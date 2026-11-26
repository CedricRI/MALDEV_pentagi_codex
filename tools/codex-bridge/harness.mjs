import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppServer, BridgeError } from './rpc.mjs';

const adapterInstructions = `You are the model backend for PentAGI. Continue the supplied conversation and follow its system and developer instructions. PentAGI owns all external tool execution. Use only the registered pentagi_tool_* dynamic functions when a tool is appropriate; their descriptions identify the original function names. Do not execute host commands, browse, edit files, use MCP tools, or delegate through Codex. Return your final answer directly, without a progress preamble. A native function call will be returned to PentAGI for execution, and its result will appear in the next request.`;

export function prepareRequest(body) {
  const bad = (message) => { throw new BridgeError(message, 400, 'invalid_request_error'); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Expected a JSON object.');
  if (!Array.isArray(body.messages) || body.messages.length === 0) bad('messages must be a non-empty array.');
  if (typeof body.model !== 'string' || !body.model.trim()) bad('model is required.');
  if (body.n !== undefined && body.n !== 1) bad('Only n=1 is supported.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') bad('stream must be a boolean.');
  if (body.functions || body.function_call) bad('Use tools/tool_choice instead of legacy functions/function_call.');
  if (body.stop !== undefined && body.stop !== null) bad('stop sequences are not supported by the Codex harness.');
  for (const key of ['logprobs', 'top_logprobs', 'logit_bias', 'audio', 'modalities', 'prediction']) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== false) bad(`${key} is not supported.`);
  }
  const tools = body.tools ?? [];
  if (!Array.isArray(tools)) bad('tools must be an array.');
  const names = new Set();
  for (const tool of tools) {
    if (tool?.type !== 'function' || typeof tool.function?.name !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.function.name)) bad('Each tool must be a named function.');
    if (names.has(tool.function.name)) bad('Tool names must be unique.');
    names.add(tool.function.name);
    if (tool.function.parameters !== undefined && (!tool.function.parameters ||
        typeof tool.function.parameters !== 'object' || Array.isArray(tool.function.parameters))) bad('Tool parameters must be a JSON Schema object.');
  }
  const choice = body.tool_choice ?? 'auto';
  let allowed = tools;
  let required = choice === 'required';
  if (choice === 'none') allowed = [];
  else if (typeof choice === 'object' && choice?.type === 'function' && names.has(choice.function?.name)) {
    allowed = tools.filter((tool) => tool.function.name === choice.function.name);
    required = true;
  } else if (choice !== 'auto' && choice !== 'required') bad('Unknown tool_choice or selected function.');
  if (required && allowed.length === 0) bad('tool_choice requires at least one available tool.');
  const dynamicTools = allowed.map((tool, index) => ({
    type: 'function', name: `pentagi_tool_${index}`,
    description: `PentAGI function: ${tool.function.name}. ${tool.function.description ?? ''}`,
    inputSchema: tool.function.parameters ?? { type: 'object', properties: {} },
  }));
  const mapping = new Map(dynamicTools.map((tool, index) => [tool.name, allowed[index].function.name]));
  const reverse = new Map(dynamicTools.map((tool, index) => [allowed[index].function.name, tool.name]));
  const systemInstructions = [];
  const developerInstructions = [];
  const items = [];
  const seenCalls = new Set();
  const pendingCalls = new Set();
  for (const message of body.messages) {
    if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) bad('Unsupported message role.');
    let text = message.content;
    if (Array.isArray(text)) {
      if (text.some((part) => part?.type !== 'text' || typeof part.text !== 'string')) bad('Only text content is supported.');
      text = text.map((part) => part.text).join('\n');
    }
    if (text !== null && text !== undefined && typeof text !== 'string') bad('Message content must be text.');
    if (message.role === 'system' || message.role === 'developer') {
      (message.role === 'system' ? systemInstructions : developerInstructions).push(text ?? '');
      continue;
    }
    if (message.role === 'tool') {
      if (!pendingCalls.delete(message.tool_call_id)) bad('Each tool result must match a preceding, unanswered tool_call_id.');
      items.push({ type: 'function_call_output', call_id: message.tool_call_id, output: text ?? '' });
      continue;
    }
    if (pendingCalls.size) bad('Tool calls must receive their results before the next user or assistant message.');
    if (text) items.push({
      type: 'message', role: message.role,
      content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text }],
      ...(message.role === 'assistant' ? { phase: 'final_answer' } : {}),
    });
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) bad('tool_calls must be an array on an assistant message.');
      for (const call of message.tool_calls) {
        if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id || seenCalls.has(call.id) ||
            typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') bad('Malformed or duplicate historical tool call.');
        let args;
        try { args = JSON.parse(call.function.arguments); }
        catch { bad('Historical tool arguments must be JSON.'); }
        if (!args || typeof args !== 'object' || Array.isArray(args)) bad('Historical tool arguments must be an object.');
        seenCalls.add(call.id);
        pendingCalls.add(call.id);
        items.push({ type: 'function_call', call_id: call.id, name: reverse.get(call.function.name) ?? call.function.name, arguments: call.function.arguments });
      }
    }
  }
  if (pendingCalls.size) bad('The conversation contains unanswered tool calls.');
  if (!items.length) bad('At least one user or assistant message is required.');
  const effort = body.reasoning_effort ?? body.reasoning?.effort;
  if (effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) bad('Unsupported reasoning effort.');
  const format = body.response_format;
  if (format && !['text', 'json_object', 'json_schema'].includes(format.type)) bad('Unsupported response_format.');
  let outputSchema;
  if (format?.type === 'json_schema') {
    outputSchema = format.json_schema?.schema;
    if (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema)) bad('response_format.json_schema.schema is required.');
  }
  const json = format?.type === 'json_object' || format?.type === 'json_schema';
  return {
    model: body.model.trim(), items, dynamicTools, mapping, required, effort, json, outputSchema,
    baseInstructions: `${adapterInstructions}\n\n${systemInstructions.join('\n\n')}`,
    developerInstructions: [
      ...developerInstructions,
      'Only produce the next assistant response. Tool calls are executed externally by PentAGI.',
      required ? 'This response MUST invoke one of the registered dynamic functions.' : '',
      json ? 'The final textual answer MUST be valid JSON, without Markdown fences.' : '',
      'Sampling parameters and output-token limits belong to Codex defaults; do not infer facts from them.',
    ].filter(Boolean).join('\n'),
  };
}

function usageFrom(params) {
  const usage = params.tokenUsage?.last;
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens ?? 0 },
  };
}

function configValue(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null).map(configValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== null).map(([key, item]) => [key, configValue(item)]));
  return value;
}

export class CodexHarness {
  constructor({ binary, args, createRpc, requestTimeoutMs = 180_000, maxConcurrent = 1, maxQueued = 24 } = {}) {
    this.createRpc = createRpc ?? ((cwd) => new AppServer({ binary, args, cwd }));
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
    this.active = 0;
    this.queue = [];
    this.models = [];
    this.defaultModel = null;
    this.closed = false;
    this.controllers = new Set();
  }

  async withRpc(signal, operation) {
    const directory = await mkdtemp(join(tmpdir(), 'MALDEV-pentagi-codex-'));
    const rpc = this.createRpc(directory);
    const abort = () => rpc.close();
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await rpc.initialize();
      signal.throwIfAborted();
      return await operation(rpc, directory);
    } finally {
      signal.removeEventListener('abort', abort);
      if (rpc.pendingToolTurn && !rpc.closed && !signal.aborted) {
        let timer;
        await Promise.race([
          rpc.request('turn/interrupt', rpc.pendingToolTurn).catch(() => {}),
          new Promise((resolve) => { timer = setTimeout(resolve, 1000); }),
        ]);
        clearTimeout(timer);
      }
      rpc.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  async initialize() {
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    await this.withRpc(signal, async (rpc) => {
      const models = [];
      let cursor;
      do {
        const page = await rpc.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
        models.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      this.models = models.filter((entry) => !entry.hidden).map((entry) => ({
        id: entry.model ?? entry.id, object: 'model', created: 0, owned_by: 'codex-chatgpt',
        supported_parameters: ['tools', 'tool_choice', 'response_format', 'reasoning_effort'],
        ...(entry.isDefault ? { isDefault: true } : {}),
      }));
      this.defaultModel = this.models.find((entry) => entry.isDefault)?.id ?? this.models[0]?.id;
      if (!this.defaultModel) throw new BridgeError('Your Codex account returned no available models.', 503);
    });
    return this.models;
  }

  acquire(signal) {
    if (this.closed) return Promise.reject(new BridgeError('Bridge is shutting down.', 503));
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.active < this.maxConcurrent) { this.active++; return Promise.resolve(); }
    if (this.queue.length >= this.maxQueued) return Promise.reject(new BridgeError('Codex request queue is full.', 429, 'rate_limit_exceeded'));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal };
      entry.abort = () => { this.queue = this.queue.filter((queued) => queued !== entry); reject(signal.reason); };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry);
    });
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      next.signal.removeEventListener('abort', next.abort);
      next.resolve();
    } else this.active--;
  }

  async complete(body, { signal: clientSignal, onDelta = () => {} } = {}) {
    const prepared = prepareRequest(body);
    const model = prepared.model === 'codex-default' ? this.defaultModel : prepared.model;
    if (!this.models.some((entry) => entry.id === model)) throw new BridgeError('Model is not in the signed-in Codex catalog. Use GET /v1/models.', 400, 'model_not_found');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new BridgeError('Codex request timed out.', 504, 'request_timeout')), this.requestTimeoutMs);
    const signal = clientSignal ? AbortSignal.any([clientSignal, controller.signal]) : controller.signal;
    this.controllers.add(controller);
    let acquired = false;
    try {
      await this.acquire(signal);
      acquired = true;
      return await this.withRpc(signal, async (rpc, directory) => {
        const configuration = await rpc.request('config/read', {});
        const config = {
          'features.shell_tool': false, 'features.apply_patch_freeform': false,
          'features.multi_agent': false, 'features.apps': false, 'features.js_repl': false,
          'agents.enabled': false, 'features.multi_agent_v2': false, 'tools.update_plan.enabled': false,
          'features.hooks': false, 'features.codex_hooks': false, 'features.plugin_hooks': false,
          'features.skip_host_skill_discovery': true, 'skills.include_instructions': false,
          'skills.bundled.enabled': false, 'code_mode.enabled': false,
          'web_search': 'disabled', 'project_doc_max_bytes': 0,
          'apps._default.enabled': false, 'include_apps_instructions': false,
          'include_environment_context': false,
        };
        config.mcp_servers = Object.fromEntries(Object.entries(configuration.config?.mcp_servers ?? {})
          .map(([name, server]) => [name, { ...configValue(server), enabled: false }]));
        config.plugins = Object.fromEntries(Object.entries(configuration.config?.plugins ?? {})
          .map(([name, plugin]) => [name, { ...configValue(plugin), enabled: false }]));
        const started = await rpc.request('thread/start', {
          model, modelProvider: 'openai', ephemeral: true, cwd: directory,
          approvalPolicy: 'never', sandbox: 'read-only', environments: [],
          baseInstructions: prepared.baseInstructions, developerInstructions: prepared.developerInstructions,
          dynamicTools: prepared.dynamicTools, config,
        });
        const threadId = started.thread.id;
        const history = [...prepared.items];
        const last = history.at(-1);
        let input = [{ type: 'text', text: 'Continue the conversation from its latest message or tool result.', text_elements: [] }];
        if (last?.type === 'message' && last.role === 'user') {
          history.pop();
          input = [{ type: 'text', text: last.content.map((part) => part.text).join('\n'), text_elements: [] }];
        }
        if (history.length) await rpc.request('thread/inject_items', { threadId, items: history });
        return await this.runTurn(rpc, threadId, model, prepared, input, signal, onDelta);
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
      if (acquired) this.release();
    }
  }

  runTurn(rpc, threadId, model, prepared, input, signal, onDelta) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fragments = new Map();
      const finalItems = new Map();
      let usage;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        rpc.removeListener('message', receive);
        rpc.removeListener('failure', failure);
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const failure = (error) => finish(error);
      const abort = () => finish(signal.reason);
      const receive = (message) => {
        const params = message.params ?? {};
        if (params.threadId && params.threadId !== threadId) return;
        try {
          if (message.method === 'thread/tokenUsage/updated') usage = usageFrom(params);
          else if (message.method === 'item/agentMessage/delta') {
            fragments.set(params.itemId, (fragments.get(params.itemId) ?? '') + params.delta);
          } else if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
            finalItems.set(params.item.id, params.item);
          } else if (message.method === 'item/tool/call' && Object.hasOwn(message, 'id')) {
            const name = prepared.mapping.get(params.tool);
            if (!name || params.namespace) throw new BridgeError('Codex requested an unregistered tool.');
            if (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) throw new BridgeError('Codex returned malformed tool arguments.');
            const call = { id: `call_${randomBytes(12).toString('hex')}`, type: 'function', function: { name, arguments: JSON.stringify(params.arguments) } };
            // End this isolated inference before any tool runs; PentAGI receives the call.
            rpc.pendingToolTurn = { threadId, turnId: params.turnId };
            finish(null, { model, content: null, tool_calls: [call], finish_reason: 'tool_calls', ...(usage ? { usage } : {}) });
          } else if (message.method === 'turn/completed') {
            if (params.turn?.status !== 'completed') throw new BridgeError(params.turn?.error?.message ?? `Codex turn ${params.turn?.status ?? 'failed'}.`);
            if (prepared.required) throw new BridgeError('Codex returned text when tool_choice required a function call.');
            const items = [...finalItems.values()];
            const finals = items.filter((item) => item.phase === 'final_answer');
            const selected = finals.length ? finals : items.slice(-1);
            const content = selected.map((item) => item.text ?? fragments.get(item.id) ?? '').join('\n');
            if (!content) throw new BridgeError('Codex returned no final assistant message.');
            if (prepared.json) {
              try { JSON.parse(content); }
              catch { throw new BridgeError('Codex returned invalid JSON for response_format.'); }
            }
            onDelta(content);
            finish(null, { model, content, finish_reason: 'stop', ...(usage ? { usage } : {}) });
          } else if (message.method === 'error' && !params.willRetry) {
            const text = params.error?.message ?? 'Codex inference failed.';
            const limited = /rate.limit|usage.limit|quota|exhausted/i.test(text);
            finish(new BridgeError(text, limited ? 429 : 502, limited ? 'rate_limit_exceeded' : 'codex_error'));
          } else if (Object.hasOwn(message, 'id')) {
            rpc.send({ id: message.id, error: { code: -32601, message: 'This bridge permits only PentAGI dynamic tool calls.' } });
            throw new BridgeError(`Unexpected Codex server request: ${message.method}`);
          }
        } catch (error) { finish(error); }
      };
      rpc.on('message', receive);
      rpc.once('failure', failure);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      rpc.request('turn/start', {
        threadId, input, ...(prepared.effort ? { effort: prepared.effort } : {}),
        ...(prepared.outputSchema ? { outputSchema: prepared.outputSchema } : {}),
      }).catch(failure);
    });
  }

  close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort(new BridgeError('Bridge is shutting down.', 503));
  }
}

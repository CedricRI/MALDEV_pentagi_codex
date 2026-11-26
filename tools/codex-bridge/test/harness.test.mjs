import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexHarness, prepareRequest } from '../harness.mjs';
import { AppServer } from '../rpc.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const tools = [{ type: 'function', function: { name: 'add_numbers', description: 'Add integers.', parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } } }];
const request = (text, extra = {}) => ({ model: 'codex-default', messages: [{ role: 'user', content: text }], ...extra });
async function harness(t, options = {}, env = {}) {
  const h = new CodexHarness({
    createRpc: (cwd) => new AppServer({ binary: process.execPath, args: [fixture], cwd, env: { ...process.env, ...env } }),
    requestTimeoutMs: 10_000, ...options,
  });
  t.after(() => h.close());
  await h.initialize();
  return h;
}

test('native tool handoff and historical results survive separate app-server processes', async (t) => {
  const h = await harness(t);
  const first = await h.complete(request('tool', { tools, tool_choice: 'required' }));
  assert.equal(first.finish_reason, 'tool_calls');
  assert.equal(first.content, null);
  assert.match(first.tool_calls[0].id, /^call_[0-9a-f]{24}$/);
  assert.equal(first.tool_calls[0].function.name, 'add_numbers');
  assert.deepEqual(JSON.parse(first.tool_calls[0].function.arguments), { a: 17, b: 25 });
  const result = await h.complete({ model: 'codex-default', tools, tool_choice: 'none', messages: [
    { role: 'user', content: 'tool' },
    { role: 'assistant', content: null, tool_calls: first.tool_calls },
    { role: 'tool', tool_call_id: first.tool_calls[0].id, content: '42' },
  ] });
  assert.equal(result.content, '42');
  assert.equal(result.finish_reason, 'stop');
  assert.equal(h.active, 0);
});

test('isolates execution and preserves system instructions and assistant prefill', async (t) => {
  const h = await harness(t);
  const result = await h.complete({ model: 'codex-default', tools, reasoning_effort: 'low', messages: [
    { role: 'system', content: 'Preserve this system rule.' }, { role: 'user', content: 'question' },
    { role: 'assistant', content: 'The answer is' }, { role: 'user', content: 'inspect' },
  ] });
  const { thread, history, turn } = JSON.parse(result.content);
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.modelProvider, 'openai');
  assert.equal(thread.sandbox, 'read-only');
  assert.deepEqual(thread.environments, []);
  assert.match(thread.baseInstructions, /Preserve this system rule/);
  assert.equal(thread.config.mcp_servers['user.server'].enabled, false);
  assert.equal(thread.config.plugins['plugin@market.place'].enabled, false);
  assert.equal(thread.config['features.shell_tool'], false);
  assert.equal(thread.config['agents.enabled'], false);
  assert.equal(history[1].role, 'assistant');
  assert.equal(history[1].content[0].text, 'The answer is');
  assert.equal(turn.effort, 'low');
  assert.equal(turn.input[0].text, 'inspect');
});

test('only final assistant content is returned and usage is measured', async (t) => {
  const h = await harness(t);
  const deltas = [];
  const result = await h.complete(request('hello'), { onDelta: (text) => deltas.push(text) });
  assert.equal(result.content, 'BRIDGE_OK');
  assert.deepEqual(deltas, ['BRIDGE_OK']);
  assert.deepEqual(result.usage, {
    prompt_tokens: 100, completion_tokens: 5, total_tokens: 105,
    prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 2 },
  });
});

test('rejects API-key authentication instead of silently billing the API', async () => {
  const rpc = new AppServer({ binary: process.execPath, args: [fixture], env: { ...process.env, FAKE_CODEX_AUTH: 'apiKey' } });
  try { await assert.rejects(rpc.initialize(), (error) => error.status === 401 && error.code === 'chatgpt_login_required'); }
  finally { rpc.close(); }
});

test('validates tool choice, model selection, JSON output and unexpected host tools', async (t) => {
  const h = await harness(t);
  await assert.rejects(h.complete(request('hello', { model: 'paid-api-model' })), (error) => error.code === 'model_not_found');
  await assert.rejects(h.complete(request('hello', { tools, tool_choice: 'required' })), /required a function call/);
  await assert.rejects(h.complete(request('unknown-tool', { tools })), /unregistered tool/);
  await assert.rejects(h.complete(request('builtin')), /Unexpected Codex server request/);
  await assert.rejects(h.complete(request('bad-json', { response_format: { type: 'json_object' } })), /invalid JSON/);
  const result = await h.complete(request('json', { response_format: { type: 'json_object' } }));
  assert.deepEqual(JSON.parse(result.content), { ok: true });
  await assert.rejects(h.complete(request('quota')), (error) => error.status === 429);
  await assert.rejects(h.complete(request('exit')), /app-server exited/);
  assert.equal(h.active, 0);
});

test('cancellation releases the concurrency slot and queued requests can proceed', async (t) => {
  const h = await harness(t, { maxConcurrent: 1 });
  const controller = new AbortController();
  const pending = h.complete(request('hang'), { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled for test/);
  const queued = h.complete(request('hello'));
  controller.abort(new Error('cancelled for test'));
  await rejected;
  assert.equal((await queued).content, 'BRIDGE_OK');
  assert.equal(h.active, 0);
});

test('timeout terminates a stalled child and leaves the harness usable', async (t) => {
  const h = await harness(t);
  h.requestTimeoutMs = 500;
  await assert.rejects(h.complete(request('hang')), (error) => error.status === 504);
  h.requestTimeoutMs = 10_000;
  assert.equal((await h.complete(request('hello'))).content, 'BRIDGE_OK');
});

test('rejects malformed conversations and unsupported features before inference', () => {
  const cases = [
    request('hello', { n: 2 }), request('hello', { stop: ['END'] }),
    request('hello', { tools, tool_choice: { type: 'function', function: { name: 'missing' } } }),
    request('hello', { tools: [tools[0], tools[0]] }),
    { model: 'codex-default', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image' } }] }] },
    { model: 'codex-default', messages: [{ role: 'tool', tool_call_id: 'unknown', content: 'result' }] },
    { model: 'codex-default', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'tool', arguments: '{}' } }] }] },
  ];
  for (const body of cases) assert.throws(() => prepareRequest(body), (error) => error.status === 400);
});

test('named tool choice exposes only that tool while none exposes no tools', () => {
  const selected = prepareRequest(request('hello', { tools, tool_choice: { type: 'function', function: { name: 'add_numbers' } } }));
  assert.equal(selected.required, true);
  assert.equal(selected.mapping.get('pentagi_tool_0'), 'add_numbers');
  assert.deepEqual(prepareRequest(request('hello', { tools, tool_choice: 'none' })).dynamicTools, []);
});

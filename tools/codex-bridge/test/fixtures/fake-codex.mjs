import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let initialized = false;
let thread;
let history = [];
const marker = process.env.FAKE_CODEX_CLOSE_MARKER;
if (marker) process.once('exit', () => appendFileSync(marker, 'closed\n'));
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const { id, method, params } = request;
  const reply = (result) => send({ id, result });
  if (method === 'initialize') { initialized = true; reply({ userAgent: 'fake-codex' }); }
  else if (method === 'initialized') continue;
  else if (!initialized) send({ id, error: { message: 'Not initialized' } });
  else if (method === 'account/read') reply({ account: { type: process.env.FAKE_CODEX_AUTH ?? 'chatgpt' } });
  else if (method === 'model/list') reply({ data: [{ id: 'test-model', model: 'test-model', isDefault: true }], nextCursor: null });
  else if (method === 'config/read') reply({ config: { mcp_servers: { 'user.server': {} }, plugins: { 'plugin@market.place': {} } } });
  else if (method === 'thread/start') { thread = params; reply({ thread: { id: 'thread-test' } }); }
  else if (method === 'thread/inject_items') { history = params.items; reply({}); }
  else if (method === 'turn/start') {
    reply({ turn: { id: 'turn-test', status: 'inProgress' } });
    const input = params.input[0]?.text ?? '';
    const notify = (methodName, data) => send({ method: methodName, params: { threadId: 'thread-test', turnId: 'turn-test', ...data } });
    if (input === 'hang') continue;
    if (input === 'exit') process.exit(7);
    if (input === 'quota') {
      notify('error', { error: { message: 'Usage limit exceeded.' }, willRetry: false });
      continue;
    }
    if (input === 'builtin') {
      send({ id: 'server-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-test' } });
      continue;
    }
    if (input === 'tool' || input === 'unknown-tool') {
      send({ id: 'tool-request', method: 'item/tool/call', params: {
        threadId: 'thread-test', turnId: 'turn-test', callId: 'native-call',
        tool: input === 'unknown-tool' ? 'not_registered' : thread.dynamicTools[0].name,
        arguments: { a: 17, b: 25 },
      } });
      continue;
    }
    notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 100, outputTokens: 5, totalTokens: 105, cachedInputTokens: 10, reasoningOutputTokens: 2 } } });
    notify('item/agentMessage/delta', { itemId: 'commentary', delta: 'INTERNAL PROGRESS MUST NOT LEAK' });
    notify('item/completed', { item: { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'INTERNAL PROGRESS MUST NOT LEAK' } });
    let text;
    if (input === 'inspect') text = JSON.stringify({ thread, history, turn: params });
    else if (input === 'json') text = '{"ok":true}';
    else if (input === 'bad-json') text = 'not JSON';
    else text = history.find((item) => item.type === 'function_call_output')?.output ?? 'BRIDGE_OK';
    notify('item/agentMessage/delta', { itemId: 'final', delta: text });
    notify('item/completed', { item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text } });
    notify('turn/completed', { turn: { id: 'turn-test', status: 'completed' } });
  } else send({ id, error: { message: `Unsupported method ${method}` } });
}

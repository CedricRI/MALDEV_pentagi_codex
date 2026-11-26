import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createBridgeServer, loadToken } from '../server.mjs';
import { BridgeError } from '../rpc.mjs';

const token = 'local-test-token-at-least-24-characters';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const body = { model: 'codex-default', messages: [{ role: 'user', content: 'hello' }] };
const textResult = { model: 'test-model', content: 'hello', finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };

async function fixture(t, complete = async () => textResult, options = {}) {
  const server = createBridgeServer({ token, harness: { defaultModel: 'test-model', models: [{ id: 'test-model', object: 'model' }], complete }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, post: (value, extra = {}) => fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(value), ...extra }) };
}

test('HTTP authentication protects inference and models; browser origins are refused', async (t) => {
  let calls = 0;
  const { url } = await fixture(t, async () => { calls++; return textResult; });
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.equal((await fetch(`${url}/v1/models`)).status, 401);
  assert.equal((await fetch(`${url}/v1/models`, { headers: { ...headers, Origin: 'https://example.test' } })).status, 403);
  const models = await (await fetch(`${url}/v1/models`, { headers })).json();
  assert.deepEqual(models.data.map((entry) => entry.id), ['codex-default', 'test-model']);
  assert.equal(calls, 0);
});

test('non-streaming completions preserve content, usage and ignored-parameter disclosure', async (t) => {
  const { post } = await fixture(t);
  const response = await post({ ...body, temperature: 0.5, max_tokens: 100 });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-codex-ignored-parameters'), 'temperature,max_tokens');
  const result = await response.json();
  assert.equal(result.object, 'chat.completion');
  assert.equal(result.choices[0].message.content, 'hello');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.equal(result.usage.total_tokens, 12);
});

test('SSE produces a tool-call delta, matching finish reason, usage and DONE', async (t) => {
  const tool = { id: 'call_test', type: 'function', function: { name: 'add', arguments: '{"a":1}' } };
  const { post } = await fixture(t, async () => ({ model: 'test-model', content: null, tool_calls: [tool], finish_reason: 'tool_calls', usage: textResult.usage }));
  const response = await post({ ...body, stream: true, stream_options: { include_usage: true } });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = (await response.text()).split('\n\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
  assert.equal(events.pop(), '[DONE]');
  const chunks = events.map(JSON.parse);
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.deepEqual(chunks[1].choices[0].delta.tool_calls[0], { index: 0, ...tool });
  assert.equal(chunks[2].choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(chunks[3].choices, []);
  assert.equal(chunks[3].usage.total_tokens, 12);
});

test('HTTP errors preserve rate limits and validate requests before starting inference', async (t) => {
  let calls = 0;
  const { post, url } = await fixture(t, async () => { calls++; throw new BridgeError('Subscription quota reached.', 429, 'rate_limit_exceeded'); });
  const invalid = await post({ ...body, n: 2 });
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
  const limited = await post(body);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '30');
  assert.equal((await limited.json()).error.code, 'rate_limit_exceeded');
  assert.equal((await fetch(`${url}/v1/embeddings`, { headers })).status, 404);
});

test('streaming errors are explicit instead of fake successful assistant messages', async (t) => {
  const { post } = await fixture(t, async () => { throw new BridgeError('Subscription quota reached.', 429, 'rate_limit_exceeded'); });
  const response = await post({ ...body, stream: true });
  const data = await response.text();
  assert.match(data, /"error":\{"message":"Subscription quota reached/);
  assert.doesNotMatch(data, /"finish_reason":"stop"/);
  assert.match(data, /data: \[DONE\]/);
});

test('oversized request bodies are refused', async (t) => {
  const { post } = await fixture(t, undefined, { maxBodyBytes: 100 });
  const response = await post({ ...body, messages: [{ role: 'user', content: 'x'.repeat(1000) }] });
  assert.equal(response.status, 413);
});

test('disconnecting a streaming caller cancels its inference', async (t) => {
  let aborted;
  const cancelled = new Promise((resolve) => { aborted = resolve; });
  const { post } = await fixture(t, async (_, { signal }) => {
    return await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted(); reject(signal.reason); }, { once: true }));
  });
  const controller = new AbortController();
  const response = await post({ ...body, stream: true }, { signal: controller.signal });
  controller.abort();
  await response.body.cancel().catch(() => {});
  await Promise.race([cancelled, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('inference was not cancelled')), 5000); timer.unref(); })]);
});

test('local token persists without printing or replacing existing credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'MALDEV-bridge-test-'));
  try {
    const path = join(directory, 'token');
    const tokenA = await loadToken(path);
    assert.equal(tokenA.length, 43);
    assert.equal(await loadToken(path), tokenA);
    assert.equal(await readFile(path, 'utf8'), tokenA);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

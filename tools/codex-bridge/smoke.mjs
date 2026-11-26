import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const base = process.env.CODEX_BRIDGE_URL ?? 'http://127.0.0.1:8765/v1';
const tokenFile = process.env.CODEX_BRIDGE_TOKEN_FILE ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../.state/codex-bridge/token');
const key = process.env.CODEX_BRIDGE_KEY ?? (await readFile(tokenFile, 'utf8')).trim();
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const call = async (body) => {
  const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result.choices[0];
};
const model = 'codex-default';
const reasoning_effort = 'low';
const messages = [{ role: 'user', content: 'Use add_numbers with a=17 and b=25.' }];
const tools = [{ type: 'function', function: {
  name: 'add_numbers', description: 'Add two integers with the external calculator.',
  parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false },
} }];
const first = await call({ model, reasoning_effort, messages, tools, tool_choice: 'required' });
assert.equal(first.finish_reason, 'tool_calls');
assert.equal(first.message.tool_calls.length, 1);
const tool = first.message.tool_calls[0];
assert.equal(tool.function.name, 'add_numbers');
assert.deepEqual(JSON.parse(tool.function.arguments), { a: 17, b: 25 });
console.log('PASS: Codex returned a native tool call for external execution.');
messages.push(first.message, { role: 'tool', tool_call_id: tool.id, content: '42' });
const second = await call({ model, reasoning_effort, messages, tools, tool_choice: 'none' });
assert.match(second.message.content, /42/);
console.log('PASS: Tool result survived the conversation round trip.');
const third = await call({ model, reasoning_effort, messages: [{ role: 'user', content: 'Return a JSON object with one key, ok, set to true.' }], response_format: { type: 'json_schema', json_schema: {
  name: 'smoke_result', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
} } });
assert.deepEqual(JSON.parse(third.message.content), { ok: true });
console.log('PASS: Structured JSON output.');

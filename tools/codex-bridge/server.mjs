import http from 'node:http';
import { timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodexHarness, prepareRequest } from './harness.mjs';
import { BridgeError } from './rpc.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function loadToken(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let file;
  try {
    file = await open(path, 'wx', 0o600);
    await file.writeFile(randomBytes(32).toString('base64url'));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally { await file?.close(); }
  const token = (await readFile(path, 'utf8')).trim();
  if (token.length < 24) throw new Error('The bridge token must contain at least 24 characters.');
  return token;
}

function authorized(request, token) {
  const received = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new BridgeError('Request body is too large.', 413, 'request_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('Request body must be valid JSON.', 400, 'invalid_request_error'); }
}

export function createBridgeServer({ harness, token, maxBodyBytes = 8 * 1024 * 1024 } = {}) {
  if (!token || token.length < 24) throw new Error('A bridge token of at least 24 characters is required.');
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const path = request.url?.split('?')[0];
    if (request.headers.origin) { json(response, 403, { error: { message: 'Browser-origin requests are not supported.', code: 'forbidden' } }); return; }
    if (path === '/healthz' && request.method === 'GET') {
      json(response, 200, { status: 'ok', backend: 'codex-app-server', authentication: 'chatgpt', model: harness.defaultModel });
      return;
    }
    if (!authorized(request, token)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      json(response, 401, { error: { message: 'Invalid local bridge token.', type: 'authentication_error', code: 'invalid_api_key' } });
      return;
    }
    if (path === '/v1/models' && request.method === 'GET') {
      json(response, 200, { object: 'list', data: [
        { id: 'codex-default', object: 'model', created: 0, owned_by: 'codex-chatgpt' }, ...harness.models,
      ] });
      return;
    }
    if (path !== '/v1/chat/completions' || request.method !== 'POST') {
      json(response, 404, { error: { message: 'Supported endpoints: GET /v1/models and POST /v1/chat/completions. Embeddings require a separate local provider.', code: 'not_found' } });
      return;
    }
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort(new BridgeError('Client disconnected.', 499, 'request_cancelled')); };
    response.once('close', disconnect);
    let heartbeat;
    let stream = false;
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let model;
    const sse = (payload) => {
      if (!response.destroyed) response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
    };
    const chunk = (delta, reason = null) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: reason }] });
    try {
      const body = await readBody(request, maxBodyBytes);
      prepareRequest(body);
      model = body.model === 'codex-default' ? harness.defaultModel : body.model;
      const ignored = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'seed', 'presence_penalty', 'frequency_penalty', 'parallel_tool_calls']
        .filter((key) => body[key] !== undefined);
      if (ignored.length) response.setHeader('X-Codex-Ignored-Parameters', ignored.join(','));
      stream = body.stream === true;
      if (stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
        sse(chunk({ role: 'assistant' }));
        heartbeat = setInterval(() => { if (!response.destroyed) response.write(': waiting for Codex\n\n'); }, 10_000);
        heartbeat.unref();
      }
      const result = await harness.complete(body, { signal: controller.signal });
      if (response.destroyed) return;
      model = result.model;
      if (stream) {
        if (result.content) sse(chunk({ content: result.content }));
        if (result.tool_calls) sse(chunk({ tool_calls: result.tool_calls.map((call, index) => ({ index, ...call })) }));
        sse(chunk({}, result.finish_reason));
        if (body.stream_options?.include_usage && result.usage) sse({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: result.usage });
        sse('[DONE]');
        response.end();
      } else {
        json(response, 200, {
          id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content: result.content, ...(result.tool_calls ? { tool_calls: result.tool_calls } : {}) }, finish_reason: result.finish_reason }],
          ...(result.usage ? { usage: result.usage } : {}),
        });
      }
    } catch (error) {
      if (response.destroyed) return;
      const payload = { error: { message: error instanceof BridgeError ? error.message : 'Local bridge failed.', type: 'bridge_error', code: error.code ?? 'bridge_error' } };
      if (error.status === 429 && !response.headersSent) response.setHeader('Retry-After', '30');
      if (stream && response.headersSent) { sse(payload); sse('[DONE]'); response.end(); }
      else json(response, error.status ?? 500, payload);
    } finally {
      clearInterval(heartbeat);
      response.removeListener('close', disconnect);
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  return server;
}

function positiveInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

export async function main() {
  const host = process.env.CODEX_BRIDGE_HOST ?? '127.0.0.1';
  const port = positiveInteger(process.env.CODEX_BRIDGE_PORT, 8765, 'CODEX_BRIDGE_PORT');
  const tokenFile = resolve(process.env.CODEX_BRIDGE_TOKEN_FILE ?? joinState('token'));
  const token = process.env.CODEX_BRIDGE_KEY ?? await loadToken(tokenFile);
  const harness = new CodexHarness({
    binary: process.env.CODEX_BIN,
    requestTimeoutMs: positiveInteger(process.env.CODEX_BRIDGE_TIMEOUT_MS, 180_000, 'CODEX_BRIDGE_TIMEOUT_MS'),
    maxConcurrent: positiveInteger(process.env.CODEX_BRIDGE_CONCURRENCY, 1, 'CODEX_BRIDGE_CONCURRENCY'),
  });
  await harness.initialize();
  const server = createBridgeServer({ harness, token });
  await new Promise((resolveListening, reject) => { server.once('error', reject); server.listen(port, host, resolveListening); });
  console.log(`PentAGI Codex bridge: http://${host}:${port}/v1`);
  console.log(`Signed-in ChatGPT backend; default model: ${harness.defaultModel}`);
  console.log(process.env.CODEX_BRIDGE_KEY ? 'Local authentication uses CODEX_BRIDGE_KEY.' : `Local authentication token file: ${tokenFile}`);
  const shutdown = () => { harness.close(); server.close(); server.closeAllConnections(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { server, harness };
}

function joinState(name) { return resolve(root, '.state/codex-bridge', name); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof BridgeError ? error.message : 'Bridge startup failed. Check Node, Codex login, and bridge configuration.'); process.exitCode = 1; });
}

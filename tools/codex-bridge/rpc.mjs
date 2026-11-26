import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export class BridgeError extends Error {
  constructor(message, status = 502, code = 'codex_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class AppServer extends EventEmitter {
  constructor({ binary = 'codex', args = [], cwd, env = process.env, spawnProcess = spawn } = {}) {
    super();
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.child = spawnProcess(binary, [...args, 'app-server', '--listen', 'stdio://'], {
      cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => this.receive(line));
    // Stderr may contain prompts or credentials; never forward it to an HTTP caller.
    this.child.stderr.resume();
    this.child.stdin.on('error', (error) => this.fail(new BridgeError(`Codex input closed: ${error.code ?? 'IO_ERROR'}`)));
    this.child.once('error', (error) => this.fail(new BridgeError(
      error.code === 'ENOENT' ? 'Codex CLI not found. Install Codex or set CODEX_BIN.' : `Cannot launch Codex: ${error.code ?? 'SPAWN_ERROR'}`,
      503, 'codex_unavailable',
    )));
    this.child.once('exit', (code) => this.fail(new BridgeError(`Codex app-server exited (${code ?? 'signal'}).`, 503)));
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.fail(new BridgeError('Codex returned invalid JSON-RPC.')); return; }
    if (Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new BridgeError(message.error.message ?? 'Codex rejected the request.'));
      else pending.resolve(message.result);
    } else if (message.method) {
      this.emit('message', message);
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.emit('failure', error);
  }

  send(message) {
    if (this.closed) throw new BridgeError('Codex connection is closed.', 503);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new BridgeError('Codex connection is closed.', 503));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'maldev_pentagi_codex', title: 'PentAGI Codex Bridge', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    const result = await this.request('account/read', { refreshToken: false });
    if (result.account?.type !== 'chatgpt') {
      throw new BridgeError('Run codex login with your ChatGPT account. API-key authentication is not accepted by this bridge.', 401, 'chatgpt_login_required');
    }
    return result;
  }

  close() {
    this.fail(new BridgeError('Codex request ended.', 499, 'request_cancelled'));
    this.lines.close();
    this.child.stdin.destroy();
    this.child.kill();
  }
}

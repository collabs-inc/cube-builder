import { connect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { BuilderError } from '../shared/errors.js';
import { WORKER_PROTOCOL, type SpawnParams, type SessionInfo, type ReadResult } from '../shared/terminal-protocol.js';

export class WorkerClient extends EventEmitter {
  identity = '';
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private stopped = false;
  private replacement?: WorkerClient;
  private retry?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private reconnect() {
    if (this.stopped || !this.autoReconnect) return;
    this.retry = setTimeout(async () => {
      try {
        const next = await WorkerClient.connect(this.path, false);
        if (this.stopped) { next.disconnect(); return; }
        this.replacement = next; this.identity = next.identity; this.attempt = 0;
        next.on('event', event => this.emit('event', event));
        next.once('disconnected', () => { this.replacement = undefined; this.emit('disconnected'); this.reconnect(); });
        this.emit('reconnected');
      } catch { this.reconnect(); }
    }, Math.min(5000, 100 * 2 ** Math.min(this.attempt++, 6)));
    this.retry.unref();
  }
  private constructor(private socket: Socket, private path: string, private autoReconnect: boolean) {
    super();
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) { socket.destroy(new Error('Worker frame exceeds maximum size')); return; }
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { socket.destroy(new Error('Malformed worker response')); return; }
        if (message.event) { this.emit('event', message.event); continue; }
        const pending = this.pending.get(message.id); if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new BuilderError(message.error?.code ?? 'worker-error', message.error?.message ?? 'Worker error'));
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new BuilderError('worker-disconnected', 'Terminal worker disconnected')); }
      this.pending.clear(); this.emit('disconnected'); this.reconnect();
    });
  }
  static async connect(path: string, autoReconnect = true): Promise<WorkerClient> {
    const socket = connect(path);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => socket.destroy(new Error('Worker connection timed out')), 2000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
    });
    const client = new WorkerClient(socket, path, false);
    try {
      const hello = await client.request('hello', { app: 'cube-builder', protocol: WORKER_PROTOCOL });
      if (hello?.app !== 'cube-builder' || hello?.protocol !== WORKER_PROTOCOL || typeof hello.identity !== 'string') throw new BuilderError('worker-incompatible', 'Unexpected terminal worker identity or protocol');
      client.identity = hello.identity; client.autoReconnect = autoReconnect; return client;
    } catch (error) { client.disconnect(); throw error; }
  }
  private request(method: string, params: unknown): Promise<any> {
    if (this.replacement) return this.replacement.request(method, params);
    if (this.closed) return Promise.reject(new BuilderError('worker-disconnected', 'Terminal worker disconnected'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BuilderError('worker-timeout', `${method} timed out`)); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  spawn(params: SpawnParams): Promise<SessionInfo> { return this.request('spawn', params); }
  list(): Promise<SessionInfo[]> { return this.request('list', {}); }
  read(id: string, options: { since: number; maxBytes?: number }): Promise<ReadResult> { return this.request('read', { id, options }); }
  write(id: string, bytes: string): Promise<void> { return this.request('write', { id, bytes }); }
  resize(id: string, cols: number, rows: number): Promise<void> { return this.request('resize', { id, cols, rows }); }
  kill(id: string): Promise<void> { return this.request('kill', { id }); }
  forget(id: string): Promise<void> { return this.request('forget', { id }); }
  stopAll(): Promise<void> { return this.request('stopAll', {}); }
  disconnect(): void { this.stopped = true; clearTimeout(this.retry); this.replacement?.disconnect(); this.closed = true; this.socket.destroy(); }
}

import { createServer, type Socket } from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { TerminalSessions } from './sessions.js';
import { WORKER_PROTOCOL } from '../shared/terminal-protocol.js';
import { errorPayload, BuilderError } from '../shared/errors.js';

export async function startWorkerServer(socketPath: string): Promise<{ close(): Promise<void> }> {
  const sessions = new TerminalSessions();
  const clients = new Set<Socket>();
  const identity = randomUUID();
  let closing = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const send = (socket: Socket, value: unknown) => {
    if (socket.writableLength > 4 * 1024 * 1024) { socket.destroy(); return; }
    socket.write(JSON.stringify(value) + '\n');
  };
  function idleCheck() {
    clearTimeout(idle);
    if (!clients.size && sessions.list().every(s => s.exited)) idle = setTimeout(() => { void close(); }, 1000);
  }
  const server = createServer(socket => {
    clients.add(socket); clearTimeout(idle);
    let buffer = '';
    let admitted = false;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => { clients.delete(socket); idleCheck(); });
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) { socket.destroy(); return; }
      for (;;) {
        const end = buffer.indexOf('\n'); if (end === -1) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let request: { id: string; method: string; params: any };
        try { request = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!request || typeof request.id !== 'string' || typeof request.method !== 'string' || !request.params || typeof request.params !== 'object') { socket.destroy(); return; }
        void (async () => {
          try {
            const p = request.params;
            let result: unknown;
            if (request.method === 'hello') {
              if (p.protocol !== WORKER_PROTOCOL || p.app !== 'cube-builder') throw new BuilderError('worker-incompatible', 'Builder terminal worker uses an incompatible protocol. Close its sessions before upgrading.');
              admitted = true; result = { protocol: WORKER_PROTOCOL, app: 'cube-builder', identity, pid: process.pid };
            } else {
              if (!admitted) throw new BuilderError('not-admitted', 'Worker handshake required');
              switch (request.method) {
                case 'spawn': result = sessions.spawn(p); break;
                case 'list': result = sessions.list(); break;
                case 'read': result = sessions.read(p.id, p.options); break;
                case 'write': result = sessions.write(p.id, p.bytes); break;
                case 'resize': result = sessions.resize(p.id, p.cols, p.rows); break;
                case 'kill': result = sessions.kill(p.id); break;
                case 'stopAll': await sessions.close(); result = null; break;
                default: throw new BuilderError('unknown-method', 'Unknown worker method');
              }
            }
            send(socket, { id: request.id, ok: true, result: result ?? null });
          } catch (error) { send(socket, { id: request.id, ok: false, error: errorPayload(error) }); }
        })();
      }
    });
    // Events are only sent after this private socket has negotiated its role.
    const event = (value: unknown) => { if (admitted) send(socket, { event: value }); };
    sessions.on('event', event);
    socket.on('close', () => sessions.off('event', event));
  });
  sessions.on('event', idleCheck);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
  await chmod(socketPath, 0o600);
  // A short grace period lets the launching server attach.
  idle = setTimeout(idleCheck, 5000);
  async function close() {
    if (closing) return; closing = true; clearTimeout(idle);
    await sessions.close();
    for (const client of clients) client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(socketPath, { force: true });
  }
  return { close };
}

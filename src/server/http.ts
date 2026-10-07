import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { validateControlRequest } from './request-policy.js';
import { isRequest } from '../shared/protocol.js';
import { BuilderError, errorPayload } from '../shared/errors.js';
import { Registry } from './registry.js';
import { ensureWorker } from './worker-runtime.js';
import { Terminals } from './terminals.js';
import { createMethods } from './methods.js';
import { broadcast } from './events.js';
import { Repos } from './repos.js';
import { Files } from './files.js';
import { Previews } from './previews.js';
import { Watches } from './watches.js';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
export function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(value));
}
export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) throw new BuilderError('too-large', 'Request exceeds 12 MiB');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BuilderError('invalid-request', 'Expected JSON'); }
}

export async function startServer(options: { port: number; stateDir: string; webRoot?: string }): Promise<{ port: number; close(): Promise<void> }> {
  const webRoot = options.webRoot ?? fileURLToPath(new URL('./web', import.meta.url));
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const registry = await Registry.open(options.stateDir);
  const worker = await ensureWorker(options.stateDir);
  const terminals = new Terminals(registry, worker);
  await terminals.reconcile();
  const repos = new Repos(registry), files = new Files(registry), previews = new Previews(registry);
  const watches = new Watches(registry, files);
  watches.on('changed', paths => broadcast(sockets, { type: 'files', paths }));
  watches.on('failure', error => broadcast(sockets, { type: 'error', message: errorPayload(error).message }));
  const dispatch = createMethods(registry, terminals, repos, files, previews);
  registry.on('changed', snapshot => broadcast(sockets, { type: 'snapshot', snapshot }));
  terminals.on('event', event => broadcast(sockets, { type: 'terminal', event }));
  terminals.on('failure', error => broadcast(sockets, { type: 'error', message: errorPayload(error).message }));
  worker.on('disconnected', () => broadcast(sockets, { type: 'error', message: 'Terminal worker disconnected. Reconnecting…' }));
  worker.on('reconnected', () => { void terminals.reconcile().then(() => { for (const socket of sockets.clients) socket.close(1012, 'Terminal transport restored'); }).catch(error => broadcast(sockets, { type: 'error', message: errorPayload(error).message })); });
  sockets.on('connection', socket => { socket.on('error', () => {}); socket.send(JSON.stringify({ type: 'snapshot', snapshot: registry.snapshot() })); });
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => { if (!res.headersSent) json(res, 400, { error: errorPayload(error) }); else res.end(); });
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health' && req.method === 'GET') { json(res, 200, { status: 'ok' }); return; }
    if (url.pathname.startsWith('/preview/') && req.method === 'GET') { await previews.serve(url.pathname, res, req.headers.range); return; }
    if (url.pathname === '/api') {
      if (req.method !== 'POST') { json(res, 405, { error: 'Use POST' }); return; }
      if (!validateControlRequest(req.headers)) { json(res, 403, { error: 'Origin refused' }); return; }
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') { json(res, 415, { error: 'Expected application/json' }); return; }
      const request = await readBody(req);
      if (!isRequest(request)) throw new BuilderError('invalid-request', 'Malformed request');
      try { json(res, 200, { id: request.id, ok: true, result: await dispatch(request.method, request.params) }); }
      catch (error) { json(res, 200, { id: request.id, ok: false, error: errorPayload(error) }); }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.split('/').some(part => part.startsWith('.'))) { res.writeHead(404).end(); return; }
    const file = resolve(webRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(resolve(webRoot) + sep)) { res.writeHead(404).end(); return; }
    try {
      const bytes = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404).end('Not found'); }
  }
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/events' || !validateControlRequest(req.headers)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  return {
    port: (server.address() as { port: number }).port,
    async close() {
      for (const ws of sockets.clients) ws.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      watches.close(); terminals.dispose(); await registry.flush(); worker.disconnect();
    },
  };
}

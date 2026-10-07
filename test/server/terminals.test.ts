import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startServer } from '../../src/server/http.js';
import { Registry } from '../../src/server/registry.js';
import { ensureWorker } from '../../src/server/worker-runtime.js';
import { Terminals } from '../../src/server/terminals.js';

test('two browser clients share one durable terminal and reconnect after the HTTP server restarts', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'builder-service-'));
  let app = await startServer({ port: 0, stateDir });
  const sockets: WebSocket[] = [];
  let base = `http://127.0.0.1:${app.port}`;
  const call = async (method: string, params: unknown = {}) => {
    const response = await fetch(`${base}/api`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'test', method, params }) });
    const reply = await response.json() as any;
    assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.result;
  };
  try {
    const initial = await call('snapshot'); assert.equal(initial.items.length, 0);
    for (let i = 0; i < 2; i++) {
      const socket = new WebSocket(`${base.replace('http:', 'ws:')}/events`, { origin: base });
      sockets.push(socket); await once(socket, 'open');
    }
    const params = { requestId: 'lost-reply', cwd: stateDir, command: '/bin/sh', args: ['-c', 'read value; printf "VALUE:%s" "$value"; read rest'], cols: 80, rows: 24 };
    const [a, b] = await Promise.all([call('terminals.create', params), call('terminals.create', params)]);
    assert.equal(a.id, b.id);
    assert.equal((await call('snapshot')).items.length, 1);
    const frame = new Promise<any>(resolve => sockets[1]!.on('message', bytes => { const event = JSON.parse(bytes.toString()); if (event.type === 'terminal' && event.event.type === 'data') resolve(event); }));
    sockets[0]!.close();
    await call('terminals.write', { id: a.id, bytes: Buffer.from('one\n').toString('base64') });
    assert.equal((await frame).event.id, a.id);
    const first = await call('terminals.read', { id: a.id, since: 0 });
    assert.ok(first.seq > 0);
    await app.close();
    app = await startServer({ port: 0, stateDir }); base = `http://127.0.0.1:${app.port}`;
    const next = await call('snapshot'); assert.equal(next.items.length, 1);
    assert.equal(next.items[0].sessionId, a.sessionId);
    assert.equal(next.items[0].exited, false);
    const replay = await call('terminals.read', { id: a.id, since: 0 });
    assert.match(Buffer.from(replay.data, 'base64').toString(), /VALUE:one/);
    await call('terminals.stopAll');
  } finally { for (const ws of sockets) ws.terminate(); await app.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('persisted sessions missing after a reboot are shown as ended without relaunching commands', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'builder-reboot-'));
  const registry = await Registry.open(stateDir);
  const worker = await ensureWorker(stateDir);
  const terminals = new Terminals(registry, worker);
  try {
    await registry.mutate(null, draft => { draft.items.push({ id: 'gone', type: 'term', repoId: null, cwd: stateDir, title: 'Old shell', createdAt: '', updatedAt: '', sessionId: 'before-reboot', requestId: 'old-launch', command: '/bin/sh', args: [], exited: false, exitCode: null }); });
    await terminals.reconcile();
    const row = registry.snapshot().items[0]!;
    assert.equal(row.type === 'term' && row.exited, true);
    assert.equal((await worker.list()).length, 0);
    await terminals.close('gone');
    assert.equal(registry.snapshot().items.length, 0);
  } finally { terminals.dispose(); worker.disconnect(); await rm(stateDir, { recursive: true, force: true }); }
});

test('reconciliation recovers a PTY created just before registry persistence crashed', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'builder-orphan-'));
  const registry = await Registry.open(stateDir);
  const worker = await ensureWorker(stateDir);
  const terminals = new Terminals(registry, worker);
  try {
    const session = await worker.spawn({ requestId: 'crashed-create', cwd: stateDir, command: '/bin/sh', args: [], cols: 80, rows: 24 });
    await terminals.reconcile();
    const row = registry.snapshot().items[0];
    assert.equal(row?.type === 'term' && row.sessionId, session.id);
    assert.equal((await terminals.create({ requestId: 'crashed-create', cwd: stateDir })).id, row?.id);
    assert.equal((await worker.list()).length, 1);
    await terminals.close(row!.id);
  } finally { await worker.stopAll(); terminals.dispose(); worker.disconnect(); await rm(stateDir, { recursive: true, force: true }); }
});

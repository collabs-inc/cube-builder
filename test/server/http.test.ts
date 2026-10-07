import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../../src/server/http.js';

test('the real server rejects control requests and socket upgrades from other origins', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'builder-http-'));
  const app = await startServer({ port: 0, stateDir });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const request = (origin?: string) => fetch(`${base}/api`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify({ id: 'r1', method: 'missing', params: {} }),
    });
    assert.equal((await request()).status, 403);
    assert.equal((await request('null')).status, 403);
    assert.equal((await request('https://evil.test')).status, 403);
    const allowed = await request(base);
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json() as any).error.code, 'unknown-method');
    assert.equal((await fetch(`${base}/api`)).status, 405);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http:', 'ws:')}/events`, { origin: 'null' });
      ws.on('open', () => { ws.close(); reject(new Error('opaque origin acquired a control socket')); });
      ws.on('unexpected-response', (_req, res) => { res.resume(); assert.equal(res.statusCode, 403); ws.terminate(); resolve(); });
      ws.on('error', () => {});
    });
  } finally { await app.close(); await rm(stateDir, { recursive: true, force: true }); }
});

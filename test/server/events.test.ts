import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { broadcast } from '../../src/server/events.js';

test('a stalled browser is disconnected rather than accumulating unbounded terminal output', async () => {
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const connected = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${(http.address() as any).port}`);
  await once(client, 'open');
  const [peer] = await connected;
  client.pause();
  try {
    const data = Buffer.alloc(256 * 1024, 120).toString('base64');
    for (let i = 0; i < 160 && peer.readyState === WebSocket.OPEN; i++) broadcast(server, { type: 'terminal', event: { type: 'data', id: 'terminal', data, seq: (i + 1) * 256 * 1024 } });
    assert.equal(peer.readyState, WebSocket.CLOSING);
    assert.ok(peer.bufferedAmount < 6 * 1024 * 1024);
  } finally { client.terminate(); peer.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve())); }
});

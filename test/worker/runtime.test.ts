import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureWorker, workerSocketPath } from '../../src/server/worker-runtime.js';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname } from 'node:path';

test('simultaneous startup uses one private worker and replacement installs reattach to its terminals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builder-worker-'));
  const state = join(root, 'state');
  const install = join(root, 'old-install');
  await mkdir(install);
  await cp(resolve('dist/worker.js'), join(install, 'worker.js'));
  const clients: Awaited<ReturnType<typeof ensureWorker>>[] = [];
  try {
    const [a, b] = await Promise.all([ensureWorker(state, { workerEntry: join(install, 'worker.js') }), ensureWorker(state, { workerEntry: join(install, 'worker.js') })]);
    clients.push(a, b);
    assert.equal(a.identity, b.identity);
    assert.equal((await stat(workerSocketPath(state))).mode & 0o777, 0o600);
    const args = { requestId: 'retry', cwd: root, command: '/bin/sh', args: ['-c', 'read answer; printf "KEPT:%s" "$answer"; read rest'], cols: 80, rows: 24 };
    const [one, two] = await Promise.all([a.spawn(args), b.spawn(args)]);
    assert.equal(one.id, two.id);
    a.disconnect(); b.disconnect();
    await rm(install, { recursive: true, force: true });
    const replacement = await ensureWorker(state);
    clients.push(replacement);
    assert.equal((await replacement.list())[0]!.pid, one.pid);
    await replacement.write(one.id, Buffer.from('alive\n').toString('base64'));
    let output = '';
    for (let i = 0; i < 100; i++) {
      output = Buffer.from((await replacement.read(one.id, { since: 0 })).data, 'base64').toString();
      if (output.includes('KEPT:alive')) break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.match(output, /KEPT:alive/);
    await replacement.stopAll();
  } finally {
    for (const client of clients) client.disconnect();
    // The idle worker removes its socket after its last client disconnects.
    for (let i = 0; i < 100; i++) {
      try { await stat(workerSocketPath(state)); } catch { break; }
      await new Promise(r => setTimeout(r, 30));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('an incompatible existing worker is refused without replacing its listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builder-incompatible-'));
  const path = workerSocketPath(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let connections = 0;
  const server = createServer(socket => {
    connections++;
    socket.on('data', data => { const request = JSON.parse(data.toString()); socket.end(JSON.stringify({ id: request.id, ok: false, error: { code: 'worker-incompatible', message: 'Old protocol' } }) + '\n'); });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    await assert.rejects(ensureWorker(root), /Old protocol/);
    assert.equal(connections, 1);
    assert.equal(server.listening, true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true }); await rm(dirname(path), { recursive: true, force: true });
  }
});

test('a socket left by a crashed owner is recovered without signaling another process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builder-stale-'));
  const path = workerSocketPath(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1],()=>console.log("ready"))', path], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout!, 'data');
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  let client: Awaited<ReturnType<typeof ensureWorker>> | undefined;
  try { client = await ensureWorker(root); assert.equal((await client.list()).length, 0); }
  finally {
    client?.disconnect();
    for (let i = 0; i < 100; i++) { try { await stat(path); } catch { break; } await new Promise(r => setTimeout(r, 30)); }
    await rm(root, { recursive: true, force: true });
  }
});

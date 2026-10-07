import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Registry } from '../../src/server/registry.js';
import { Files } from '../../src/server/files.js';
import { Repos } from '../../src/server/repos.js';
import { Previews } from '../../src/server/previews.js';
import { Watches } from '../../src/server/watches.js';

test('file mutations preserve existing bytes and reject stale destructive actions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builder-mutations-'));
  const registry = await Registry.open(join(root, 'state'));
  const files = new Files(registry);
  try {
    const folder = join(root, 'files'); await files.mkdir(folder);
    const uploaded = await files.upload({ directory: folder, name: 'upload.txt', data: Buffer.from('original').toString('base64') });
    await assert.rejects(files.upload({ directory: folder, name: 'upload.txt', data: 'eA==' }), /exist/);
    await assert.rejects(files.upload({ directory: folder, name: '../escape', data: 'eA==' }), /name/);
    await assert.rejects(files.upload({ directory: folder, name: 'huge', data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }), /8 MiB/);
    await writeFile(uploaded.path, 'external change');
    await assert.rejects(files.remove({ path: uploaded.path, revision: uploaded.revision }), /changed/);
    assert.equal(await readFile(uploaded.path, 'utf8'), 'external change');
    const info = await files.info(uploaded.path);
    const renamed = await files.rename({ path: uploaded.path, destination: join(folder, 'renamed.txt'), revision: info.revision });
    assert.equal((await files.list(folder)).entries[0]!.name, 'renamed.txt');
    const first = await files.read(renamed.path);
    const results = await Promise.allSettled(['one', 'two'].map(content => files.write({ path: renamed.path, revision: first.revision, content })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const current = await files.info(renamed.path); await files.remove({ path: renamed.path, revision: current.revision });
    await assert.rejects(stat(renamed.path), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed clones clean only their newly created destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builder-clone-'));
  const repos = new Repos(await Registry.open(join(root, 'state')));
  try {
    const path = join(root, 'clone');
    await assert.rejects(repos.clone(join(root, 'not-a-remote'), path));
    await assert.rejects(stat(path), /ENOENT/);
    await writeFile(path, 'keep existing destination');
    await assert.rejects(repos.clone(join(root, 'not-a-remote'), path));
    assert.equal(await readFile(path, 'utf8'), 'keep existing destination');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('external filesystem changes are observed and root HTML artifacts are discovered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builder-watch-'));
  const registry = await Registry.open(join(root, 'state')); const files = new Files(registry);
  const repos = new Repos(registry); const watches = new Watches(registry, files);
  try {
    await repos.add(root);
    const changed = once(watches, 'changed');
    const path = join(root, 'chart.html'); await writeFile(path, '<h1>Chart</h1>');
    const [paths] = await changed; assert.ok(paths.includes(path));
    for (let i = 0; i < 100 && !registry.snapshot().items.some(i => i.type === 'artifact'); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(registry.snapshot().items.filter(i => i.type === 'artifact').length, 1);
  } finally { watches.close(); await registry.flush(); await rm(root, { recursive: true, force: true }); }
});

test('expired capabilities and sibling resources of non-HTML previews are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builder-preview-'));
  const registry = await Registry.open(join(root, 'state')); const files = new Files(registry);
  const expired = new Previews(registry, 0); const normal = new Previews(registry);
  let mode = expired;
  const server = createServer((req, res) => { void mode.serve(req.url!, res).catch(() => res.writeHead(500).end()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    await writeFile(join(root, 'image.png'), 'image fixture'); await writeFile(join(root, 'other.txt'), 'private');
    const item = await files.open(join(root, 'image.png'));
    const old = await expired.create(item.id); assert.equal((await fetch(base + old.url)).status, 404);
    mode = normal; const current = await normal.create(item.id);
    assert.equal((await fetch(base + current.url)).status, 200);
    assert.equal((await fetch(base + current.url.replace('image.png', 'other.txt'))).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

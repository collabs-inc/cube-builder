import { test } from 'node:test';
import { watch } from 'node:fs';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'builder-mutations-')));
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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'builder-clone-')));
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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'builder-watch-')));
  const registry = await Registry.open(join(root, 'state')); const files = new Files(registry);
  const repos = new Repos(registry); const watches = new Watches(registry, files);
  const events: unknown[] = [];
  const diagnostic = watch(root, { recursive: true }, (event, name) => events.push({ event, name }));
  try {
    await repos.add(root);
    const changed = once(watches, 'changed', { signal: AbortSignal.timeout(5000) });
    const path = join(root, 'chart.html'); await writeFile(path, '<h1>Chart</h1>');
    const [paths] = await changed.catch(error => { console.error('Watch diagnostics', { events, snapshot: registry.snapshot() }); throw error; }); assert.ok(paths.includes(path));
    for (let i = 0; i < 100 && !registry.snapshot().items.some(i => i.type === 'artifact'); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(registry.snapshot().items.filter(i => i.type === 'artifact').length, 1);
  } finally { diagnostic.close(); watches.close(); await registry.flush(); await rm(root, { recursive: true, force: true }); }
});

test('expired capabilities and sibling resources of non-HTML previews are refused', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'builder-preview-')));
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

test('an external edit immediately after an atomic save remains observable', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'builder-atomic-watch-')));
  const registry = await Registry.open(join(root, 'state')), files = new Files(registry), repos = new Repos(registry);
  const path = join(root, 'note.md'); await writeFile(path, 'initial'); await repos.add(root); await files.open(path);
  const watches = new Watches(registry, files);
  try {
    const read = await files.read(path); await files.write({ path, revision: read.revision, content: 'saved' });
    await new Promise(r => setTimeout(r, 250));
    const changed = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('External edit was not reported')), 2500); watches.on('changed', paths => { if (paths.includes(path)) { clearTimeout(timer); resolve(); } }); });
    await writeFile(path, 'external'); await changed;
  } finally { watches.close(); await registry.flush(); await rm(root, { recursive: true, force: true }); }
});

test('previews for tree images do not register catalog rows', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'builder-thumb-')));
  try {
    const registry = await Registry.open(join(root, 'state'));
    await writeFile(join(root, 'image.png'), 'image');
    const previews = new Previews(registry);
    const result = await previews.forPath(join(root, 'image.png'));
    assert.match(result.url, /^\/preview\//);
    assert.equal(registry.snapshot().items.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('trash retains files and directory contents under the installation state', async () => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'builder-trash-')));
  try {
    const registry=await Registry.open(join(root,'state')),files=new Files(registry);
    const folder=join(root,'folder');await files.mkdir(folder);
    await writeFile(join(folder,'keep.txt'),'recoverable');
    await files.open(join(folder,'keep.txt'));
    const before=await files.info(folder);
    const result=await files.trash({path:folder,revision:before.revision});
    await assert.rejects(stat(folder),/ENOENT/);
    assert.equal(await readFile(join(result.path,'keep.txt'),'utf8'),'recoverable');
    assert.equal(registry.snapshot().items.length,0);
    const repo=await new Repos(registry).add(root);
    await assert.rejects(files.trash({path:root,revision:(await files.info(root)).revision}),/repository/i);
    assert.equal(registry.snapshot().repos[0]?.id,repo.id);
  } finally {await rm(root,{recursive:true,force:true})}
});

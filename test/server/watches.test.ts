import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/server/registry.js';
import { Files } from '../../src/server/files.js';
import { Repos } from '../../src/server/repos.js';
import { Watches } from '../../src/server/watches.js';

async function watchCount() {
  let count = 0;
  for (const fd of await readdir('/proc/self/fdinfo')) {
    try { count += ((await readFile(`/proc/self/fdinfo/${fd}`, 'utf8')).match(/^inotify wd:/gm) ?? []).length; } catch {}
  }
  return count;
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'condition timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('excluded trees consume no recursive watches; source edits and new directories stay live', { skip: process.platform !== 'linux' }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'builder-watch-budget-'));
  const root = join(temp, 'repo');
  const registry = await Registry.open(join(temp, 'state'));
  const files = new Files(registry);
  for (const excluded of ['node_modules', '.git', 'dist', '.venv', '.cache']) {
    for (let i = 0; i < 20; i++) await mkdir(join(root, excluded, `dir-${i}`), { recursive: true });
  }
  await mkdir(join(root, 'src'), { recursive: true });
  await symlink(join(root, 'node_modules'), join(root, 'linked-deps'));
  await new Repos(registry).add(root);
  const before = await watchCount();
  const watches = new Watches(registry, files);
  const changed = new Set<string>();
  watches.on('changed', (paths: string[]) => paths.forEach(path => changed.add(path)));
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(await watchCount() - before < 20, 'ignored directories must be pruned before allocating watches');
    const source = join(root, 'src', 'code.ts');
    await writeFile(source, 'first'); await until(() => changed.has(source));
    changed.clear(); await writeFile(source, 'second'); await until(() => changed.has(source));
    await mkdir(join(root, 'new'));
    const nested = join(root, 'new', 'code.ts');
    await writeFile(nested, 'new'); await until(() => changed.has(nested));
    const artifact = join(root, 'report.html');
    await writeFile(artifact, '<h1>Report</h1>');
    await until(() => registry.snapshot().items.some(item => item.type === 'artifact'));
    await registry.mutate(null, draft => { draft.repos = []; draft.items = []; });
    await until(async () => await watchCount() <= before);
  } finally { await watches.close(); await registry.flush(); await rm(temp, { recursive: true, force: true }); }
});

test('opening a standalone file does not recursively watch its siblings', { skip: process.platform !== 'linux' }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'builder-file-watch-budget-'));
  const registry = await Registry.open(join(temp, 'state')); const files = new Files(registry);
  for (let i = 0; i < 30; i++) await mkdir(join(temp, 'unrelated', `dir-${i}`), { recursive: true });
  for (let i = 0; i < 30; i++) await writeFile(join(temp, `sibling-${i}.txt`), 'unrelated');
  const file = join(temp, 'note.txt'); await writeFile(file, 'first'); await files.open(file);
  const before = await watchCount(); const watches = new Watches(registry, files);
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(await watchCount() - before < 10, 'standalone file parent watch must be shallow');
  } finally { await watches.close(); await registry.flush(); await rm(temp, { recursive: true, force: true }); }
});

test('watch setup prunes excluded directories before requesting native subscriptions', async t => {
  const fs = (await import('node:fs')).default;
  const { EventEmitter } = await import('node:events');
  const allocated: string[] = []; const recursive: string[] = [];
  let active = 0;
  t.mock.method(fs, 'watch', (path: string, options: { recursive?: boolean }) => {
    allocated.push(String(path)); if (options?.recursive) recursive.push(String(path));
    active++;
    const watcher = new EventEmitter() as import('node:fs').FSWatcher;
    let closed = false;
    watcher.close = () => { if (!closed) { closed = true; active--; } };
    watcher.ref = watcher.unref = () => watcher;
    return watcher;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const temp = await mkdtemp(join(tmpdir(), 'builder-watch-traversal-'));
  const root = join(temp, 'repo');
  await mkdir(join(root, 'node_modules', 'nested'), { recursive: true });
  await mkdir(join(root, '.git', 'objects'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'code.ts'), 'source');
  const registry = await Registry.open(join(temp, 'state')); const files = new Files(registry);
  await new Repos(registry).add(root);
  const watches = new Watches(registry, files);
  try {
    await until(() => allocated.includes(root));
    assert.deepEqual(recursive, [], 'native recursive watches cannot prune excluded trees');
    await until(() => allocated.includes(join(root, 'src')));
    assert.equal(allocated.some(path => /node_modules|\.git/.test(path)), false);
  } finally { await watches.close(); await registry.flush(); await rm(temp, { recursive: true, force: true }); }
  assert.equal(active, 0, 'shutdown must release every subscription');
});

test('watch exhaustion explains the resource and recovery action without relabeling disk errors elsewhere', async () => {
  const { watchFailure } = await import('../../src/server/watches.js');
  const cause = Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
  const diagnostic = watchFailure(cause, '/repo');
  assert.match(diagnostic.message, /inotify/); assert.match(diagnostic.message, /not disk space/);
  assert.match(diagnostic.message, /fs.inotify.max_user_watches/); assert.equal(diagnostic.cause, cause);
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  assert.equal(watchFailure(denied, '/repo'), denied);
});

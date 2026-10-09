import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/server/registry.js';

test('registry serializes changes, rejects stale revisions, and hydrates committed data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builder-registry-'));
  try {
    const registry = await Registry.open(root);
    await Promise.all(Array.from({ length: 12 }, (_, i) => registry.mutate(null, draft => { draft.repos.push({ id: String(i), root: `/tmp/repo-${i}`, name: `Repo ${i}`, worktrees: [] }); })));
    assert.equal(registry.snapshot().repos.length, 12);
    assert.equal(registry.snapshot().revision, 12);
    await assert.rejects(registry.mutate(0, () => {}), /changed/);
    const reloaded = await Registry.open(root);
    assert.deepEqual(reloaded.snapshot(), registry.snapshot());
    const snapshot = reloaded.snapshot(); snapshot.repos.length = 0;
    assert.equal(reloaded.snapshot().repos.length, 12);
    await assert.rejects(registry.mutate(null, () => { throw new Error('failed mutation'); }));
    assert.equal(registry.snapshot().revision, 12);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('corrupt state is preserved for recovery rather than silently overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builder-corrupt-'));
  try {
    await writeFile(join(root, 'registry.json'), '{broken');
    const registry = await Registry.open(root);
    assert.equal(registry.snapshot().repos.length, 0);
    assert.equal((await readdir(root)).filter(name => name.startsWith('registry.corrupt-')).length, 1);
    assert.match(registry.warning ?? '', /recovery/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('catalog identity survives an empty restart and changes after state is reset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builder-identity-'));
  try {
    const first = await Registry.open(root);
    const epoch = first.snapshot().epoch;
    assert.equal(typeof epoch, 'string');
    assert.ok(epoch.length > 0);
    assert.equal((await Registry.open(root)).snapshot().epoch, epoch);
    await first.mutate(null, draft => { draft.repos.push({ id: 'repo', root: '/tmp/repo', name: 'Repo', worktrees: [] }); });
    assert.equal((await Registry.open(root)).snapshot().epoch, epoch);
    await rm(join(root, 'registry.json'));
    const reset = await Registry.open(root);
    assert.notEqual(reset.snapshot().epoch, epoch);
    assert.equal(reset.snapshot().revision, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an existing registry gains a durable identity without losing rows or revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builder-migration-'));
  try {
    const repos = [{ id: 'repo', root: '/tmp/repo', name: 'Repo', worktrees: [] }];
    await writeFile(join(root, 'registry.json'), JSON.stringify({ version: 1, revision: 8, repos, items: [] }));
    const registry = await Registry.open(root);
    assert.equal(typeof registry.snapshot().epoch, 'string');
    assert.equal(registry.snapshot().revision, 8);
    assert.deepEqual(registry.snapshot().repos, repos);
    assert.deepEqual((await Registry.open(root)).snapshot(), registry.snapshot());
  } finally { await rm(root, { recursive: true, force: true }); }
});

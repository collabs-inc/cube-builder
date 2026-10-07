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

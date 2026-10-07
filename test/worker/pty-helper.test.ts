import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { repairPtyHelpers } from '../../src/shared/pty-helper.mjs';
test('packaged spawn helpers become executable without changing unrelated files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builder-pty-mode-'));
  try {
    await mkdir(join(root, 'prebuilds/darwin-arm64'), { recursive: true });
    const helper = join(root, 'prebuilds/darwin-arm64/spawn-helper'), other = join(root, 'package.json');
    await writeFile(helper, 'helper', { mode: 0o644 }); await writeFile(other, '{}', { mode: 0o644 });
    await repairPtyHelpers(root); await repairPtyHelpers(root);
    assert.equal((await stat(helper)).mode & 0o777, 0o755);
    assert.equal((await stat(other)).mode & 0o777, 0o644);
  } finally { await rm(root, { recursive: true, force: true }); }
});

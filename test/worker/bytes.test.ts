import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase64 } from '../../src/shared/bytes.js';
test('large valid payloads decode without a regular expression stack overflow', () => {
  const source = Buffer.alloc(8 * 1024 * 1024, 117);
  assert.deepEqual(decodeBase64(source.toString('base64'), source.length, 'Upload'), source);
  for (const invalid of ['x', 'abc!', 'eA===', 'eA==\n']) assert.throws(() => decodeBase64(invalid, 1024, 'Input'));
  assert.throws(() => decodeBase64('eHg=', 1, 'Input'), /exceeds/);
});

import { expect, test } from 'vitest';
import { FileDraft } from '../../src/web/items/file-draft';
test('external write during debounce retains original revision and blocks blur save', () => {
  const draft = new FileDraft();
  expect(draft.read('original', 'r1')).toBe(true);
  draft.edit('my typing');
  expect(draft.read('agent change', 'r2')).toBe(false);
  expect(draft.revision).toBe('r1');
  expect(draft.conflict).toBe(true);
  expect(draft.value).toBe('my typing');
  expect(draft.canSave).toBe(false);
});
test('completed save does not discard newer typing', () => {
  const draft = new FileDraft(); draft.read('original', 'r1');
  draft.edit('first'); draft.edit('second'); draft.saved('first', 'r2');
  expect(draft.value).toBe('second'); expect(draft.revision).toBe('r2');
});
test('queued saves advance revisions and ignore own watcher notifications while pending', async () => {
  const draft = new FileDraft(); draft.read('original', 'r1'); draft.edit('first');
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const revisions: (string | null)[] = [];
  const first = draft.save('first', async revision => { revisions.push(revision); await delayed; return 'r2'; });
  await Promise.resolve();
  draft.edit('second');
  expect(draft.read('first', 'r2')).toBe(false);
  const second = draft.save('second', async revision => { revisions.push(revision); return 'r3'; });
  release(); await first; await second;
  expect(revisions).toEqual(['r1', 'r2']); expect(draft.conflict).toBe(false);
  expect(draft.value).toBe(null); expect(draft.revision).toBe('r3');
});

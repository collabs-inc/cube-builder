import { test, expect } from 'vitest';
import { createWorkspace } from '../../src/web/state/workspace.js';
test('moving and hiding panes retain their mounted identities and keep client layouts independent', () => {
  const one = createWorkspace('one', localStorage), two = createWorkspace('two', localStorage);
  one.open('terminal-a'); one.open('editor-b');
  const screen = one.get().screens[0]!;
  one.move('terminal-a', { kind: 'seam', columnId: screen.columns[1]!.id, seamIndex: 1 });
  expect(one.get().mounted).toEqual(['terminal-a', 'editor-b']);
  one.hide('terminal-a');
  expect(one.get().mounted).toContain('terminal-a');
  expect(one.get().screens[0]!.columns.flatMap(c => c.panes).map(p => p.itemId)).not.toContain('terminal-a');
  expect(two.get().mounted).toEqual([]);
  expect(createWorkspace('one', localStorage).get().mounted).toContain('terminal-a');
});
test('screens retain independent placements and opening an item travels to its existing screen', () => {
  const store = createWorkspace('screens', localStorage);
  store.open('a'); const first = store.get().activeScreenId;
  store.newScreen(); store.open('b');
  expect(store.get().activeScreenId).not.toEqual(first);
  store.open('a'); expect(store.get().activeScreenId).toEqual(first);
  store.reconcile(['a']); expect(store.get().mounted).toEqual(['a']);
});
test('screen changes and hiding the active pane keep narrow-view focus on a visible pane', () => {
  const store = createWorkspace('phone-focus', localStorage);
  store.open('a'); store.open('b'); store.zoom('b'); store.hide('b');
  expect(store.get().activeItemId).toBe('a'); expect(store.get().zoom).toBeNull();
  const first = store.get().activeScreenId; store.newScreen();
  expect(store.get().activeItemId).toBeNull(); store.open('c'); store.selectScreen(first);
  expect(store.get().activeItemId).toBe('a');
});

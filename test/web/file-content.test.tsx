import React, { useState } from 'react';
import { test, expect, vi } from 'vitest';
import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/react';
import { Content } from '../../src/web/items/Content';
const fixture = vi.hoisted(() => ({ disk: 'original', revision: 'r1', changed: undefined as undefined | ((event: any) => void), writes: [] as string[] }));
vi.mock('../../src/web/services/http', () => ({ services: {
  subscribe: (callback: any) => { fixture.changed = callback; return () => {}; },
  call: async (method: string, params: any) => {
    if (method === 'files.read') return { content: fixture.disk, revision: fixture.revision };
    if (method === 'files.write') { fixture.writes.push(params.content); if (params.revision !== fixture.revision) throw Object.assign(new Error('changed'), { code: 'file-changed' }); fixture.disk = params.content; fixture.revision = 'r3'; return { revision: 'r3' }; }
  },
} }));
function FakeEditor({ content, onDraftChange, onContentChange }: any) {
  const [value, setValue] = useState(content);
  return <textarea aria-label="editor" value={value} onChange={event => { setValue(event.target.value); onDraftChange(event.target.value); }} onBlur={() => onContentChange(value)} />;
}
vi.mock('../../src/components/CodeEditorView', () => ({ CodeEditorView: (props: any) => <FakeEditor {...props} /> }));
vi.mock('../../src/components/Editor', () => ({ Editor: (props: any) => <FakeEditor content={props.currentItem.text} onDraftChange={props.onDraftChange} onContentChange={props.onTextChange} /> }));
test('dirty file retains its base through watcher, blur, and switching views', async () => {
  fixture.disk = 'original'; fixture.revision = 'r1'; fixture.writes = [];
  render(<Content item={{ id: 'file', type: 'file', filePath: '/tmp/note.md', cwd: '/tmp', title: 'note.md', repoId: null, createdAt: '', updatedAt: '' }} visible focused theme="light" report={() => {}} openPath={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Source' }));
  const editor = await screen.findByRole('textbox', { name: 'editor' });
  fireEvent.change(editor, { target: { value: 'retained draft' } });
  fixture.disk = 'external'; fixture.revision = 'r2'; fixture.changed!({ type: 'files', paths: ['/tmp/note.md'] });
  await screen.findByRole('button', { name: 'Download draft' });
  fireEvent.blur(editor);
  expect(fixture.disk).toBe('external'); expect(fixture.writes).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('retained draft'));
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('retained draft'));
  cleanup();
});

test.each(['---\ntitle: Example\n...\nBody', '---\ntitle: [broken\n---\nBody'])('rich save preserves frontmatter once: %s', async initial => {
  fixture.disk = initial; fixture.revision = 'r1'; fixture.writes = [];
  const view = render(<Content item={{ id: 'roundtrip', type: 'file', filePath: '/tmp/roundtrip.md', cwd: '/tmp', title: 'roundtrip.md', repoId: null, createdAt: '', updatedAt: '' }} visible focused theme="light" report={() => {}} openPath={() => {}} />);
  try {
    const editor = await screen.findByRole('textbox', { name: 'editor' });
    fireEvent.change(editor, { target: { value: (editor as HTMLTextAreaElement).value + '\nEdited' } });
    fireEvent.blur(editor);
    await waitFor(() => expect(fixture.disk).toBe(initial + '\nEdited'));
  } finally { view.unmount(); }
});

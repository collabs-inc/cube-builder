import React from 'react';
import { test, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
const mock = vi.hoisted(() => ({ value: '', change: () => {}, disposed: false }));
vi.mock('monaco-editor', () => {
  const noop = () => {};
  const defaults = { getExtraLibs: () => ({}), addExtraLib: noop, setCompilerOptions: noop, setDiagnosticsOptions: noop, setEagerModelSync: noop };
  return { Uri: { file: (value: string) => value }, languages: { typescript: { javascriptDefaults: defaults, typescriptDefaults: defaults, JsxEmit: { ReactJSX: 1 }, ModuleKind: { ESNext: 1 }, ScriptTarget: { ESNext: 1 } } }, editor: {
    defineTheme: noop, setTheme: noop, getModel: () => null,
    createModel: (value: string) => { mock.value = value; return { dispose: noop, setValue: (value: string) => { mock.value = value; } }; },
    create: () => { mock.disposed = false; return { getValue: () => { if (mock.disposed) throw new Error('read disposed editor'); return mock.value; }, onDidChangeModelContent: (callback: () => void) => { mock.change = callback; return { dispose: noop }; }, onDidBlurEditorText: () => ({ dispose: noop }), updateOptions: noop, setModel: noop, dispose: () => { mock.disposed = true; } }; },
  } };
});
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/esm/vs/language/json/json.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/esm/vs/language/css/css.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/esm/vs/language/html/html.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker?worker', () => ({ default: class {} }));
import { CodeEditorView } from '../../src/components/CodeEditorView/CodeEditorView';
test('completion of save A cannot clean edit B or orphan its debounce on unmount', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const save = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined);
  const view = render(<CodeEditorView filePath="/note.md" content="initial" onContentChange={save} theme="light" />);
  try {
    act(() => { mock.value = 'A'; mock.change(); });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    act(() => { mock.value = 'B'; mock.change(); });
    await act(async () => { release(); await first; });
    view.unmount();
    expect(save.mock.calls.map(call => call[0])).toEqual(['A', 'B']);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(save).toHaveBeenCalledTimes(2);
  } finally { view.unmount(); vi.useRealTimers(); }
});

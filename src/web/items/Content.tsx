import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BuilderItem, FileItem } from '../../shared/model';
import { services } from '../services/http';
import { createTerminalHost } from '../services/terminal-host';
import { parseFileToViewerItem } from '../../shared/viewer-item';
import { beginLoad, finishLoad, initialFrameState } from './artifact-item-logic';
const Terminal = lazy(() => import('../../components/Terminal/TerminalTab'));
const CodeEditor = lazy(() => import('../../components/CodeEditorView').then(m => ({ default: m.CodeEditorView })));
const Editor = lazy(() => import('../../components/Editor').then(m => ({ default: m.Editor })));
export function Content({ item, visible, focused, theme, report, openPath }: { item: BuilderItem; visible: boolean; focused: boolean; theme: 'light' | 'dark'; report: (error: unknown) => void; openPath: (path: string) => void }) {
  const host = useMemo(() => createTerminalHost(services, item.cwd, report), [item.cwd, report]);
  return <Suspense fallback={<div className="pane-message">Loading…</div>}>
    {item.type === 'term' ? <Terminal host={host} sessionId={item.id} visible={visible} focused={focused} theme={theme} remote readOnly={item.exited} onOpenPath={openPath} allowAbsolutePaths onTransferStatus={status => { if (status?.kind === 'errors') report(status.messages.join('\n')); }} /> : <FileContent item={item} theme={theme} report={report} />}
  </Suspense>;
}
function FileContent({ item, theme, report }: { item: FileItem; theme: 'light' | 'dark'; report: (error: unknown) => void }) {
  const [mode, setMode] = useState<'preview' | 'source'>(/\.(md|markdown)$/i.test(item.filePath) || item.type !== 'file' ? 'preview' : 'source');
  const [content, setContent] = useState<string | null>(null), [error, setError] = useState('');
  const [conflict, setConflict] = useState(false), [reload, setReload] = useState(0);
  const revision = useRef<string | null>(null), draft = useRef<string | null>(null), saving = useRef(false);
  const markdown = /\.(md|markdown)$/i.test(item.filePath);
  const text = item.type === 'file' || item.type === 'artifact';
  const read = useCallback(async () => {
    try { const file = await services.call('files.read', { path: item.filePath });
      if (draft.current !== null || saving.current) { if (revision.current !== file.revision) setConflict(true); return; }
      revision.current = file.revision; setContent(file.content); setError('');
    } catch (error) { setError(String(error)); }
  }, [item.filePath]);
  useEffect(() => { if (!text) return; void read(); return services.subscribe(event => { if (event.type === 'files' && event.paths.some(p => p === item.filePath || item.filePath.startsWith(p + '/'))) void read(); }); }, [read, text, reload]);
  const save = useCallback(async (value: string) => {
    draft.current = value; saving.current = true;
    try { const result = await services.call('files.write', { path: item.filePath, content: value, revision: revision.current });
      revision.current = result.revision; if (draft.current === value) draft.current = null; setConflict(false); return { ok: true, mtime: result.revision };
    } catch (error) { if ((error as { code?: string }).code === 'conflict') setConflict(true); else report(error); return { ok: false, conflict: true, mtime: revision.current ?? '' }; }
    finally { saving.current = false; }
  }, [item.filePath, report]);
  const viewer = useMemo(() => parseFileToViewerItem(item.filePath, content ?? ''), [item.filePath, content]);
  const saveMarkdown = useCallback((body: string) => {
    // Preserve arbitrary YAML byte-for-byte; the rich editor edits the body.
    const front = content?.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? '';
    return save(front + body);
  }, [content, save]);
  return <div className="file-content">
    {text && <div className="file-toolbar">{(markdown || item.type === 'artifact') && <><button aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>Preview</button><button aria-pressed={mode === 'source'} onClick={() => setMode('source')}>Source</button></>}
      {conflict && <span role="alert">File changed on disk. Your draft is kept. <button onClick={() => { draft.current = null; setConflict(false); setReload(v => v + 1); }}>Reload disk version</button><button onClick={() => { if (draft.current !== null) { const blob = new Blob([draft.current], { type: 'text/plain' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = item.title + '.draft'; a.click(); URL.revokeObjectURL(url); } }}>Download draft</button></span>}
    </div>}
    {error && <div role="alert" className="pane-message">{error}<button onClick={() => setReload(v => v + 1)}>Retry</button></div>}
    {mode === 'source' && text && content !== null && <CodeEditor filePath={item.filePath} content={content} onContentChange={save} theme={theme} />}
    {mode === 'preview' && markdown && content !== null && <Editor currentItem={viewer} onTextChange={saveMarkdown} theme={theme} />}
    {mode === 'preview' && !markdown && <Preview item={item} theme={theme} />}
  </div>;
}
function Preview({ item, theme }: { item: FileItem; theme: string }) {
  const [frames, setFrames] = useState(initialFrameState), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => services.subscribe(event => { if (event.type === 'files' && event.paths.some(p => p === item.filePath || p.startsWith(item.cwd + '/'))) setRevision(v => v + 1); }), [item]);
  useEffect(() => {
    let canceled = false;
    void services.call('previews.create', { itemId: item.id }).then(({ url }) => { if (!canceled) { setFrames(state => beginLoad(state, `${url}?theme=${theme}&v=${revision}`)); setError(''); } }, error => { if (!canceled) setError(String(error)); });
    const timer = setTimeout(() => setRevision(v => v + 1), 12 * 60 * 1000);
    return () => { canceled = true; clearTimeout(timer); };
  }, [item.id, theme, revision]);
  return <div className="preview-content">{error && <div role="alert">{error}<button onClick={() => setRevision(v => v + 1)}>Retry</button></div>}{(['a', 'b'] as const).map(side => frames[side] && (item.type === 'image' ? <img key={side} src={frames[side]!} alt={item.title} onLoad={() => setFrames(state => finishLoad(state, side))} style={{ visibility: frames.front === side ? 'visible' : 'hidden' }} /> : <iframe key={side} title={item.title + ' preview ' + side} src={frames[side]!} sandbox="allow-scripts allow-forms allow-downloads allow-modals allow-popups" onLoad={() => setFrames(state => finishLoad(state, side))} style={{ visibility: frames.front === side ? 'visible' : 'hidden' }} />))}</div>;
}

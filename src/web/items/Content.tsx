import { FileDraft } from './file-draft';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BuilderItem, FileItem } from '../../shared/model';
import { services } from '../services/http';
import { createTerminalHost } from '../services/terminal-host';
import { parseFileToViewerItem } from '../../shared/viewer-item';
import { beginLoad, finishLoad, initialFrameState } from './artifact-item-logic';
const PdfView = lazy(() => import('../../components/PdfView/PdfView'));
const Terminal = lazy(() => import('../../components/Terminal/TerminalTab'));
const CodeEditor = lazy(() => import('../../components/CodeEditorView').then(m => ({ default: m.CodeEditorView })));
const Editor = lazy(() => import('../../components/Editor').then(m => ({ default: m.Editor })));
export function Content({ item, visible, focused, theme, fontSize, report, openPath }: { item: BuilderItem; visible: boolean; focused: boolean; theme: 'light' | 'dark'; fontSize?: number; report: (error: unknown) => void; openPath: (path: string) => void }) {
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const host = useMemo(() => createTerminalHost(services, item.cwd, report), [item.cwd, report]);
  return <>{openUrl && <div className="terminal-link"><a href={openUrl} target="_blank" rel="noopener noreferrer">Open link requested by terminal</a><button onClick={() => setOpenUrl(null)}>Dismiss</button></div>}<Suspense fallback={<div className="pane-message">Loading…</div>}>
    {item.type === 'term' ? <Terminal host={host} sessionId={item.id} visible={visible} focused={focused} theme={theme} fontSize={fontSize} onOpenUrlRequest={setOpenUrl} remote readOnly={item.exited} onOpenPath={path => openPath(path.startsWith('/') ? path : item.cwd + '/' + path)} allowAbsolutePaths onTransferStatus={status => { if (status?.kind === 'errors') report(status.messages.join('\n')); }} /> : <FileContent item={item} theme={theme} report={report} />}
  </Suspense></>;
}
function FileContent({ item, theme, report }: { item: FileItem; theme: 'light' | 'dark'; report: (error: unknown) => void }) {
  const [mode, setMode] = useState<'preview' | 'source'>(/\.(md|markdown)$/i.test(item.filePath) || item.type !== 'file' ? 'preview' : 'source');
  const [content, setContent] = useState<string | null>(null), [error, setError] = useState('');
  const [conflict, setConflict] = useState(false), [reload, setReload] = useState(0);
  const documentState = useRef(new FileDraft());
  const generation = useRef(0);
  const currentGeneration = generation.current;
  const markdown = /\.(md|markdown)$/i.test(item.filePath);
  const text = item.type === 'file' || item.type === 'artifact';
  const read = useCallback(async () => {
    try { const file = await services.call('files.read', { path: item.filePath });
      if (!documentState.current.read(file.content, file.revision)) { setConflict(documentState.current.conflict); return; } setContent(file.content); setError('');
    } catch (error) { setError(String(error)); }
  }, [item.filePath]);
  useEffect(() => { if (!text) return; void read(); return services.subscribe(event => { if (event.type === 'files' && event.paths.some(p => p === item.filePath || item.filePath.startsWith(p + '/'))) void read(); }); }, [read, text, reload]);
  const save = useCallback(async (value: string) => {
    if (currentGeneration !== generation.current) return { ok: false, conflict: true, mtime: '' };
    const state = documentState.current; state.edit(value);
    if (!state.canSave) return { ok: false, conflict: true, mtime: state.revision ?? '' };
    try { const ok = await state.save(value, async revision => { const result = await services.call('files.write', { path: item.filePath, content: value, revision }); return result.revision; });
      if (currentGeneration === generation.current && ok) { setContent(value); void read(); }
      setConflict(state.conflict); return { ok, conflict: !ok, mtime: state.revision ?? '' };
    } catch (error) { if ((error as { code?: string }).code === 'file-changed') { state.conflict = true; setConflict(true); } else report(error); return { ok: false, conflict: true, mtime: state.revision ?? '' }; }
  }, [item.filePath, report, currentGeneration, read]);
  const displayedContent = documentState.current.value ?? content;
  const sourceRef = useRef(displayedContent); sourceRef.current = displayedContent;
  const viewer = useMemo(() => parseFileToViewerItem(item.filePath, displayedContent ?? ''), [item.filePath, displayedContent]);
  const saveMarkdown = useCallback((body: string) => {
    // Preserve arbitrary YAML byte-for-byte; the rich editor edits the body.
    const front = sourceRef.current?.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? '';
    return save(front + body);
  }, [save]);
  return <div className="file-content">
    {text && <div className="file-toolbar">{(markdown || item.type === 'artifact') && <><button aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>Preview</button><button aria-pressed={mode === 'source'} onClick={() => setMode('source')}>Source</button></>}
      {conflict && <span role="alert">File changed on disk. Your draft is kept. <button onClick={() => { generation.current++; documentState.current = new FileDraft(); setContent(null); setConflict(false); setReload(v => v + 1); }}>Reload disk version</button><button onClick={() => { if (documentState.current.value !== null) { const blob = new Blob([documentState.current.value], { type: 'text/plain' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = item.title + '.draft'; a.click(); URL.revokeObjectURL(url); } }}>Download draft</button></span>}
    </div>}
    {error && <div role="alert" className="pane-message">{error}<button onClick={() => setReload(v => v + 1)}>Retry</button></div>}
    {mode === 'source' && text && content !== null && <CodeEditor key={reload} onDraftChange={value => documentState.current.edit(value)} filePath={item.filePath} content={displayedContent ?? ''} onContentChange={save} theme={theme} />}
    {mode === 'preview' && markdown && content !== null && <Editor key={reload} onDraftChange={body => { const front = sourceRef.current?.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? ''; documentState.current.edit(front + body); }} currentItem={viewer} onTextChange={saveMarkdown} theme={theme} />}
    {item.type === 'pdf' && <PdfView itemId={item.id} />}
    {mode === 'preview' && !markdown && item.type !== 'pdf' && <Preview item={item} theme={theme} />}
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

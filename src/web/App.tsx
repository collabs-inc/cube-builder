import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Terminal } from "@phosphor-icons/react/dist/csr/Terminal";
import { FolderOpen } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { Sun } from "@phosphor-icons/react/dist/csr/Sun";
import { Moon } from "@phosphor-icons/react/dist/csr/Moon";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { ArrowsOut } from "@phosphor-icons/react/dist/csr/ArrowsOut";
import { Minus } from "@phosphor-icons/react/dist/csr/Minus";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { Sparkle } from "@phosphor-icons/react/dist/csr/Sparkle";
import { GitBranch } from "@phosphor-icons/react/dist/csr/GitBranch";
import type { BuilderSnapshot, BuilderItem, BuilderRepo, DirectoryListing } from '../shared/model';
import { services } from './services/http';
import { createWorkspace } from './state/workspace';
import { railGeometry, resolveDropTarget, type MoveTarget } from './state/layout-ops';
import { screenToPixelColumns } from './state/screen-ops';
import { startPointerDrag } from './items/use-pointer-drag';
import { Content } from './items/Content';
import { MiniRepoRow } from './sidebar/MiniRepoRow';
import { bytesToBase64 } from './services/assets';
const workspace = createWorkspace('browser', localStorage);
const initial: BuilderSnapshot = { revision: 0, repos: [], items: [], capabilities: { platform: '', home: '' } };
type Dialog = { title: string; fields: { name: string; label: string; value?: string }[]; submit: (values: Record<string, string>) => Promise<void> };
export default function App() {
  const [snapshot, setSnapshot] = useState(initial), [connected, setConnected] = useState(false), [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null), [directory, setDirectory] = useState<DirectoryListing | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null), [nested, setNested] = useState<Record<string, boolean>>({});
  const [theme, setTheme] = useState<'light' | 'dark'>(() => { const value = new URLSearchParams(location.search).get('theme') ?? localStorage.getItem('cube-builder.theme'); return value === 'dark' || (!value && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; });
  const [phoneDetail, setPhoneDetail] = useState(false);
  const layout = useSyncExternalStore(workspace.subscribe, workspace.get);
  const rail = useRef<HTMLDivElement>(null), [size, setSize] = useState({ width: 800, height: 600 });
  const report = useCallback((error: unknown) => setError(error instanceof Error ? error.message : String(error)), []);
  const perform = useCallback((fn: () => Promise<unknown>) => { void fn().catch(report); }, [report]);
  useEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); document.documentElement.dataset.theme = theme; localStorage.setItem('cube-builder.theme', theme); }, [theme]);
  useEffect(() => services.subscribe(event => {
    if (event.type === 'snapshot') { setSnapshot(event.snapshot); workspace.reconcile(event.snapshot.items.map(i => i.id)); }
    else if (event.type === 'error') report(event.message);
  }, setConnected), [report]);
  useEffect(() => { const element = rail.current; if (!element) return; const observer = new ResizeObserver(([entry]) => { if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height }); }); observer.observe(element); return () => observer.disconnect(); }, []);
  const open = useCallback((id: string) => { workspace.open(id); setPhoneDetail(true); }, []);
  const openPath = useCallback((path: string) => perform(async () => { const item = await services.call('files.open', { path }); open(item.id); }), [open, perform]);
  const browse = useCallback((path: string) => perform(async () => setDirectory(await services.call('files.list', { path }))), [perform]);
  const terminal = (cwd: string, repoId: string | null, command?: string, args?: string[]) => perform(async () => { const item = await services.call('terminals.create', { requestId: crypto.randomUUID(), cwd, repoId, command, args }); open(item.id); });
  const agent = (cwd: string, repoId: string | null) => setDialog({ title: 'New agent', fields: [{ name: 'command', label: 'Installed command', value: 'codex' }, { name: 'args', label: 'Arguments (JSON array)', value: '[]' }], submit: async values => { const args: unknown = JSON.parse(values.args!); if (!Array.isArray(args) || args.some(v => typeof v !== 'string')) throw new Error('Arguments must be an array of strings'); const item = await services.call('terminals.create', { requestId: crypto.randomUUID(), cwd, repoId, command: values.command, args, harness: values.command }); open(item.id); } });
  const addRepo = (kind: 'add' | 'create' | 'clone') => setDialog({ title: kind === 'add' ? 'Open folder' : kind === 'clone' ? 'Clone repository' : 'Create repository', fields: [...(kind === 'clone' ? [{ name: 'url', label: 'Repository URL' }] : []), { name: 'path', label: 'Absolute path on this machine', value: snapshot.capabilities.home + '/' }], submit: async values => { const repo = kind === 'clone' ? await services.call('repos.clone', { url: values.url!, path: values.path! }) : await services.call(kind === 'add' ? 'repos.add' : 'repos.create', { path: values.path! }); setSelectedRepo(repo.id); } });
  const worktree = (repo: BuilderRepo) => setDialog({ title: 'New worktree', fields: [{ name: 'path', label: 'New directory', value: repo.root + '-worktree' }, { name: 'branch', label: 'New branch' }], submit: async values => { await services.call('worktrees.create', { repoId: repo.id, path: values.path!, branch: values.branch! }); setNested(v => ({ ...v, [repo.id]: true })); } });
  const closeItem = (item: BuilderItem) => {
    if (item.type === 'term' && !item.exited) { setDialog({ title: 'Stop this terminal and close it?', fields: [], submit: async () => { await services.call('terminals.close', { id: item.id }); } }); return; }
    perform(() => services.call(item.type === 'term' ? 'terminals.close' : 'files.close', { id: item.id }));
  };
  const current = layout.screens.find(s => s.id === layout.activeScreenId)!;
  const columns = screenToPixelColumns(current, size.width), rects = railGeometry(columns).rects;
  const [drop, setDrop] = useState<MoveTarget | null>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.altKey) return;
      if (event.key === 'n') { event.preventDefault(); workspace.newScreen(); }
      if (event.key === 'w' && layout.activeItemId) { event.preventDefault(); workspace.hide(layout.activeItemId); }
      if (event.key === 'Enter' && layout.activeItemId) { event.preventDefault(); workspace.zoom(layout.activeItemId); }
      const number = Number(event.key); if (number > 0 && number <= layout.screens.length) { event.preventDefault(); workspace.selectScreen(layout.screens[number - 1]!.id); }
    }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [layout]);
  const itemRow = (item: BuilderItem) => <div key={item.id} className={`builder-item-row ${layout.activeItemId === item.id ? 'selected' : ''}`}><button onClick={() => open(item.id)} title={item.type === 'term' ? item.cwd : item.filePath}>{item.type === 'term' ? <Terminal size={13} /> : <FolderOpen size={13} />}<span>{item.title}</span>{item.type === 'term' && <small>{item.exited ? 'exited' : item.attention === 'waiting' ? '●' : ''}</small>}</button><button title={item.type === 'term' ? 'Stop and close' : 'Close file'} onClick={() => closeItem(item)}><X size={11} /></button></div>;
  return <div className={`builder-app ${phoneDetail ? 'phone-detail' : ''}`}>
    <aside className="builder-sidebar repos-sidebar mini-repo-tree"><header><span>Cube Builder</span><button title="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button></header>
      <div className="sidebar-tools"><button onClick={() => addRepo('add')}><Plus size={13} />Open folder</button><button title="Create repository" onClick={() => addRepo('create')}><FolderOpen size={14} /></button><button title="Clone repository" onClick={() => addRepo('clone')}><GitBranch size={14} /></button></div>
      <div className="sidebar-scroll">{snapshot.repos.map(repo => <section key={repo.id}>
        <MiniRepoRow repo={repo} active={selectedRepo === repo.id} message={null} onClick={() => setSelectedRepo(repo.id)} onContextMenu={event => { event.preventDefault(); setDialog({ title: `Remove ${repo.name} from Builder? Files stay on disk.`, fields: [], submit: async () => { await services.call('repos.remove', { id: repo.id }); } }); }} onNewTerminal={() => terminal(repo.root, repo.id)} onNewAgent={() => agent(repo.root, repo.id)} onOpenFiles={() => browse(repo.root)} worktreeView={{ on: !!nested[repo.id], onToggle: () => { setNested(v => ({ ...v, [repo.id]: !v[repo.id] })); perform(() => services.call('repos.refresh', { id: repo.id })); } }} />
        {nested[repo.id] && <div className="worktrees">{repo.worktrees.map(tree => <div key={tree.id}><span title={tree.root}>{tree.branch || tree.name}</span><button title="Browse worktree" onClick={() => browse(tree.root)}><FolderOpen size={12} /></button><button title="Worktree terminal" onClick={() => terminal(tree.root, repo.id)}><Terminal size={12} /></button>{!tree.main && <button title="Remove worktree" onClick={() => setDialog({ title: `Remove worktree ${tree.name}?`, fields: [], submit: async () => { await services.call('worktrees.remove', { repoId: repo.id, path: tree.root }); } })}><X size={12} /></button>}</div>)}<button onClick={() => worktree(repo)}><Plus size={12} />New worktree</button></div>}
        {snapshot.items.filter(item => item.repoId === repo.id).map(itemRow)}
      </section>)}{snapshot.items.filter(item => !item.repoId).map(itemRow)}</div>
      <footer><button onClick={() => terminal(snapshot.capabilities.home, null)} disabled={!connected}><Terminal size={13} />New terminal</button><button onClick={() => browse(snapshot.capabilities.home)} disabled={!connected}><FolderOpen size={13} />Files</button><span className={`connection ${connected ? 'online' : ''}`}>{connected ? 'Connected' : 'Reconnecting…'}</span></footer>
    </aside>
    <main className="builder-main"><nav className="builder-screens"><button className="phone-back" onClick={() => setPhoneDetail(false)} aria-label="Back to items"><ArrowLeft size={15} /></button>{layout.screens.map((screen, index) => <button key={screen.id} aria-pressed={screen.id === layout.activeScreenId} onClick={() => workspace.selectScreen(screen.id)} onDoubleClick={() => setDialog({ title: 'Rename screen', fields: [{ name: 'name', label: 'Name', value: screen.name }], submit: async values => workspace.renameScreen(screen.id, values.name!) })}>{screen.name || `Screen ${index + 1}`}</button>)}<button title="New screen" onClick={() => workspace.newScreen()}><Plus size={14} /></button></nav>
      {(error || snapshot.warning) && <div className="builder-error" role="alert">{error || snapshot.warning}<button onClick={() => { setError(''); setSnapshot(s => ({ ...s, warning: undefined })); }}><X size={12} /></button></div>}
      <div className="builder-rail" ref={rail} data-dropping={!!drop}>
        {!rects.length && <div className="builder-empty"><span>Build here.</span><p>Open a folder or start a terminal on this machine.</p><button onClick={() => addRepo('add')}>Open folder</button><button disabled={!connected} onClick={() => terminal(snapshot.capabilities.home, null)}>New terminal</button></div>}
        {layout.mounted.map(id => { const item = snapshot.items.find(i => i.id === id); if (!item) return null; const rect = rects.find(r => r.itemId === id), zoom = layout.zoom === id; const visible = !!rect && (!layout.zoom || zoom); return <section key={id} data-item-id={id} className={`builder-pane ${layout.activeItemId === id ? 'focused' : ''}`} style={{ display: visible ? undefined : 'none', left: zoom ? 0 : rect?.leftPx, top: zoom ? 0 : `${(rect?.topFr ?? 0) * 100}%`, width: zoom ? '100%' : rect?.widthPx, height: zoom ? '100%' : `${(rect?.heightFr ?? 1) * 100}%` }} onPointerDownCapture={() => workspace.focus(id)}>
          <div className="builder-pane-inner"><header className="builder-pane-header"><span className="pane-title" onPointerDown={event => { if (event.button !== 0) return; let target: MoveTarget | null = null; startPointerDrag(event, { onMove(_dx, _dy, e) { const bounds = rail.current!.getBoundingClientRect(); target = resolveDropTarget(columns, e.clientX - bounds.left, (e.clientY - bounds.top) / bounds.height)?.target ?? null; setDrop(target); }, onEnd(dx, dy, canceled) { if (!canceled && Math.hypot(dx, dy) > 8 && target) workspace.move(id, target); setDrop(null); } }, rail.current); }}>{item.title}{item.type === 'term' && item.exited ? ` · exited ${item.exitCode ?? ''}` : ''}</span><button title="Hide pane (keep running)" onClick={() => workspace.hide(id)}><Minus size={13} /></button><button title="Zoom pane" onClick={() => workspace.zoom(id)}><ArrowsOut size={13} /></button><button title="Close" onClick={() => closeItem(item)}><X size={13} /></button></header>
          <div className="builder-pane-body"><Content item={item} visible={visible} focused={layout.activeItemId === id} theme={theme} report={report} openPath={openPath} /></div></div></section>; })}
        {!layout.zoom && current.columns.map((column, index) => { const px = columns[index]!; const left = columns.slice(0, index + 1).reduce((n, c) => n + c.widthPx, 0); let top = 0; return <div key={column.id}>{index < columns.length - 1 && <div className="column-divider" style={{ left }} onPointerDown={event => { let previous = 0; startPointerDrag(event, { onMove(dx) { workspace.resizeColumn(column.id, (dx - previous) / size.width); previous = dx; }, onEnd() {} }); }} />}{column.panes.slice(0, -1).map((pane, seam) => { top += pane.heightRatio; return <div key={pane.itemId} className="pane-divider" style={{ left: left - px.widthPx, width: px.widthPx, top: `${top * 100}%` }} onPointerDown={event => { let previous = 0; startPointerDrag(event, { onMove(_dx, dy) { workspace.resizePane(column.id, seam, (dy - previous) / size.height); previous = dy; }, onEnd() {} }); }} />; })}</div>; })}
      </div></main>
    {directory && <div className="dialog-backdrop"><section className="file-browser" role="dialog" aria-label="Files"><header><button onClick={() => browse(directory.parent)}><ArrowLeft size={15} /></button><span title={directory.path}>{directory.path}</span><button onClick={() => setDirectory(null)}><X size={16} /></button></header><div className="file-browser-tools"><button onClick={() => setDialog({ title: 'New file', fields: [{ name: 'name', label: 'Filename' }], submit: async values => { await services.call('files.upload', { directory: directory.path, name: values.name!, data: '' }); browse(directory.path); } })}>New file</button><button onClick={() => setDialog({ title: 'New folder', fields: [{ name: 'name', label: 'Folder name' }], submit: async values => { if (values.name!.includes('/')) throw new Error('Enter a folder name'); await services.call('files.mkdir', { path: directory.path + '/' + values.name }); browse(directory.path); } })}>New folder</button><label>Upload<input type="file" onChange={event => { const file = event.target.files?.[0]; if (file) perform(async () => { if (file.size > 8 * 1024 * 1024) throw new Error('Uploads are limited to 8 MiB'); await services.call('files.upload', { directory: directory.path, name: file.name, data: bytesToBase64(new Uint8Array(await file.arrayBuffer())) }); browse(directory.path); }); }} /></label></div><div className="file-browser-list">{directory.entries.map(entry => <div key={entry.path}><button onClick={() => { if (entry.directory) browse(entry.path); else { openPath(entry.path); setDirectory(null); } }}>{entry.directory ? '▸' : '·'} {entry.name}</button><button onClick={() => setDialog({ title: 'Rename', fields: [{ name: 'path', label: 'New absolute path', value: entry.path }], submit: async values => { await services.call('files.rename', { path: entry.path, destination: values.path!, revision: entry.revision }); browse(directory.path); } })}>Rename</button>{!entry.directory && <button onClick={() => setDialog({ title: `Delete ${entry.name}?`, fields: [], submit: async () => { await services.call('files.remove', { path: entry.path, revision: entry.revision }); browse(directory.path); } })}>Delete</button>}</div>)}</div></section></div>}
    {dialog && <FormDialog dialog={dialog} close={() => setDialog(null)} />}
  </div>;
}
function FormDialog({ dialog, close }: { dialog: Dialog; close: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <div className="dialog-backdrop"><form className="builder-dialog" role="dialog" aria-label={dialog.title} onSubmit={event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>; setBusy(true); void dialog.submit(values).then(close, error => { setError(String(error)); setBusy(false); }); }}><h2>{dialog.title}</h2>{dialog.fields.map((field, i) => <label key={field.name}>{field.label}<input autoFocus={i === 0} name={field.name} defaultValue={field.value} required autoComplete="off" /></label>)}{error && <p role="alert">{error}</p>}<footer><button type="button" onClick={close} disabled={busy}>Cancel</button><button disabled={busy}>{busy ? 'Working…' : 'Continue'}</button></footer></form></div>;
}

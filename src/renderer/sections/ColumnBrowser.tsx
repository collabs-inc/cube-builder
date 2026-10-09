// A macOS-style column browser: the roots in the first column, and each
// folder you pick opening the next column to its right, so a deep
// hierarchy reads as a trail rather than an expanding tree. In a folder:
// the sessions running there first, then folders, then files, by name —
// the machine's filesystem with what is running inside it. The browser owns no files of its own: it
// lists through the same directory call the file tree uses and hands a
// picked file to the caller.
import { useEffect, useRef, useState } from "react";
import { CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { Terminal } from '@phosphor-icons/react/dist/csr/Terminal';
import { getFileIcon } from "@builder/components/TreeView";
import type { DirEntry } from "../services/types";
import "./ColumnBrowser.css";

export interface BrowserRoot {
  name: string;
  path: string;
  /** The repo a root belongs to, so a picked file opens on the right machine; null for a plain folder. */
  repoId: string | null;
}

interface Pick {
  path: string;
  name: string;
  repoId: string | null;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
}

export interface PickedFile {
  kind: "file";
  path: string;
  name: string;
  repoId: string | null;
}

/** A session the browser lists inside the folder it runs in. */
export interface SessionEntry {
  id: string;
  name: string;
  /** The sidebar's hue class for the glyph (agent-claude…), or none. */
  hue: string | null;
  icon?: React.ReactNode;
}

export interface PickedSession {
  kind: "session";
  id: string;
}

export type Picked = PickedFile | PickedSession;

/** How a file row is drawn when the caller knows more about it — an artifact, say. */
export interface FileDecoration {
  kind: string;
  name: string;
  hue: string | null;
  icon?: React.ReactNode;
}

export function ColumnBrowser({
  roots,
  readDir,
  sessionsIn,
  decorateFile,
  onPickFile,
  onNewTerminal,
  onFileDragStart,
  onFolderDragStart,
  onSessionDragStart,
  onRowDragEnd,
  preview,
  onColumns,
}: {
  roots: BrowserRoot[];
  readDir: (path: string) => Promise<DirEntry[]>;
  /** The sessions running in a folder; listed first in that folder's column. */
  sessionsIn?: (path: string, repoId: string | null) => SessionEntry[];
  /** A file the caller recognises (an artifact…) keeps its place but takes this look. */
  decorateFile?: (file: Omit<PickedFile, "kind">) => FileDecoration | null;
  /** A file was picked: the browser marks it and shows `preview`; opening it is the caller's call. */
  onPickFile?: (path: string, repoId: string | null) => void;
  /** The folder row's action: a shell started in that folder. */
  onNewTerminal?: (path: string, repoId: string | null) => void;
  /** Given, rows of that kind can be dragged out; the caller loads the drag. */
  onFileDragStart?: (event: React.DragEvent<HTMLElement>, file: Omit<PickedFile, "kind">) => void;
  onFolderDragStart?: (event: React.DragEvent<HTMLElement>, folder: { path: string; name: string; repoId: string | null }) => void;
  onSessionDragStart?: (event: React.DragEvent<HTMLElement>, session: SessionEntry) => void;
  onRowDragEnd?: () => void;
  /** The last column: whatever the caller shows for the pick (or none). */
  preview?: (picked: Picked | null) => React.ReactNode;
  /** How many columns are showing — the roots, the trail, and a preview when something is picked. */
  onColumns?: ((count: number) => void) | undefined;
}) {
  // The folders picked so far, one per column after the roots.
  const [trail, setTrail] = useState<Pick[]>([]);
  // The file or session picked in the last column, cleared by any move along the trail.
  const [picked, setPicked] = useState<Picked | null>(null);
  // Folded groups, "<folder>:<group>", remembered while the browser is open.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggleFold = (key: string) => setFolded(previous => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const [listings, setListings] = useState<Record<string, DirEntry[]>>({});
  const scrollerRef = useRef<HTMLDivElement>(null);
  // A column the keyboard asked to enter; focused once its listing has rows.
  const pendingFocusRef = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    for (const pick of trail) {
      if (listings[pick.path] !== undefined) continue;
      void readDir(pick.path)
        .then(entries => { if (live) setListings(previous => ({ ...previous, [pick.path]: sortEntries(entries) })); })
        .catch(() => { if (live) setListings(previous => ({ ...previous, [pick.path]: [] })); });
    }
    return () => { live = false; };
  }, [trail, listings, readDir]);

  useEffect(() => {
    // A new column, or a preview, opens at the right edge; keep it in view.
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
    onColumns?.(1 + trail.length + (picked ? 1 : 0));
  }, [trail.length, picked, onColumns]);

  const pickFolder = (column: number, pick: Pick) => { setPicked(null); setTrail(previous => [...previous.slice(0, column), pick]); };
  const pickFile = (file: Omit<PickedFile, "kind">) => { setPicked({ kind: "file", ...file }); onPickFile?.(file.path, file.repoId); };
  const pickSession = (id: string) => setPicked({ kind: "session", id });

  const focusRow = (column: number, name: string | null): boolean => {
    const scroller = scrollerRef.current;
    if (!scroller) return false;
    const rows = [...scroller.querySelectorAll<HTMLElement>(`.column-browser-column[data-column="${column}"] .column-browser-row`)];
    const target = name === null ? rows[0] : rows.find(row => row.dataset.name === name) ?? rows[0];
    target?.focus();
    return target !== undefined;
  };

  useEffect(() => {
    const column = pendingFocusRef.current;
    if (column === null) return;
    if (focusRow(column, null)) pendingFocusRef.current = null;
  });

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".column-browser-row");
    if (!row) return;
    const column = Number(row.closest<HTMLElement>(".column-browser-column")?.dataset.column ?? 0);
    const siblings = [...(row.parentElement?.querySelectorAll<HTMLElement>(".column-browser-row") ?? [])];
    const index = siblings.indexOf(row);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      siblings[event.key === "ArrowDown" ? Math.min(siblings.length - 1, index + 1) : Math.max(0, index - 1)]?.focus();
    } else if (event.key === "ArrowRight" || event.key === "Enter") {
      event.preventDefault();
      row.click();
      if (row.dataset.kind === "folder") pendingFocusRef.current = column + 1;
    } else if (event.key === "ArrowLeft" && column > 0) {
      event.preventDefault();
      focusRow(column - 1, trail[column - 1]?.name ?? null);
    }
  };

  const columns: { key: string; sessions: SessionEntry[]; rows: Pick[]; files: (Pick & { isFile: true })[]; selected: string | null }[] = [
    { key: "roots", sessions: [], rows: roots.map(root => ({ path: root.path, name: root.name, repoId: root.repoId })), files: [], selected: trail[0]?.path ?? null },
    ...trail.map((pick, index) => {
      const entries = listings[pick.path] ?? [];
      return {
        key: pick.path,
        sessions: sessionsIn?.(pick.path, pick.repoId) ?? [],
        rows: entries.filter(entry => entry.isDirectory).map(entry => ({ path: joinPath(pick.path, entry.name), name: entry.name, repoId: pick.repoId })),
        files: entries.filter(entry => !entry.isDirectory).map(entry => ({ path: joinPath(pick.path, entry.name), name: entry.name, repoId: pick.repoId, isFile: true as const })),
        selected: trail[index + 1]?.path ?? null,
      };
    }),
  ];

  return (
    <div ref={scrollerRef} className="column-browser" onKeyDown={onKeyDown}>
      {columns.map((column, index) => (
        <div key={column.key} className="column-browser-column" data-column={index} role="listbox" aria-label={index === 0 ? "Places" : trail[index - 1]!.name}>
          {/* Both kinds present: small group labels, each a fold. One kind alone stays a plain list. */}
          {(() => {
            const grouped = column.sessions.length > 0 && column.rows.length + column.files.length > 0;
            const sessionsKey = `${column.key}:sessions`;
            const filesKey = `${column.key}:files`;
            const showSessions = !(grouped && folded.has(sessionsKey));
            const showFiles = !(grouped && folded.has(filesKey));
            const header = (key: string, label: string, open: boolean) => (
              <button type="button" className="column-browser-group" aria-expanded={open} onClick={() => toggleFold(key)}>
                <span className="column-browser-group-caret">{open ? <CaretDown size={9} weight="bold" /> : <CaretRight size={9} weight="bold" />}</span>
                {label}
              </button>
            );
            return (
              <>
                {grouped && header(sessionsKey, "Sessions", showSessions)}
                {showSessions && column.sessions.map(session => (
            <button
              key={`session:${session.id}`}
              type="button"
              className="column-browser-row"
              data-kind="session"
              data-name={session.name}
              role="option"
              aria-selected={picked?.kind === "session" && picked.id === session.id ? "true" : undefined}
              tabIndex={-1}
              onClick={() => pickSession(session.id)}
              draggable={onSessionDragStart !== undefined}
              onDragStart={onSessionDragStart ? event => onSessionDragStart(event, session) : undefined}
              onDragEnd={onRowDragEnd}
            >
              <span className={`column-browser-icon${session.hue ? ` ${session.hue}` : ""}`}>{session.icon ?? <Terminal size={14} />}</span>
              <span className="column-browser-name">{session.name}</span>
            </button>
          ))}
                {grouped && header(filesKey, "Files", showFiles)}
                {showFiles && column.rows.map(folder => (
            <div
              key={folder.path}
              className="column-browser-row"
              data-kind="folder"
              data-name={folder.name}
              role="option"
              aria-selected={column.selected === folder.path ? "true" : undefined}
              tabIndex={-1}
              onClick={() => pickFolder(index, folder)}
              onKeyDown={event => { if (event.key === " ") { event.preventDefault(); pickFolder(index, folder); } }}
              draggable={onFolderDragStart !== undefined}
              onDragStart={onFolderDragStart ? event => onFolderDragStart(event, { path: folder.path, name: folder.name, repoId: folder.repoId }) : undefined}
              onDragEnd={onRowDragEnd}
            >
              <span className="column-browser-icon"><Folder size={14} /></span>
              <span className="column-browser-name">{folder.name}</span>
              {onNewTerminal && (
                <button
                  type="button"
                  className="column-browser-action"
                  aria-label={`New terminal in ${folder.name}`}
                  title="New terminal here"
                  tabIndex={-1}
                  onClick={event => { event.stopPropagation(); onNewTerminal(folder.path, folder.repoId); }}
                >
                  <Terminal size={12} />
                </button>
              )}
              <span className="column-browser-caret"><CaretRight size={10} /></span>
            </div>
          ))}
                {showFiles && column.files.map(file => {
            // The rail's file tree keys a glyph and a colour on the file's
            // kind; the browser draws the same pair so a file looks the same
            // wherever it is listed.
            const { icon: Glyph, color } = getFileIcon(file.name);
            const dot = file.name.lastIndexOf(".");
            const decoration = decorateFile?.({ path: file.path, name: file.name, repoId: file.repoId }) ?? null;
            return (
              <button
                key={file.path}
                type="button"
                className="column-browser-row"
                data-kind={decoration?.kind ?? "file"}
                data-name={file.name}
                role="option"
                aria-selected={picked?.kind === "file" && picked.path === file.path ? "true" : undefined}
                tabIndex={-1}
                onClick={() => pickFile(file)}
                draggable={onFileDragStart !== undefined}
                onDragStart={onFileDragStart ? event => onFileDragStart(event, { path: file.path, name: file.name, repoId: file.repoId }) : undefined}
                onDragEnd={onRowDragEnd}
              >
                {decoration ? (
                  <span className={`column-browser-icon${decoration.hue ? ` ${decoration.hue}` : ""}`}>{decoration.icon}</span>
                ) : (
                  <span className="column-browser-icon" style={{ color }} data-file-kind={dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "file"}><Glyph size={14} /></span>
                )}
                <span className="column-browser-name">{decoration?.name ?? file.name}</span>
              </button>
            );
          })}
              </>
            );
          })()}
        </div>
      ))}
      {preview && <div className="column-browser-preview">{preview(picked)}</div>}
    </div>
  );
}

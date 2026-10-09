/**
 * Window-level drag-and-drop: dropping Finder files, or dragging a file
 * from the nav sidebar's own TreeView, onto the main area opens them as
 * workspace items. Ported from the old shell's window-level handling
 * (src/windows/shell/src/renderer.js:1601-1708), simplified for the
 * single-renderer app:
 *   - no `dnd:*` webview relays (there are no webviews to relay into)
 *   - no pointer-events juggling on webviews (nothing to juggle)
 *   - no canvas coordinates or offset-cascade positioning (there's no
 *     canvas — dropped files just open, at whatever position ItemHost
 *     puts new items)
 *
 * The affordance is PER ZONE, not per window. A single window-wide
 * "Drop to open" scrim was what this started as (and what the old shell
 * had wired up but never rendered), and it was wrong twice over: it
 * covered surfaces where a drop does nothing at all — the sidebar, a
 * modal — and it promised one outcome across zones that do genuinely
 * different things. Dropping onto a LOCAL terminal types a path that
 * already exists; onto a REMOTE one it uploads the file first and types
 * the path it landed on over there; onto the workspace it opens the file
 * as an item. So the window listeners here only decide WHICH zone (and
 * which item) is under the pointer, and each surface renders its own
 * answer — see `dropHintText`.
 */



import { useEffect } from "react";
import { services } from "./services";
import { openFile, resolveMachineId } from "./items/open-file";
import { repoForAbsPath } from "./state/repos";
import { catalogStore } from "./state/catalog";
import { focusItem } from "./state/workspace";
import { setDropTarget } from "./state/drop-target";
import { carriesFiles } from "@port/shared/file-drag";

export type DropZone = "sidebar" | "tree" | "terminal" | "agent" | "overlay" | "main";

const SIDEBAR_SELECTOR = ".app-sidebar";
// Tree pane root from Task 4 — see its keep-alive contract in Rail.tsx.
// The tree has its own drag-drop handler via packages/components/TreeView/useDragDrop.ts;
// the window-level handler must skip drops inside it to avoid double-pasting the same paths.
const TREE_PANE_SELECTOR = ".file-tree-pane";
// TerminalTab.tsx's own container div — see its `className="terminal-tab"`.
// TerminalTab already has a container-level drop handler that shell-quotes
// paths into the pty; the window-level handler must skip drops inside it to
// avoid double-pasting the same paths.
const TERMINAL_SELECTOR = ".terminal-tab";
// Every modal overlay (GateModal, SettingsModal, ConfirmDialog, the
// sidebar's add-repo modals) carries this class — see App.css's
// `.app-modal-overlay` doc comment. A drop landing on one must be inert: in
// particular, a Finder drop onto the gate must not open a workspace item
// behind the scrim while the user hasn't signed in / provisioned / logged
// into gh yet.
const MODAL_OVERLAY_SELECTOR = ".app-modal-overlay";

/**
 * The type a file dragged out of the desktop's Files window carries
 * (sections/BrowseFiles.tsx). The path itself travels through
 * `services.desktop.dragPaths`, like a tree drag; this type is what lets
 * the workspace advertise the drop, which a bare text/plain drag never
 * does (see `carriesFiles`).
 */
export const BROWSER_FILE_DRAG_TYPE = "application/x-cube-browser-file";
/** A folder dragged out of the browser: on the screen it becomes a terminal there. */
export const BROWSER_FOLDER_DRAG_TYPE = "application/x-cube-browser-folder";
/** A session dragged out of the browser: the item id travels as its data. */
export const SESSION_DRAG_TYPE = "application/x-cube-session";

/** What a drag from inside the app carries, read off its types during dragover. */
export type BrowserDragKind = "file" | "folder" | "session";

export function browserDragKind(dataTransfer: { types?: readonly string[] } | null | undefined): BrowserDragKind | null {
  const types = dataTransfer?.types;
  if (!types) return null;
  if (types.includes(SESSION_DRAG_TYPE)) return "session";
  if (types.includes(BROWSER_FOLDER_DRAG_TYPE)) return "folder";
  if (types.includes(BROWSER_FILE_DRAG_TYPE)) return "file";
  return null;
}

export function carriesBrowserFile(dataTransfer: { types?: readonly string[] } | null | undefined): boolean {
  return dataTransfer?.types?.includes(BROWSER_FILE_DRAG_TYPE) === true;
}

/** Minimal shape `classifyDropTarget` needs — real DOM elements satisfy it,
 * and tests can pass a plain fake without importing a DOM environment.
 * Extends `EventTarget` so it's a valid narrowing of `EventTarget | null`. */
interface ClosestTarget extends EventTarget {
  closest(selector: string): unknown;
}

function hasClosest(target: EventTarget | null): target is ClosestTarget {
  return target != null && typeof (target as ClosestTarget).closest === "function";
}

/**
 * Classifies a drop event's target so the window-level handler knows what
 * to do with it:
 *   - "sidebar": inside `.app-sidebar` — TreeView's own drag-drop
 *     (packages/components/TreeView/useDragDrop.ts) handles file moves
 *     there; the window-level handler must leave it alone (renderer.js's
 *     old "ignore drops left of the viewer" check, ported as a class check
 *     instead of an x-coordinate check since there's no fixed panel split
 *     to compare against anymore).
 *   - "tree": inside a tree pane's `.file-tree-pane` container — TreeView's
 *     own drag-drop handler (packages/components/TreeView/useDragDrop.ts)
 *     handles file moves there; the window-level handler must leave it alone.
 *   - "terminal": inside a terminal item's `.terminal-tab` container —
 *     TerminalTab.tsx's own drop handler already pastes paths into the pty.
 *   - "overlay": inside any `.app-modal-overlay` (gate, settings, confirm,
 *     add-repo) — a drop here must be inert, not open a workspace item
 *     behind the modal.
 *   - "main": everywhere else — the window-level handler opens the dropped
 *     files.
 */
export function classifyDropTarget(target: EventTarget | null): DropZone {
  if (!hasClosest(target)) return "main";
  if (target.closest(SIDEBAR_SELECTOR)) return "sidebar";
  if (target.closest(TREE_PANE_SELECTOR)) return "tree";
  if (target.closest(TERMINAL_SELECTOR)) return "terminal";
  if (target.closest(".agent-item") || target.closest('[data-item-type="agent"]')) return "agent";
  if (target.closest(MODAL_OVERLAY_SELECTOR)) return "overlay";
  return "main";
}

/** Rail.tsx stamps every item slot with `data-item-id` (see its
 *  keep-alive contract) — the one existing hook for asking "which item is
 *  under the pointer", which the zone alone cannot answer when two
 *  terminals are on screen. */
const ITEM_SLOT_SELECTOR = "[data-item-id]";

/** Where a drag currently is: the zone, plus the item slot within it when
 *  there is one. */
export interface DropTarget {
  zone: DropZone;
  itemId: string | null;
  /** What is being dragged — OS files, or one of the app's own kinds. */
  drag?: "files" | BrowserDragKind | undefined;
}

/** Classifies a drag's current position for the affordance layer — the
 *  zone, and the specific item slot the pointer is inside. */
export function resolveDropTarget(target: EventTarget | null): DropTarget {
  const zone = classifyDropTarget(target);
  if (!hasClosest(target)) return { zone, itemId: null };
  const slot = target.closest(ITEM_SLOT_SELECTOR);
  const itemId =
    slot !== null && typeof (slot as Element).getAttribute === "function"
      ? (slot as Element).getAttribute("data-item-id")
      : null;
  return { zone, itemId };
}

export { carriesFiles };

/**
 * What dropping here will actually do, in the user's words. `null` means
 * a drop does nothing in that zone, so nothing should be drawn: a drop on
 * a modal scrim is deliberately inert. The sidebar is no longer one of
 * those — it is a drop TARGET as of the external-file drop mode
 * (`packages/components/src/TreeView/external-drop.ts`), so it gets its
 * own copy/upload wording here, and its highlight comes from `useDragDrop`.
 */
export function dropHintText(zone: DropZone, opts: { remote: boolean }): string | null {
  if (zone === "terminal") {
    return opts.remote ? "Upload file and add remote file path" : "Add file path";
  }
  if (zone === "sidebar" || zone === "tree") {
    return opts.remote ? "Upload here" : "Copy here";
  }
  return zone === "main" ? "Open file" : null;
}

/**
 * Whether the window-level dragover should force `dropEffect = "none"` for
 * a file drag over this zone. The cursor is an affordance like the hint
 * text: the window handler must `preventDefault()` everywhere (or dropping
 * a file navigates the renderer to it), but preventing default is also the
 * DOM's "valid drop target" signal, so every inert surface would otherwise
 * show a copy cursor for a drop that does nothing — misleading over the
 * sidebar's non-tree chrome (and the whole default view mode), and over a
 * modal scrim.
 *
 * `claimedByTarget` is `e.defaultPrevented` read at the top of the window's
 * bubble-phase listener — a tree row or terminal that accepts the drag has
 * already called `preventDefault()` by then, and its own `dropEffect`
 * choice must stand. "main" is always a real target (the drop opens the
 * file), and a terminal's handler owns its zone either way.
 */
export function refusesUnclaimedFileDrag(zone: DropZone, claimedByTarget: boolean): boolean {
  if (claimedByTarget) return false;
  return zone === "sidebar" || zone === "tree" || zone === "overlay";
}

/**
 * The hint the WORKSPACE draws for a drag in flight, or `null` when it
 * should draw none. Only the "main" zone is its own: a terminal pane
 * renders its answer itself (TerminalItem, which alone knows whether that
 * pane is remote), and a drop on the sidebar, tree pane, or a modal scrim
 * does nothing at all.
 *
 * This exists rather than the caller passing `dropTarget.zone` straight to
 * `dropHintText`: doing that drew a second, main-area-centred "Add file
 * path" behind the terminal's own hint, and — since the workspace has no
 * pane to ask and hardcoded `remote: false` — the two labels disagreed
 * over a remote terminal, where the drop uploads first.
 */
export function workspaceDropHintText(target: DropTarget | null): string | null {
  if (target?.zone !== "main") return null;
  if (target.drag === "session") return "Open on this screen";
  if (target.drag === "folder") return "Open a terminal here";
  return dropHintText("main", { remote: false });
}

/**
 * Where a session drag counts: a session is not a path, so a terminal or
 * an agent under the pointer has nothing to paste — the drop opens the
 * session on the screen, and the workspace draws the affordance. Files and
 * folders keep their zones: a terminal takes their path.
 */
export function retargetForDrag(target: DropTarget, kind: DropTarget["drag"]): DropTarget {
  if (kind === "session" && (target.zone === "terminal" || target.zone === "agent")) return { ...target, zone: "main", drag: kind };
  return { ...target, drag: kind };
}

/** Minimal file-list shape `extractFinderPaths` needs. A real
 * `DataTransfer.files` (a `FileList`) satisfies this structurally, and so
 * does a plain array — letting tests pass one directly instead of
 * constructing a `FileList`. */
interface FileListLike {
  readonly length: number;
  [index: number]: File | undefined;
}

/**
 * Extracts Finder file paths from a drop's DataTransfer. Must be called
 * SYNCHRONOUSLY, before any `await` — native file handles on DataTransfer
 * are invalidated after the first await, so this has to run before
 * `dragPaths.get()` (which is itself async) in the caller. Non-file items
 * (e.g. a plain text/URL drag) throw from `getPathForFile` and are skipped.
 */
export function extractFinderPaths(
  dataTransfer: { files: FileListLike } | null,
  getPathForFile: (file: File) => string,
): string[] {
  const paths: string[] = [];
  const files = dataTransfer?.files;
  if (!files) return paths;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;
    try {
      const p = getPathForFile(file);
      if (p) paths.push(p);
    } catch {
      // Non-file DataTransfer item — skip.
    }
  }
  return paths;
}

/**
 * Nav-internal drags (TreeView's useDragDrop, which sets paths via
 * `services.desktop.dragPaths.set()`) take precedence over Finder paths
 * extracted from the same drop — a drag that started inside the app but
 * also happens to carry File objects should resolve to the internal path,
 * not re-derive it from the (possibly stale) native handle.
 */
export function resolveDropPaths(finderPaths: string[], dragPaths: string[]): string[] {
  return dragPaths.length > 0 ? dragPaths : finderPaths;
}

/** Filters out directories in parallel — folder drops aren't supported. */
export async function filterOutDirectories(
  paths: string[],
  isDirectory: (path: string) => Promise<boolean>,
): Promise<string[]> {
  const checks = paths.map(async (p) => ((await isDirectory(p)) ? null : p));
  const results = await Promise.all(checks);
  return results.filter((p): p is string => p !== null);
}

export interface OpenDroppedPathsDeps {
  getDragPaths: () => Promise<string[]>;
  isDirectory: (path: string) => Promise<boolean>;
  openFile: (path: string, options: { repoId?: string }) => void;
  repoForAbsPath: (path: string) => { id: string } | null;
}

/**
 * The async continuation of a main-area drop, once `finderPaths` has
 * already been extracted synchronously by the caller. Resolves nav-drag
 * vs. Finder precedence, filters out directories, then opens each
 * remaining file path on the workspace store. Offset-cascade positioning
 * from the old canvas-based code is dead — there's no canvas to place
 * tiles on.
 */
export async function openDroppedPaths(
  finderPaths: string[],
  deps: OpenDroppedPathsDeps,
): Promise<void> {
  let dragPaths: string[] = [];
  try {
    dragPaths = await deps.getDragPaths();
  } catch {
    // noop — fall back to finderPaths below.
  }
  const paths = resolveDropPaths(finderPaths, dragPaths);
  if (paths.length === 0) return;

  const filePaths = await filterOutDirectories(paths, deps.isDirectory);
  if (filePaths.length === 0) return;

  for (const filePath of filePaths) {
    const repoId = deps.repoForAbsPath(filePath)?.id;
    deps.openFile(filePath, repoId !== undefined ? { repoId } : {});
  }
}

/**
 * The async continuation of a folder drop: a shell started in that folder
 * on its machine, then shown. TerminalItem is loaded on demand — it is a
 * heavy module (xterm), and this file's own tests run without a DOM.
 */
export async function openDroppedFolder(getDragPaths: () => Promise<string[]>): Promise<void> {
  let paths: string[] = [];
  try { paths = await getDragPaths(); } catch { return; }
  const path = paths[0];
  if (!path) return;
  const repoId = repoForAbsPath(path)?.id;
  const machineId = resolveMachineId(repoId);
  if (machineId === null) return;
  const { createTerminalItem } = await import("./items/TerminalItem");
  const item = await createTerminalItem({ machineId, cwd: path, target: "shell", view: "terminal", ...(repoId !== undefined ? { repoId } : {}) });
  focusItem(item.id, item.type, repoId ?? null);
}

/**
 * Wires the window-level dragenter/dragover/dragleave/drop listeners and
 * publishes where the drag is to `dropTargetStore`, for each surface to
 * render its own affordance against. On drop it classifies the target and
 * either ignores it (sidebar and tree — TreeView owns those), leaves it to
 * TerminalTab's own handler (terminal), or opens the dropped files (main).
 *
 * Two different signals, deliberately:
 *   - `dragover` says WHERE the pointer is. It is the only event that
 *     keeps reporting a target as the pointer moves within the window, so
 *     it is what drives the published zone. It fires continuously, which
 *     `setDropTarget`'s equality check absorbs.
 *   - `dragenter`/`dragleave` count nesting, and answer only one question:
 *     has the drag left the WINDOW? Child elements fire their own
 *     enter/leave pairs as the pointer crosses them, so the counter has to
 *     unwind to zero before the affordance comes down. Without this the
 *     last dragover's target would stick after the drag left entirely.
 *
 * The drop listener is registered in the capture phase: TerminalTab.tsx's
 * own container-level drop handler calls `stopPropagation()`, so a
 * bubbling window listener never sees a drop onto a terminal and the
 * affordance would stay up forever. Capture runs before the target's
 * handler regardless, and the "terminal" zone is skipped here anyway, so
 * nothing double-handles.
 */
export function useWindowDragDrop(): void {
  useEffect(() => {
    let dragCounter = 0;

    const onDragEnter = (e: DragEvent): void => {
      e.preventDefault();
      dragCounter++;
    };

    const onDragOver = (e: DragEvent): void => {
      // Read before our own preventDefault below: this bubble-phase
      // listener runs after any tree-row or terminal handler, so
      // defaultPrevented here means a real target claimed the drag.
      const claimed = e.defaultPrevented;
      e.preventDefault();
      const kind = browserDragKind(e.dataTransfer) ?? (carriesFiles(e.dataTransfer) ? "files" : null);
      const target = kind === null ? null : retargetForDrag(resolveDropTarget(e.target), kind);
      setDropTarget(target);
      if (target !== null && e.dataTransfer && refusesUnclaimedFileDrag(target.zone, claimed)) {
        e.dataTransfer.dropEffect = "none";
      }
    };

    const onDragLeave = (e: DragEvent): void => {
      e.preventDefault();
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) setDropTarget(null);
    };

    const onDrop = (e: DragEvent): void => {
      e.preventDefault();
      dragCounter = 0;
      setDropTarget(null);

      const kind = browserDragKind(e.dataTransfer);
      const zone = retargetForDrag({ zone: classifyDropTarget(e.target), itemId: null }, kind ?? "files").zone;
      if (zone !== "main") return;

      // A session lands on the screen in view; nothing to read off disk.
      if (kind === "session") {
        const id = e.dataTransfer?.getData(SESSION_DRAG_TYPE);
        const item = id ? catalogStore.getSnapshot().items.find(candidate => candidate.id === id) : undefined;
        if (item) focusItem(item.id, item.type, item.repoId ?? null);
        return;
      }
      // A folder becomes a terminal there — the folder row's own action.
      if (kind === "folder") {
        void openDroppedFolder(() => services.desktop.dragPaths.get());
        return;
      }

      // Synchronous, before any await — see extractFinderPaths's doc
      // comment.
      const finderPaths = extractFinderPaths(e.dataTransfer, services.desktop.getPathForFile);

      void openDroppedPaths(finderPaths, {
        getDragPaths: () => services.desktop.dragPaths.get(),
        isDirectory: services.files.isDirectory,
        openFile,
        repoForAbsPath,
      });
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop, { capture: true });

    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop, { capture: true });
      // A drag in progress across an unmount would otherwise leave the
      // affordance up with nothing left to take it down.
      setDropTarget(null);
    };
  }, []);
}

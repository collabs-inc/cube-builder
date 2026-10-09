import { NEW_SESSION_MENU, launchChoiceOf } from "@port/shared/launch-menu";
import { resolveMachineId } from "../items/open-file";
import type { ContextMenuItem } from "@port/shared/types";
// The file tree, extracted from the sidebar's own file panel so more than
// one surface can
// render it: the sidebar's scoped panel (one root, expansion persisted) and
// a workspace tree pane (one root, expansion in memory). Everything here
// was that panel's — WorkspaceTree per root, search/sort, multi-select,
// inline rename, drag-drop, the import-web-article modal, the key handlers
// — moved rather than rewritten, so its porting history still reads:
//
//   Ported from src/windows/nav/src/App.tsx (the old nav webview), with the
//   transport swapped out: window.api.* calls go through the services
//   layer, `onNavScope` is now a `scope` prop (now the `workspaces` prop
//   here), `sendToHost("nav:scope-back")` is now an `onScopeBack` prop (it
//   stayed behind on the panel, which owned the scope header),
//   `onFocusSearch` is now an imperative handle, and `selectFile` opens a
//   workspace item directly instead of round-tripping through main to a
//   separate viewer webview.
//
//   The tooltip system used to live here too and no longer does: it is
//   app-wide chrome that several surfaces outside this file already used,
//   so it moved to `hooks/useTooltips.ts` and is installed once by `App`.
//   Rows here still opt in the same way, with `data-tooltip`.
//
// What is NOT inherited from that panel is the key-handler guard. The
// sidebar could assume it was the only tree in the document; a host that
// can be mounted several times over cannot, so `shouldHandleSidebarKey`'s
// verdict is now filtered through a per-instance claim — see active-host.ts.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { Clock } from '@phosphor-icons/react/dist/csr/Clock';
import { ListBullets } from '@phosphor-icons/react/dist/csr/ListBullets';
import { TextAa } from '@phosphor-icons/react/dist/csr/TextAa';
import { TreeStructure } from '@phosphor-icons/react/dist/csr/TreeStructure';
import { SearchSortControls, useMultiSelect, useInlineRename, useDragDrop, sortModeOrder, sortModeLabels, TREE_SORT_MODE_STORAGE_KEY } from "@builder/components/TreeView";
import { WorkspaceTree } from "@builder/components/TreeView/WorkspaceTree";
import type { WorkspaceFileTreeHandle } from "@builder/components/TreeView/useWorkspaceFileTree";
import type { SortMode, FlatItem, SearchSortControlsHandle } from "@builder/components/TreeView";
import { saveExpandedWorkspaces } from "@builder/components/TreeView/useFileTree";
import { isSubpath, parentPath } from "@port/shared/path-utils";
// TreeView ships its own stylesheet, which the package's components don't
// import themselves — the old nav window pulled it in from its entry
// (src/windows/nav/src/main.tsx on main). This is the only consumer of
// those components now, so it imports it here rather than from the app
// entry; without it the whole file tree renders unstyled.
import "@builder/components/TreeView/TreeView.css";
import "./FileTreeHost.css";
import { claimTreeHostKeys, releaseTreeHostKeys, treeHostHoldsKeys } from "./active-host";
import { treePaneNameFor } from "./tree-pane-name";
import { selectionDisplayed, shouldClearSelection } from "../sidebar/nav-selection";
import { openTreePane, useWorkspace } from "../state/workspace";
import { useCatalog } from "../state/catalog";
import { shouldHandleSidebarKey } from "../sidebar/focus-guard";
import { resolveNavStatus } from "../sidebar/nav-status";
import { services } from "../services";
import { openFile } from "../items/open-file";
import { repoForAbsPath, reposStore } from "../state/repos";
import { isCloudPath } from "../items/cloud-placeholder";
import { dropHintText } from "../drag-drop";
import { useFileImport } from "../sidebar/use-file-import";
import { TransferStrip } from "../sidebar/TransferStrip";

function newRef<T>(): RefObject<T | null> {
  return { current: null };
}

function ImportWebArticleModal({
  folderPath,
  onClose,
  onImported,
}: {
  folderPath: string;
  onClose: () => void;
  onImported: (filePath: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleImport = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await services.files.importWebArticle(url.trim(), folderPath);
      onImported(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import article");
    } finally {
      setLoading(false);
    }
  };

  // Portal outside the host's clipping and stacking contexts, and the
  // app body that can be marked inert while an overlay is open.
  return createPortal(
    <div className="create-item-modal-overlay app-modal-overlay" onClick={onClose}>
      <div className="create-item-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="create-item-modal-header">
          <h3 className="create-item-modal-title">Import Web Article</h3>
        </div>
        <form
          className="create-item-modal-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!loading) handleImport();
          }}
        >
          <div className="create-item-form-group">
            <input
              type="url"
              placeholder="Enter article URL..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onClose();
              }}
              className="create-item-modal-text-input"
              autoFocus
              disabled={loading}
            />
          </div>
          {error && (
            <p className="create-item-modal-error">{error}</p>
          )}
          <div className="create-item-modal-actions">
            <button
              type="button"
              onClick={onClose}
              className="create-item-modal-button create-item-modal-button-secondary"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!url.trim() || loading}
              className="create-item-modal-button create-item-modal-button-primary"
            >
              {loading ? "Importing..." : "Import"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.getElementById("overlay-root") ?? document.body,
  );
}

/**
 * The "Import Web Article" menu entry, or nothing on a host that cannot run
 * it. `services.files.importWebArticle` throws `UnsupportedOnWeb` in the
 * browser (readability + image download is a main-process job), so offering
 * it there is a dead affordance — the same reason `revealInFinder` gates the
 * reveal entry below and `localRepos` gates the local-add entry points in
 * ReposSidebar.
 *
 * It rides on `capabilities.images` rather than a flag of its own. That flag
 * reads "image and PDF viewing", so the fit is approximate — but the import
 * writes an article's images into the workspace and the article viewer is the
 * file viewer, both hosts answer it identically to `importWebArticle`'s own
 * support (all-true on the desktop, all-false in the browser), and a new
 * capability is a change to a shared type in both hosts for one menu entry.
 * If the two ever diverge — a browser build that views images but still
 * cannot import — this is the call site to split.
 *
 * This is one of TWO filters over each menu array: this one asks what the
 * HOST can do, `filterCloudMenuItems` (which wraps every array on its way to
 * showContextMenu) asks what the PATH's machine can do. They compose —
 * capabilities first, inside the array; the cloud filter last, over it.
 */
function importWebArticleItems(): Array<{ id: string; label: string }> {
  return services.desktop.capabilities.images
    ? [{ id: "import-web-article", label: "Import Web Article" }]
    : [];
}

export interface FileTreeHostHandle {
  focusSearch: () => void;
}

export interface FileTreeHostProps {
  /** Roots to render, one WorkspaceTree each (the sidebar passes its one
   * scoped root; a pane passes its one root). */
  workspaces: Array<{ path: string; name: string }>;
  /**
   * Whether this host's surface is the one currently showing. Sidebar.tsx
   * keeps ReposSidebar mounted alongside the file panel (one display:none)
   * so mode toggles don't lose either one's state — but that means this
   * host's own document-level key handlers would otherwise still fire while
   * ReposSidebar is the one showing. Read via a ref inside the handlers
   * rather than as a dependency, so the listener doesn't get torn down and
   * rebuilt on every mode change.
   */
  visible: boolean;
  /**
   * Whether expand/collapse survives a remount. The sidebar persists to the
   * shared "expanded_workspaces" pref; a pane does not — closing it loses
   * its expansion by design, and it opens with its root expanded instead.
   */
  persistExpansion: boolean;
  /** Takes a row click's open instead of the default placement on the rail — a persona's pane opens into its own column. */
  onOpenFile?: ((path: string, repoId: string | undefined) => void) | undefined;
  /**
   * True for the sidebar host only. Until some host has been pointed at,
   * nothing holds the key claim; the default host handles keys anyway, which
   * is what preserves the pre-extraction behaviour on a fresh launch where
   * the user has clicked nothing. See active-host.ts.
   */
  defaultKeyClaim?: boolean;
}

export const FileTreeHost = forwardRef<FileTreeHostHandle, FileTreeHostProps>(function FileTreeHost(
  { workspaces, visible, persistExpansion, defaultKeyClaim, onOpenFile },
  ref,
) {
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Stable for this mount: it is the identity the key claim is filed under,
  // so it must not change while the host is on screen.
  const hostId = useRef(`host-${crypto.randomUUID()}`).current;
  const platform = useMemo(() => services.desktop.getPlatform(), []);
  const revealLabel =
    platform === "darwin" ? "Reveal in Finder" : platform === "win32" ? "Reveal in Explorer" : "Reveal in File Manager";

  const treeSearchRef = useRef<SearchSortControlsHandle>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // The click-highlight follows its pane off the rail (#98 review): once
  // the opened file's pane has been SEEN displayed and later isn't —
  // hidden from the pane's ✕, or closed outright — the selection clears.
  // The latch is what keeps the open round trip from clearing it early;
  // see nav-selection.ts.
  const { columns } = useWorkspace();
  const catalogItems = useCatalog().items;
  const selectionWasDisplayedRef = useRef(false);
  useEffect(() => {
    selectionWasDisplayedRef.current = false;
  }, [selectedPath]);
  useEffect(() => {
    if (selectedPath === null) return;
    const paned = new Set(
      columns.flatMap((column) => column.panes.map((pane) => pane.itemId)),
    );
    if (selectionDisplayed(selectedPath, catalogItems, paned)) {
      selectionWasDisplayedRef.current = true;
      return;
    }
    if (
      shouldClearSelection(selectedPath, catalogItems, paned, selectionWasDisplayedRef.current)
    ) {
      setSelectedPath(null);
    }
  }, [selectedPath, columns, catalogItems]);
  const [importModal, setImportModal] = useState<{ folderPath: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [listView, setListView] = useState(() => localStorage.getItem("nav_list_view") === "true");
  const toggleListView = useCallback(() => {
    setListView((prev) => {
      const next = !prev;
      localStorage.setItem("nav_list_view", String(next));
      return next;
    });
  }, []);

  // The `workspaces` prop is a plain array literal from some callers, so
  // everything downstream keys off its CONTENT rather than its identity —
  // otherwise the memos below (and the effects that depend on them) would
  // recompute on every parent render. The old panel memoized this upstream;
  // a pane has no reason to have to.
  const workspacesKey = workspaces.map((w) => `${w.path}\0${w.name}`).join("\u0001");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content, see above
  const stableWorkspaces = useMemo(() => workspaces, [workspacesKey]);
  // Deliberately the PROP's order, not the sorted one: `workspacePaths[0]` is
  // the fallback parent folder for a right-click on empty space.
  const workspacePaths = useMemo(() => stableWorkspaces.map((w) => w.path), [stableWorkspaces]);
  const sortedWorkspaces = useMemo(
    () => [...stableWorkspaces].sort((a, b) => a.name.localeCompare(b.name)),
    [stableWorkspaces],
  );
  const workspacePathsRef = useRef(workspacePaths);
  workspacePathsRef.current = workspacePaths;

  const reposState = useSyncExternalStore(
    reposStore.subscribe,
    reposStore.getSnapshot,
  );
  const primaryRoot = workspacePaths[0] ?? null;
  const navStatus = useMemo(() => {
    const repo = repoForAbsPath(primaryRoot);
    if (!repo) return resolveNavStatus(null);
    const entry = reposState.statuses[repo.id];
    return resolveNavStatus({
      kind: repo.kind,
      status: entry?.status,
      error: entry?.error,
    });
  }, [primaryRoot, reposState.statuses]);

  const [treeSortMode, setTreeSortMode] = useState<SortMode>("alpha-desc");
  const sortMode = treeSortMode;

  // Workspace expand/collapse state
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());
  const [pendingExpandAll, setPendingExpandAll] = useState<Set<string>>(new Set());

  // Read from inside callbacks with empty dep arrays (toggleWorkspace), so
  // it has to be a ref rather than the prop closed over.
  const persistExpansionRef = useRef(persistExpansion);
  persistExpansionRef.current = persistExpansion;
  /** `saveExpandedWorkspaces`, or nothing on a host that does not persist. */
  const persistExpanded = useCallback((next: Set<string>) => {
    if (persistExpansionRef.current) saveExpandedWorkspaces(next);
  }, []);

  // Refs for each workspace's imperative handle
  const workspaceRefsMap = useRef(new Map<string, RefObject<WorkspaceFileTreeHandle | null>>());

  const getWorkspaceRef = useCallback((wsPath: string) => {
    let r = workspaceRefsMap.current.get(wsPath);
    if (!r) {
      r = newRef<WorkspaceFileTreeHandle>();
      workspaceRefsMap.current.set(wsPath, r);
    }
    return r;
  }, []);

  // Assemble flat items lazily from workspace refs
  const isSearching = searchQuery.trim().length > 0;
  const getAllFlatItems = useCallback(() => {
    const items: FlatItem[] = [];
    for (const ws of sortedWorkspaces) {
      if (!isSearching && !expandedWorkspaces.has(ws.path)) continue;
      const r = workspaceRefsMap.current.get(ws.path);
      if (r?.current) items.push(...r.current.flatItems);
    }
    return items;
  }, [sortedWorkspaces, expandedWorkspaces, isSearching]);

  const focusSearch = useCallback(() => {
    treeSearchRef.current?.focusSearch();
  }, []);

  useImperativeHandle(ref, () => ({ focusSearch }), [focusSearch]);

  // The key claim is per mount, and a host that goes away must not keep it —
  // otherwise closing a tree pane would leave the sidebar unable to handle
  // an arrow key until something else was clicked.
  useEffect(() => {
    return () => releaseTreeHostKeys(hostId);
  }, [hostId]);

  useEffect(() => {
    services.prefs.get(TREE_SORT_MODE_STORAGE_KEY).then((v) => {
      if (typeof v === "string" && sortModeOrder.includes(v as SortMode)) {
        setTreeSortMode(v as SortMode);
      }
    });
  }, []);

  // Load persisted expanded workspaces. A non-persisting host (a pane) skips
  // the pref entirely and opens with every root expanded — a fresh pane
  // showing a collapsed root would be a pane showing nothing.
  useEffect(() => {
    if (!persistExpansionRef.current) {
      setExpandedWorkspaces(new Set(workspacePaths));
      return;
    }
    services.prefs
      .get("expanded_workspaces")
      .then((stored) => {
        if (Array.isArray(stored) && stored.length > 0) {
          setExpandedWorkspaces(new Set(stored as string[]));
        } else {
          // Default: expand all
          setExpandedWorkspaces(new Set(workspacePaths));
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time mount
  }, []);

  // When the roots change, prune expanded state
  const workspacePathsKey = workspacePaths.join("\0");
  const prevWorkspacesKeyRef = useRef(workspacePathsKey);

  useEffect(() => {
    const changed = workspacePathsKey !== prevWorkspacesKeyRef.current;
    prevWorkspacesKeyRef.current = workspacePathsKey;

    if (changed) {
      const roots = new Set(workspacePaths);
      setExpandedWorkspaces((prev) => {
        const valid = new Set<string>();
        for (const p of prev) {
          if (roots.has(p)) valid.add(p);
        }
        if (valid.size === 0) return roots;
        return valid;
      });
      // Clean up refs for the root that's no longer scoped
      for (const key of workspaceRefsMap.current.keys()) {
        if (!roots.has(key)) {
          workspaceRefsMap.current.delete(key);
        }
      }
    }
  }, [workspacePathsKey, workspacePaths]);

  useEffect(() => {
    return services.files.onFileRenamed((oldPath, newPath) => {
      setSelectedPath((current) => (current === oldPath ? newPath : current));
    });
  }, []);

  useEffect(() => {
    return services.desktop.onFileSelected((path) => {
      setSelectedPath(path);
    });
  }, []);

  // Expand ancestors when a file is selected externally
  useEffect(() => {
    if (!selectedPath) return;
    const ws = workspacePaths.find((p) => isSubpath(p, selectedPath));
    if (!ws) return;

    // Ensure workspace is expanded
    setExpandedWorkspaces((prev) => {
      if (prev.has(ws)) return prev;
      const next = new Set(prev);
      next.add(ws);
      persistExpanded(next);
      return next;
    });

    // Call expandAncestors on the workspace ref
    const r = workspaceRefsMap.current.get(ws);
    r?.current?.expandAncestors(selectedPath);
  }, [selectedPath, workspacePaths, persistExpanded]);

  useEffect(() => {
    return services.files.onFilesDeleted((paths) => {
      setSelectedPath((current) => (current && paths.includes(current) ? null : current));
    });
  }, []);

  // Expand folder helper (used by drag-drop and create operations)
  const expandFolder = useCallback(
    (path: string) => {
      // Find the workspace this path belongs to and notify it
      for (const ws of workspacePaths) {
        if (path === ws || isSubpath(ws, path)) {
          const r = workspaceRefsMap.current.get(ws);
          if (r?.current) {
            // expandAncestors also expands the target dir
            r.current.expandAncestors(path + "/dummy");
          }
          break;
        }
      }
    },
    [workspacePaths],
  );

  async function createFileInFolder(folderPath: string, name: string) {
    let fileName = name ? (name.endsWith(".md") ? name : `${name}.md`) : "Untitled.md";

    const entries = await services.files.readDir(folderPath);
    const existingNames = new Set(entries.map((e) => e.name.toLowerCase()));

    if (existingNames.has(fileName.toLowerCase())) {
      const stem = fileName.replace(/\.md$/, "");
      let n = 2;
      while (existingNames.has(`${stem} ${n}.md`.toLowerCase())) {
        n++;
      }
      fileName = `${stem} ${n}.md`;
    }

    const filePath = `${folderPath}/${fileName}`;
    const frontmatter = ["---", 'type: "note"', "---", ""].join("\n");
    expandFolder(folderPath);
    await services.files.writeFile(filePath, frontmatter);
  }

  async function createFolderInFolder(parentFolder: string) {
    let folderName = "New Folder";
    const entries = await services.files.readDir(parentFolder);
    const existingNames = new Set(entries.map((e) => e.name.toLowerCase()));

    if (existingNames.has(folderName.toLowerCase())) {
      let n = 2;
      while (existingNames.has(`New Folder ${n}`.toLowerCase())) {
        n++;
      }
      folderName = `New Folder ${n}`;
    }

    const folderPath = `${parentFolder}/${folderName}`;
    await services.files.createDir(folderPath);
    expandFolder(parentFolder);
    inlineRename.startRename(folderPath, folderName);
  }

  const deleteFile = useCallback(async (path: string) => {
    if (workspacePathsRef.current.includes(path)) return;
    await services.files.trashFile(path);
  }, []);

  const selectFolder = useCallback((path: string) => {
    services.desktop.selectFolder(path);
  }, []);

  // The old flow sent to main which routed to the viewer webview. This
  // opens the file directly on the workspace store instead — no round trip.
  // nav also calls selectFile(null) to clear its own visual selection; that
  // has no workspace-store equivalent (there's no "active item" to clear
  // just because the tree deselected), so it only updates local state.
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const selectFile = useCallback((path: string | null) => {
    setSelectedPath(path);
    if (path === null) return;
    const repoId = repoForAbsPath(path)?.id;
    if (onOpenFileRef.current) onOpenFileRef.current(path, repoId);
    else openFile(path, repoId ? { repoId } : {});
  }, []);

  const multiSelect = useMultiSelect(getAllFlatItems, selectFile);
  const multiSelectRef = useRef(multiSelect);
  multiSelectRef.current = multiSelect;

  const inlineRename = useInlineRename(async (oldPath: string, newName: string) => {
    await services.files.renameFile(oldPath, newName);
  });
  const inlineRenameRef = useRef(inlineRename);
  inlineRenameRef.current = inlineRename;

  // Files dropped from the OS onto a tree row — the shared sidebar import
  // seam (use-file-import.ts). Selected, not opened: opening a 40MB binary
  // because you filed it is a bad surprise. A multi-file drop selects
  // nothing (the hook only reports single-file successes).
  const { transfer, dismissTransfer, importFiles } = useFileImport({
    onSingleImported: setSelectedPath,
  });

  const onMove = useCallback(async (sourcePaths: string[], targetFolder: string) => {
    for (const p of sourcePaths) {
      await services.files.moveFile(p, targetFolder);
    }
  }, []);

  const dragDrop = useDragDrop(onMove, expandFolder, undefined, importFiles);

  const stableDragStart = useCallback(
    (e: React.DragEvent, path: string) => dragDrop.handleDragStart(e, path, multiSelectRef.current.selected),
    [dragDrop.handleDragStart],
  );

  const externalHint =
    dragDrop.externalTargetFolder !== null
      ? dropHintText("sidebar", { remote: isCloudPath(dragDrop.externalTargetFolder) })
      : null;

  const cycleSortMode = useCallback(() => {
    setTreeSortMode((currentMode) => {
      const currentIndex = sortModeOrder.indexOf(currentMode);
      const nextIndex = (currentIndex + 1) % sortModeOrder.length;
      const newMode = sortModeOrder[nextIndex] ?? currentMode;
      services.prefs.set(TREE_SORT_MODE_STORAGE_KEY, newMode);
      return newMode;
    });
  }, []);

  // #98 step 3: every sort mode in one native menu instead of hidden
  // behind a blind cycle. The current mode is marked in its label — the
  // ContextMenuItem shape has no checked flag, and growing the shared type
  // for one caller isn't worth it.
  const openSortMenu = useCallback(async () => {
    const selected = await services.desktop.showContextMenu(
      sortModeOrder.map((mode) => ({
        id: mode,
        label: `${mode === treeSortMode ? "✓  " : "     "}${sortModeLabels[mode]}`,
      })),
    );
    if (selected && sortModeOrder.includes(selected as SortMode)) {
      setTreeSortMode(selected as SortMode);
      void services.prefs.set(TREE_SORT_MODE_STORAGE_KEY, selected);
    }
  }, [treeSortMode]);

  const handlePlusClick = useCallback(async (folderPath: string) => {
    const result = await services.desktop.showContextMenu(
      [{ id: "new-note", label: "New Note" }, ...importWebArticleItems()],
    );
    if (result === "new-note") {
      createFileInFolder(folderPath, "");
    } else if (result === "import-web-article") {
      setImportModal({ folderPath });
    }
  }, []);

  const handleContextMenu = useCallback(
    async (_e: React.MouseEvent, item: FlatItem | null) => {
      const ms = multiSelectRef.current;
      const wsPaths = workspacePathsRef.current;
      const multiSelected = ms.selected.size > 1;

      // Only reveal-in-Finder has no browser equivalent (it shells out to
      // the OS file manager) — hidden behind capabilities.revealInFinder.
      // "Open in Terminal" is an in-app round trip (nav:open-in-terminal ->
      // main forwards -> renderer creates a terminal item), not an OS
      // action, so a browser shim can honour it and it stays unconditional.
      const revealAndTerminalItems: ContextMenuItem[] = [
        ...(services.desktop.capabilities.revealInFinder
          ? [{ id: "reveal-in-finder", label: revealLabel }]
          : []),
        ...NEW_SESSION_MENU,
      ];

      let menuItems: ContextMenuItem[];

      if (multiSelected) {
        menuItems = [{ id: "delete", label: `Delete ${ms.selected.size} Items` }];
      } else if (!item) {
        menuItems = [
          { id: "new-file", label: "New File" },
          { id: "new-folder", label: "New Folder" },
        ];
      } else if (item.kind === "workspace") {
        menuItems = [
          { id: "download", label: "Download…" },
          { id: "new-file", label: "New File" },
          { id: "new-folder", label: "New Folder" },
          { id: "open-as-pane", label: "Open as pane" },
          ...importWebArticleItems(),
          { id: "separator", label: "" },
          { id: "copy-path", label: "Copy Filepath" },
          ...revealAndTerminalItems,
        ];
      } else if (item.kind === "folder") {
        const isRoot = wsPaths.includes(item.path);
        menuItems = [
          { id: "download", label: "Download…" },
          { id: "new-file", label: "New File" },
          { id: "new-folder", label: "New Folder" },
          { id: "open-as-pane", label: "Open as pane" },
          ...importWebArticleItems(),
          ...(!isRoot
            ? [
                { id: "separator", label: "" },
                { id: "rename", label: "Rename" },
                { id: "delete", label: "Delete" },
              ]
            : []),
          { id: "separator", label: "" },
          { id: "copy-path", label: "Copy Filepath" },
          ...revealAndTerminalItems,
        ];
      } else {
        menuItems = [
          { id: "download", label: "Download…" },
          { id: "rename", label: "Rename" },
          { id: "delete", label: "Delete" },
          { id: "separator", label: "" },
          { id: "copy-path", label: "Copy Filepath" },
          ...revealAndTerminalItems,
        ];
      }

      const parentFolder = !item
        ? (wsPaths[0] ?? "")
        : item.kind === "workspace" || item.kind === "folder"
          ? item.path
          : parentPath(item.path);

      const action = await services.desktop.showContextMenu(
        await installedAgentMenu(menuItems, resolveMachineId(repoForAbsPath(parentFolder)?.id)),
      );
      if (!action) return;
      const launch = launchChoiceOf(action);
      if (launch) {
        services.desktop.openInTerminal(parentFolder, launch);
        return;
      }

      switch (action) {
        case "download":
          if (item) {
            setDownloadError(null);
            try { await services.files.downloadFile(item.path); }
            catch (error) { setDownloadError(error instanceof Error ? error.message : "Could not download item"); }
          }
          break;
        case "new-file":
          await createFileInFolder(parentFolder, "");
          break;
        case "new-folder":
          await createFolderInFolder(parentFolder);
          break;
        case "open-as-pane": {
          if (!item) break;
          const repo = repoForAbsPath(item.path);
          openTreePane({
            repoId: repo?.id ?? null,
            root: item.path,
            name: treePaneNameFor(item.path, repo),
          });
          break;
        }
        case "import-web-article":
          if (item) {
            setImportModal({ folderPath: item.path });
          }
          break;
        case "rename":
          if (item) inlineRenameRef.current.startRename(item.path, item.name);
          break;
        case "delete":
          if (multiSelected) {
            for (const path of ms.selected) {
              if (wsPaths.includes(path)) continue;
              await services.files.trashFile(path);
            }
            ms.clearSelection();
          } else if (item && !wsPaths.includes(item.path)) {
            await services.files.trashFile(item.path);
          }
          break;
        case "copy-path":
          if (item) navigator.clipboard.writeText(item.path);
          break;
        case "reveal-in-finder":
          if (item) services.desktop.revealInFinder(item.path);
          break;
        case "terminal":
          if (item)
            services.desktop.openInTerminal(
              item.kind === "folder" || item.kind === "workspace" ? item.path : parentPath(item.path),
            );
          break;
      }
    },
    [expandFolder, revealLabel],
  );

  // Workspace toggle (normal + alt-click recursive)
  const toggleWorkspace = useCallback(
    (path: string, recursive: boolean) => {
      setExpandedWorkspaces((prev) => {
        const wasExpanded = prev.has(path);

        if (recursive && wasExpanded) {
          const wsRef = workspaceRefsMap.current.get(path);
          wsRef?.current?.collapseAllDirs();
          const next = new Set(prev);
          next.delete(path);
          persistExpanded(next);
          return next;
        }

        if (recursive && !wasExpanded) {
          setPendingExpandAll((p) => {
            const next = new Set(p);
            next.add(path);
            return next;
          });
          const next = new Set(prev);
          next.add(path);
          persistExpanded(next);
          return next;
        }

        const next = new Set(prev);
        if (wasExpanded) {
          next.delete(path);
        } else {
          next.add(path);
        }
        persistExpanded(next);
        return next;
      });
    },
    [persistExpanded],
  );

  const handleExpandAllComplete = useCallback((wsPath: string) => {
    setPendingExpandAll((prev) => {
      const next = new Set(prev);
      next.delete(wsPath);
      return next;
    });
  }, []);

  // Keyboard navigation (arrow keys) — at component level
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const lastSelectedIndexRef = useRef<number>(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const navigateItems = useCallback(
    (direction: "up" | "down", shiftKey: boolean) => {
      const allNavigable: FlatItem[] = [];
      for (const ws of sortedWorkspaces) {
        if (!isSearching && !expandedWorkspaces.has(ws.path)) continue;
        const r = workspaceRefsMap.current.get(ws.path);
        if (r?.current) {
          allNavigable.push(...r.current.navigableItems);
        }
      }
      if (allNavigable.length === 0) return;

      const effectivePath = multiSelect.cursor ?? selectedPath;
      let currentIndex = allNavigable.findIndex((d) => d.path === effectivePath);

      if (currentIndex < 0 && lastSelectedIndexRef.current >= 0) {
        currentIndex = Math.min(lastSelectedIndexRef.current, allNavigable.length - 1);
      }

      let nextIndex: number;
      if (direction === "down") {
        nextIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, allNavigable.length - 1);
      } else {
        nextIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0);
      }

      lastSelectedIndexRef.current = nextIndex;
      const next = allNavigable[nextIndex];
      if (!next) return;

      multiSelect.handleClick(next.path, { metaKey: false, shiftKey });

      // Scroll into view
      const container = containerRef.current;
      const el = container?.querySelector(`[data-item-id="${CSS.escape(next.path)}"]`);
      if (el && container) {
        const elRect = el.getBoundingClientRect();
        const boxRect = container.getBoundingClientRect();
        const top = elRect.top - boxRect.top;
        const bottom = elRect.bottom - boxRect.top;

        if (top < 0) {
          container.scrollTop += top;
        } else if (bottom > container.clientHeight) {
          container.scrollTop += bottom - container.clientHeight;
        }
      }
    },
    [sortedWorkspaces, expandedWorkspaces, isSearching, selectedPath, multiSelect.cursor, multiSelect.handleClick],
  );

  // Arrow key handler — scoped to this host's own container focus (a
  // shared document now hosts terminals/editors too, see focus-guard.ts),
  // and then to whether this host is the one holding the key claim
  // (active-host.ts) — several hosts can be mounted at once, and all of
  // them read a body-focused document as "focus is still here".
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!visibleRef.current) return;
      if (!treeHostHoldsKeys(hostId, defaultKeyClaim ?? false)) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (!shouldHandleSidebarKey(rootRef.current, document.activeElement, document.body)) return;

      e.preventDefault();
      navigateItems(e.key === "ArrowDown" ? "down" : "up", e.shiftKey);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigateItems, hostId, defaultKeyClaim]);

  // Scroll selected item into view
  useEffect(() => {
    if (!selectedPath || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-item-id="${CSS.escape(selectedPath)}"]`);
    if (!el) return;
    const container = containerRef.current;
    const elRect = el.getBoundingClientRect();
    const boxRect = container.getBoundingClientRect();
    const top = elRect.top - boxRect.top;
    const bottom = elRect.bottom - boxRect.top;

    if (top < 0) {
      container.scrollTop += top;
    } else if (bottom > container.clientHeight) {
      container.scrollTop += bottom - container.clientHeight;
    }
  }, [selectedPath]);

  // F2, Delete, Escape key handlers — same focus scoping and key claim as
  // the arrow keys.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!visibleRef.current) return;
      if (!treeHostHoldsKeys(hostId, defaultKeyClaim ?? false)) return;
      if (!shouldHandleSidebarKey(rootRef.current, document.activeElement, document.body)) return;

      const ir = inlineRenameRef.current;
      const ms = multiSelectRef.current;
      const sel = selectedPathRef.current;

      if (e.key === "F2" && sel) {
        const items = getAllFlatItems();
        const item = items.find((i) => i.path === sel);
        if (item) {
          e.preventDefault();
          ir.startRename(item.path, item.name);
        }
      }

      if ((e.key === "Delete" || e.key === "Backspace") && ms.selected.size > 0) {
        e.preventDefault();
        const wsPaths = workspacePathsRef.current;
        for (const path of ms.selected) {
          if (wsPaths.includes(path)) continue;
          void services.files.trashFile(path);
        }
        ms.clearSelection();
      }

      if (e.key === "Escape") {
        if (ir.renamingPath) {
          e.preventDefault();
          ir.cancelRename();
        } else if (sel) {
          e.preventDefault();
          selectFile(null);
        } else {
          ms.clearSelection();
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectFile, getAllFlatItems, hostId, defaultKeyClaim]);

  return (
    <div
      className="file-tree-host"
      ref={rootRef}
      // Capture, not bubble: a pointer down on a tree row is stopped by
      // plenty of handlers on the way up, and the claim has to be taken
      // whichever part of the host was aimed at.
      onPointerDownCapture={() => claimTreeHostKeys(hostId)}
    >
      {/* #98: the search row sits OUTSIDE .workspace-content's inset
          padding, as a direct child of the flex column, so it spans the
          panel edge to edge. */}
      <div className="nav-search-row">
        <SearchSortControls
          ref={treeSearchRef}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          sortMode={sortMode}
          onCycleSortMode={cycleSortMode}
          searchPlaceholder="Search"
          // No shortcut label: nothing binds ⌘K to this field, and a hint
          // that promises one is worse than none (Paul, 2026-09-19).
          onArrowNav={navigateItems}
          hideSort
        />
        {/* The view/sort controls trail the search field. They used to trail
            the panel's scope header instead; they moved down here when the
            tree host was extracted, because a tree pane has no scope header
            and both consumers need them — and because their state (list
            view, sort mode) lives in this component either way. Provisional
            placement: the options UI is #98's deferred step 3, and these
            keep the functionality reachable meanwhile. */}
        {/* Names the mode you are IN, not the one a click would take you
            to. Its neighbour is the sort control, which reads "Sort: Name"
            — the mode it is on — so a view control advertising its
            destination made the pair disagree about what an icon in this
            row means. No `aria-pressed`: the accessible name already
            carries the state, and a toggle whose name changes with it
            would say "Tree view, not pressed" while tree view was the
            thing on screen. Sort sets the same precedent — it names its
            state and has no pressed state either. */}
        <button
          type="button"
          className="nav-scope-action"
          aria-label={listView ? "List view" : "Tree view"}
          data-tooltip={listView ? "List view" : "Tree view"}
          onClick={toggleListView}
        >
          {listView ? <ListBullets size={12} weight="regular" /> : <TreeStructure size={12} weight="regular" />}
        </button>
        <button
          type="button"
          className="nav-scope-action nav-scope-action-menu"
          aria-label={`Sort: ${sortModeLabels[sortMode]}`}
          aria-haspopup="menu"
          data-tooltip={`Sort: ${sortModeLabels[sortMode]}`}
          onClick={() => void openSortMenu()}
        >
          {sortMode.startsWith("alpha") ? <TextAa size={12} weight="regular" /> : <Clock size={12} weight="regular" />}
          <CaretDown size={8} weight="bold" />
        </button>
      </div>
      <div className="workspace-content">
        {downloadError && <div className="nav-tree-status nav-tree-status-error" role="alert">{downloadError}</div>}
        <div className="table-container items-table">
          <div className="table-wrapper">
            <div
              ref={containerRef}
              className="table-body-scroll scrollbar-hover"
              onDragOver={(event) => {
                if (!event.defaultPrevented && sortedWorkspaces.length === 1) {
                  dragDrop.handleDragOver(event, sortedWorkspaces[0]!.path);
                }
              }}
              onDragLeave={dragDrop.handleDragLeave}
              onDrop={(event) => {
                if (sortedWorkspaces.length === 1) {
                  dragDrop.handleDrop(event, sortedWorkspaces[0]!.path);
                }
              }}
              onContextMenu={(e) => {
                if (e.target === e.currentTarget) {
                  e.preventDefault();
                  handleContextMenu(e, null);
                }
              }}
            >
              {navStatus.kind === "connecting" && (
                <div className="nav-tree-status">
                  <span className="status-dot status-connecting" />
                  Connecting…
                </div>
              )}
              {navStatus.kind === "error" && (
                <div className="nav-tree-status nav-tree-status-error">
                  <span className="status-dot status-error" />
                  {navStatus.message}
                </div>
              )}
              {navStatus.kind === "ready"
                && sortedWorkspaces.map((ws, idx) => (
                <WorkspaceTree
                  key={ws.path}
                  ref={getWorkspaceRef(ws.path)}
                  workspace={ws}
                  isExpanded={expandedWorkspaces.has(ws.path)}
                  onToggleExpand={toggleWorkspace}
                  selectedPath={selectedPath}
                  selectedPaths={multiSelect.selected}
                  onItemClick={multiSelect.handleClick}
                  onCreateFile={createFileInFolder}
                  onPlusClick={handlePlusClick}
                  onDeleteFile={deleteFile}
                  onContextMenu={handleContextMenu}
                  sortMode={sortMode}
                  renamingPath={inlineRename.renamingPath}
                  renameValue={inlineRename.renameValue}
                  renameInputRef={inlineRename.inputRef}
                  onRenameChange={inlineRename.setRenameValue}
                  onRenameConfirm={inlineRename.confirmRename}
                  onRenameCancel={inlineRename.cancelRename}
                  dropTargetPath={dragDrop.dropTargetPath}
                  onDragStart={stableDragStart}
                  onDragOver={dragDrop.handleDragOver}
                  onDragLeave={dragDrop.handleDragLeave}
                  onDrop={dragDrop.handleDrop}
                  onDragEnd={dragDrop.handleDragEnd}
                  onSelectFolder={selectFolder}
                  isFirstWorkspace={idx === 0}
                  searchQuery={searchQuery}
                  listView={listView}
                  initialExpandAll={pendingExpandAll.has(ws.path)}
                  onExpandAllComplete={handleExpandAllComplete}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
      <TransferStrip hint={externalHint} transfer={transfer} onDismiss={dismissTransfer} />
      {importModal && (
        <ImportWebArticleModal
          folderPath={importModal.folderPath}
          onClose={() => setImportModal(null)}
          onImported={(filePath) => {
            setImportModal(null);
            selectFile(filePath);
          }}
        />
      )}
    </div>
  );
});

export default FileTreeHost;
import { installedAgentMenu } from "../items/agent/installed-agent-menu";

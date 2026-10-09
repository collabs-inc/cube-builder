// Ported from src/windows/viewer/src/App.tsx (the old singleton viewer
// webview). The old component drove `selectedPath` from an `onFileSelected`
// IPC event sent by the shell; here it comes straight from the workspace
// item's `filePath` prop — the item IS the unit, so there's no separate
// "which file is the viewer showing" state to keep in sync. Dropped
// entirely: folder mode (`focusedFolder`, `FolderTableView`, `CloseOverlay`
// for it — nav folder clicks only open items now), tile-mode query params
// (`tilePath`/`tileMode`), `CloseOverlay` for files (close is sidebar/Cmd+W
// now), `onNavVisibility` (no per-viewer nav toggle in the merged app), and
// the `onShellBlur` subscription (it only blurred the active element;
// normal DOM focus handles that in a single renderer). Kept: the mtime
// guard, echo suppression via `lastWrittenContentRef`, the stale-load
// token, and the rename flow — which now patches the catalog item via
// `services.catalog.updateItem` (identity moved there — see
// state/catalog.ts) so it re-infers its type from the new extension.
// Monaco (CodeEditorView) and blocknote (ItemDetailView) are pulled in
// lazily so the app's entry chunk stays free of them.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewerItem } from "@port/shared/types";
import { parseFileToViewerItem, serializeViewerItem } from "@port/shared/viewer-item";
import { splitFilepath } from "@port/shared/filepath";
import { isImageFile } from "@port/shared/image";
import { isBrowserPreviewImage } from "@port/shared/browser-image";
import { parseCloudPath } from "@port/shared/path-utils";
import { isPdfFile } from "@port/shared/pdf";
import { fileDraft } from "../services/drafts";
import { extractCoverImageUrl } from "@port/shared/extract-cover-image";
import { ImageView } from "@builder/components/ImageView/ImageView";
import { LoadingPulse } from "@builder/components/LoadingPulse";
import type { OwnedItem } from "@port/shared/catalog";
import { services } from "../services";
import { inferItemType } from "../state/catalog";
import { useAppTheme } from "../hooks/useAppTheme";
import { isMarkdownFile, resolveFileDisplayState, fsChangeTouchesPath, type FileDisplayState } from "./file-item-logic";
// Editor/Blocknote.css is deliberately NOT imported here — it overrides
// BlockNote's own selectors and so must load after them, which only happens
// if it rides along in the lazy editor chunk (Editor.tsx imports it).
import "@builder/components/Markdown/MarkdownContent.css";
import "@builder/components/CodeEditorView/CodeEditorView.css";
import "./FileItem.css";

const ENABLE_STALE_LOAD_GUARD = true;

// Dynamically imported so monaco (CodeEditorView) and blocknote
// (ItemDetailView) never land in the app's entry chunk — only in a chunk
// fetched when a code or markdown item first shows. Their CSS stays a
// static import above: TypeScript's wildcard `declare module '*.css'`
// (from vite/client) doesn't resolve for dynamic `import()` expressions,
// and CSS weight is negligible next to monaco/blocknote's JS.
//
// StrictMode: the old viewer rendered outside StrictMode specifically to
// avoid React 19 dev-mode flushSync warnings BlockNote triggers (see the old
// `src/windows/viewer/src/main.tsx`'s comment). App.tsx keeps StrictMode on
// — it's already caught real bugs on this branch, and a subtree can't opt
// back out of an ancestor's StrictMode — so those flushSync warnings are
// expected, dev-only noise from ItemDetailView/BlockNote here. Accepted as
// the cost of keeping StrictMode's bug-catching; not a regression to chase.
const LazyItemDetailView = lazy(() =>
  import("@builder/components/ItemDetailView").then((m) => ({ default: m.ItemDetailView })),
);

const LazyCodeEditorView = lazy(() =>
  import("@builder/components/CodeEditorView").then((m) => ({ default: m.CodeEditorView })),
);

function LoadingState() {
  return (
    <LoadingPulse className="loading-state" label="Loading file" />
  );
}

export interface FileItemProps {
  item: OwnedItem;
  visible?: boolean;
  onFocus?: () => void;
  /**
   * Suppresses this viewer's own filepath header, for a host whose chrome
   * already shows the path.
   *
   * A rail pane's header shows the item's NAME (`paneTitle`), so the full
   * path underneath adds something. A canvas tile's title bar shows
   * `splitFilepath(filePath)` — the same parent + name split rendered here —
   * so inside a tile the header is the identical string twice, once in the
   * chrome and once in the guest. Fullscreen does not help: the tile keeps
   * its title bar there.
   *
   * A prop rather than a CSS rule scoped to `.tile-guest` because the
   * duplicate should not be rendered at all, and because which chrome a host
   * supplies is the host's fact to state, not something the guest infers
   * from where it happens to be mounted.
   */
  hidePathHeader?: boolean | undefined;
}

export function FileItem({ item, hidePathHeader = false, visible = true, onFocus }: FileItemProps) {
  const filePath = item.filePath ?? null;
  const [fileContent, setFileContent] = useState("");
  const [draftConflict, setDraftConflict] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const [reloadRevision, setReloadRevision] = useState(0);
  useEffect(() => {
    let disposed=false;
    setPreviewUrl(undefined);
    if(filePath && isPdfFile(filePath)) void services.files.previewUrl(filePath).then(url=>{if(!disposed)setPreviewUrl(url)}).catch(error=>{if(!disposed)setFileError(String(error))});
    return ()=>{disposed=true};
  },[filePath]);
  const lastWrittenContentRef = useRef<string | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [fileStats, setFileStats] = useState<{
    ctime: string;
    mtime: string;
  } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [admissionRevision, setAdmissionRevision] = useState(0);
  const isRenamingRef = useRef(false);
  const fileMtimeRef = useRef<string | null>(null);
  const filePathRef = useRef(filePath);
  const latestLoadTokenRef = useRef<symbol | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const pdfRef = useRef<HTMLIFrameElement>(null);
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  filePathRef.current = filePath;

  // A kept-alive editor can outlast the read's connection wait budget.
  // Admission gives a failed load another attempt without reopening it.
  useEffect(() => services.repos.onStatus(event => {
    if (event.status === "open" && event.repoId === item.machineId) {
      setAdmissionRevision(revision => revision + 1);
    }
  }), [item.machineId]);

  // Native PDF documents cannot bubble pointer events into the rail. As
  // with managed previews, observe the host's focused frame without
  // accessing or modifying the isolated document.
  useEffect(() => {
    if (!visible || item.type !== "pdf") return;
    let focused = false;
    const timer = setInterval(() => {
      const next = pdfRef.current !== null && document.activeElement === pdfRef.current;
      if (next && !focused) onFocusRef.current?.();
      focused = next;
    }, 50);
    return () => clearInterval(timer);
  }, [visible, item.type]);

  // Re-read this item's own file when it changes on disk — scoped to
  // filePath via fsChangeTouchesPath so a batch of events touching other
  // open items' files doesn't trigger a reload here.
  useEffect(() => {
    if (!filePath || isImageFile(filePath) || isPdfFile(filePath)) return;

    return services.files.onFsChanged((events) => {
      const currentPath = filePathRef.current;
      if (!currentPath || !fsChangeTouchesPath(events, currentPath)) return;

      services.files.readDocument(currentPath)
        .then(({content, stats}) => {
          if (filePathRef.current !== currentPath) return;
          const draft=fileDraft(currentPath);
          if (draft.read(content,stats.revision ?? stats.mtime)) {
            fileMtimeRef.current = draft.revision;
            // Keep the content and stats from one disk revision together.
            // Updating only stats after our save recreates ViewerItem with
            // old text, which the original editor treats as an external edit.
            setFileContent(content);
            setFileStats(stats);
          }
          setDraftConflict(draft.conflict);
        })
        .catch((err) => {
          console.error("[file-item] failed to re-read file:", err);
        });
    });
  }, [filePath]);

  // Re-check the file when the window regains focus — catches external
  // edits made while the app wasn't foregrounded.
  useEffect(() => {
    const onFocus = () => {
      const currentPath = filePathRef.current;
      if (!currentPath || isImageFile(currentPath) || isPdfFile(currentPath)) return;

      void services.files.readDocument(currentPath).then(({content,stats})=>{
        if(filePathRef.current!==currentPath)return;
        const draft=fileDraft(currentPath);
        if(draft.read(content,stats.revision ?? stats.mtime)){fileMtimeRef.current=draft.revision;setFileContent(content);setFileStats(stats)}
        setDraftConflict(draft.conflict);
      }).catch(error=>console.error('[file-item] refresh failed',error));
    };

    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Load a new path, or retry a failed load when the machine reconnects
  // or its hidden tile reopens. Loaded editors keep their unsaved content.
  const prevPathRef = useRef(filePath);
  useEffect(() => {
    const pathChanged = filePath !== prevPathRef.current;
    prevPathRef.current = filePath;

    if (pathChanged && isRenamingRef.current) {
      isRenamingRef.current = false;
      latestLoadTokenRef.current = null;
      setLoadedPath(filePath);
      setFileError(null);
      return;
    }

    if (!filePath) {
      latestLoadTokenRef.current = null;
      fileMtimeRef.current = null;
      lastWrittenContentRef.current = null;
      setFileContent("");
      setLoadedPath(null);
      setFileStats(null);
      setFileError(null);
      return;
    }

    if (!pathChanged && loadedPath === filePath && !fileError && reloadRevision === 0) return;
    if (!pathChanged && !visible) return;

    const path = filePath;
    const loadToken = Symbol("file-item-load");
    latestLoadTokenRef.current = loadToken;

    setFileError(null);

    if (isImageFile(path) || isPdfFile(path)) {
      setFileContent("");
      setLoadedPath(path);
      setFileError(null);
      services.files
        .getFileStats(path)
        .then((stats) => {
          if (ENABLE_STALE_LOAD_GUARD && latestLoadTokenRef.current !== loadToken) return;
          setFileStats(stats);
        })
        .catch(() => {});
      return;
    }

    services.files.readDocument(path)
      .then(({content, stats}) => {
        if (
          (ENABLE_STALE_LOAD_GUARD && latestLoadTokenRef.current !== loadToken) ||
          (ENABLE_STALE_LOAD_GUARD && filePathRef.current !== path)
        ) {
          return;
        }
        const draft=fileDraft(path);
        draft.read(content,stats.revision ?? stats.mtime);
        setFileContent(draft.value ?? content);
        setDraftConflict(draft.conflict);
        setLoadedPath(path);
        setFileStats(stats);
        fileMtimeRef.current = fileDraft(path).revision;
        setFileError(null);
      })
      .catch((err) => {
        if (
          (ENABLE_STALE_LOAD_GUARD && latestLoadTokenRef.current !== loadToken) ||
          (ENABLE_STALE_LOAD_GUARD && filePathRef.current !== path)
        ) {
          return;
        }
        setFileError(String(err));
      });
  }, [filePath, visible, admissionRevision, reloadRevision]);

  // Reset scroll to the top whenever a different file is opened. Keyed on
  // loadedPath so in-place reloads (fs change, focus) that only refresh
  // content keep the reader's position.
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [loadedPath]);

  const viewerItem = useMemo<ViewerItem | null>(() => {
    if (!loadedPath || fileError) return null;
    return parseFileToViewerItem(loadedPath, fileContent, fileStats ?? undefined);
  }, [loadedPath, fileContent, fileError, fileStats]);

  const [coverImageFailed, setCoverImageFailed] = useState(false);

  const coverImageReference = useMemo(() => {
    if (!viewerItem || !loadedPath || !isMarkdownFile(loadedPath)) return null;
    return extractCoverImageUrl(viewerItem.text ?? "", viewerItem.frontmatter, loadedPath);
  }, [viewerItem, loadedPath]);
  const [coverImageUrl,setCoverImageUrl] = useState<string|null>(null);
  useEffect(()=>{
    let active=true;
    setCoverImageUrl(null);
    if(coverImageReference?.startsWith('cube-file:')) {
      const url=new URL(coverImageReference);
      void services.files.previewUrl(decodeURIComponent(url.pathname)).then(value=>{if(active)setCoverImageUrl(value)}).catch(()=>{if(active)setCoverImageFailed(true)});
    } else setCoverImageUrl(coverImageReference);
    return ()=>{active=false};
  },[coverImageReference]);

  useEffect(() => {
    setCoverImageFailed(false);
  }, [coverImageUrl]);

  const hasCoverImage = !!coverImageUrl && !coverImageFailed;

  const saveContent = useCallback(async (path:string, content:string) => {
    const draft=fileDraft(path);
    if(draft.value===null)draft.edit(content);
    lastWrittenContentRef.current=content;
    try {
      const ok=await draft.save(content,async revision=>{
        const result=await services.files.writeFile(path,content,revision??undefined);
        if(!result.ok)throw Object.assign(new Error("File changed on disk"),{code:'file-changed'});
        return result.revision??result.mtime;
      });
      fileMtimeRef.current=draft.revision;
      setDraftConflict(draft.conflict);
      return {ok,mtime:draft.revision??'',conflict:draft.conflict};
    } catch(error) {
      setDraftConflict(draft.conflict);
      if(draft.conflict)return {ok:false,mtime:draft.revision??'',conflict:true};
      throw error;
    }
  },[]);
  const saveViewerText = useCallback(async(text:string)=>{
    if(!loadedPath||!viewerItem||filePathRef.current!==loadedPath)return;
    return saveContent(loadedPath,serializeViewerItem(viewerItem,text));
  },[loadedPath,viewerItem,saveContent]);
  const saveCodeContent = useCallback(async(text:string)=>{
    if(!loadedPath||filePathRef.current!==loadedPath)return;
    return saveContent(loadedPath,text);
  },[loadedPath,saveContent]);

  // Ordering race: `renameFile`'s response and the fs watcher's own
  // file-renamed broadcast (state/file-events.ts, subscribed once at
  // App-level) both end up patching this item's `filePath` via
  // `services.catalog.updateItem` for the same oldPath/newPath pair —
  // whichever arrives first wins; the catalog document only changes once,
  // so the second patch just re-asserts the same values. If the watcher's
  // broadcast wins the race, this item's `filePath` prop — and thus the
  // load effect below — updates to newPath *before* this function reaches
  // `isRenamingRef.current = true`, so that path change runs as an
  // ordinary (redundant but harmless) reload instead of being skipped.
  // This function then still sets `isRenamingRef.current = true` right
  // before its own now-redundant `updateItem` call, leaving the flag
  // dangling until consumed. That's benign: the only thing that can change
  // a mounted item's filePath again is another rename, so the stale flag
  // just gets picked up by (and correctly suppresses the reload for) that
  // next rename.
  const handleRename = useCallback(
    async (newTitle: string) => {
      if (!loadedPath) return;
      try {
        const newPath = await services.files.renameFile(loadedPath, newTitle);
        isRenamingRef.current = true;
        await services.catalog.updateItem(item.machineId, item.id, {
          filePath: newPath,
          type: inferItemType(newPath),
        });
      } catch (err) {
        console.error("[file-item] rename failed:", err);
      }
    },
    [loadedPath, item.machineId, item.id],
  );

  // useAppTheme derives from documentElement's `dark` class (the source of
  // truth @port/shared/dark-mode maintains) via a MutationObserver, so a
  // settings-driven theme change (SettingsModal's ThemeToggle -> main flips
  // nativeTheme.themeSource -> the class flips) retheme this item live —
  // not just an OS-level prefers-color-scheme change.
  const theme = useAppTheme();

  const resolvedDisplayState = resolveFileDisplayState({ filePath, loadedPath, fileError });
  const canPreviewCloudImage =
    resolvedDisplayState.kind === "image" &&
    parseCloudPath(filePath ?? "") !== null &&
    isBrowserPreviewImage(filePath ?? "");
  // The web host can serve cloud images Chromium understands through a
  // short-lived file URL. Other images and PDFs still need desktop support.
  const displayState: FileDisplayState =
    (resolvedDisplayState.kind === "image" || resolvedDisplayState.kind === "pdf") &&
    !services.desktop.capabilities.images &&
    !canPreviewCloudImage
      ? { kind: "error", message: "Images and PDFs are not available in the browser yet" }
      : resolvedDisplayState;
  const displayedPath = loadedPath;
  const editingDisabled = !!filePath && filePath !== loadedPath && !isRenamingRef.current;
  const headerPath = displayState.kind === "loading" ? filePath : displayedPath;
  // Matches the old viewer's `hasFile` gate: the filepath header shows for
  // every real view (loading/markdown/code/image/pdf) but not for "empty"
  // (nothing selected) or "error" (the error message takes over instead).
  const showsHeader =
    !hidePathHeader && item.type !== "image" && displayState.kind !== "empty" && displayState.kind !== "error";

  return (
    <div className={`file-item${item.type === "image" ? " file-item-image" : ""}`}>
      {showsHeader &&
        headerPath &&
        (() => {
          const { parent, name } = splitFilepath(headerPath);
          return (
            <div className="item-filepath">
              <span className="filepath-text" title={headerPath}>
                <span className="filepath-parent">{parent}</span>
                <span className="filepath-name">{name}</span>
              </span>
            </div>
          );
        })()}
      <main ref={mainRef} className="main-content scrollbar-hover">
        {hasCoverImage && (
          <div className="item-cover-image">
            <img
              src={coverImageUrl}
              alt="Cover"
              className="cover-image"
              onError={() => setCoverImageFailed(true)}
            />
          </div>
        )}
        {draftConflict && loadedPath && <div role="alert" className="file-conflict">
          This file changed on disk. Your draft is preserved.
          <button onClick={()=>{void services.desktop.clipboard.writeText(fileDraft(loadedPath).value??'')}}>Copy draft</button>
          <button onClick={()=>{fileDraft(loadedPath).discard();setDraftConflict(false);setLoadedPath(null);setReloadRevision(value=>value+1)}}>Reload from disk</button>
        </div>}
        {displayState.kind === "error" && (
          <div className="empty-state" style={{ color: "#ef4444" }}>
            {displayState.message}
          </div>
        )}
        {displayState.kind === "loading" && <LoadingState />}
        {displayState.kind === "markdown" && viewerItem && (
          <Suspense fallback={<LoadingState />}>
            <LazyItemDetailView
              item={viewerItem}
              onTextChange={saveViewerText}
              onDraftChange={text=>{if(loadedPath)fileDraft(loadedPath).edit(serializeViewerItem(viewerItem,text))}}
              onTitleChange={handleRename}
              theme={theme}
              editingDisabled={editingDisabled}
            />
          </Suspense>
        )}
        {displayState.kind === "code" && displayedPath && (
          <Suspense fallback={<LoadingState />}>
            <LazyCodeEditorView
              filePath={displayedPath}
              content={fileContent}
              onContentChange={saveCodeContent}
              onDraftChange={text=>{if(loadedPath)fileDraft(loadedPath).edit(text)}}
              theme={theme}
              editingDisabled={editingDisabled}
            />
          </Suspense>
        )}
        {displayState.kind === "image" && displayedPath && (
          <ImageView filePath={displayedPath} fileStats={fileStats} theme={theme} loadImage={services.files.getImageFull} />
        )}
        {displayState.kind === "pdf" && displayedPath && (
          <iframe
            ref={pdfRef}
            src={previewUrl}
            sandbox="allow-same-origin"
            style={{ width: "100%", height: "100%", border: "none" }}
            title={displayedPath}
          />
        )}
        {displayState.kind === "cloud-binary" && (
          <div className="cloud-unavailable">
            {displayState.format === "image"
              ? "Images on cloud machines can’t be shown yet."
              : "PDFs on cloud machines can’t be shown yet."}
          </div>
        )}
      </main>
    </div>
  );
}

export default FileItem;

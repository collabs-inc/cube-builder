import { LOCAL_MACHINE_ID } from "@port/shared/types";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { useIsNarrow } from "./hooks/useIsNarrow";
import { useViewportHeightVar } from "./hooks/useViewportHeightVar";
import { useTooltips } from "./hooks/useTooltips";
import { services } from "./services";
import { init as initRepos, repoForAbsPath } from "./state/repos";
import { startLiveStatus } from "./state/live-status";
import { startFileEvents } from "./state/file-events";
import { startWorkspacePersistence } from "./workspace-persistence";
import { effectiveNarrowView, setNarrowView, setSettingsModalOpen, useUiState } from "./state/ui";
import { AppViewport } from "./desktop/apps/AppViewport";
import { configureAppNavigation, useAppNavigation } from "./state/app-navigation";
import { startNavigationHistory } from "./state/navigation-history";
import { installNarrowHistory, noteNarrowItemOpened } from "./state/narrow-history";
import { installUnloadGuard } from "./state/unload-guard";
import { handleShortcut } from "./shortcuts";
import { useWindowDragDrop, workspaceDropHintText } from "./drag-drop";
import { useDropTarget } from "./state/drop-target";
import { createTerminalItem, type CreateTerminalItemOptions } from "./items/TerminalItem";
import { launchFailureMessage } from "./items/terminal-item-logic";
import { resolveMachineId } from "./items/open-file";
import { focusItem, useWorkspace } from "./state/workspace";
import { loadCache, acceptSnapshot, evictMachine, setPairedCloudMachine } from "./state/catalog";
import { startRepoReady } from "./state/repo-ready";
import { startSidebarDisclosure } from "./state/sidebar-disclosure";
import { ConfirmDialogHost } from "./overlays/ConfirmDialog";
import { PromptDialogHost } from "./overlays/PromptDialog";

import { useTreePaneLifecycle } from "./filetree/tree-pane-lifecycle";

// React.lazy so SettingsModal's chunk only loads on first open, not as part
// of the app's entry bundle.
const SettingsModal = lazy(() => import("./overlays/SettingsModal"));

// Seeds the catalog store from localStorage synchronously, at module-eval
// time — same "before first paint" placement as main.tsx's initDarkMode()
// call — so the very first render already has whatever the last session
// cached, rather than painting an empty rail for one frame while a fresh
// snapshot is still in flight. useCatalogBootstrap (below) takes over from
// here once the app is mounted: it doesn't call loadCache() itself.
setPairedCloudMachine(null);
loadCache();
configureAppNavigation({ enabled: true, machineId: LOCAL_MACHINE_ID, accountId: null });

const LOADING_FADE_MS = 350;

function LoadingOverlay({ status, fadeOut }: { status: string; fadeOut: boolean }) {
  return (
    <div id="loading-overlay" className={fadeOut ? "fade-out" : ""}>
      <div id="loading-spinner" />
      <div id="loading-status">{status}</div>
    </div>
  );
}

/** Toggles the platform-win class used by CSS to adjust chrome on Windows. */
function usePlatformClass(): void {
  useEffect(() => {
    const isWindows = services.desktop.getPlatform() === "win32";
    document.documentElement.classList.toggle("platform-win", isWindows);
    document.body.classList.toggle("platform-win", isWindows);
  }, []);
}

/** Loads the persisted workspace on mount and keeps it saved thereafter. */
function useWorkspacePersistence(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const persistence = startWorkspacePersistence();
    let disposed = false;
    void persistence.ready.then(() => { if (!disposed) setReady(true); });

    const onBeforeUnload = (): void => persistence.saveNow();
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      disposed = true;
      persistence.dispose();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);
  return ready;
}

/** Loads the repos store and keeps a catalog item's live status
 * (foreground command, last-touched file, pty exit) in sync — the two
 * pieces of state the repos sidebar renders beyond the catalog store
 * itself. Also wires services.files.onFileRenamed/onFilesDeleted onto the
 * catalog's rename/delete side effects (state/file-events.ts) — these fire
 * app-wide, so they're subscribed once here rather than inside the
 * sidebar itself. */
function useReposAndLiveStatus(): void {
  useEffect(() => {
    const disposeRepos = initRepos();
    const disposeLiveStatus = startLiveStatus();
    const disposeFileEvents = startFileEvents();
    return () => {
      disposeRepos();
      disposeLiveStatus();
      disposeFileEvents();
    };
  }, []);
}

/**
 * Keeps the catalog store live once the app is mounted: `loadCache()`
 * itself already ran at this module's top level (see above) so the first
 * render has whatever was cached, but nothing yet keeps it live or seeds
 * it from an actually-attached daemon. Subscribes
 * `services.catalog.onChanged` straight onto `acceptSnapshot` — the same
 * per-machine accept path a cold-start seed uses, per state/catalog.ts's
 * module doc comment — and calls `services.catalog.get()` once to do that
 * seed: it resolves one `{ machineId, catalog }` tree per attached daemon,
 * unmerged, so each entry is fed through `acceptSnapshot` individually
 * rather than treated as an already-merged view.
 *
 * `onEvicted` is the counterpart: a machine this client stops being paired
 * with (sign-out, `machine:destroy`) has no catalog to send, so main says
 * so explicitly and the store drops that tree and its cache.
 */
function useCatalogBootstrap(): void {
  useEffect(() => {
    // Watches for repos/worktrees THIS client added going ready — subscribed
    // here so it is listening before the seed below can deliver one.
    // Listening before repo-ready can open a first session, since that
    // focusItem is a reveal the collapsed sidebar must honour.
    const stopDisclosure = startSidebarDisclosure();
    const stopRepoReady = startRepoReady();
    const unsubscribe = services.catalog.onChanged(({ machineId, catalog }) => {
      acceptSnapshot(machineId, catalog);
    });
    const unsubscribeEvicted = services.catalog.onEvicted(({ machineId }) => {
      evictMachine(machineId);
    });
    services.catalog
      .get()
      .then((trees) => {
        for (const { machineId, catalog } of trees) acceptSnapshot(machineId, catalog);
      })
      .catch((err: unknown) => {
        console.error("[app] catalog seed failed:", err);
      });
    return () => {
      unsubscribe();
      unsubscribeEvicted();
      stopRepoReady();
      stopDisclosure();
    };
  }, []);
}

// Status label is static — main has never produced a "shell:loading-status"
// event to vary it (that IPC channel was dropped as dead code), so this
// overlay only ever shows this one message before onLoadingDone fades it out.
const LOADING_STATUS = "Initializing…";

function useLoadingOverlay(): { visible: boolean; status: string; fadeOut: boolean } {
  const [fadeOut, setFadeOut] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    return services.desktop.onLoadingDone(() => {
      setFadeOut(true);
      setTimeout(() => setVisible(false), LOADING_FADE_MS);
    });
  }, []);

  return { visible, status: LOADING_STATUS, fadeOut };
}

/**
 * Open/close is driven by main (services.desktop.onSettingsToggle —
 * shell:settings — see src/main/index.ts's setSettingsOpen). The gear
 * button (ReposSidebar.tsx) round-trips through
 * services.desktop.toggleSettings (settings:open/close/toggle IPC) rather
 * than setting the flag locally, same as the old shell. Cmd+, and the app
 * menu instead arrive as the "toggle-settings" shortcut action
 * (services.desktop.onShortcut — see attachShortcutListener/sendShortcut
 * in src/main/index.ts), a separate channel nothing previously consumed;
 * this hook forwards that action through the same toggleSettings()
 * round-trip so main's `settingsOpen` flag — which the gear button's IPC
 * also depends on — stays in sync regardless of which surface toggled it.
 *
 * Also restores focus to whatever was focused right before the modal
 * opened, once it closes (if that element is still attached to the
 * document) — ports the old shell's focus-restore behavior. The settings
 * are a panel over a dimmer at every width now (they were the navigator's
 * Settings surface wide, for a while), so the restore is unconditional;
 * the one wide request the desktop shell still diverts — the cloud pane,
 * into the tools panel — lowers the flag before this sees a close.
 */
export function useSettingsModal(isNarrow: boolean): void {
  const lastFocusedRef = useRef<Element | null>(null);

  useEffect(() => {
    return services.desktop.onSettingsToggle((action, pane) => {
      const open = action === "open";
      if (open) lastFocusedRef.current = document.activeElement;
      setSettingsModalOpen(open, pane);
      if (!open) {
        const toFocus = lastFocusedRef.current;
        lastFocusedRef.current = null;
        if (toFocus instanceof HTMLElement && toFocus.isConnected) toFocus.focus();
      }
    });
  }, [isNarrow]);

  useEffect(() => {
    return services.desktop.onShortcut((action) => {
      if (action === "toggle-settings") services.desktop.toggleSettings();
    });
  }, []);
}

/**
 * Wires the central shortcut handler (shortcuts.ts) onto
 * services.desktop.onShortcut, plus a document-level keydown listener for
 * Cmd+N / Cmd+W — ports the old shell's own belt-and-suspenders pairing of
 * the two (renderer.js:1109 + renderer.js:1117-1126): main's
 * before-input-event listener (attachShortcutListener, src/main/index.ts)
 * already forwards these over the same onShortcut channel, but the old
 * shell kept a redundant document keydown for them too, so this does the
 * same rather than dropping coverage. handleShortcut itself applies the
 * settings-modal gate and the active-item no-op, so this listener just
 * translates the raw key event into an action string.
 */
export function useShortcuts(): void {
  useEffect(() => {
    return services.desktop.onShortcut(handleShortcut);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (services.desktop.capabilities.localRepos && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        event.preventDefault();
        return; // Native shortcut dispatch already performs the selection.
      }
      if (!event.metaKey || event.altKey) return;
      if (event.key === "n" && !event.shiftKey) {
        event.preventDefault();
        handleShortcut("new-tile");
      } else if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        handleShortcut(event.shiftKey ? "close-screen" : "close-tile");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

/**
 * "Open in Terminal" (nav context menu / repo row) round-trips through
 * main: services.desktop.openInTerminal(path) sends "nav:open-in-terminal",
 * which main re-emits as "open-terminal" (src/main/ipc-knowledge.ts) rather
 * than replying directly. Both live callers (filetree/FileTreeHost.tsx, ReposSidebar.tsx)
 * already normalize `path` to a directory before sending, matching what the
 * old shell's canvas-target handler did with it (used the received path as
 * cwd directly, no directory check of its own) — so this just opens a
 * terminal item at that cwd, tagging it with the owning repo if any.
 * `path` can be a cloud repo's virtual root (ReposSidebar.tsx's
 * `virtualRootFor`), not only a real local one, so the item's machine is
 * resolved the same way open-file.ts's `openFile` resolves one, via
 * `resolveMachineId` — not assumed local.
 *
 * Folder menus carry an explicit launch choice through this event. Legacy
 * path-only callers still open a shell, independent of saved preferences.
 */
export function useOpenTerminal(): void {
  useEffect(() => {
    return services.desktop.onOpenTerminal((path, launch) => {
      const repoId = repoForAbsPath(path)?.id;
      const machineId = resolveMachineId(repoId);
      if (machineId === null) {
        // Only reachable for a cloud repo with no machine paired. Say
        // so: a silent return here is exactly how "New terminal" on a cloud
        // repo became an invisible no-op on 2026-08-16.
        console.error(`[app] open-terminal: no machine to hand ${path} to (cloud repo, none paired)`);
        return;
      }
      const options: CreateTerminalItemOptions = { machineId, cwd: path, target: "shell", ...launch };
      if (repoId !== undefined) options.repoId = repoId;
      createTerminalItem(options)
        .then((item) => focusItem(item.id, item.type, item.repoId ?? null))
        .catch((err: unknown) => {
          // No row and no tile to show it on (the item was never created),
          // so the console keeps being this path's only channel — with the
          // user-facing sentence rather than the wrapped Error.
          console.error("[app] open-terminal failed:", launchFailureMessage(err));
        });
    });
  }, []);
}

function AppShell() {
  const appNavigation = useAppNavigation();
  const loading = useLoadingOverlay();
  const { settingsModalOpen, settingsPane, narrowView } = useUiState();
  const isNarrow = useIsNarrow();
  const { activeItemId } = useWorkspace();
  const workspaceVisible = true;
  // The sidebar's back/forward arrows walk this; a phone has no arrows.
  useEffect(() => (isNarrow ? undefined : startNavigationHistory()), [isNarrow]);
  const narrowScreen = effectiveNarrowView(narrowView, activeItemId);
  usePlatformClass();
  useTooltips();
  useCatalogBootstrap();
  const workspaceReady = useWorkspacePersistence();
  useReposAndLiveStatus();
  useSettingsModal(isNarrow);
  useShortcuts();
  useOpenTerminal();
  useWindowDragDrop();
  useViewportHeightVar(isNarrow);
  useTreePaneLifecycle();
  const workspaceDropHint = workspaceDropHintText(useDropTarget());

  // Every narrow ENTRY starts from "item" (spec §1: a window dragged narrow
  // keeps showing what it was showing; effectiveNarrowView sends a no-item
  // viewport to home anyway). Resetting while wide is what makes re-entry
  // deterministic instead of inheriting a stale "home".
  useEffect(() => {
    if (!isNarrow) setNarrowView("item");
  }, [isNarrow]);

  // Installs the web build's single history entry for the narrow item
  // screen (state/narrow-history.ts) — a no-op off the web. Exactly one
  // install site: see this file's own controller rationale in the Task 6
  // review ruling.
  useEffect(() => installNarrowHistory(), []);

  // Web-only beforeunload confirm against a habitual Cmd/Ctrl+W closing
  // the tab mid-session (state/unload-guard.ts) — a no-op on Electron.
  useEffect(() => installUnloadGuard(), []);
  useEffect(() => {
    if (isNarrow && workspaceVisible && narrowScreen === "item") noteNarrowItemOpened();
  }, [isNarrow, workspaceVisible, narrowScreen]);

  if (!workspaceReady) return <LoadingOverlay status="" fadeOut={false} />;

  return (
    <div className="app-shell" style={{ "--navigator-width": `${appNavigation.sidebarWidth}px`, "--app-sidebar-space": appNavigation.sidebarOpen ? `min(${appNavigation.sidebarWidth}px, max(0px, calc(100vw - 320px)))` : "0px",
      "--studio-sidebar-width": `${appNavigation.studioSidebarWidth}px`, "--finder-sidebar-width": `${appNavigation.finderSidebarWidth}px` } as React.CSSProperties}>
      <div id="titlebar" />

      {/* inert while the narrow settings modal is open — ports
          setUnderlyingShellInert's semantics (renderer.js:725-729), which
          inert'd #panels (nav + viewer) and the nav toggle button. Wide
          there is no modal: the flag routes to the navigator's Settings
          surface, which lives inside .app-body and must stay usable. Also
          inert while the gate is up — same reasoning, unescapable is
          unescapable: Tab must not walk out of the gate into background
          buttons. inert alone doesn't stop ReposSidebar's document-level
          arrow-key handler (see its own gate check), since that handler
          treats "nothing focused" as "focus is still here" rather than
          requiring focus inside a container. */}
      <div className="app-body" inert={settingsModalOpen}>
        <AppViewport isNarrow={isNarrow} workspaceDropHint={workspaceDropHint} />
      </div>

      <div id="overlay-root" />

      {loading.visible && <LoadingOverlay status={loading.status} fadeOut={loading.fadeOut} />}

      {/* Settings is a modal over the dimmed app, wide and narrow alike. */}
      {settingsModalOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            onClose={() => services.desktop.closeSettings()}
            initialPane={settingsPane}
          />
        </Suspense>
      )}

      <ConfirmDialogHost />
      <PromptDialogHost />

    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}

export default App;

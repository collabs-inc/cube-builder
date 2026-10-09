import { LOCAL_MACHINE_ID } from "@port/shared/types";

import { isInstallationMachine } from "./services/machine";
import { launchChoiceOf, type LaunchChoice } from "@port/shared/launch-menu";
import { goToScreenPosition } from "@port/shared/shortcuts";
/**
 * Central handler for shortcut actions that reach the renderer over
 * `services.desktop.onShortcut` (main's menu accelerators + the
 * before-input-event listener, `src/main/index.ts`'s `sendShortcut`/
 * `attachShortcutListener`) — port of the old shell's `handleShortcut`
 * (`src/windows/shell/src/renderer.js:1014-1107`). The old canvas actions
 * (`toggle-fullscreen-tile`, `focus-tile-right/left/up/down`) are gone along
 * with the canvas, but now have rail successors below: "zoom-pane" and
 * "focus-pane-left/right/up/down".
 *
 * Ownership map — every action the main process can send, and where it's
 * actually handled:
 *  - "new-tile" / "close-tile"                          -> handleShortcut, below
 *  - "focus-pane-left/right/up/down"                    -> handleShortcut, below
 *  - "move-pane-left/right/up/down"                     -> handleShortcut, below
 *  - "zoom-pane"                                        -> handleShortcut, below
 *  - "go-to-screen-1" … "go-to-screen-9"               -> handleShortcut, below
 *  - "toggle-settings"                                  -> App.tsx's useSettingsModal
 *  - "sidebar-files", "studio-sidebar"                  -> AppDesktop.tsx (Desktop.tsx for legacy panel)
 *  - "add-repo"                                      -> Desktop.tsx
 * Each of those other owners already has its own `services.desktop.onShortcut`
 * subscription (Tasks 6/7/10) — do NOT also handle their actions here, or a
 * single shortcut fires twice.
 *
 * "close-tile" hides rather than destroys the active item — same rail
 * verb as the pane header's ✕ (`hideItem`, workspace.ts) — so Cmd+W keeps
 * a terminal's PTY (and every other item type's state) alive for re-display
 * via the sidebar, matching the header button's semantics rather than the
 * old canvas's destroy-on-close.
 *
 * Settings-modal gate: while the settings modal is open, this handler
 * suppresses every one of its own actions (mirroring the old shell's gate,
 * `renderer.js:1015-1018`: `if (settingsModalOpen && action !== "toggle-settings")
 * return`). The other owners listed above already self-gate the same way.
 *
 * Escape-blurs-editable — intentionally dropped: the old viewer blurred
 * whatever editable element was focused on Escape (deleted `viewer/src/
 * App.tsx:420-451`). monaco, blocknote, and xterm each already own their
 * own Escape behavior in this single-renderer app, and a global
 * Escape-blur listener would fight them, so it is not ported here.
 */



import { uiStore, togglePaneZoom } from "./state/ui";
import { reposStore } from "./state/repos";
import { activeColumnsLike, activeScreen, closeScreen, hideItem, isTreePaneId, moveItem, focusDirection, focusItem, screenView, setActiveView, workspaceStore } from "./state/workspace";
import { keyboardMoveTarget, type Direction } from "./state/layout-ops";
import { createTerminalItem, type CreateTerminalItemOptions } from "./items/TerminalItem";
import { launchFailureMessage } from "./items/terminal-item-logic";
import { resolveMachineId } from "./items/open-file";
import { getDefaultAgent } from "./items/agent/default-agent";
import { requestItemFocus } from "./state/item-focus";
import { requestInstantScreenNavigation } from "./state/screen-navigation";

const FOCUS_ACTIONS = new Map<string, Direction>([
  ["focus-pane-left", "left"],
  ["focus-pane-right", "right"],
  ["focus-pane-up", "up"],
  ["focus-pane-down", "down"],
]);
const MOVE_ACTIONS = new Map<string, Direction>([
  ["move-pane-left", "left"],
  ["move-pane-right", "right"],
  ["move-pane-up", "up"],
  ["move-pane-down", "down"],
]);

/**
 * Handles "focus-pane-*" and "move-pane-*" — the only two action families
 * with more than a one-line body, split out of `handleShortcut` to keep
 * both functions under the project's cyclomatic-complexity budget. Returns
 * whether `action` was one of these (so the caller knows not to fall
 * through to anything else), regardless of whether the move/focus itself
 * found a target to act on.
 */
function handleDirectionAction(action: string): boolean {
  const focusDir = FOCUS_ACTIONS.get(action);
  if (focusDir) {
    focusDirection(focusDir);
    return true;
  }
  const moveDir = MOVE_ACTIONS.get(action);
  if (!moveDir) return false;
  const snapshot = workspaceStore.getSnapshot();
  const { activeItemId } = snapshot;
  if (activeItemId) {
    const target = keyboardMoveTarget(activeColumnsLike(snapshot), activeItemId, moveDir);
    if (target) moveItem(activeItemId, target);
  }
  return true;
}

/**
 * Creates a session scoped to the active repo (if any) and gives
 * it a pane — "new-tile"'s body, split out because it's async now: item
 * identity is a `services.catalog.addItem` round-trip
 * (`createTerminalItem`, TerminalItem.tsx), not a synchronous store
 * mutation. The active repo's machine is resolved via
 * `resolveMachineId` (open-file.ts) the same way a nav file-open resolves
 * one; a null result (a cloud repo whose catalog row hasn't synced yet)
 * is a no-op rather than a guess.
 */
async function newTile(launch?: LaunchChoice): Promise<void> {
  const { repos, activeRepoId } = reposStore.getSnapshot();
  const checkoutId = activeRepoId;
  const activeRepo = repos.find(p => p.id === checkoutId);
  if (checkoutId && checkoutId !== "__unscoped__" && !activeRepo) return;
  const machineId = resolveMachineId(activeRepo?.id);
  if (!isInstallationMachine(machineId)) return;
  const choice = launch ?? { view: "conversation", target: await getDefaultAgent() };
  if (!isInstallationMachine(machineId)) return;
  const options: CreateTerminalItemOptions = { machineId: LOCAL_MACHINE_ID, ...choice };
  if (activeRepo?.path !== undefined) options.cwd = activeRepo.path;
  if (activeRepo?.id !== undefined) options.repoId = activeRepo.id;
  const item = await createTerminalItem(options);
  focusItem(item.id, item.type, item.repoId ?? null);
  requestItemFocus(item.id);
}

/**
 * Handles every rail-focused shortcut action — see the module comment for
 * the full ownership map and why "close-tile" hides rather than destroys.
 * Every action is a no-op while the settings modal is open. Focus/move
 * actions are delegated to `handleDirectionAction`, above.
 */
export function handleShortcut(action: string): void {
  if (uiStore.getSnapshot().settingsModalOpen) return;

  const launch = launchChoiceOf(action);
  if (action === "new-tile" || launch) {
    newTile(launch ?? undefined).catch((err: unknown) => {
      // Cmd+N has no row to hang a message on — the tile it would have
      // created is the surface, and there isn't one. The console is the
      // only channel this path has ever had; what changed is that the
      // message is now the user-facing sentence rather than the wrapped
      // Error (see launchFailureMessage).
      console.error("[shortcuts] new-tile failed:", launchFailureMessage(err));
    });
  } else if (action === "close-screen") {
    const screen = activeScreen(workspaceStore.getSnapshot());
    if (screen) closeScreen(screen.id);
  } else if (action === "close-tile") {
    const { activeItemId } = workspaceStore.getSnapshot();
    if (activeItemId) hideItem(activeItemId);
  } else if (action === "zoom-pane") {
    // Tree panes opt out of zoom (Rail.tsx's `zoomed` gate explains why);
    // without this the shortcut would set the ui flag with nothing
    // rendering it, and the next non-tree activation would zoom unasked.
    const { activeItemId } = workspaceStore.getSnapshot();
    if (activeItemId === null || !isTreePaneId(activeItemId)) togglePaneZoom();
  } else if (!handleDirectionAction(action)) {
    const position = goToScreenPosition(action);
    goToScreen(position);
  }
}

/**
 * "go-to-screen-N": Cmd+N selects the Nth screen in the sequence through
 * the same `setActiveView` a ViewSwitcher click uses, but marks the target
 * first so the rail cuts to it instead of sliding (screen-navigation.ts).
 * A digit past the last screen is a no-op, never a new screen; so is the
 * screen already showing, which leaves no mark behind.
 */
function goToScreen(position: number | null): void {
  if (position === null) return;
  const snapshot = workspaceStore.getSnapshot();
  const screen = snapshot.screens[position - 1];
  if (!screen || snapshot.activeView === screenView(screen.id)) return;
  requestInstantScreenNavigation(screen.id);
  setActiveView(screenView(screen.id));
}

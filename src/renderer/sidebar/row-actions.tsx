import { isInstallationMachine } from "../services/machine";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { LOCAL_MACHINE_ID, type ContextMenuItem } from "@port/shared/types";
import type { CatalogRepo, OwnedItem, WorktreeOrigin } from "@port/shared/catalog";
import { isSiteItem } from "@port/shared/site";
import { NEW_AGENT_SUBMENU, NEW_TERMINAL_SUBMENU, launchChoiceOf, newSessionMenu, type LaunchChoice } from "@port/shared/launch-menu";
import { services } from "../services";
import { useCatalog } from "../state/catalog";
import { useRepos } from "../state/repos";
import { activeScreen, focusItem, openTreePane, unmountItem, workspaceStore } from "../state/workspace";
import { nearestScreenPlacing } from "../state/screen-ops";
import { requestItemFocus } from "../state/item-focus";
import { createTerminalItem } from "../items/TerminalItem";
import { launchFailureMessage } from "../items/terminal-item-logic";
import { installedAgentMenu } from "../items/agent/installed-agent-menu";
import { artifactActionMessage, canCopyArtifactUrl, copyArtifactUrl, openArtifactInBrowser } from "../items/artifact-urls";
import { acpConversationsEnabled } from "../feature-flags";
import { confirmDialog } from "../overlays/ConfirmDialog";
import { itemRowScope, repoRowScope, type RowScope } from "./sidebar-order";
import { checkoutBranch, checkoutName, virtualRootFor, verbsForRepo, worktreeCountFor, worktreeGithubUrl, type RepoInfo } from "./group-entries";
import { removeConfirmDetail, repoRemoveConfirmDetail } from "./worktree-copy";
import CreateRepoModal from "./CreateRepoModal";
import { hiddenArtifactsStore, hideArtifact, showArtifacts } from "../state/hidden-artifacts";
import NewWorktreeModal from "./NewWorktreeModal";

export type MoveScope = RowScope | null;
type MenuEvent = { clientX: number; clientY: number };
interface RowMessage { text: string; isError: boolean }

export interface RowActionsOptions {
  moveMenu?: (scope: MoveScope, id: string) => {
    items: ContextMenuItem[];
    // The sidebar's reorder operation is asynchronous; keep awaiting it.
    run(selected: string): boolean | Promise<void>;
  };
  onNavigate?: () => void;
  startRename?: (itemId: string) => void;
  openTreePaneFor?: (repo: RepoInfo) => void;
  /** Host-owned row presentation and selection state. */
  setClosing?: (itemId: string, closing: boolean) => void;
  setActiveRepo?: (repoId: string) => void;
  focusEntry?: (itemId: string) => void;
  getItemTitle?: (itemId: string) => string | undefined;
}

export interface RowActions {
  repoMenu(repo: RepoInfo, event: MenuEvent): Promise<void>;
  checkoutMenu(repo: RepoInfo, event: MenuEvent): Promise<void>;
  worktreeMenu(repo: RepoInfo, worktreeOf: WorktreeOrigin): Promise<void>;
  itemMenu(itemId: string, event: MenuEvent): Promise<void>;
  modals: ReactNode;
  modalOpen: boolean;
  rowMessage: (RowMessage & { repoId: string | null }) | null;
  showRowMessage(repoId: string | null, text: string, isError: boolean): void;
  removalMessage(repo: RepoInfo): RowMessage | null;
  retryRemoval(repo: RepoInfo): (() => void) | undefined;
  newWorktree(parentId: string): Promise<void>;
  pickAgent(repo: RepoInfo, view?: LaunchChoice["view"]): Promise<void>;
  closeItem(itemId: string): Promise<void>;
  renameItem(itemId: string, title: string): void;
}

/** A repository in this app always belongs to the installation machine. */
function machineIdForRepo(repo: RepoInfo): string | null {
  return repo.kind === "local" ? LOCAL_MACHINE_ID : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function repoRemovalFailure(err: unknown, prefix = "Remove failed"): string {
  return `${prefix}: ${errorMessage(err)}`;
}

/**
 * Row message for a failed worktree removal. The daemon refuses to drop a
 * row whose `git worktree add` is still running ("still creating", see
 * cubed/server.ts's removeRepo) — a window that closes on its own, so
 * it reads as "try again", not as a failure the user has to act on.
 */
function removeWorktreeFailure(err: unknown): string {
  const message = errorMessage(err);
  if (message.includes("still creating")) return "Still creating — try again in a moment";
  return repoRemovalFailure(err);
}

/**
 * Copy for the one outcome repo teardown can't repair: the repo is
 * gone from the registry, so its rows had to go too, but some of its
 * sessions outlived the kill and are still running on the machine.
 */
function sessionsLeftRunning(failed: number): string {
  return failed === 1
    ? "1 session could not be ended and is still running."
    : `${failed} sessions could not be ended and are still running.`;
}

/**
 * Where a row message about `item` renders. A repo-less site is drawn under its
 * machine header (machine-sites.ts), whose message slot is keyed by machine id;
 * anything else outside a catalog repo (including a persona's context-folder
 * artifact, whose `repoId` is the persona) reports in the Unscoped group (`null`).
 */
function artifactMessageScope(item: OwnedItem, repos: readonly CatalogRepo[]): string | null {
  if (item.repoId !== undefined) {
    return repos.some(repo => repo.id === item.repoId) ? item.repoId : null;
  }
  return isSiteItem(item) ? item.machineId : null;
}

function useRowActionContext(options: RowActionsOptions) {
  const catalog = useCatalog();
  const reposState = useRepos();
  const availableRepoMenu = useCallback((repo: RepoInfo, items: ContextMenuItem[]) =>
    repo.kind === "local" ? items : items.map(item => ({ ...item, enabled: false })), []);

  const defaultOpenTreePane = useCallback((repo: RepoInfo) => {
    options.setActiveRepo?.(repo.id);
    openTreePane({
      repoId: repo.id, root: virtualRootFor(repo), name: checkoutName(repo) ?? repo.name,
    });
    options.onNavigate?.();
  }, [options.setActiveRepo, options.onNavigate]);
  const moveMenu = useCallback((scope: MoveScope, id: string) =>
    options.moveMenu?.(scope, id) ?? { items: [], run: () => false },
  [options.moveMenu]);
  return {
    catalog, reposState, availableRepoMenu, moveMenu, options,
    handleOpenFiles: options.openTreePaneFor ?? defaultOpenTreePane,
    onNavigate: options.onNavigate,
    setActiveRepo: options.setActiveRepo,
    setClosing: options.setClosing,
    focusEntry: options.focusEntry ?? focusItem,
  };
}
type ActionContext = ReturnType<typeof useRowActionContext>;

function localRemovalMessage(incomplete: boolean, error: string | undefined): RowMessage {
  return {
    text: incomplete ? (error ? repoRemovalFailure(error, "Removal incomplete") : "Removal incomplete") : "Removing…",
    isError: incomplete,
  };
}

function worktreeMenuItems(worktreeOf: WorktreeOrigin, githubUrl: string | null) {
  // A worktree that doesn't exist on disk yet has no directory to open a
  // terminal in, start an agent in, or browse — the same gate the hover
  // actions use.
  const creating = Boolean(worktreeOf.creation);
  const items: ContextMenuItem[] = [
    ...(creating
      ? []
      : [
          ...newSessionMenu(acpConversationsEnabled()),
          { id: "browse-files", label: "Browse files" },
        ]),
    ...(githubUrl ? [{ id: "open-github", label: "Open on GitHub" }] : []),
    ...(worktreeOf.creation?.state === "failed" ? [{ id: "retry", label: "Retry" }] : []),
    // Always last, and always present: a row stuck pending or failed is
    // exactly the one a user most needs to be able to get rid of.
    { id: "remove-worktree", label: "Remove worktree…" },
  ];
  return items;
}

function moveItems(move: ReturnType<ActionContext["moveMenu"]>): ContextMenuItem[] {
  return move.items.length > 0 ? [{ id: "separator", label: "" }, ...move.items] : [];
}

async function runMove(move: ReturnType<ActionContext["moveMenu"]>, selected: string | null) {
  if (selected !== null) await move.run(selected);
}

async function showRepoMenu(
  repo: RepoInfo, items: ContextMenuItem[], move: ReturnType<ActionContext["moveMenu"]>,
  availableRepoMenu: ActionContext["availableRepoMenu"],
) {
  items.push(...moveItems(move));
  const selected = await services.desktop.showContextMenu(await installedAgentMenu(
    availableRepoMenu(repo, items), machineIdForRepo(repo),
  ));
  await runMove(move, selected);
  // Showing hidden rows is this device's own preference: no machine needed.
  if (selected !== "open-github" && selected !== "show-hidden-artifacts" && !isInstallationMachine(machineIdForRepo(repo))) {
    return null;
  }
  return selected;
}

function confirmRepoRemoval(
  repo: RepoInfo, inspect: { dirty: number; unpushedCommits: number } | null,
  repos: RepoInfo[],
) {
  const deletesCheckout = repo.kind === "cloud";
  return confirmDialog({
    message: repo.kind === "local" ? "Remove this repo from Cube?" : `Remove repo "${repo.name}"?`,
    detail: repo.kind === "local"
      ? "Its Cube agents and terminals will stop. "
        + "The repo and all worktrees will stay on disk."
      : repoRemoveConfirmDetail({
      checkout: !deletesCheckout
        ? "kept"
        : repo.kind === "cloud"
          ? "deleted-on-cloud"
          : "deleted",
      inspect,
      branch: checkoutBranch(repo),
      worktreeCount: worktreeCountFor(repos, repo.id),
    }),
    buttons: ["Cancel", "Remove"],
  });
}

async function inspectRepoRemoval(machineId: string, repoId: string) {
  const result = await services.worktrees.inspect(machineId, repoId);
  // A missing checkout has no counts to name, but its row is still removable.
  return result.missing
    ? null : { dirty: result.dirty, unpushedCommits: result.unpushedCommits };
}

function repoMenuItems(repo: RepoInfo, source: CatalogRepo | undefined, hiddenArtifacts: number): ContextMenuItem[] {
  const verbs = verbsForRepo(repo);
  return [
    ...newSessionMenu(acpConversationsEnabled()),
    { id: "separator", label: "" },
    ...verbs.map((v) => ({ id: v.id, label: v.label, enabled: v.enabled })),
    ...(!source?.originUrl ? [{ id: "publish-repo", label: "Publish to GitHub…" }] : []),
    ...(hiddenArtifacts > 0
      ? [{ id: "show-hidden-artifacts", label: `Show hidden artifacts (${hiddenArtifacts})` }]
      : []),
  ];
}

/** The artifacts this device hides that belong to `repoId` or any of its worktrees. */
function hiddenArtifactIds(catalog: { repos: readonly CatalogRepo[]; items: readonly OwnedItem[] }, repoId: string): string[] {
  const hidden = hiddenArtifactsStore.getSnapshot();
  const repoIds = new Set([repoId, ...catalog.repos.filter(row => row.worktreeOf?.repoId === repoId).map(row => row.id)]);
  return catalog.items
    .filter(item => item.type === "artifact" && hidden.has(item.id) && item.repoId !== undefined && repoIds.has(item.repoId))
    .map(item => item.id);
}

function publishTargetFor(machineId: string, repo: RepoInfo, source: CatalogRepo | undefined) {
  return {
    machineId,
    repo: {
      id: repo.id, name: repo.name,
      ...(source?.githubPublish ? { githubPublish: source.githubPublish } : {}),
    },
  };
}

function closeItemConfirmation(item: OwnedItem, title: string | undefined) {
  if ((item.type === "term" || item.type === "agent") && item.ptySessionId) {
    const isAgent = item.type === "agent";
    return confirmDialog({
      message: `Close ${title ?? (isAgent ? "this conversation" : "this terminal")}?`,
      detail: item.role === "persona" && item.cwd?.includes("/.cube/personas/")
        ? `This ends the conversation. Its context folder stays at ${item.cwd}.`
        : isAgent
          ? "This ends the conversation and discards its transcript."
          : "This ends the terminal session.",
      buttons: ["Cancel", "Close"],
    });
  }
  return null;
}

function canOpenHere(id: string): boolean {
  // Offered only when a click would travel away: the item is on another
  // screen and not this one. Anywhere else a click already opens it here.
  const workspaceState = workspaceStore.getSnapshot();
  const current = activeScreen(workspaceState);
  const shownElsewhere = current !== null
    && nearestScreenPlacing(workspaceState.screens, current.id, id) !== null;

  return shownElsewhere;
}

function itemMenuItems(
  item: OwnedItem | undefined, openHere: boolean,
): ContextMenuItem[] {
  return [
    ...(openHere ? [{ id: "open-here", label: "Open here" }] : []),
    ...(item?.type === "artifact" ? [{ id: "open-in-browser", label: "Open in browser" }] : []),
    ...(item && canCopyArtifactUrl(item, services.desktop.capabilities.localRepos)
      ? [{ id: "copy-url", label: "Copy URL" }] : []),
    { id: "rename", label: "Rename" },
    // An artifact exists while it is valid (its file exists, its port
    // serves HTML), so its row offers no removal. It can leave this
    // device's sidebar, though; its repo row's menu brings it back.
    ...(item?.type === "artifact"
      ? [{ id: "hide-artifact", label: "Hide from sidebar" }]
      : [{ id: "close-item", label: "Close" }]),
  ];
}

async function runArtifactAction(
  selected: string | null, item: OwnedItem, repos: readonly CatalogRepo[],
  showRowMessage: ShowRowMessage,
) {
  if (selected === "open-in-browser") {
    try {
      await openArtifactInBrowser(
        item, document.documentElement.classList.contains("dark") ? "dark" : "light",
      );
    } catch (err) {
      showRowMessage(
        artifactMessageScope(item, repos),
        artifactActionMessage(err, "This artifact couldn’t be opened in the browser."), true,
      );
    }
  } else if (selected === "copy-url") {
    try {
      await copyArtifactUrl(item);
    } catch (err) {
      showRowMessage(
        artifactMessageScope(item, repos),
        artifactActionMessage(err, "This URL couldn’t be copied."), true,
      );
    }
  }
}

function useRowMessages() {
  // `repoId: null` addresses the Unscoped group — terminals opened
  // without a repo (`createTerminalItem`, TerminalItem.tsx, called with
  // no `repoId`) live there, and a close failure on one still has to be
  // visible somewhere.
  const [rowMessage, setRowMessage] = useState<
    (RowMessage & { repoId: string | null }) | null
  >(null);

  // A transient per-row message (a success confirmation or an action
  // failure) — success clears itself quickly; a failure sits long enough
  // to actually read, since the row otherwise gives no other sign the
  // action didn't work.
  const showRowMessage = useCallback((repoId: string | null, text: string, isError: boolean) => {
    setRowMessage({ repoId, text, isError });
    setTimeout(
      () => {
        setRowMessage((current) => (current?.repoId === repoId ? null : current));
      },
      isError ? 5000 : 2000,
    );
  }, []);

  return { rowMessage, showRowMessage };
}
type ShowRowMessage = RowActions["showRowMessage"];

function useLocalRemoval({ catalog }: ActionContext) {
  const [removals, setRemovals] = useState<Record<string, {
    operationId: string; state: "running" | "incomplete"; error?: string;
  }>>({});
  const removalOperations = useRef(new Map<string, string>());
  const detachLocal = useCallback(async (repo: RepoInfo) => {
    const persisted = catalog.repos.find(row => row.id === repo.id)?.detachment;
    const operationId = persisted?.operationId
      ?? removalOperations.current.get(repo.id) ?? crypto.randomUUID();
    removalOperations.current.set(repo.id, operationId);
    setRemovals(current => ({ ...current, [repo.id]: { operationId, state: "running" } }));
    try {
      const result = await services.repos.remove(repo.id, operationId);
      removalOperations.current.set(repo.id, result.operationId);
      setRemovals(current => ({ ...current, [repo.id]: {
        operationId: result.operationId,
        state: result.state === "complete" ? "running" : "incomplete",
      } }));
      // Catalog reconciliation removes membership and views only on completion.
    } catch (error) {
      setRemovals(current => ({
        ...current, [repo.id]: { operationId, state: "incomplete", error: errorMessage(error) },
      }));
    }
  }, [catalog.repos]);
  const removalMessage = (repo: RepoInfo): RowMessage | null => {
    if (repo.kind !== "local") return null;
    const local = removals[repo.id];
    const persisted = catalog.repos.find(row => row.id === repo.id)?.detachment;
    if (!local && !persisted) return null;
    const incomplete = local ? local.state === "incomplete" : persisted?.state === "incomplete";
    return localRemovalMessage(incomplete, local?.error);
  };
  const retryRemoval = (repo: RepoInfo) => {
    const persisted = catalog.repos.find(row => row.id === repo.id)?.detachment;
    return repo.kind === "local"
      && (removals[repo.id]?.state === "incomplete" || (!removals[repo.id] && persisted))
      ? () => { void detachLocal(repo); } : undefined;
  };

  return { detachLocal, removalMessage, retryRemoval };
}

function useRowModals({ reposState }: ActionContext) {
  const [publishTarget, setPublishTarget] = useState<{
    machineId: string; repo: Pick<CatalogRepo, "id" | "name" | "githubPublish">;
  } | null>(null);
  // The repo the New Worktree dialog is cutting from, or null when it is
  // closed. An id rather than the repo itself so the dialog always sees
  // the live row, not the one that existed at click time.
  const [worktreeParentId, setWorktreeParentId] = useState<string | null>(null);

  const handleNewWorktree = useCallback(async (parentId: string) => {
    const repo = reposState.repos.find(repo => repo.id === parentId);
    if (!repo || !isInstallationMachine(machineIdForRepo(repo))) return;
    setWorktreeParentId(parentId);
  }, [reposState.repos]);

  const worktreeParent = reposState.repos.find((p) => p.id === worktreeParentId) ?? null;

  // The dialog's parent can vanish under it — the repo removed, or its
  // machine evicted — while it is open. Dropping the id with it keeps the
  // sidebar's arrow keys, which are disabled while that id is set, from
  // being stranded behind a dialog that is no longer rendering.
  useEffect(() => {
    if (worktreeParentId !== null && !worktreeParent) setWorktreeParentId(null);
  }, [worktreeParentId, worktreeParent]);

  return {
    handleNewWorktree, setPublishTarget,
    modalOpen: publishTarget !== null || worktreeParentId !== null,
    modals: <>
      {publishTarget && <CreateRepoModal machineId={publishTarget.machineId}
        repo={publishTarget.repo} onClose={() => setPublishTarget(null)} />}
      <NewWorktreeModal open={worktreeParentId !== null} parent={worktreeParent}
        machineId={worktreeParent ? machineIdForRepo(worktreeParent) : null}
        onClose={() => setWorktreeParentId(null)} />
    </>,
  };
}

function useSessionActions(
  { onNavigate, setActiveRepo }: ActionContext,
  showRowMessage: ShowRowMessage,
) {
  // Shared by both context menus (repo rows and worktree rows): a worktree is
  // where agent work actually happens, so its row offers the same agents its
  // repo does. `virtualRootFor` covers both kinds — a cloud row has no local
  // path, and spawns at `/@cloud/<id>` instead.
  const handleNewSession = useCallback(
    async (repo: RepoInfo, launch: LaunchChoice) => {
      if (!isInstallationMachine(machineIdForRepo(repo))) return;
      const machineId = machineIdForRepo(repo);
      const label = launch.view === "conversation" ? "New agent" : "New terminal";
      if (machineId === null) {
        showRowMessage(repo.id, `${label} failed: repository is not on this installation`, true);
        return;
      }
      try {
        const item = await createTerminalItem({
          machineId,
          cwd: virtualRootFor(repo),
          repoId: repo.id,
          ...launch,
        });
        setActiveRepo?.(repo.id);
        focusItem(item.id, item.type, repo.id);
        // The session is now open on the rail — from the narrow
        // drawer that is a navigation, so the drawer gets out of its way.
        // Only on the success path: a failure leaves its reason in the
        // row message, which is unreadable once the drawer has closed.
        onNavigate?.();
      } catch (err) {
        // `launchFailureMessage`, not `errorMessage`: a machine too old to
        // spawn a conversation adapter, and a harness that isn't installed,
        // each carry a sentence written for the user behind a marker the
        // IPC wrapper would otherwise leave on screen.
        showRowMessage(repo.id, `${label} failed: ${launchFailureMessage(err)}`, true);
      }
    },
    [showRowMessage, onNavigate, setActiveRepo],
  );
  /**
   * The empty-checkout row's click. Offers the SAME agents the context
   * menus do, from the one shared list, so the two entry points cannot
   * drift apart — flat rather than nested, because this is a chooser the
   * user asked for by clicking, not a menu they have to navigate into.
   */
  const handlePickAgent = useCallback(
    async (repo: RepoInfo, view: LaunchChoice["view"] = "conversation") => {
      if (!isInstallationMachine(machineIdForRepo(repo))) return;
      // With conversations gated off (feature-flags.ts) the terminal action
      // is what it was before they existed: a shell, at once, no chooser.
      // The agent chooser stays as it was too — its picks become terminals
      // running the harness, decided in `planLaunch`.
      if (view === "terminal" && !acpConversationsEnabled()) {
        await handleNewSession(repo, { view: "terminal", target: "shell" });
        return;
      }
      const selected = await services.desktop.showContextMenu(await installedAgentMenu(
        view === "conversation" ? NEW_AGENT_SUBMENU : NEW_TERMINAL_SUBMENU,
        machineIdForRepo(repo),
      ));
      const launch = launchChoiceOf(selected);
      if (launch) await handleNewSession(repo, launch);
    },
    [handleNewSession],
  );
  return { handleNewSession, handlePickAgent };
}
type SessionActions = ReturnType<typeof useSessionActions>;

function useWorktreeRemoval(_context: ActionContext, showRowMessage: ShowRowMessage) {
  const handleRetryWorktree = useCallback(
    (repo: RepoInfo) => {
      const machineId = machineIdForRepo(repo);
      if (machineId === null) {
        // Only reachable for a cloud row whose machine isn't known yet, and
        // a worktree row can't exist without the machine that holds it —
        // so this is a transient state, not a failure worth a row message.
        console.warn("[worktrees] retry skipped — no machine for", repo.id);
        return;
      }
      services.worktrees.retry(machineId, repo.id).catch((err: unknown) => {
        console.error("[worktrees] retry failed", err);
      });
    },
    [],
  );
  // Worktree removal's safety property: `git worktree remove` refuses a
  // dirty worktree on its own, but silently discards unpushed commits, so
  // only a row with something on disk to lose gets inspected and confirmed
  // — and `force` is reachable only through that confirmation, which is why
  // forcing has exactly one call site in this file. A row whose worktree
  // never finished creating (pending or failed) has nothing on disk to lose:
  // skip both `inspect` and the dialog, and remove unforced (the daemon
  // prunes such a row instead of running `git worktree remove`).
  //
  // `inspect` sits inside the try because it talks to the daemon and throws
  // for a missing or broken worktree — outside it that rejection would go
  // unhandled and the row would show no sign the action failed.
  const handleRemoveWorktree = useCallback(
    async (repo: RepoInfo, worktreeOf: WorktreeOrigin) => {
      const machineId = machineIdForRepo(repo);
      if (machineId === null) {
        showRowMessage(repo.id, "Remove failed: repository is not on this installation", true);
        return;
      }
      try {
        if (worktreeOf.creation) {
          await services.catalog.removeRepo(machineId, repo.id, { force: false });
          return;
        }
        const inspect = await services.worktrees.inspect(machineId, repo.id);
        // Nothing on disk, so nothing to lose and nothing for a dialog to
        // name. Unforced: the daemon prunes the record rather than running
        // `git worktree remove` against a path that is not there.
        if (inspect.missing) {
          await services.catalog.removeRepo(machineId, repo.id, { force: false });
          return;
        }
        const response = await confirmDialog({
          message: `Remove worktree "${repo.name}"?`,
          detail: removeConfirmDetail(inspect),
          buttons: ["Cancel", "Remove"],
        });
        if (response !== 1) return;
        // Force only here: the dialog has just named exactly what is discarded.
        await services.catalog.removeRepo(machineId, repo.id, { force: true });
      } catch (err) {
        console.error("[worktrees] Remove failed", repo.id, err);
        showRowMessage(repo.id, removeWorktreeFailure(err), true);
      }
    },
    [showRowMessage],
  );
  return { handleRetryWorktree, handleRemoveWorktree };
}
type WorktreeRemoval = ReturnType<typeof useWorktreeRemoval>;

function useWorktreeMenu(
  { catalog, moveMenu, availableRepoMenu, handleOpenFiles }: ActionContext,
  { handleNewSession }: SessionActions,
  { handleRetryWorktree, handleRemoveWorktree }: WorktreeRemoval,
) {
  // A worktree row's context menu is its own thing, not a variant of
  // verbsForRepo's repo verbs — "Open on GitHub"/"Retry" are gated on the
  // row's own worktreeOf fields rather than pool status, and there is no
  // "New worktree…" (a worktree never spawns a worktree of a worktree). The
  // New terminal / New agent pair IS shared with the repo menu: those are
  // about a directory, and a worktree has one.
  const handleWorktreeContextMenu = useCallback(
    async (repo: RepoInfo, worktreeOf: WorktreeOrigin) => {
      const githubUrl = worktreeGithubUrl(worktreeOf.source);
      const items = worktreeMenuItems(worktreeOf, githubUrl);
      const move = moveMenu(repoRowScope(catalog, repo.id), repo.id);
      const selected = await showRepoMenu(repo, items, move, availableRepoMenu);
      const launch = launchChoiceOf(selected);
      if (launch) {
        await handleNewSession(repo, launch);
      } else if (selected === "browse-files") {
        handleOpenFiles(repo);
      } else if (selected === "open-github") {
        if (githubUrl) services.desktop.openExternal(githubUrl);
      } else if (selected === "retry") {
        handleRetryWorktree(repo);
      } else if (selected === "remove-worktree") {
        await handleRemoveWorktree(repo, worktreeOf);
      }
    },
    [
      handleOpenFiles, handleNewSession, handleRetryWorktree, handleRemoveWorktree,
      availableRepoMenu, moveMenu, catalog,
    ],
  );
  return handleWorktreeContextMenu;
}

function useCloseItemsForRepo({ catalog }: ActionContext) {
  // Closes every item belonging to `repo`, killing their sessions in
  // parallel (`services.catalog.removeItem` — cubed's own handler kills
  // the pty and forgets its record before confirming, see server.ts's
  // catalog:remove-item) and then dropping each item's pane *regardless of
  // outcome*.
  //
  // Deliberately a different rule from the single-item close: by the time
  // this runs the repo itself is gone from the registry, so a row kept
  // back for a failed kill would belong to nothing. Callers get the
  // failure count and surface one aggregate message instead. Ported from
  // the shell's `tileManager.closeTilesForRepo` (via workspace.ts's own
  // `closeItemsForRepo`, deleted along with the rest of workspace.ts's
  // item mutators — see task-9-report.md).
  const closeItemsForRepo = useCallback(
    async (repo: RepoInfo): Promise<{ failed: number }> => {
      const machineId = machineIdForRepo(repo);
      const ids = catalog.items.filter((item) => item.repoId === repo.id).map((item) => item.id);
      if (machineId === null || ids.length === 0) {
        for (const id of ids) unmountItem(id);
        return { failed: 0 };
      }
      const results = await Promise.allSettled(
        ids.map((id) => services.catalog.removeItem(machineId, id)),
      );
      for (const id of ids) unmountItem(id);
      return { failed: results.filter((r) => r.status === "rejected").length };
    },
    [catalog.items],
  );
  return closeItemsForRepo;
}

function useRemoveRepo(
  context: ActionContext, showRowMessage: ShowRowMessage,
  detachLocal: ReturnType<typeof useLocalRemoval>["detachLocal"],
) {
  const { reposState } = context;
  const handleRemoveRepo = useCallback(async (repo: RepoInfo) => {
    if (!isInstallationMachine(machineIdForRepo(repo))) return;
    const response = await confirmRepoRemoval(repo, null, reposState.repos);
    if (response !== 1) return;
    await detachLocal(repo);
  }, [reposState.repos, detachLocal]);
  return handleRemoveRepo;
}

function useCheckoutMenu(
  { catalog, moveMenu, availableRepoMenu, handleOpenFiles }: ActionContext,
  { handleNewSession }: SessionActions,
  handleWorktreeContextMenu: RowActions["worktreeMenu"],
) {
  /**
   * A CHECKOUT row's context menu — the repo's own working copy, or one of
   * its worktrees. Never the repo's own menu, which is what issue #139 was:
   * the primary checkout renders as a peer of the worktree rows and used to
   * open the repo menu, so "Remove repo…" sat on a row labeled "Primary
   * worktree" and someone took it for a worktree removal.
   *
   * The primary checkout carries no removal at all. It is a view of the repo
   * rather than a thing of its own — git will not remove a main working tree
   * either (cubed's `worktrees.remove` refuses it outright) — so the verb
   * lives one level up, on the row that actually names the repo.
   *
   * It says so rather than leaving a gap. A worktree row's menu ends in
   * "Remove worktree…", so someone who came here to get rid of something
   * finds nothing where they expected it and learns neither the rule nor
   * where the verb went. The inert item occupies that same last slot and
   * answers both.
   */
  const handleCheckoutContextMenu = useCallback(
    async (repo: RepoInfo, _event: MenuEvent) => {
      if (repo.worktreeOf) {
        await handleWorktreeContextMenu(repo, repo.worktreeOf);
        return;
      }
      // A combined single-checkout row moves among repos; the primary
      // checkout of a repo with worktrees has no siblings of its own rank.
      const combined = !catalog.repos.some((row) => row.worktreeOf?.repoId === repo.id);
      const move = moveMenu(combined ? repoRowScope(catalog, repo.id) : null, repo.id);
      const selected = await services.desktop.showContextMenu(await installedAgentMenu(
        availableRepoMenu(repo, [
          ...newSessionMenu(acpConversationsEnabled()),
          { id: "browse-files", label: "Browse files" },
          { id: "separator", label: "" },
          // `enabled: false` is the whole mechanism: buildTemplate (ipc-misc.ts)
          // renders it greyed out with no click handler, so it can never
          // resolve the menu's promise and needs no branch below.
          {
            id: "primary-not-removable",
            label: "Can't remove primary worktree",
            enabled: false,
          },
          ...moveItems(move),
        ]), machineIdForRepo(repo),
      ));
      await runMove(move, selected);
      if (!isInstallationMachine(machineIdForRepo(repo))) return;
      const launch = launchChoiceOf(selected);
      if (launch) {
        await handleNewSession(repo, launch);
      } else if (selected === "browse-files") {
        handleOpenFiles(repo);
      }
    },
    [
      handleOpenFiles, handleNewSession, handleWorktreeContextMenu,
      availableRepoMenu, moveMenu, catalog,
    ],
  );
  return handleCheckoutContextMenu;
}

function useRepoMenu(
  { catalog, moveMenu, availableRepoMenu, handleOpenFiles }: ActionContext,
  { handleNewSession }: SessionActions,
  { handleNewWorktree, setPublishTarget }: ReturnType<typeof useRowModals>,
  handleRemoveRepo: ReturnType<typeof useRemoveRepo>,
  showRowMessage: ShowRowMessage,
) {
  const openPublish = useCallback((repo: RepoInfo, source: CatalogRepo | undefined) => {
    const machineId = machineIdForRepo(repo);
    if (machineId) setPublishTarget(publishTargetFor(machineId, repo, source));
  }, [setPublishTarget]);
  const handleRepoContextMenu = useCallback(
    async (repo: RepoInfo, _event: MenuEvent) => {
      const source = catalog.repos.find(row => row.id === repo.id);
      const move = moveMenu(repoRowScope(catalog, repo.id), repo.id);
      const hidden = hiddenArtifactIds(catalog, repo.id);
      const selected = await showRepoMenu(
        repo, repoMenuItems(repo, source, hidden.length), move, availableRepoMenu,
      );
      const launch = launchChoiceOf(selected);
      // A cloud repo has no real filesystem root — new-terminal
      // and new-agent target the virtual root instead.
      if (launch) {
        await handleNewSession(repo, launch);

      } else if (selected === "new-worktree") {
        handleNewWorktree(repo.id);
      } else if (selected === "publish-repo") {
        openPublish(repo, source);
      } else if (selected === "show-hidden-artifacts") {
        showArtifacts(hidden);
      } else if (selected === "browse-files") {
        handleOpenFiles(repo);
      } else if (selected === "remove" || selected === "destroy") {
        // Both verbs land here: `handleRemoveRepo` picks the route off the
        // repo's own kind, so the two ids differ only in the menu.
        await handleRemoveRepo(repo);
      }
    },
    [
      handleOpenFiles, handleNewSession, handleNewWorktree, handleRemoveRepo,
      catalog, availableRepoMenu, moveMenu, openPublish,
    ],
  );

  return handleRepoContextMenu;
}

const NO_CLOSING = () => {};

function useCloseEntry(
  { catalog, setClosing = NO_CLOSING, options: { getItemTitle } }: ActionContext,
  showRowMessage: ShowRowMessage,
) {
  // Confirm-then-close, shared by the context menu's Close and the row's
  // trash action: a live session gets a confirm (closing kills it),
  // anything else closes straight away. An agent conversation counts —
  // closing one is MORE destructive than closing a terminal, not less: it
  // ends the session and deletes the transcript with it. There is no
  // separate kill to send, though; cubed's `catalog:remove-item` kills the
  // row's session itself (see below).
  //
  // The row survives until the daemon confirms the session ended, showing a
  // spinner meanwhile; if the kill fails the item stays put with an inline
  // error rather than vanishing while its process keeps running.
  const closeEntry = useCallback(
    async (id: string) => {
      const item = catalog.items.find((i) => i.id === id);
      if (!item) return;
      // No sidebar path removes or hides an artifact: it lives while its
      // file exists or its port serves HTML, and Hide belongs to the tile.
      if (item.type === "artifact") return;
      const confirmation = closeItemConfirmation(item, getItemTitle?.(id));
      if (confirmation && await confirmation !== 1) return;
      setClosing(id, true);
      try {
        // cubed's catalog:remove-item handler kills the pty and forgets
        // its record itself before confirming (server.ts) — there is
        // nothing left for the client to do beyond asking for the item to
        // go away and, on success, forgetting it (pane and mounted entry
        // both — this is a close, not a hide) immediately rather than
        // waiting on the catalog broadcast round trip.
        await services.catalog.removeItem(item.machineId, id);
        unmountItem(id);
      } catch (err) {
        setClosing(id, false);
        showRowMessage(item.repoId ?? null, `Close failed: ${errorMessage(err)}`, true);
      }
    },
    [getItemTitle, setClosing, catalog.items, showRowMessage],
  );
  return closeEntry;
}

function useItemMenu(
  {
    catalog, moveMenu, focusEntry, options: { startRename, getItemTitle },
  }: ActionContext,
  closeEntry: RowActions["closeItem"], showRowMessage: ShowRowMessage,
) {
  const handleContextMenu = useCallback(
    async (id: string, _event: MenuEvent) => {
      const item = catalog.items.find(candidate => candidate.id === id);
      const move = moveMenu(itemRowScope(catalog, id), id);
      const selected = await services.desktop.showContextMenu([
        ...itemMenuItems(item, canOpenHere(id)), ...moveItems(move),
      ]);
      await runMove(move, selected);
      if (selected === "open-here") {
        focusEntry(id);
        requestItemFocus(id);
      } else if (selected === "rename") {
        startRename?.(id);
      } else if (selected === "close-item") {
        await closeEntry(id);
      } else if (selected === "hide-artifact") {
        hideArtifact(id);

      } else if (item) {
        await runArtifactAction(selected, item, catalog.repos, showRowMessage);
      }
    },
    [
      startRename, closeEntry, catalog, showRowMessage, focusEntry, moveMenu,
      getItemTitle,
    ],
  );
  return handleContextMenu;
}

function useRenameItem({ catalog }: ActionContext) {
  const commitRename = useCallback(
    (id: string, title: string) => {
      const trimmed = title.trim();
      const item = catalog.items.find((i) => i.id === id);
      if (item) {
        // Matches tile-manager.js's renameTile: an empty/whitespace-only
        // rename clears the custom title, falling back to the item's
        // default label. `CatalogUpdateItemPatch` (unlike the old
        // WorkspaceItemPatch) has no way to explicitly clear a field under
        // exactOptionalPropertyTypes, so an empty string is the clearing
        // sentinel instead — build-item-entry.ts's title logic already
        // treats a falsy userTitle the same as an absent one, so this has
        // the identical visible effect.
        void services.catalog.updateItem(item.machineId, id, { userTitle: trimmed });
      }
    },
    [catalog.items],
  );
  return commitRename;
}

export function useRowActions(options: RowActionsOptions): RowActions {
  const context = useRowActionContext(options);
  const messages = useRowMessages();
  const removal = useLocalRemoval(context);
  const modals = useRowModals(context);
  const sessions = useSessionActions(context, messages.showRowMessage);
  const worktreeRemoval = useWorktreeRemoval(context, messages.showRowMessage);
  const worktreeMenu = useWorktreeMenu(context, sessions, worktreeRemoval);
  const removeRepo = useRemoveRepo(context, messages.showRowMessage, removal.detachLocal);
  const repoMenu = useRepoMenu(context, sessions, modals, removeRepo, messages.showRowMessage);
  const checkoutMenu = useCheckoutMenu(context, sessions, worktreeMenu);
  const closeItem = useCloseEntry(context, messages.showRowMessage);
  const itemMenu = useItemMenu(context, closeItem, messages.showRowMessage);
  const renameItem = useRenameItem(context);
  return {
    repoMenu, checkoutMenu, worktreeMenu, itemMenu, closeItem, renameItem,
    modals: modals.modals, modalOpen: modals.modalOpen,
    newWorktree: modals.handleNewWorktree, pickAgent: sessions.handlePickAgent,
    removalMessage: removal.removalMessage, retryRemoval: removal.retryRemoval,
    ...messages,
  };
}

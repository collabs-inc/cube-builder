/**
 * Renderer-side repos store: the list of repos, their live
 * connection statuses, and which one is "active" — plain module store +
 * subscribe pattern, exactly like `./workspace.ts`.
 *
 * The list itself is DERIVED, not fetched: which repos exist is a fact
 * about each machine's catalog, so `init()` subscribes to `./catalog.ts`
 * and maps its merged view through `./repo-views.ts`. Statuses and the
 * persisted active-repo id are still the renderer's own concerns and
 * still come from `services.repos.onStatus`/`services.prefs`.
 */



import { useSyncExternalStore } from "react";
import type { CheckoutHead, WorktreeOrigin } from "@port/shared/catalog";
import { isSubpath } from "@port/shared/path-utils";
import { CLOUD_PATH_PREFIX, type RepoInfo } from "@port/shared/types";
import { services } from "../services";
import { catalogStore, type CatalogSnapshot } from "./catalog";
import { repoViewsFrom } from "./repo-views";

const ACTIVE_REPO_PREF_KEY = "active-project-id";

export interface RepoStatusInfo {
  status: string;
  error?: string;
  ptydInterface?: number;
}

export interface ReposState {
  repos: RepoInfo[];
  statuses: Record<string, RepoStatusInfo>;
  activeRepoId: string | null;
}

let state: ReposState = { repos: [], statuses: {}, activeRepoId: null };
const subscribers = new Set<() => void>();

// The catalog snapshot `syncFromCatalog` last looked at. The catalog store
// notifies on EVERY item mutation (a cwd or title patch from any terminal),
// and the overwhelming majority of those leave the repo list alone, so
// this identity compare short-circuits before the derive even runs. Null
// until the first sync (and again after `_resetForTest`) so that first look
// never short-circuits.
let lastCatalog: CatalogSnapshot | null = null;

// Which repo the user actually wants active: their last explicit
// `setActive`, or — until they make one this session — the id `init()` read
// back from prefs. Consulted on EVERY list change rather than applied once,
// because the list is derived from the catalog and each machine's catalog
// arrives on its own schedule: a cloud repo's row can land seconds after
// the local machine's, long after the pref read resolved, and the stored
// choice has to still be honoured when it does.
let preferredActiveId: string | null = null;

// An explicit selection may name a just-created worktree before its catalog
// row arrives. Keep that selection authoritative through unrelated repo-list
// changes, but only until the row is observed: after discovery, a later row
// removal must use the ordinary fallback behavior.
let pendingActiveId: string | null = null;

// Whether `init()`'s persisted-id read has come back. Until it has, a list
// change must not fall back to `repos[0]`: that fallback persists, and
// would overwrite the very value this same `init()` is still reading.
let prefResolved = false;

function notify(): void {
  for (const callback of subscribers) callback();
}

function findRepo(id: string): RepoInfo | null {
  return state.repos.find((r) => r.id === id) ?? null;
}

/**
 * A cloud repo has no real filesystem root (`RepoInfo.path`
 * is only ever set for `kind: "local"`) — its terminals target the virtual
 * cloud root instead. Mirrors project-state.js's `routablePath`.
 */
function routablePath(repo: RepoInfo): string {
  return repo.kind === "local" && repo.path ? repo.path : `${CLOUD_PATH_PREFIX}${repo.id}`;
}

function persistActiveId(id: string): void {
  services.prefs.set(ACTIVE_REPO_PREF_KEY, id).catch((err: unknown) => {
    console.error("[app] failed to persist active repo:", err);
  });
}

/**
 * Sets the active repo by id and persists the choice. A no-op — no state
 * change, no persist, no notify — for an unknown id unless `allowPending`
 * marks a just-created row that has not reached the catalog yet, or for an
 * id that's already active.
 */
export function setActive(id: string, options: { allowPending?: boolean } = {}): void {
  if (state.activeRepoId === id) return;
  // A just-created worktree can be selected before its catalog broadcast.
  const repo = findRepo(id);
  if (!repo && !options.allowPending) return;
  pendingActiveId = repo ? null : id;
  preferredActiveId = id;
  state = { ...state, activeRepoId: id };
  notify();
  persistActiveId(id);
}

/**
 * Finds the cached repo that owns `absPath` (longest-root-prefix match),
 * or null if no repo's root contains it. Matches against `routablePath`,
 * so a cloud repo is owned via its virtual `/@cloud/<id>` root —
 * the same root `pathForRepo` hands out and that the sidebar's own
 * "new terminal" verb opens at.
 *
 * The shared `repoForPath` (and main's routing, which depends on it)
 * deliberately resolves local repos only; this is the renderer's
 * "which repo should this item be filed under" question, where a cloud
 * path unambiguously names its repo. Callers pass the result straight to
 * a catalog item's `repoId` (`services.catalog.addItem`/`createTerminalItem`)
 * — see App.tsx, filetree/FileTreeHost.tsx, shortcuts.ts and items/open-file.ts.
 */
export function repoForAbsPath(absPath: string | null | undefined): RepoInfo | null {
  if (!absPath) return null;
  let best: RepoInfo | null = null;
  let bestRootLength = -1;
  for (const repo of state.repos) {
    const root = routablePath(repo);
    if (!isSubpath(root, absPath)) continue;
    if (root.length > bestRootLength) {
      best = repo;
      bestRootLength = root.length;
    }
  }
  return best;
}

/**
 * Returns the routable path of the cached repo `id` (its real root for
 * local, the virtual cloud root for cloud), or null if unknown.
 */
export function pathForRepo(id: string): string | null {
  const repo = findRepo(id);
  return repo ? routablePath(repo) : null;
}

/**
 * Picks the active repo after a repo-list change: an explicitly pending id
 * while its row is still in flight, then the user's preference once the list
 * contains it, else the current choice if that's still present, else the
 * first repo (or null if none remain). Mirrors project-state.js's
 * `updateProjects`, plus the preference step a derived list needs — see
 * `preferredActiveId`.
 *
 * The preference outranks the current choice on purpose: a current id that
 * differs from it is a fallback this function itself picked from a
 * partially-arrived catalog, and must give way once the real repo shows
 * up. An explicit `setActive` can never be outranked this way — it makes
 * its own id the preference.
 */
function resolveActiveAfterListChange(repos: RepoInfo[], currentId: string | null): string | null {
  if (
    pendingActiveId !== null &&
    pendingActiveId === currentId &&
    !repos.some((r) => r.id === pendingActiveId)
  ) {
    return currentId;
  }
  if (preferredActiveId && repos.some((r) => r.id === preferredActiveId)) {
    return preferredActiveId;
  }
  if (currentId && repos.some((r) => r.id === currentId)) return currentId;
  if (!prefResolved) return currentId;
  return repos[0]?.id ?? null;
}

/**
 * Applies a freshly derived repo list. The fallback selection is a real
 * active-id change from this function's own vantage point, so it is
 * persisted here — which is exactly why `resolveActiveAfterListChange`
 * refuses to make one before `init()`'s persisted-id read has landed.
 */
function applyRepos(repos: RepoInfo[]): void {
  if (pendingActiveId && repos.some((r) => r.id === pendingActiveId)) {
    pendingActiveId = null;
  }
  const activeRepoId = resolveActiveAfterListChange(repos, state.activeRepoId);
  const activeChanged = activeRepoId !== state.activeRepoId;
  state = { ...state, repos, activeRepoId };
  notify();
  if (activeChanged && activeRepoId) persistActiveId(activeRepoId);
}

/**
 * Structural equality for a worktree row's origin. Everything here can
 * change over a worktree's life span without touching `id`/`name`/`kind`/
 * `path` — `creation` above all: it goes from `{ state: "pending" }` to
 * absent the moment the checkout finishes, and that transition used to be
 * invisible to `sameViews`, so a worktree row's "Creating…" never cleared
 * in a live session (only a fresh catalog load re-derived it correctly).
 * `source` is compared with `JSON.stringify` rather than field by field —
 * it is a small, freshly-constructed literal on both sides of every
 * comparison this function is used for, so key-order drift isn't a real
 * risk, and a false "different" here costs one harmless extra re-render
 * where a false "same" costs a permanently stale row.
 */
function sameWorktreeOf(a: WorktreeOrigin | undefined, b: WorktreeOrigin | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.repoId === b.repoId &&
    a.createdOnBranch === b.createdOnBranch &&
    a.baseBranch === b.baseBranch &&
    JSON.stringify(a.source) === JSON.stringify(b.source) &&
    a.creation?.state === b.creation?.state &&
    a.creation?.error === b.creation?.error
  );
}

/**
 * Structural equality for a checkout's observed head. Like `creation`
 * above, this moves on its own: the machine writes it during a worktree
 * sweep, some time after the row exists, and rewrites it on every `git
 * checkout` in that directory. Nothing else about the row moves with it, so
 * leaving it out of `sameViews` discarded the only catalog change that ever
 * carried a branch name.
 *
 * `branch` is compared with `===` on a `string | null`, so "detached"
 * (null) and "on a branch named nothing" cannot collapse into each other.
 */
function sameHead(a: CheckoutHead | undefined, b: CheckoutHead | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.branch === b.branch && a.sha === b.sha;
}

/** Whether two derived repo lists are the same list, field for field. */
function sameViews(a: RepoInfo[], b: RepoInfo[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (r, i) =>
        r.id === b[i]!.id &&
        r.name === b[i]!.name &&
        r.kind === b[i]!.kind &&
        r.path === b[i]!.path &&
        sameHead(r.head, b[i]!.head) &&
        sameWorktreeOf(r.worktreeOf, b[i]!.worktreeOf),
    )
  );
}

/**
 * Re-derives the repo list from the catalog store. Compares the derived
 * views before applying: an item-only catalog change (the common case)
 * must not hand every `useRepos` subscriber a new array and re-render
 * the sidebar on every keystroke-driven cwd patch.
 */
function syncFromCatalog(): void {
  const catalog = catalogStore.getSnapshot();
  if (catalog === lastCatalog) return;
  lastCatalog = catalog;
  const next = repoViewsFrom(catalog);
  if (sameViews(state.repos, next)) return;
  applyRepos(next);
}

function applyStatus(event: { repoId: string; status: string; error?: string; ptydInterface?: number }): void {
  const entry: RepoStatusInfo =
    event.error !== undefined ? { status: event.status, error: event.error } : { status: event.status };
  if (event.ptydInterface !== undefined) entry.ptydInterface = event.ptydInterface;
  state = { ...state, statuses: { ...state.statuses, [event.repoId]: entry } };
  notify();
}

/**
 * Seeds the store and keeps it live: the repo list from the catalog
 * store, the statuses from `services.repos`, and the active repo
 * from `services.prefs`.
 *
 * The first `syncFromCatalog()` is synchronous — `catalogStore` is already
 * seeded from localStorage by App.tsx's bootstrap `loadCache()` — so the
 * "list not loaded yet" window this store used to expose (and guard with a
 * `reposReady` promise) no longer exists for a cached machine.
 *
 * It does still exist for an uncached machine, whose catalog arrives over
 * IPC possibly long after the persisted-id read resolves. That is why the
 * read's result is remembered as `preferredActiveId` rather than applied
 * once — every later list change gets to honour it — and why no fallback
 * selection is made at all until the read has landed: a `repos[0]`
 * guess persists, and would overwrite the very value being read.
 *
 * The status snapshot is merged rather than assigned: a live `onStatus`
 * that already landed for a repo wins over this possibly-stale
 * snapshot's entry for the same id. Subscriptions are wired before the
 * reads are issued so no early update is missed.
 *
 * A `disposed` guard stops a late-resolving read from applying anything
 * after `dispose()` has already run. Returns the dispose function.
 */
export function init(): () => void {
  let disposed = false;

  syncFromCatalog();
  const offCatalog = catalogStore.subscribe(syncFromCatalog);
  const offStatus = services.repos.onStatus((event) => {
    if (disposed) return;
    applyStatus(event);
  });

  Promise.all([services.repos.statusSnapshot(), services.prefs.get(ACTIVE_REPO_PREF_KEY)])
    .then(([statuses, persistedActiveId]) => {
      if (disposed) return;
      // `??=` in spirit: an explicit `setActive` during this round trip has
      // already set the preference, and the value being read back is older
      // than that click — it must not win.
      if (preferredActiveId === null && typeof persistedActiveId === "string") {
        preferredActiveId = persistedActiveId;
      }
      prefResolved = true;
      const mergedStatuses = { ...statuses, ...state.statuses };
      const activeRepoId = resolveActiveAfterListChange(state.repos, state.activeRepoId);
      state = { ...state, statuses: mergedStatuses, activeRepoId };
      notify();
      if (activeRepoId !== null && activeRepoId !== persistedActiveId) {
        persistActiveId(activeRepoId);
      }
    })
    .catch((err: unknown) => {
      console.error("[app] repos init failed:", err);
      // Still resolved, just to nothing: leaving this false would make
      // `resolveActiveAfterListChange` refuse to pick a repo for the
      // rest of the session, so one rejected `prefs.get` would mean the
      // rail never auto-selects anything again.
      prefResolved = true;
    });

  return () => {
    disposed = true;
    offCatalog();
    offStatus();
  };
}

/**
 * Test-only: resets the module-singleton store to its default empty state.
 * Production code never needs this — the store starts empty on module load
 * and `init()` is the only thing that changes it from then on.
 */
export function _resetForTest(): void {
  state = { repos: [], statuses: {}, activeRepoId: null };
  lastCatalog = null;
  preferredActiveId = null;
  pendingActiveId = null;
  prefResolved = false;
}

export const reposStore = {
  subscribe(callback: () => void): () => void {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  },
  getSnapshot(): ReposState {
    return state;
  },
};

/** Subscribes a React component to the repos store. */
export function useRepos(): ReposState {
  return useSyncExternalStore(reposStore.subscribe, reposStore.getSnapshot);
}

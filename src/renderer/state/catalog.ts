/**
 * Renderer-side catalog store: the machine's sidebar contents (repos and
 * items), one document per attached machine, kept live over
 * `services.catalog.onChanged`. Plain module store + subscribe pattern,
 * exactly like `./workspace.ts`.
 *
 * `services.catalog.get()` returns one `{ machineId, catalog }` tree per
 * attached daemon (`@port/shared/catalog`'s `MachineCatalog`), unmerged —
 * a cold-start caller feeds each entry through `acceptSnapshot`, the SAME
 * per-machine accept path `onChanged` uses, so cold start and steady state
 * share one path instead of two. `getSnapshot()` below is this store's own
 * merged VIEW for rendering, built via the shared `mergeCatalogs` (so this
 * store and the router apply the identical merge rule) from the accepted
 * trees — not from `get()`'s result directly.
 */



import { useSyncExternalStore } from "react";
import { mergeCatalogs, type CatalogDocument, type CatalogItemType, type MachineCatalog, type MergedCatalog, type OwnedItem } from "@port/shared/catalog";
import { isWorkerItem, LOCAL_MACHINE_ID } from "@port/shared/types";
import { LEGACY_PREVIEW_TARGET } from "@port/shared/site";
import { applyScopeOrder, isPermutationOf, scopeMemberIds, scopeRows, type ReorderScope } from "@port/shared/catalog-order";

export type {
  CatalogDocument,
  CatalogItem,
  CatalogItemType,
  CatalogRepo,
  MachineCatalog,
  MergedCatalog,
  OwnedItem,
  OwnedRepo,
} from "@port/shared/catalog";

/** This store's own merged view for rendering — same shape as `MergedCatalog`. */
export type CatalogSnapshot = MergedCatalog;

const CACHE_KEY_PREFIX = "catalog_cache_";

const trees = new Map<string, CatalogDocument>();
const pendingOrders = new Map<string, { machineId: string; epoch: string; scope: ReorderScope; ids: string[] }>();
const authoritativeMachines = new Set<string>();
const removedRepos = new Set<string>();
const evictedMachines = new Set<string>();
let snapshot: CatalogSnapshot = { repos: [], items: [] };
const subscribers = new Set<() => void>();

/**
 * The one paired cloud machine's id, as last reported by
 * `services.machine`, and whether that report has arrived at all.
 *
 * Eviction is a broadcast (`catalog:evicted`) with no durable record behind
 * it any more — the old sign-out wrote `projects.json`, so the removal
 * survived a restart on its own. `ensurePaired` fires the signed-out branch
 * from `pairAndBroadcast()`, which runs BEFORE any window exists (an
 * expired refresh token, a session revoked from another device), so that
 * broadcast reaches nobody. Without the prune below, `loadCache()` would
 * then re-seed the unpaired machine's tree from localStorage on every
 * launch, forever: `loadCloudMachine()` is null by then, so the eviction
 * can never re-fire. Pairing, not the catalog, is the fact that decides
 * whether a machine's rows belong on the rail.
 */
let pairedCloudMachineId: string | null = null;
let pairingKnown = false;

/**
 * Whether this client should hold a tree for `machineId` at all. The local
 * machine always qualifies. A remote one qualifies only while it IS the
 * paired cloud machine — and until pairing is known, nothing is dropped,
 * since "not paired yet" and "not paired any more" are not the same answer.
 */
function isPairedMachine(machineId: string): boolean {
  if (machineId === LOCAL_MACHINE_ID) return true;
  if (!pairingKnown) return true;
  return machineId === pairedCloudMachineId;
}

function notify(): void {
  for (const callback of subscribers) callback();
}

// Rebuilds the merged view once per accepted snapshot and stores it, rather
// than merging inside getSnapshot() itself: useSyncExternalStore compares
// snapshots by identity, so a fresh object on every call would re-render
// forever.
function recompute(): void {
  const projected = new Map(trees);
  for (const [key, pending] of pendingOrders) {
    const held = trees.get(pending.machineId);
    const members = held && scopeMemberIds(held, pending.scope);
    if (!held || held.epoch !== pending.epoch || !members || !isPermutationOf(pending.ids, members)) {
      pendingOrders.delete(key);
      continue;
    }
    const catalog = projected.get(pending.machineId)!;
    projected.set(pending.machineId, scopeRows(pending.scope) === "items"
      ? { ...catalog, items: applyScopeOrder(catalog.items, pending.ids) }
      : { ...catalog, repos: applyScopeOrder(catalog.repos, pending.ids) });
  }
  const perMachine: MachineCatalog[] = [...projected].map(([machineId, catalog]) => ({ machineId, catalog }));
  snapshot = mergeCatalogs(perMachine);
  // Cached documents and older daemons can still carry retired managed preview rows.
  snapshot.items = snapshot.items.filter(item => item.type !== "artifact" || item.target !== LEGACY_PREVIEW_TARGET);
}

/** Paint a drop synchronously without changing authoritative revisions or disk cache.
 * A matching broadcast retires the preview; refusal rolls back only this request. */
export function previewCatalogOrder(machineId: string, scope: ReorderScope, ids: string[]): () => void {
  const held = trees.get(machineId);
  const members = held && scopeMemberIds(held, scope);
  if (!held || !members || !isPermutationOf(ids, members)) return () => {};
  const owner = scope.kind === "items" || scope.kind === "repo-items" ? scope.repoId
    : scope.kind === "worktrees" ? scope.parentId : null;
  const key = JSON.stringify([machineId, scope.kind, owner]);
  const pending = { machineId, epoch: held.epoch, scope, ids: [...ids] };
  pendingOrders.set(key, pending);
  recompute();
  notify();
  return () => {
    if (pendingOrders.get(key) !== pending) return;
    pendingOrders.delete(key);
    recompute();
    notify();
  };
}

/**
 * Whether `catalog` should replace whatever this store currently holds for
 * `machineId`. A different epoch always wins: a catalog that was recreated
 * restarts at rev 1, and comparing rev alone would read that as stale and
 * ignore the machine's real state forever. Shared by `acceptSnapshot` and
 * `loadCache` so a cache seed and a live broadcast apply the identical rule.
 */
function isNewer(held: CatalogDocument | undefined, catalog: CatalogDocument): boolean {
  return held === undefined || held.epoch !== catalog.epoch || catalog.rev > held.rev;
}

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function cacheKey(machineId: string): string {
  return `${CACHE_KEY_PREFIX}${machineId}`;
}

/** Narrows a `JSON.parse`d cache value enough to trust it as a `CatalogDocument`
 * — not a deep validation, just enough that a corrupt or foreign localStorage
 * value can't be mistaken for one and crash the merge.
 *
 * This is also where a pre-rename cached document (one carrying `projects`
 * rather than `repos`) is DROPPED rather than migrated: requiring `repos`
 * makes an old entry fail the narrowing, and `loadCache` skips whatever
 * fails it. That is deliberate — this cache exists only so the rail paints
 * before the machine answers, and the first real `catalog:changed` repaints
 * and re-caches within the same wake. Migrating it would be a second copy
 * of cubed's migration living on the far side of the wire, for the
 * benefit of one frame. Note this drops the ENTRY, never renders the
 * document as an empty catalog: an old-shape document simply never enters
 * `trees`, so nothing paints until the machine's own snapshot lands. */
function isCatalogDocument(value: unknown): value is CatalogDocument {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.epoch === "string" &&
    typeof v.rev === "number" &&
    Array.isArray(v.repos) &&
    Array.isArray(v.items)
  );
}

/**
 * Caches `machineId`'s accepted document to localStorage, so the next
 * launch can paint the sidebar instantly instead of showing a blank rail
 * while the machine wakes. Called only from `acceptSnapshot`, after it has
 * already decided to accept — never from a user action.
 */
export function saveCache(machineId: string, catalog: CatalogDocument): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(cacheKey(machineId), JSON.stringify(catalog));
  } catch (err) {
    console.error(`[catalog] failed to cache ${machineId}:`, err);
  }
}

/**
 * Seeds `trees` from every cached machine document, so `getSnapshot()` has
 * content before any real snapshot arrives over the wire. A cache is never
 * a source of truth: an entry that fails to parse, or doesn't look like a
 * `CatalogDocument`, is dropped rather than thrown — losing it costs one
 * wake, and a corrupt entry must never take the rail down. Each surviving
 * entry still goes through `isNewer`, so a real snapshot already held (or
 * arriving after) supersedes the cache rather than being clobbered by it.
 *
 * A machine this client is not paired with is skipped outright — see
 * `isPairedMachine`. This runs at module load, before pairing is known, so
 * it usually skips nothing; `setPairedCloudMachine` prunes what it seeded
 * as soon as the answer arrives.
 */
export function loadCache(): void {
  if (!hasLocalStorage()) return;
  let changed = false;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null || !key.startsWith(CACHE_KEY_PREFIX)) continue;
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isCatalogDocument(parsed)) continue;
    const machineId = key.slice(CACHE_KEY_PREFIX.length);
    if (!isPairedMachine(machineId)) continue;
    if (!isNewer(trees.get(machineId), parsed)) continue;
    trees.set(machineId, parsed);
    changed = true;
  }
  if (!changed) return;
  recompute();
  notify();
}

export function acceptSnapshot(machineId: string, catalog: CatalogDocument): boolean {
  const held = trees.get(machineId);
  if (!isNewer(held, catalog)) {
    // The first live answer may be identical to the cache. Its contents
    // need no update, but it now makes absence authoritative for layouts.
    if (!authoritativeMachines.has(machineId) && held?.epoch === catalog.epoch && held.rev === catalog.rev) {
      authoritativeMachines.add(machineId);
      evictedMachines.delete(machineId);
      recompute();
      notify();
    }
    return false;
  }
  authoritativeMachines.add(machineId);
  evictedMachines.delete(machineId);
  for (const repo of held?.repos ?? []) if (!catalog.repos.some(next => next.id === repo.id)) removedRepos.add(repo.id);
  for (const repo of catalog.repos) removedRepos.delete(repo.id);
  trees.set(machineId, catalog);
  for (const [key, pending] of pendingOrders) {
    if (pending.machineId !== machineId) continue;
    const members = scopeMemberIds(catalog, pending.scope);
    if (members?.length === pending.ids.length && members.every((id, index) => id === pending.ids[index])) pendingOrders.delete(key);
  }
  saveCache(machineId, catalog);
  recompute();
  notify();
  return true;
}

/**
 * The daemon-side absolute root of every repo `machineId` holds — the
 * mapping resolveTerminalPath needs to rebase a machine-native absolute
 * path into the virtual `/@cloud/<repoId>` space (issue #25's C case).
 * Reads the held tree directly: RepoInfo deliberately strips cloud
 * roots, so this is the one renderer-side window onto them. Unknown
 * machine → empty, which downstream reads as "nothing resolvable".
 */
export function repoRootsForMachine(machineId: string): { repoId: string; root: string }[] {
  const held = trees.get(machineId);
  if (held === undefined) return [];
  return held.repos.map((repo) => ({ repoId: repo.id, root: repo.root }));
}

/**
 * Drops everything this store holds for a machine the client is no longer
 * paired with — sign-out, `machine:destroy`. The cached copy goes too:
 * without that, the next launch would re-seed the destroyed machine's
 * repos from localStorage and the rail would show rows for a machine
 * that no longer exists. A machine that was never held is a no-op, so a
 * broadcast that arrives twice costs nothing.
 */
export function evictMachine(machineId: string): void {
  const newlyEvicted = !evictedMachines.has(machineId) && machineId === pairedCloudMachineId;
  evictedMachines.add(machineId);
  const held = dropMachine(machineId);
  if (machineId === pairedCloudMachineId) pairedCloudMachineId = null;
  // An eviction is also the moment to re-check every OTHER remote tree: the
  // broadcast that would have dropped one may have arrived while no window
  // existed (see `pairedCloudMachineId`).
  const pruned = pruneUnpaired();
  if (!held && !pruned && !newlyEvicted) return;
  recompute();
  notify();
}

/** Drops one machine's tree and its cache entry. True if a tree was held. */
function dropMachine(machineId: string): boolean {
  for (const repo of trees.get(machineId)?.repos ?? []) removedRepos.add(repo.id);
  const held = trees.delete(machineId);
  if (!hasLocalStorage()) return held;
  try {
    localStorage.removeItem(cacheKey(machineId));
  } catch (err) {
    console.error(`[catalog] failed to drop the cache for ${machineId}:`, err);
  }
  return held;
}

/** Drops every held tree for a machine this client is not paired with. */
function pruneUnpaired(): boolean {
  let dropped = false;
  for (const machineId of [...trees.keys()]) {
    if (isPairedMachine(machineId)) continue;
    dropMachine(machineId);
    dropped = true;
  }
  return dropped;
}

/**
 * Records which cloud machine this client is paired with — `null` for none —
 * and drops any tree (and cache entry) that answer disqualifies. Called from
 * `startCloudMachineSync` on the initial read and on every change, rather
 * than off the cloud-machine store's subscribe, because "signed out, still
 * holding a stale cache" is a no-CHANGE the store never notifies for.
 */
export function setPairedCloudMachine(machineId: string | null): void {
  const changed = !pairingKnown || pairedCloudMachineId !== machineId;
  pairedCloudMachineId = machineId;
  pairingKnown = true;
  if (!pruneUnpaired() && !changed) return;
  recompute();
  notify();
}

/**
 * Test-only: clears every machine's tree back to empty. Production code
 * never needs this — the store starts empty on module load and
 * `acceptSnapshot`/`loadCache` are the only things that change it from
 * then on.
 */
export function resetCatalog(): void {
  pendingOrders.clear();
  trees.clear();
  authoritativeMachines.clear();
  removedRepos.clear();
  evictedMachines.clear();
  pairedCloudMachineId = null;
  pairingKnown = false;
  recompute();
  notify();
}

/** Absence is authoritative only after this owner answered or was unpaired. */
export function checkoutWasRemoved(repoId: string, machineId?: string, localCatalogExpected = true): boolean {
  if (snapshot.repos.some(repo => repo.id === repoId)) return false;
  if (removedRepos.has(repoId)) return true;
  // Older saved screens have no machine owner, and a deleted repo may
  // already be absent from the cache. Only complete discovery can prove
  // absence then. The web client never expects a local daemon snapshot.
  if (machineId === undefined) return pairingKnown
    && (!localCatalogExpected || authoritativeMachines.has(LOCAL_MACHINE_ID))
    && (pairedCloudMachineId === null || authoritativeMachines.has(pairedCloudMachineId));
  return evictedMachines.has(machineId)
    || (pairingKnown && machineId !== LOCAL_MACHINE_ID && machineId !== pairedCloudMachineId)
    || authoritativeMachines.has(machineId);
}

/** Global layouts wait for an item's machine, independently of screen membership. */
export function itemWasRemoved(itemId: string, machineId?: string, localCatalogExpected = true): boolean {
  if (snapshot.items.some(item => item.id === itemId)) return false;
  if (machineId === undefined) return pairingKnown
    && (!localCatalogExpected || authoritativeMachines.has(LOCAL_MACHINE_ID))
    && (pairedCloudMachineId === null || authoritativeMachines.has(pairedCloudMachineId));
  return evictedMachines.has(machineId)
    || (pairingKnown && machineId !== LOCAL_MACHINE_ID && machineId !== pairedCloudMachineId)
    || authoritativeMachines.has(machineId);
}

/**
 * Whether `machineId`'s rows are authoritatively gone from this client: it
 * was evicted (a sign-out or machine:destroy broadcast), or pairing is known
 * and names a different cloud machine, which is how a sign-out that happened
 * before any window existed arrives, since setPairedCloudMachine drops that
 * tree without evicting it. The local machine is never removed, and unknown
 * pairing is not an answer.
 */
export function machineWasRemoved(machineId: string): boolean {
  if (evictedMachines.has(machineId)) return true;
  return pairingKnown && machineId !== LOCAL_MACHINE_ID && machineId !== pairedCloudMachineId;
}

/**
 * The held document for one machine, exactly as accepted: before the merged
 * snapshot's filtering, which drops preview artifacts while site previews are
 * disabled. Reorder membership must be computed from this, never from the
 * snapshot, or a permutation misses rows the daemon still holds and is refused.
 */
export function machineDocument(machineId: string): CatalogDocument | undefined {
  return trees.get(machineId);
}

export const catalogStore = {
  subscribe(callback: () => void): () => void {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  },
  getSnapshot(): CatalogSnapshot {
    return snapshot;
  },
};

/** Subscribes a React component to the catalog store. */
export function useCatalog(): CatalogSnapshot {
  return useSyncExternalStore(catalogStore.subscribe, catalogStore.getSnapshot);
}

/**
 * Removes exited terminal items that this client was displaying, plus
 * persona workers, which run without a mounted tile until someone opens
 * them. Other unmounted terminals are deliberately NOT swept: with items
 * now durable, a session that died overnight should still be visible in
 * the morning rather than silently gone.
 *
 * "Exited" here means the session ENDED — it ran and stopped, and cubed
 * saw the code it stopped with. An item can also lose its pty without
 * anything having ended: a ptyd restart takes every pty on the machine
 * with it, and cubed's start-up sweep stamps `exitedAt` on every item
 * it can no longer account for (terminals.ts's sweepStaleItems), with no
 * exit code, because no exit was ever observed. Those are precisely the
 * items whose conversations are still recoverable — sweeping on `exitedAt`
 * alone deleted the whole set on every restart, and killed or orphaned the
 * sessions their tiles had already resumed. The exit code is what tells
 * the two apart, and `updateItem` clears it the moment an item has a live
 * pty again, so it can never go stale (see cubed's catalog.ts).
 *
 * `recoveringItemIds` covers the window the exit code cannot: a resume
 * that fails exits for real, with a code, and the tile answers by
 * respawning (TerminalItem.tsx's heal). Between that exit landing and the
 * replacement's id being written, the item looks exactly like one nobody
 * wants — so a tile that is mid-replacement says so, and is spared. This
 * is the coordination `resumeHealArmed` used to provide before removal
 * stopped being an exit side effect.
 *
 * `agent` items are excluded outright, and the exclusion is not a special
 * case so much as the rule stated for a different kind of row. A terminal
 * IS its session — when the shell exits there is nothing left to look at,
 * which is what made vanishing the right behaviour. An agent item is a
 * CONVERSATION whose transcript outlives the process that produced it, and
 * whose view offers Resume; sweeping it would throw away a readable
 * history because a subprocess ended, and would do it silently, on attach.
 */
export function sweepExitedOnAttach(
  items: OwnedItem[],
  displayedItemIds: Set<string>,
  recoveringItemIds: Set<string>,
): OwnedItem[] {
  return items.filter(
    (i) =>
      i.type !== "agent" &&
      i.exitCode !== undefined &&
      (displayedItemIds.has(i.id) || isWorkerItem(i)) &&
      !recoveringItemIds.has(i.id),
  );
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);

/**
 * Infers a catalog item's type from a file's extension. Was
 * `workspace.ts`'s `inferItemType`, ported here since type inference on
 * rename is now a catalog patch (`services.catalog.updateItem`), not a
 * workspace mutation.
 */
export function inferItemType(filePath: string): CatalogItemType {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (ext === ".md") return "note";
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "code";
}

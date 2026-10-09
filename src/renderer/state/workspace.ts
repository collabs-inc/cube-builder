/**
 * Renderer-side workspace store: this client's arrangement of the catalog's
 * items — which columns exist, which panes sit in which column, which item
 * is active, and which item ids this viewport keeps mounted. Identity
 * (which items and repos exist, their cwd, titles, session ids) is the
 * catalog's (`./catalog.ts`), not this store's. `reconcileColumns`
 * (layout-ops.ts) is what keeps this arrangement in sync as the catalog
 * changes underneath it.
 *
 * `mountedItemIds` (layout-ops.ts's `WorkspaceState`) is this store's own
 * keep-alive registry — CLAUDE.md's Rail contract ("every item — displayed
 * or hidden — keeps one stable keyed slot... Hidden items sit at
 * display:none") still holds, but "hidden" can no longer mean "in no
 * column" the way it did right after Task 9: the catalog now surfaces
 * every machine item, including ones this client has never opened, and
 * mounting (spawning a pty connection for) every one of those on sight
 * would be wrong. So there are three states now, not two:
 *  - paned (in `columns`): mounted and positioned;
 *  - mounted but unpaned (in `mountedItemIds`, not in `columns`): the
 *    keep-alive "hidden" case — mounted at display:none;
 *  - neither: not mounted at all — another client's item, or one this
 *    client has simply never opened. Still a normal sidebar row
 *    (ReposSidebar.tsx reads the catalog directly for that), just not a
 *    live Rail slot.
 * `focusItem`, `mountPersonaItems` and `registerTreePane` add live slots to
 * `mountedItemIds`; `hideItem` removes the pane but leaves
 * the id mounted; `unmountItem` is the only place an id is removed from
 * `mountedItemIds` — a permanent close, paired with
 * `services.catalog.removeItem` by whoever is actually deleting the item
 * (ReposSidebar.tsx).
 *
 * A fourth kind of id exists alongside the three placement states above:
 * `tree:<uuid>` file-tree panes (`treePanes`). They are client-local view
 * state, never a catalog item, so they have no "not mounted at all" row to
 * be revealed from — `openTreePane` places one straight into the workspace,
 * while `registerTreePane` leaves placement to the persona view.
 * `hideItem`/`unmountItem` both close it outright rather
 * than keeping a hidden-but-mounted state for it (see `closeTreePane`).
 */



import { useSyncExternalStore } from "react";
import { LOCAL_MACHINE_ID } from "@port/shared/types";
import { isSubpath, parseCloudPath } from "@port/shared/path-utils";
import { treePaneParent } from "../filetree/tree-pane-parent";
import { treePaneNameFor } from "../filetree/tree-pane-name";
import { requestSidebarReveal } from "./sidebar-reveal";
import { requestInstantScreenNavigation } from "./screen-navigation";
import { columnOf, focusTarget, insertPane, MIN_COLUMN_WIDTH_PX, movePane, nextActiveAfterRemoval, reconcileColumns, removePane, repairLayout, resizeColumnWidth, resizePaneRatio, SEED_WIDTH_PX } from "./layout-ops";
import type { Direction, MoveTarget, WorkspaceState as ColumnArrangement } from "./layout-ops";
import { canvasCenter } from "./canvas-center";
import { requestCanvasReveal } from "./canvas-reveal";
import { addCanvasTile, clampTileSize, defaultTileSize, originForCenter, reconcileCanvasTiles, removeCanvasTile, repairCanvasTiles, repairCanvasViewport, repairRememberedTileSizes, tileSizeBucket, type CanvasTile, type PersistedCanvasViewport, type RememberedTileSizes } from "./canvas-ops";
import { automaticScreenTarget, insertScreenPane, normalizeWidthRatios, moveScreenPane, moveScreen, nearestScreenPlacing, reconcileScreens, removeFromAllScreens, removeScreenPane, repairScreens, resizeScreenDivider as resizeScreenDividerOp, screenDisplayName, type Screen } from "./screen-ops";
import { screenViewportSize } from "./screen-viewport-size";
import type { ColumnLike } from "./layout-ops";
import { catalogStore, itemWasRemoved } from "./catalog";
import { visibleScreenId } from "./screen-scroll-position";

export type { Column, MoveTarget } from "./layout-ops";
export type { CanvasTile, RememberedTileSizes } from "./canvas-ops";
export type { Screen, ScreenColumn } from "./screen-ops";

export type WorkspaceView = "columns" | "canvas" | `screen:${string}`;

const SCREEN_VIEW_PREFIX = "screen:";

/** The view value that shows screen `id`. */
export function screenView(id: string): WorkspaceView {
  return `${SCREEN_VIEW_PREFIX}${id}`;
}

/** The screen id a view names, or null for columns/canvas. */
export function screenIdOf(view: WorkspaceView): string | null {
  return view.startsWith(SCREEN_VIEW_PREFIX) ? view.slice(SCREEN_VIEW_PREFIX.length) : null;
}

/** The screen `activeView` shows, or null when columns or canvas is showing. */
export function activeScreen(s: WorkspaceState): Screen | null {
  const id = screenIdOf(s.activeView);
  if (id === null) return null;
  return s.screens.find((scr) => scr.id === id) ?? null;
}

/** The viewport and sidebar share this checkout selection, including __unscoped__. */
export function activeCheckoutId(s: WorkspaceState = state): string | null {
  return activeScreen(s)?.checkoutId ?? null;
}

/** `state` with the active screen replaced by `next`; same state when unchanged. */
function withActiveScreen(next: Screen): WorkspaceState {
  const current = activeScreen(state);
  if (current === null || next === current) return state;
  return { ...state, screens: state.screens.map((s) => (s.id === next.id ? next : s)) };
}

/**
 * The columns the keyboard and the "next active" rules act on: the active
 * screen's while a screen shows, else the Columns rail — INCLUDING while
 * Canvas shows, which is what those rules read today and is left alone.
 */
export function activeColumnsLike(s: WorkspaceState): readonly ColumnLike[] {
  return activeScreen(s)?.columns ?? s.columns;
}

/**
 * Every item id the showing view has on screen — canvas tiles, the rail's
 * panes, or the active screen's panes. The sidebar's "hidden" dot is
 * derived from this and nothing else.
 */
export function displayedItemIds(s: WorkspaceState): Set<string> {
  const ids = new Set<string>();
  if (s.activeView === "canvas") {
    for (const tile of s.canvasTiles) ids.add(tile.itemId);
    return ids;
  }
  for (const column of activeColumnsLike(s)) for (const pane of column.panes) ids.add(pane.itemId);
  return ids;
}

/** A client-local file-tree pane: view state, never a catalog item. `root`
 * is stored exactly as the fs layer consumes it — absolute for local repos,
 * virtual `/@cloud/<repoId>/…` for cloud — so listing/watching/import need
 * no new routing. `name` is the pane's display title (repo name for a
 * repo-root pane, folder basename otherwise). */
export interface TreePaneRecord {
  personaId?: string;
  repoId: string | null;
  root: string;
  name: string;
}

export interface MachineStatusPaneRecord { machineId: string; name: string }
export const isMachineStatusPaneId = (id: string): boolean => id.startsWith("machine-status:");
function repairMachineStatusPanes(raw: unknown): Record<string, MachineStatusPaneRecord> {
  const result: Record<string, MachineStatusPaneRecord> = {};
  if (!raw || typeof raw !== "object") return result;
  for (const [id, row] of Object.entries(raw)) {
    if (!isMachineStatusPaneId(id) || !row || typeof row !== "object") continue;
    const value = row as Partial<MachineStatusPaneRecord>;
    if (typeof value.machineId === "string" && value.machineId && typeof value.name === "string") result[id] = { machineId: value.machineId, name: value.name };
  }
  return result;
}

export const TREE_PANE_ID_PREFIX = "tree:";

export function isTreePaneId(id: string): boolean {
  return id.startsWith(TREE_PANE_ID_PREFIX);
}

function repairTreePanes(raw: unknown): Record<string, TreePaneRecord> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, TreePaneRecord> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isTreePaneId(id)) continue;
    if (typeof value !== "object" || value === null) continue;
    const { repoId, root, name, personaId } =
      value as Partial<Record<keyof TreePaneRecord, unknown>>;
    if (typeof root !== "string" || root.length === 0 || typeof name !== "string") continue;
    out[id] = { repoId: typeof repoId === "string" ? repoId : null, root, name,
      ...(typeof personaId === "string" ? { personaId } : {}) };
  }
  return out;
}

/**
 * Named screens and their keep-alive registry. Legacy column/canvas fields
 * remain readable for older saved files; hydrateScreens imports them at
 * the application boundary and clears their original placements.
 */
export interface WorkspaceState extends ColumnArrangement {
  activeView: WorkspaceView;
  canvasTiles: CanvasTile[];
  canvasViewport: PersistedCanvasViewport;
  /** Sizes a manual tile resize taught, used for future tiles of the same
   * bucket — see canvas-ops's TileSizeBucket. Device-local like the canvas
   * itself. */
  canvasTileSizes: RememberedTileSizes;
  treePanes: Record<string, TreePaneRecord>;
  machineStatusPanes: Record<string, MachineStatusPaneRecord>;
  /** This client's named, viewport-fitted arrangements — see screen-ops.ts. */
  screens: Screen[];
  /** Machine ownership only for preserving placements while catalogs reconnect. */
  itemMachineIds?: Record<string, string>;
}

/**
 * What `getPersistable()` hands `services.workspace.save` — the exact
 * arrangement shape (`columns`, `activeItemId`, `defaultWidthPx`,
 * `mountedItemIds`), since that's everything `WorkspaceState` holds now
 * that item identity lives in the catalog. A named alias rather than
 * reusing `WorkspaceState` directly at every call site, so the persistence
 * boundary reads as its own concept even though the shape is identical.
 */
export type PersistableWorkspaceState = WorkspaceState;

/**
 * Input to `hydrate()`. `columns`/`defaultWidthPx`/`mountedItemIds` are
 * `unknown` (not their real types) because they come straight from
 * persisted JSON — repaired below (columns via `repairLayout`,
 * `mountedItemIds` by filtering to strings). Unlike before Task 9, this
 * has no `items`: hydrate only sanity-checks the arrangement's own shape
 * (ids, widths, ratios, no duplicate pane references, `mountedItemIds`
 * being string-shaped); it has no way to know which item ids are real.
 * That's `reconcileColumns`'s job, applied once the catalog is known.
 */
export interface HydrateInput {
  activeItemId: string | null;
  columns?: unknown;
  defaultWidthPx?: unknown;
  mountedItemIds?: unknown;
  activeView?: unknown;
  canvasTiles?: unknown;
  canvasViewport?: unknown;
  canvasTileSizes?: unknown;
  treePanes?: unknown;
  machineStatusPanes?: unknown;
  screens?: unknown;
  selectedScreenIds?: unknown;
  openCheckoutIds?: unknown;
  itemMachineIds?: unknown;
}

let state: WorkspaceState = {
  columns: [],
  activeItemId: null,
  defaultWidthPx: SEED_WIDTH_PX,
  mountedItemIds: [],
  activeView: "columns",
  canvasTiles: [],
  canvasViewport: repairCanvasViewport(undefined),
  canvasTileSizes: {},
  treePanes: {},
  machineStatusPanes: {},
  screens: [],
};
const subscribers = new Set<() => void>();
const emptyScreenTimers = new Map<string, ReturnType<typeof setTimeout>>();
const EMPTY_SCREEN_CLOSE_DELAY_MS = 500;
let pendingHydratedItemIds = new Set<string>();
let localCatalogExpected = true;

let columnIdCounter = 0;

function generateColumnId(): string {
  columnIdCounter++;
  return `col-${Date.now()}-${columnIdCounter}`;
}

let screenIdCounter = 0;
function generateScreenId(): string {
  screenIdCounter++;
  return `scr-${Date.now()}-${screenIdCounter}`;
}

function notify(): void {
  const emptyIds = new Set(state.screens.slice(0, -1).filter(isSpareScreen).map(screen => screen.id));
  for (const [id, timer] of emptyScreenTimers) {
    if (!emptyIds.has(id)) { clearTimeout(timer); emptyScreenTimers.delete(id); }
  }
  for (const id of emptyIds) {
    if (emptyScreenTimers.has(id)) continue;
    emptyScreenTimers.set(id, setTimeout(() => {
      emptyScreenTimers.delete(id);
      const screen = state.screens.find(candidate => candidate.id === id);
      if (screen && screen !== state.screens.at(-1) && isSpareScreen(screen)) {
        const spare = state.screens.at(-1)!;
        // Keep the screen the user just emptied in place. It can become the
        // spare itself instead of sliding the user onto another empty page.
        const keepCurrent = state.activeView === screenView(id)
          && screen === state.screens.at(-2) && isSpareScreen(spare);
        closeScreen(keepCurrent ? spare.id : id);
      }
    }, EMPTY_SCREEN_CLOSE_DELAY_MS));
  }
  for (const callback of subscribers) callback();
}

/**
 * Every item id any raw pane references, treated as "known" so
 * `repairLayout`'s existence check never drops a pane on shape grounds
 * alone — this store has no item list of its own to check against.
 * Whether an id is actually still real is `reconcileColumns`'s job, run
 * separately once the catalog is known.
 */
function referencedItemIds(rawColumns: unknown): { id: string }[] {
  if (!Array.isArray(rawColumns)) return [];
  const ids = new Set<string>();
  for (const rawColumn of rawColumns) {
    if (typeof rawColumn !== "object" || rawColumn === null) continue;
    const panes = (rawColumn as { panes?: unknown }).panes;
    if (!Array.isArray(panes)) continue;
    for (const rawPane of panes) {
      if (typeof rawPane !== "object" || rawPane === null) continue;
      const itemId = (rawPane as { itemId?: unknown }).itemId;
      if (typeof itemId === "string") ids.add(itemId);
    }
  }
  return [...ids].map((id) => ({ id }));
}

/**
 * Replaces the entire store state (e.g. loading a saved workspace).
 * `columns`/`defaultWidthPx` are repaired via `repairLayout` (layout-ops.ts)
 * for shape alone — malformed ids/widths/ratios and duplicate pane
 * references are fixed up, but nothing is pruned for referencing an unknown
 * item, since this store no longer has an item list to check against.
 * `activeItemId` must name an item that ended up on the rail, else it falls
 * back to the first column's first pane, or null if the rail is empty.
 * `mountedItemIds` is repaired to string entries only, then unioned with
 * every id a repaired pane references — a paned id is always mounted (see
 * this file's own module doc comment), so a persisted `mountedItemIds`
 * that somehow fell out of sync with `columns` self-heals here rather than
 * leaving a paned item that Rail doesn't consider mounted.
 */
export function hydrate(next: HydrateInput, preserveUndiscovered = false): void {
  personaMountedIds.clear();
  for (const timer of emptyScreenTimers.values()) clearTimeout(timer);
  emptyScreenTimers.clear();
  localCatalogExpected = true;
  const { columns, defaultWidthPx } = repairLayout(
    next.columns,
    next.defaultWidthPx,
    referencedItemIds(next.columns),
    generateColumnId,
  );
  const canvasTiles = repairCanvasTiles(next.canvasTiles);
  const canvasViewport = repairCanvasViewport(next.canvasViewport);
  const canvasTileSizes = repairRememberedTileSizes(next.canvasTileSizes);
  const treePanes = repairTreePanes(next.treePanes);
  const screens = repairScreens(next.screens, generateColumnId);
  const activeView = repairActiveView(next.activeView, screens);
  const placements = { columns, canvasTiles, screens };
  const activeItemId =
    next.activeItemId !== null && placedAnywhere(placements, next.activeItemId)
      ? next.activeItemId
      : firstPlacedOn(placements, activeView);
  const rawMounted = Array.isArray(next.mountedItemIds)
    ? next.mountedItemIds.filter((id): id is string => typeof id === "string")
    : [];
  // A placed id is always mounted — canvas tiles and screens included,
  // same self-healing rationale as the paned union below it.
  const mountedItemIds = [
    ...new Set([
      ...rawMounted,
      ...referencedItemIds(columns).map((i) => i.id),
      ...canvasTiles.map((t) => t.itemId),
      ...screens.flatMap((s) => s.columns.flatMap((c) => c.panes.map((p) => p.itemId))),
    ]),
  ];
  state = {
    columns,
    activeItemId,
    defaultWidthPx,
    mountedItemIds,
    activeView,
    canvasTiles,
    canvasViewport,
    canvasTileSizes,
    treePanes,
    machineStatusPanes: repairMachineStatusPanes(next.machineStatusPanes),
    screens,
    itemMachineIds: repairItemMachineIds(next.itemMachineIds),
  };
  pendingHydratedItemIds = preserveUndiscovered ? new Set(mountedItemIds) : new Set();
  notify();
}

/** Application load boundary: migrate every old arrangement into the global sequence. */
export function hydrateScreens(next: HydrateInput): void {
  const repaired = repairLayout(next.columns, next.defaultWidthPx, referencedItemIds(next.columns), generateColumnId);
  let screens = repairScreens(next.screens, generateColumnId);
  const itemMachineIds = repairItemMachineIds(next.itemMachineIds);
  const mountedItemIds = [...new Set([
    ...(Array.isArray(next.mountedItemIds) ? next.mountedItemIds.filter((id): id is string => typeof id === "string") : []),
    ...screens.flatMap(s => s.columns.flatMap(c => c.panes.map(p => p.itemId))),
  ])];
  let view = next.activeView;
  if (repaired.columns.length) {
    const imported: Screen[] = [];
    for (let start = 0; start < repaired.columns.length; start += 3) {
      imported.push({ id: generateScreenId(), name: "", columns: normalizeWidthRatios(
        repaired.columns.slice(start, start + 3).map(c => ({ id: c.id, widthRatio: c.widthPx, panes: c.panes })),
      ) });
    }
    screens.unshift(...imported);
    if (view === "columns" || view === undefined) {
      const focused = imported.find(screen => screen.columns.some(column => column.panes.some(pane => pane.itemId === next.activeItemId)));
      view = screenView((focused ?? imported[0]!).id);
    }
  }
  const tiles = repairCanvasTiles(next.canvasTiles);
  if (tiles.length) {
    const id = generateScreenId();
    screens.push({ id, name: "Imported canvas", columns: tiles.sort((a, b) => a.x - b.x || a.y - b.y).map(t => ({ id: generateColumnId(), widthRatio: 1 / tiles.length, panes: [{ itemId: t.itemId, heightRatio: 1 }] })) });
    if (view === "canvas") view = screenView(id);
  }
  // Preserve shared placements; repairScreens already deduplicates within
  // each screen. Old checkout ownership still supplies discovery metadata.
  const repairedById = new Map<string, Screen>();
  const selected = screens.find(s => screenView(s.id) === view);
  for (const screen of [...(selected ? [selected] : []), ...screens.filter(s => s !== selected)]) {
    const global: Screen = { id: screen.id, name: screen.name, columns: screen.columns,
      ...(screen.customName ? { customName: true } : {}) };
    for (const column of screen.columns) for (const pane of column.panes) {
      if (screen.checkoutMachineId && !itemMachineIds[pane.itemId]) itemMachineIds[pane.itemId] = screen.checkoutMachineId;
    }
    repairedById.set(screen.id, global);
  }
  screens = withTrailingEmpty(screens.map(s => repairedById.get(s.id)!));
  if (!screens.some(s => screenView(s.id) === view)) view = screenView(screens[0]!.id);
  const active = screens.find(s => screenView(s.id) === view)!;
  const activeItemId = active.columns.some(c => c.panes.some(p => p.itemId === next.activeItemId))
    ? next.activeItemId : active.columns[0]?.panes[0]?.itemId ?? null;
  hydrate({ ...next, columns: [], canvasTiles: [], screens, activeView: view, activeItemId, mountedItemIds, itemMachineIds }, true);
}

function repairItemMachineIds(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/**
 * A screen nobody has claimed: no panes and no name of its own. Naming a
 * screen occupies it the way placing a tile does, so a named empty screen
 * is never the spare and never auto-closes.
 */
function isSpareScreen(screen: Screen): boolean {
  return screen.columns.length === 0 && screenDisplayName(screen) === "";
}

/** Append a spare; other empty screens close after their grace period. */
function withTrailingEmpty(screens: Screen[]): Screen[] {
  if (screens.length && isSpareScreen(screens.at(-1)!)) return screens;
  return [...screens, { id: generateScreenId(), name: "", columns: [] }];
}

/** "columns" unless the raw value is "canvas" or names a screen that survived repair. */
function repairActiveView(raw: unknown, screens: Screen[]): WorkspaceView {
  if (raw === "canvas") return "canvas";
  if (typeof raw !== "string" || !raw.startsWith(SCREEN_VIEW_PREFIX)) return "columns";
  const id = raw.slice(SCREEN_VIEW_PREFIX.length);
  return screens.some((s) => s.id === id) ? screenView(id) : "columns";
}

/**
 * Records a manually-dragged tile size as the default for future tiles of
 * the same bucket (term / doc — see canvas-ops). No-op for types outside
 * both buckets, and for a resize that lands where the bucket already is.
 * The size is snapped and floor-clamped so the remembered default is
 * always one the engine could have produced itself.
 */
export function rememberCanvasTileSize(tileType: string, size: { w: number; h: number }): void {
  const bucket = tileSizeBucket(tileType);
  if (bucket === null) return;
  const next = clampTileSize(size);
  const prev = state.canvasTileSizes[bucket];
  if (prev !== undefined && prev.w === next.w && prev.h === next.h) return;
  state = {
    ...state,
    canvasTileSizes: { ...state.canvasTileSizes, [bucket]: next },
  };
  notify();
}

/**
 * Reconciles the arrangement against the catalog's known item ids — see
 * `reconcileColumns` (layout-ops.ts). Called whenever a catalog snapshot is
 * accepted; a no-op leaves `state`'s reference untouched and skips notify.
 * Tree-pane ids are unioned into "known" first — they are never catalog
 * items, so without this every tree pane would be pruned on the very first
 * catalog broadcast (Rail and CanvasView both call this on every snapshot).
 */
export function reconcile(knownItemIds: Set<string>): void {
  const known = new Set(knownItemIds);
  for (const id of [...Object.keys(state.treePanes), ...Object.keys(state.machineStatusPanes)]) known.add(id);
  const itemMachineIds = { ...state.itemMachineIds };
  let ownershipChanged = false;
  for (const item of catalogStore.getSnapshot().items) {
    if (!state.mountedItemIds.includes(item.id)) continue;
    pendingHydratedItemIds.delete(item.id);
    if (itemMachineIds[item.id] !== item.machineId) {
      itemMachineIds[item.id] = item.machineId;
      ownershipChanged = true;
    }
  }
  // A partial catalog is not evidence that a saved item disappeared.
  for (const id of state.mountedItemIds) {
    if (known.has(id)) { pendingHydratedItemIds.delete(id); continue; }
    if ((pendingHydratedItemIds.has(id) || itemMachineIds[id])
      && !itemWasRemoved(id, itemMachineIds[id], localCatalogExpected)) known.add(id);
  }
  const nextColumns = reconcileColumns(state, known);
  const nextTiles = reconcileCanvasTiles(state.canvasTiles, known);
  const nextScreens = reconcileScreens(state.screens, known);
  if (!ownershipChanged && nextColumns === state && nextTiles === state.canvasTiles && nextScreens === state.screens) {
    return;
  }
  const placements = { ...state, ...nextColumns, canvasTiles: nextTiles, screens: nextScreens };
  const activeItemId = activeScreen(placements) && (!placements.activeItemId || !placedOn(placements, placements.activeView, placements.activeItemId))
    ? firstPlacedOn(placements, placements.activeView) : placements.activeItemId;
  state = { ...placements, activeItemId, itemMachineIds: Object.fromEntries(Object.entries(itemMachineIds).filter(([id]) => known.has(id))) };
  notify();
}

/**
 * Rail index for a new item's column: right of the focused item's column,
 * or appended at the rail's end when nothing is focused.
 */
function insertionRailIndex(): number {
  const loc = state.activeItemId ? columnOf(state.columns, state.activeItemId) : null;
  return loc ? loc.colIdx + 1 : state.columns.length;
}

/**
 * Removes an item's pane from the rail — the pane's ✕ and Cmd+W route here.
 * The item itself (and, for a terminal, its PTY) lives on untouched in the
 * catalog, and `mountedItemIds` is untouched too: this is the keep-alive
 * "hide" case (see this file's module doc comment), not a close, so Rail
 * keeps the item mounted at `display:none` rather than tearing it down. A
 * no-op if `id` isn't currently on the rail. If the removed pane was
 * active, the next active item is chosen spatially — see
 * `nextActiveAfterRemoval` (layout-ops.ts): below, above, right column's
 * top pane, left column's top pane, else null.
 */
export function hideItem(id: string): void {
  if (isMachineStatusPaneId(id) && !state.screens.some(screen => screen !== activeScreen(state) && columnOf(screen.columns, id) !== null)) { closeMachineStatusPane(id); return; }
  if (isTreePaneId(id) && !state.screens.some(screen => screen !== activeScreen(state) && columnOf(screen.columns, id) !== null)) {
    closeTreePane(id);
    return;
  }
  // Canvas view's "hide" is its own gesture: the tile's ✕ (and Cmd+W while
  // the canvas is showing) drops the item's tile, not its column pane —
  // the columns arrangement is a different view's business. Same
  // keep-alive intent as the columns branch: `mountedItemIds` untouched.
  if (state.activeView === "canvas") {
    if (!state.canvasTiles.some((t) => t.itemId === id)) return;
    const canvasTiles = removeCanvasTile(state.canvasTiles, id);
    const activeItemId =
      state.activeItemId === id ? topCanvasItemId(canvasTiles) : state.activeItemId;
    state = { ...state, canvasTiles, activeItemId };
    notify();
    return;
  }
  // A showing screen's "hide" drops the pane from that screen only — its
  // other screens (and the Columns rail) are unaffected, same per-view
  // keep-alive intent as the canvas branch above.
  const screen = activeScreen(state);
  if (screen !== null) {
    if (columnOf(screen.columns, id) === null) return;
    const activeItemId =
      state.activeItemId === id ? nextActiveAfterRemoval(screen.columns, id) : state.activeItemId;
    state = { ...withActiveScreen(removeScreenPane(screen, id)), activeItemId };
    notify();
    return;
  }
  if (columnOf(state.columns, id) === null) return;
  const activeItemId =
    state.activeItemId === id ? nextActiveAfterRemoval(state.columns, id) : state.activeItemId;
  state = { ...state, columns: removePane(state.columns, id), activeItemId };
  notify();
}

/** The frontmost remaining tile's item — the canvas's "next active" rule. */
function topCanvasItemId(tiles: CanvasTile[]): string | null {
  let top: CanvasTile | null = null;
  for (const t of tiles) if (top === null || t.z > top.z) top = t;
  return top?.itemId ?? null;
}

/**
 * Permanently drops an item from this viewport: removes its pane (if any)
 * AND drops it from `mountedItemIds`, so Rail stops keeping it alive —
 * unlike `hideItem`, there is no keep-alive intent here. The catalog item
 * itself is untouched; this is paired with `services.catalog.removeItem`
 * by whoever is actually closing the item (ReposSidebar.tsx's close
 * flow). A no-op if `id` is mounted nowhere already.
 */
export function unmountItem(id: string): void {
  if (isMachineStatusPaneId(id)) { closeMachineStatusPane(id); return; }
  if (isTreePaneId(id)) {
    closeTreePane(id);
    return;
  }
  if (!placedAnywhere(state, id) && !state.mountedItemIds.includes(id)) return;
  const activeItemId =
    state.activeItemId === id
      ? nextActiveAfterRemoval(activeColumnsLike(state), id)
      : state.activeItemId;
  state = {
    ...state,
    columns: removePane(state.columns, id),
    // A permanent close clears every placement, whichever view is showing —
    // unlike hideItem, there is no per-view intent to preserve.
    canvasTiles: removeCanvasTile(state.canvasTiles, id),
    screens: removeFromAllScreens(state.screens, id),
    mountedItemIds: state.mountedItemIds.filter((i) => i !== id),
    activeItemId,
  };
  notify();
}

/**
 * Activates an item by id. A no-op if `id` isn't currently on the rail —
 * reveal goes through `focusItem`, not this direct activation.
 */
/** Focus a transient full-pane view without placing it into a saved screen. */
export function activateMountedItem(id: string): void {
  if (!state.mountedItemIds.includes(id) || state.activeItemId === id) return;
  state = { ...state, activeItemId: id };
  notify();
}

export function setActiveItem(id: string): void {
  if (state.activeItemId === id) return;
  // Placed anywhere counts — a canvas tile or a screen pane is as
  // activatable as a Columns-rail pane. A merely-mounted (hidden) id still
  // isn't: reveal goes through focusItem.
  if (
    columnOf(state.columns, id) === null &&
    !state.canvasTiles.some((t) => t.itemId === id) &&
    !state.screens.some((s) => columnOf(s.columns, id) !== null)
  ) {
    return;
  }
  state = { ...state, activeItemId: id };
  notify();
}

/**
 * `focusItem`'s canvas branch: "reveal" means "place on the canvas" — a
 * first free slot, sized by item type, mounted and activated — never a new
 * column (the columns arrangement belongs to another view). An item already
 * on the canvas just activates, exactly like a paned item in columns view.
 */
function focusOnCanvas(id: string, itemType: string | undefined): void {
  if (state.canvasTiles.some((t) => t.itemId === id)) {
    setActiveItem(id);
    // Already placed: re-clicking the row is a navigation — the canvas
    // pans to the tile (CanvasView answers this signal).
    requestCanvasReveal(id);
    return;
  }
  // Placement starts at the middle of what the user is looking at (the
  // live viewport center, not the debounced persisted one) and walks
  // right from there; with no canvas mounted to ask, addCanvasTile falls
  // back to the world margin.
  const size = defaultTileSize(itemType ?? "term", state.canvasTileSizes);
  const center = canvasCenter();
  const canvasTiles = center
    ? addCanvasTile(state.canvasTiles, id, size, originForCenter(center, size.w, size.h))
    : addCanvasTile(state.canvasTiles, id, size);
  const mountedItemIds = state.mountedItemIds.includes(id)
    ? state.mountedItemIds
    : [...state.mountedItemIds, id];
  state = { ...state, canvasTiles, mountedItemIds, activeItemId: id };
  notify();
  requestCanvasReveal(id);
}

/**
 * New screen items join the end, choosing between a column and a stack.
 * An item already on the screen just activates.
 */
function focusOnScreen(screen: Screen, id: string): void {
  if (columnOf(screen.columns, id) !== null) {
    setActiveItem(id);
    return;
  }
  const next = appendScreenItem(screen, id);
  const mountedItemIds = state.mountedItemIds.includes(id)
    ? state.mountedItemIds
    : [...state.mountedItemIds, id];
  state = { ...withActiveScreen(next), mountedItemIds, activeItemId: id };
  state = { ...state, screens: withTrailingEmpty(state.screens) };
  notify();
}

/**
 * Activates an item, revealing it first if it isn't currently placed.
 * Screens append a column or stack using the available space; the legacy
 * rail inserts beside the focused column. An item already placed activates via
 * `setActiveItem`. Unlike before Task 9, this trusts the caller's id — this
 * store has no item list of its own to validate it against.
 *
 * Adds the id to `mountedItemIds`, covering both cases: revealing an item
 * this client hid earlier (already mounted, this is a no-op union) and
 * opening/displaying an item for the first time (not yet mounted, this is
 * where it starts being kept alive).
 */
export function focusItem(id: string, itemType?: string, _repoId?: string | null): void {
  focusItemWithPlacement(id, itemType, true);
}

function focusItemWithPlacement(id: string, itemType: string | undefined, followVisibleScreen: boolean): void {
  requestSidebarReveal(id);
  // Ownership scopes sessions and file access, never their screen placement.
  const machineId = catalogStore.getSnapshot().items.find(item => item.id === id)?.machineId;
  if (machineId) state = { ...state, itemMachineIds: { ...state.itemMachineIds, [id]: machineId } };
  if (state.activeView === "canvas") {
    focusOnCanvas(id, itemType);
    return;
  }
  // The screen in view wins over the active view: the active view follows
  // a native scroll only once it settles, and an open fired mid-coast — or
  // right after landing on the trailing empty screen — would otherwise go
  // to the screen just left behind.
  const inView = visibleScreenId();
  if (followVisibleScreen && inView !== null && screenIdOf(state.activeView) !== null && inView !== screenIdOf(state.activeView) && state.screens.some(screen => screen.id === inView)) {
    setActiveView(screenView(inView));
  }
  const screen = activeScreen(state);
  if (screen !== null) {
    focusOnScreen(screen, id);
    return;
  }
  if (columnOf(state.columns, id) !== null) {
    setActiveItem(id);
    return;
  }
  const columns = insertPane(
    state.columns,
    id,
    { kind: "column", railIndex: insertionRailIndex() },
    { id: generateColumnId(), widthPx: state.defaultWidthPx },
  );
  const mountedItemIds = state.mountedItemIds.includes(id)
    ? state.mountedItemIds
    : [...state.mountedItemIds, id];
  state = { ...state, columns, activeItemId: id, mountedItemIds };
  notify();
}

/**
 * A sidebar click: show the item where it already is. When the active screen
 * does not place it but another screen does, travel to the nearest such
 * screen instead of opening a second copy here; otherwise behave exactly as
 * `focusItem`. The row menu's "Open here" is how a user asks for a placement
 * on this screen regardless.
 *
 * Deliberately not `focusItem` itself: creation, `openFile`, reveal-all and
 * every other caller mean "put it in front of me here", which is still right
 * for them.
 */
export function showItem(id: string): void {
  const selected = activeScreen(state);
  const screen = selected === null ? null : state.screens.find(s => s.id === visibleScreenId()) ?? selected;
  const target = screen === null ? null : nearestScreenPlacing(state.screens, screen.id, id);
  if (target === null) {
    focusItem(id);
    return;
  }
  requestInstantScreenNavigation(target);
  setActiveView(screenView(target));
  // The rail has not scrolled to the destination yet. Honor the explicit
  // destination while retaining the shared ownership, reveal and focus path.
  focusItemWithPlacement(id, undefined, false);
  if (selected?.id === target) {
    // A click during coasting can reselect the already-active screen.
    // Give the rail a render to consume the navigation request in that case.
    state = { ...state };
    notify();
  }
}

/**
 * Registers and mounts a client-local tree pane without changing workspace
 * placement or focus. Reuse is scoped to the exact root and persona.
 */
export function openMachineStatusPane(input: MachineStatusPaneRecord): string {
  const existing = Object.entries(state.machineStatusPanes).find(([, pane]) => pane.machineId === input.machineId);
  if (existing) { focusItem(existing[0], "machine-status"); return existing[0]; }
  const id = `machine-status:${crypto.randomUUID()}`;
  state = { ...state, machineStatusPanes: { ...state.machineStatusPanes, [id]: { ...input } }, mountedItemIds: [...state.mountedItemIds, id] };
  createScreen();
  focusItem(id, "machine-status");
  return id;
}
export function closeMachineStatusPane(id: string): void {
  if (!state.machineStatusPanes[id]) return;
  const panes = { ...state.machineStatusPanes }; delete panes[id];
  const canvasTiles = removeCanvasTile(state.canvasTiles, id);
  const activeItemId = state.activeItemId !== id ? state.activeItemId : state.activeView === "canvas" ? topCanvasItemId(canvasTiles) : nextActiveAfterRemoval(activeColumnsLike(state), id);
  state = { ...state, machineStatusPanes: panes, columns: removePane(state.columns, id), screens: removeFromAllScreens(state.screens, id), canvasTiles, mountedItemIds: state.mountedItemIds.filter(i => i !== id), activeItemId };
  notify();
}

export function registerTreePane(input: TreePaneRecord): string {
  const existing = Object.entries(state.treePanes).find(([, p]) =>
    p.root === input.root && p.personaId === input.personaId);
  const id = existing?.[0] ?? `${TREE_PANE_ID_PREFIX}${crypto.randomUUID()}`;
  if (existing && state.mountedItemIds.includes(id)) return id;
  state = {
    ...state,
    treePanes: existing ? state.treePanes : { ...state.treePanes, [id]: { ...input } },
    mountedItemIds: state.mountedItemIds.includes(id)
      ? state.mountedItemIds : [...state.mountedItemIds, id],
  };
  notify();
  return id;
}

/** Opens a tree pane in the main workspace, focusing an existing match when available. */
export function openTreePane(input: TreePaneRecord): string {
  const id = registerTreePane(input);
  focusItem(id, "tree");
  return id;
}

/** Navigate the existing view; its mount, focus and every placement stay intact. */
export function navigateTreePaneUp(id: string): void {
  const pane = state.treePanes[id];
  if (!pane) return;
  const root = treePaneParent(pane.root);
  if (root === null) return;
  const cloud = parseCloudPath(root);
  const repos = catalogStore.getSnapshot().repos;
  const repo = cloud ? repos.find(candidate => candidate.id === cloud.repoId)
    : repos.filter(candidate => candidate.machineId === LOCAL_MACHINE_ID && isSubpath(candidate.root, root))
        .sort((a, b) => b.root.length - a.root.length)[0];
  const name = cloud && !cloud.rel ? repo?.name ?? "/"
    : treePaneNameFor(root, repo ? { id: repo.id, name: repo.name, path: repo.root } : null);
  state = { ...state, treePanes: { ...state.treePanes, [id]: { ...pane, root, name, repoId: repo?.id ?? null } } };
  notify();
}

/**
 * Closes a tree pane for good: record, pane, canvas tile and mount all go
 * together. Tree panes have no hidden state — a client-local pane has no
 * catalog-backed sidebar row to be revealed from, so ✕/Cmd+W route here
 * (via hideItem's delegation) rather than to the keep-alive hide.
 */
export function closeTreePane(id: string): void {
  if (!(id in state.treePanes)) return;
  // `nextActiveAfterRemoval` is columns-only, so on its own it would pick
  // null for a canvas-view tile-only pane instead of promoting the top
  // remaining tile — same fix as `hideItem`'s canvas branch above.
  const canvasTiles = removeCanvasTile(state.canvasTiles, id);
  const activeItemId =
    state.activeItemId === id
      ? state.activeView === "canvas"
        ? topCanvasItemId(canvasTiles)
        : nextActiveAfterRemoval(activeColumnsLike(state), id)
      : state.activeItemId;
  const treePanes = { ...state.treePanes };
  delete treePanes[id];
  state = {
    ...state,
    treePanes,
    columns: removePane(state.columns, id),
    canvasTiles,
    screens: removeFromAllScreens(state.screens, id),
    mountedItemIds: state.mountedItemIds.filter((i) => i !== id),
    activeItemId,
  };
  notify();
}

/** Moves a displayed item to a seam or a new rail column (drag + keyboard). */
export function moveItem(itemId: string, target: MoveTarget): void {
  const screen = activeScreen(state);
  if (screen !== null) {
    if (columnOf(screen.columns, itemId) === null) return;
    const next = moveScreenPane(screen, itemId, target, generateColumnId());
    if (next === screen) return;
    state = withActiveScreen(next);
    notify();
    return;
  }
  const loc = columnOf(state.columns, itemId);
  if (!loc) return;
  const source = state.columns[loc.colIdx]!;
  const widthPx = source.panes.length === 1 ? source.widthPx : state.defaultWidthPx;
  const columns = movePane(state.columns, itemId, target, {
    id: generateColumnId(),
    widthPx,
  });
  if (columns === state.columns) return;
  state = { ...state, columns };
  notify();
}

/** Drags the divider right of `leftColumnId` on the showing screen. No-op off a screen. */
export function resizeScreenDivider(leftColumnId: string, deltaRatio: number, minRatio?: number): void {
  const screen = activeScreen(state);
  if (screen === null) return;
  const next = resizeScreenDividerOp(screen, leftColumnId, deltaRatio, minRatio);
  if (next === screen) return;
  state = withActiveScreen(next);
  notify();
}

/** Sets a column's width (clamped) and makes it the sticky default. */
export function resizeColumn(columnId: string, widthPx: number): void {
  if (!state.columns.some((c) => c.id === columnId)) return;
  const columns = resizeColumnWidth(state.columns, columnId, widthPx);
  const clamped = Math.max(MIN_COLUMN_WIDTH_PX, Math.round(widthPx));
  if (columns === state.columns && state.defaultWidthPx === clamped) return;
  state = { ...state, columns, defaultWidthPx: clamped };
  notify();
}

/** Drags the seam between two stacked panes. */
export function resizePane(columnId: string, seamIndex: number, deltaRatio: number): void {
  const screen = activeScreen(state);
  if (screen) {
    const columns = resizePaneRatio(screen.columns, columnId, seamIndex, deltaRatio);
    if (columns === screen.columns) return;
    state = withActiveScreen({ ...screen, columns });
    notify();
    return;
  }
  const columns = resizePaneRatio(state.columns, columnId, seamIndex, deltaRatio);
  if (columns === state.columns) return;
  state = { ...state, columns };
  notify();
}

/** Moves focus one pane up/down or one column left/right. */
export function focusDirection(dir: Direction): void {
  if (state.activeItemId === null) return;
  const target = focusTarget(activeColumnsLike(state), state.activeItemId, dir);
  if (target !== null) setActiveItem(target);
}

type Placements = Pick<WorkspaceState, "columns" | "canvasTiles" | "screens">;

/** Whether `id` has a placement on `view`. */
function placedOn(p: Placements, view: WorkspaceView, id: string): boolean {
  if (view === "columns") return columnOf(p.columns, id) !== null;
  if (view === "canvas") return p.canvasTiles.some((t) => t.itemId === id);
  const scr = p.screens.find((x) => x.id === screenIdOf(view));
  return scr !== undefined && columnOf(scr.columns, id) !== null;
}

/**
 * The screen `id` already sits on — the active one when it holds it, else
 * the first that does — or null when no screen holds it. What a gallery
 * pick uses to go TO an item rather than copy it onto the current screen.
 */
export function screenHolding(s: WorkspaceState, id: string): Screen | null {
  const active = activeScreen(s);
  if (active && columnOf(active.columns, id) !== null) return active;
  return s.screens.find(screen => columnOf(screen.columns, id) !== null) ?? null;
}

/** Every screen `id` sits on, in strip order. */
export function screensHolding(s: WorkspaceState, id: string): Screen[] {
  return s.screens.filter(screen => columnOf(screen.columns, id) !== null);
}

/** Whether `id` has a placement on any view at all. */
function placedAnywhere(p: Placements, id: string): boolean {
  return (
    placedOn(p, "columns", id) ||
    placedOn(p, "canvas", id) ||
    p.screens.some((s) => columnOf(s.columns, id) !== null)
  );
}

/** The item a view opens on when the current active item is not placed there. */
function firstPlacedOn(p: Placements, view: WorkspaceView): string | null {
  if (view === "columns") return p.columns[0]?.panes[0]?.itemId ?? null;
  if (view === "canvas") return topCanvasItemId(p.canvasTiles);
  const scr = p.screens.find((x) => x.id === screenIdOf(view));
  return scr?.columns[0]?.panes[0]?.itemId ?? null;
}

/**
 * Switches the showing view. A `screen:` view must name an existing
 * screen. The active item is kept if the new view places it, else the
 * view's first placed item (or null) — one rule for all three kinds, so
 * Rail's `displayed` zoom guard is never handed an active item the
 * showing view cannot draw.
 */
export function setActiveView(view: WorkspaceView): void {
  if (state.activeView === view) return;
  const id = screenIdOf(view);
  if (id !== null && !state.screens.some(s => s.id === id)) return;
  const activeItemId = state.activeItemId !== null && placedOn(state, view, state.activeItemId)
    ? state.activeItemId : firstPlacedOn(state, view);
  state = { ...state, activeView: view, activeItemId };
  notify();
}

/** Select the trailing empty screen; repeated creation never accumulates spares. */
export function createScreen(): string {
  state = { ...state, screens: withTrailingEmpty(state.screens) };
  const id = state.screens.at(-1)!.id;
  setActiveView(screenView(id));
  return id;
}

export function renameScreen(id: string, name: string): void {
  const trimmed = name.trim();
  const target = state.screens.find(s => s.id === id);
  if (!target || (target.name === trimmed && target.customName)) return;
  const screens = state.screens.map(s => s.id === id ? { ...s, name: trimmed, customName: true } : s);
  state = { ...state, screens: withTrailingEmpty(screens) };
  notify();
}

/**
 * Moves a screen to `toIndex` (spec §3.2). Validated against the live store,
 * not the drag that asked for it: the empty-screen timer can turn the screen
 * being dragged into the spare, and closeScreen can remove it, while a
 * gesture is still in flight. The spare never moves and nothing lands on or
 * after it, which is what keeps an empty screen at the end.
 */
export function reorderScreen(id: string, toIndex: number): boolean {
  const spareIndex = state.screens.length - 1;
  const spare = state.screens[spareIndex];
  const from = state.screens.findIndex((screen) => screen.id === id);
  if (from < 0 || spare === undefined) return false;
  if (from === spareIndex && isSpareScreen(spare)) return false;
  const limit = isSpareScreen(spare) ? spareIndex : state.screens.length;
  if (toIndex < 0 || toIndex >= limit) return false;
  const screens = moveScreen(state.screens, id, toIndex);
  if (screens === state.screens) return false;
  const activeId = screenIdOf(state.activeView);
  if (activeId !== null) requestInstantScreenNavigation(activeId);
  state = { ...state, screens };
  notify();
  return true;
}

/** Explicit close removes only the arrangement; its item instances stay alive. */
export function closeScreen(id: string): void {
  const index = state.screens.findIndex(s => s.id === id);
  if (index === -1) return;
  const screens = withTrailingEmpty(state.screens.filter(s => s.id !== id));
  const activeView = state.activeView === screenView(id)
    ? screenView(screens[Math.max(0, index - 1)]?.id ?? screens[0]!.id) : state.activeView;
  const placements = { ...state, screens };
  const activeItemId = state.activeItemId && placedOn(placements, activeView, state.activeItemId)
    ? state.activeItemId : firstPlacedOn(placements, activeView);
  state = { ...state, screens, activeView, activeItemId };
  notify();
}

/** Commit a drag to a screen without navigating or deleting an emptied source. */
export function moveItemToScreen(itemId: string, screenId: string, target?: MoveTarget, sourceScreenId?: string): void {
  const destination = state.screens.find(s => s.id === screenId);
  const source = sourceScreenId ? state.screens.find(s => s.id === sourceScreenId && columnOf(s.columns, itemId) !== null)
    : state.screens.find(s => s === activeScreen(state) && columnOf(s.columns, itemId) !== null)
      ?? state.screens.find(s => columnOf(s.columns, itemId) !== null);
  if (!source || !destination || (source === destination && !target)) return;
  if (target?.kind === "seam" && !destination.columns.some(c => c.id === target.columnId)) return;
  const exists = columnOf(destination.columns, itemId) !== null;
  const next = exists
    ? target ? moveScreenPane(destination, itemId, target, generateColumnId()) : destination
    : insertScreenPane(destination, itemId, target ?? automaticScreenTarget(destination, screenViewportSize()), generateColumnId());
  if (next === destination && source === destination) return;
  const screens = withTrailingEmpty(state.screens.map(s => s === destination ? next : s === source ? removeScreenPane(s, itemId) : s));
  const placements = { ...state, screens };
  const activeItemId = state.activeView === screenView(destination.id) ? itemId
    : state.activeItemId === itemId ? firstPlacedOn(placements, state.activeView) : state.activeItemId;
  state = { ...state, screens, activeItemId };
  notify();
}

export interface CheckoutScreenInput { repoId: string; name: string; itemIds: string[]; machineId?: string }

function appendScreenItem(screen: Screen, id: string): Screen {
  return insertScreenPane(screen, id, automaticScreenTarget(screen, screenViewportSize()), generateColumnId());
}

/** Worktree selection is context only. Explicit reveal-all places its items here. */
export function openCheckoutScreen(input: CheckoutScreenInput, options: { revealAll?: boolean } = {}): void {
  if (!options.revealAll) return;
  if (!activeScreen(state)) createScreen();
  for (const id of new Set(input.itemIds)) {
    focusItem(id);
  }
}

/** Discovery supplies ownership for reconnect repair, never opens or moves tiles. */
export function syncCheckoutScreens(inputs: CheckoutScreenInput[], options: { localCatalogExpected: boolean } = { localCatalogExpected: true }): void {
  localCatalogExpected = options.localCatalogExpected;
  const itemMachineIds = { ...state.itemMachineIds };
  let changed = false;
  for (const input of inputs) for (const id of input.itemIds) {
    if (!input.machineId || !state.mountedItemIds.includes(id) || itemMachineIds[id] === input.machineId) continue;
    itemMachineIds[id] = input.machineId;
    changed = true;
  }
  if (changed) { state = { ...state, itemMachineIds }; notify(); }
}

/**
 * Drops an item's canvas tile without touching `mountedItemIds` — the
 * canvas analogue of a pane hide, callable from any view (sidebar row
 * actions don't know which view is showing). A no-op if the item has no
 * tile.
 */
export function removeFromCanvas(id: string): void {
  const canvasTiles = removeCanvasTile(state.canvasTiles, id);
  if (canvasTiles === state.canvasTiles) return;
  const activeItemId =
    state.activeItemId === id && state.activeView === "canvas"
      ? topCanvasItemId(canvasTiles)
      : state.activeItemId;
  state = { ...state, canvasTiles, activeItemId };
  notify();
}

const sameTile = (a: CanvasTile, b: CanvasTile): boolean =>
  a.itemId === b.itemId && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.z === b.z;

/**
 * Wholesale writeback from the canvas engine (canvas/tile-manager.js's
 * save marshalling): while a CanvasView is mounted, the engine's
 * module-global tiles array is the runtime truth and this mirrors it into
 * the persisted arrangement. Value-identical writebacks (the engine's
 * debounced save firing with nothing changed) skip notify entirely. A
 * tile the store hasn't seen keeps the placed-implies-mounted invariant.
 */
export function syncCanvasTiles(tiles: CanvasTile[]): void {
  const prev = state.canvasTiles;
  if (prev.length === tiles.length && prev.every((t, i) => sameTile(t, tiles[i]!))) return;
  const mountedItemIds = [
    ...new Set([...state.mountedItemIds, ...tiles.map((t) => t.itemId)]),
  ];
  state = { ...state, canvasTiles: tiles.map((t) => ({ ...t })), mountedItemIds };
  notify();
}




/**
 * Stores the viewport's persisted center form. The canvas component owns
 * the runtime pan (element-size-dependent) and commits here debounced /
 * on gesture end, so zoom-pan frames never spam notify()/save cycles.
 */
export function setCanvasViewport(viewport: PersistedCanvasViewport): void {
  const v = state.canvasViewport;
  if (v.centerX === viewport.centerX && v.centerY === viewport.centerY && v.zoom === viewport.zoom)
    return;
  state = { ...state, canvasViewport: { ...viewport } };
  notify();
}

export const workspaceStore = {
  subscribe(callback: () => void): () => void {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  },
  getSnapshot(): WorkspaceState {
    return state;
  },
  /** The current arrangement, in exactly the shape `services.workspace.save` persists. */
  getPersistable(): PersistableWorkspaceState {
    return state;
  },
};

/** Subscribes a React component to the workspace store. */
export function useWorkspace(): WorkspaceState {
  return useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getSnapshot);
}

// Ownership lasts for one open/pick/dismiss cycle; pre-existing mounts are never claimed.
const personaMountedIds = new Set<string>();

/** Release only mounts owned by the overlay, preserving every workspace placement. */
export function releasePersonaItems(): void {
  const ids = [...personaMountedIds];
  personaMountedIds.clear();
  for (const id of ids) {
    if (!placedAnywhere(state, id)) unmountItem(id);
  }
}

/** Open an overlay's live slots without adding placements or changing the underlying view. */
export function mountPersonaItems(ids: readonly string[]): void {
  const added = ids.filter(id => !state.mountedItemIds.includes(id));
  if (!added.length) return;
  for (const id of added) personaMountedIds.add(id);
  state = { ...state, mountedItemIds: [...state.mountedItemIds, ...new Set(added)] };
  notify();
}

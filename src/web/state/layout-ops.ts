// Adapted from src/windows/app/src/state/layout-ops.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * Pure layout math for the viewport rail: columns of stacked panes.
 * No DOM, no React, no store access — workspace.ts composes these into
 * mutations, and Rail.tsx composes them into geometry. Nothing here
 * mutates its arguments; functions documented as returning "the same
 * reference" on a no-op do exactly that, so callers can identity-check
 * to skip a notify()/save cycle.
 */
export interface PaneSlot {
  itemId: string;
  heightRatio: number;
}

export interface Column {
  id: string;
  widthPx: number;
  panes: PaneSlot[];
}

/**
 * The part of a column every pane-level routine actually reads — id and
 * pane stack, no width. `Column` (pixel widths, the Columns rail) and
 * screen-ops.ts's `ScreenColumn` (ratio widths, a screen) both satisfy
 * it, so `columnOf`, `nextActiveAfterRemoval`, `focusTarget`,
 * `keyboardMoveTarget` and the move-target adjustment serve both views
 * from one implementation.
 */
export interface ColumnLike {
  id: string;
  panes: PaneSlot[];
}

export type MoveTarget =
  | { kind: "seam"; columnId: string; seamIndex: number }
  | { kind: "column"; railIndex: number };

export const SEED_WIDTH_PX = 560;
export const MIN_COLUMN_WIDTH_PX = 240;
export const MIN_PANE_RATIO = 0.1;

// Scrollable space past the last column, so its right-edge resize handle
// can straddle the edge like every other column's instead of being flush
// against an unscrollable content boundary. Also gives the end-of-rail
// drop indicator (drawn at totalWidthPx) room to be visible. Desktop-only:
// narrow mode pins the content to the viewport and must not include it.
export const RAIL_TRAILING_BUFFER_PX = 160;

const isUsableRatio = (r: number): boolean => Number.isFinite(r) && r > 0;

export function normalizeRatios(panes: PaneSlot[]): PaneSlot[] {
  if (panes.length === 0) return [];
  const sum = panes.reduce((acc, p) => acc + p.heightRatio, 0);
  if (!isUsableRatio(sum) || panes.some((p) => !isUsableRatio(p.heightRatio))) {
    return panes.map((p) => ({ ...p, heightRatio: 1 / panes.length }));
  }
  return panes.map((p) => ({ ...p, heightRatio: p.heightRatio / sum }));
}

export function columnOf(
  columns: readonly ColumnLike[],
  itemId: string,
): { colIdx: number; paneIdx: number } | null {
  for (let colIdx = 0; colIdx < columns.length; colIdx++) {
    const paneIdx = columns[colIdx]!.panes.findIndex((p) => p.itemId === itemId);
    if (paneIdx !== -1) return { colIdx, paneIdx };
  }
  return null;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/**
 * Inserts `itemId` into a pane stack at `seamIndex` (clamped), giving it
 * `1/n` of the height and scaling the existing panes by `(n-1)/n`, then
 * normalizing. The Columns rail and screens both stack panes this way.
 */
export function insertIntoStack(panes: PaneSlot[], itemId: string, seamIndex: number): PaneSlot[] {
  const n = panes.length + 1;
  const scaled = panes.map((p) => ({ ...p, heightRatio: p.heightRatio * ((n - 1) / n) }));
  const seam = clamp(seamIndex, 0, panes.length);
  return normalizeRatios([
    ...scaled.slice(0, seam),
    { itemId, heightRatio: 1 / n },
    ...scaled.slice(seam),
  ]);
}

export function insertPane(
  columns: Column[],
  itemId: string,
  target: MoveTarget,
  newColumn: { id: string; widthPx: number },
): Column[] {
  if (target.kind === "column") {
    const railIndex = clamp(target.railIndex, 0, columns.length);
    const column: Column = {
      id: newColumn.id,
      widthPx: newColumn.widthPx,
      panes: [{ itemId, heightRatio: 1 }],
    };
    return [...columns.slice(0, railIndex), column, ...columns.slice(railIndex)];
  }
  if (!columns.some((c) => c.id === target.columnId)) return columns;
  return columns.map((column) =>
    column.id !== target.columnId
      ? column
      : { ...column, panes: insertIntoStack(column.panes, itemId, target.seamIndex) },
  );
}

export function removePane(columns: Column[], itemId: string): Column[] {
  if (columnOf(columns, itemId) === null) return columns;
  const out: Column[] = [];
  for (const column of columns) {
    const panes = column.panes.filter((p) => p.itemId !== itemId);
    if (panes.length === 0) continue;
    out.push(
      panes.length === column.panes.length
        ? column
        : { ...column, panes: normalizeRatios(panes) },
    );
  }
  return out;
}

/**
 * The renderer's arrangement: which columns exist, which panes sit in
 * which column, which item (if any) is active, and which item ids this
 * viewport keeps mounted (keep-alive) whether or not they're currently
 * paned. Identity — which items exist at all — belongs to the catalog,
 * not here; see reconcileColumns.
 *
 * `mountedItemIds` is a superset of every id any pane in `columns`
 * references (an id gains an entry the moment it's first given a pane —
 * see workspace.ts's `focusItem` — and never loses it just because its
 * pane is later removed by `hideItem`). This is what lets Rail.tsx tell
 * "hidden — keep it warm" (in `mountedItemIds`, in no column) apart from
 * "never opened by this client" (in neither): the catalog now surfaces
 * every machine item, including ones this client has never touched, and
 * only the former should keep a live DOM slot / terminal connection.
 */
export interface WorkspaceState {
  columns: Column[];
  activeItemId: string | null;
  defaultWidthPx: number;
  mountedItemIds: string[];
}

/**
 * Reconciles the arrangement against the catalog's known item ids: drops
 * every pane (and, transitively via `removePane`'s own pruning, every
 * column left empty by that) whose item the catalog no longer has, clears
 * `activeItemId` if it named one of them, and prunes `mountedItemIds` the
 * same way (an item the catalog has forgotten entirely has nothing left to
 * stay mounted for). Returns `state` itself, unchanged, when every pane,
 * the active item, and every mounted id are still known — this identity
 * matters, since this runs on every accepted catalog snapshot and a fresh
 * object each time would re-render the whole rail on every heartbeat.
 */
export function reconcileColumns(
  state: WorkspaceState,
  knownItemIds: Set<string>,
): WorkspaceState {
  const unknownIds: string[] = [];
  for (const column of state.columns) {
    for (const pane of column.panes) {
      if (!knownItemIds.has(pane.itemId)) unknownIds.push(pane.itemId);
    }
  }
  let columns = state.columns;
  for (const itemId of unknownIds) columns = removePane(columns, itemId);

  const activeItemId =
    state.activeItemId !== null && !knownItemIds.has(state.activeItemId)
      ? null
      : state.activeItemId;

  const mountedItemIds = state.mountedItemIds.filter((id) => knownItemIds.has(id));
  const mountedChanged = mountedItemIds.length !== state.mountedItemIds.length;

  if (columns === state.columns && activeItemId === state.activeItemId && !mountedChanged) {
    return state;
  }
  return {
    ...state,
    columns,
    activeItemId,
    mountedItemIds: mountedChanged ? mountedItemIds : state.mountedItemIds,
  };
}

function adjustSeamTarget(
  target: Extract<MoveTarget, { kind: "seam" }>,
  sourceId: string,
  paneIdx: number,
  columns: readonly ColumnLike[],
): Extract<MoveTarget, { kind: "seam" }> | null {
  if (!columns.some((c) => c.id === target.columnId)) return null;
  if (target.columnId !== sourceId) return target;
  let seam = target.seamIndex;
  if (seam > paneIdx) seam -= 1;
  if (seam === paneIdx) return null;
  return { kind: "seam", columnId: target.columnId, seamIndex: seam };
}

function adjustColumnTarget(
  target: Extract<MoveTarget, { kind: "column" }>,
  colIdx: number,
  sole: boolean,
): Extract<MoveTarget, { kind: "column" }> | null {
  if (!sole) return target;
  let railIndex = target.railIndex;
  if (railIndex === colIdx || railIndex === colIdx + 1) return null;
  if (railIndex > colIdx) railIndex -= 1;
  return { kind: "column", railIndex };
}

/**
 * The effective target for moving `itemId`, once its own removal is
 * accounted for: a seam index past the pane's own slot shifts down by
 * one, a column index past a sole pane's column shifts left by one, and
 * a target that lands the pane exactly where it already is (or names a
 * column that no longer exists) is null. Shared by the Columns rail and
 * screens.
 */
export function adjustMoveTarget(
  columns: readonly ColumnLike[],
  itemId: string,
  target: MoveTarget,
): MoveTarget | null {
  const loc = columnOf(columns, itemId);
  if (!loc) return null;
  const source = columns[loc.colIdx]!;
  const sole = source.panes.length === 1;
  return target.kind === "seam"
    ? adjustSeamTarget(target, source.id, loc.paneIdx, columns)
    : adjustColumnTarget(target, loc.colIdx, sole);
}

export function movePane(
  columns: Column[],
  itemId: string,
  target: MoveTarget,
  newColumn: { id: string; widthPx: number },
): Column[] {
  const effective = adjustMoveTarget(columns, itemId, target);
  if (!effective) return columns;
  return insertPane(removePane(columns, itemId), itemId, effective, newColumn);
}

export type Direction = "left" | "right" | "up" | "down";

export function nextActiveAfterRemoval(
  columns: readonly ColumnLike[],
  itemId: string,
): string | null {
  const loc = columnOf(columns, itemId);
  if (!loc) return null;
  const column = columns[loc.colIdx]!;
  const below = column.panes[loc.paneIdx + 1];
  if (below) return below.itemId;
  const above = column.panes[loc.paneIdx - 1];
  if (above) return above.itemId;
  const right = columns[loc.colIdx + 1];
  if (right) return right.panes[0]!.itemId;
  const left = columns[loc.colIdx - 1];
  if (left) return left.panes[0]!.itemId;
  return null;
}

export function focusTarget(
  columns: readonly ColumnLike[],
  itemId: string,
  dir: Direction,
): string | null {
  const loc = columnOf(columns, itemId);
  if (!loc) return null;
  const column = columns[loc.colIdx]!;
  if (dir === "up") return column.panes[loc.paneIdx - 1]?.itemId ?? null;
  if (dir === "down") return column.panes[loc.paneIdx + 1]?.itemId ?? null;
  const neighbour = columns[loc.colIdx + (dir === "right" ? 1 : -1)];
  return neighbour?.panes[0]?.itemId ?? null;
}

function verticalMoveTarget(
  column: ColumnLike,
  paneIdx: number,
  dir: "up" | "down",
): Extract<MoveTarget, { kind: "seam" }> | null {
  if (dir === "up") {
    if (paneIdx === 0) return null;
    return { kind: "seam", columnId: column.id, seamIndex: paneIdx - 1 };
  }
  if (paneIdx >= column.panes.length - 1) return null;
  return { kind: "seam", columnId: column.id, seamIndex: paneIdx + 2 };
}

function horizontalMoveTarget(
  columns: readonly ColumnLike[],
  colIdx: number,
  sole: boolean,
  dir: "left" | "right",
): Extract<MoveTarget, { kind: "column" }> | null {
  if (dir === "left") {
    if (sole && colIdx === 0) return null;
    return { kind: "column", railIndex: sole ? colIdx - 1 : colIdx };
  }
  if (sole && colIdx === columns.length - 1) return null;
  return { kind: "column", railIndex: sole ? colIdx + 2 : colIdx + 1 };
}

export function keyboardMoveTarget(
  columns: readonly ColumnLike[],
  itemId: string,
  dir: Direction,
): MoveTarget | null {
  const loc = columnOf(columns, itemId);
  if (!loc) return null;
  const column = columns[loc.colIdx]!;
  const sole = column.panes.length === 1;
  if (dir === "up" || dir === "down") {
    return verticalMoveTarget(column, loc.paneIdx, dir);
  }
  return horizontalMoveTarget(columns, loc.colIdx, sole, dir);
}

export function resizeColumnWidth(
  columns: Column[],
  columnId: string,
  widthPx: number,
): Column[] {
  const column = columns.find((c) => c.id === columnId);
  if (!column) return columns;
  const clamped = Math.max(MIN_COLUMN_WIDTH_PX, Math.round(widthPx));
  if (column.widthPx === clamped) return columns;
  return columns.map((c) =>
    c.id === columnId ? { ...c, widthPx: clamped } : c,
  );
}

export function resizePaneRatio<T extends ColumnLike>(
  columns: T[],
  columnId: string,
  seamIndex: number,
  deltaRatio: number,
): T[] {
  const column = columns.find((c) => c.id === columnId);
  const upper = column?.panes[seamIndex];
  const lower = column?.panes[seamIndex + 1];
  if (!column || !upper || !lower) return columns;
  const maxGrow = lower.heightRatio - MIN_PANE_RATIO;
  const maxShrink = upper.heightRatio - MIN_PANE_RATIO;
  const delta = Math.max(
    -Math.max(0, maxShrink),
    Math.min(Math.max(0, maxGrow), deltaRatio),
  );
  if (delta === 0) return columns;
  return columns.map((c) => {
    if (c.id !== columnId) return c;
    const panes = c.panes.map((p, i) => {
      if (i === seamIndex) return { ...p, heightRatio: upper.heightRatio + delta };
      if (i === seamIndex + 1) {
        return { ...p, heightRatio: lower.heightRatio - delta };
      }
      return p;
    });
    return { ...c, panes };
  });
}

export const EDGE_ZONE_PX = 48;

export interface PaneRect {
  itemId: string;
  columnId: string;
  leftPx: number;
  widthPx: number;
  topFr: number;
  heightFr: number;
}

export function railGeometry(
  columns: Column[],
): { rects: PaneRect[]; totalWidthPx: number } {
  const rects: PaneRect[] = [];
  let leftPx = 0;
  for (const column of columns) {
    let topFr = 0;
    for (const pane of column.panes) {
      rects.push({
        itemId: pane.itemId,
        columnId: column.id,
        leftPx,
        widthPx: column.widthPx,
        topFr,
        heightFr: pane.heightRatio,
      });
      topFr += pane.heightRatio;
    }
    leftPx += column.widthPx;
  }
  return { rects, totalWidthPx: leftPx };
}

export function minimalScrollLeft(
  scrollLeft: number,
  viewportWidthPx: number,
  colLeftPx: number,
  colWidthPx: number,
): number {
  if (colWidthPx >= viewportWidthPx) return colLeftPx;
  if (colLeftPx < scrollLeft) return colLeftPx;
  const colRight = colLeftPx + colWidthPx;
  const viewRight = scrollLeft + viewportWidthPx;
  if (colRight > viewRight) return colRight - viewportWidthPx;
  return scrollLeft;
}

export type DropIndicator =
  | { kind: "column"; leftPx: number }
  | { kind: "seam"; leftPx: number; widthPx: number; topFr: number };

function resolveSeamDropInColumn(
  column: Column,
  yFr: number,
  leftPx: number,
): { target: MoveTarget; indicator: DropIndicator } | null {
  let topFr = 0;
  for (let p = 0; p < column.panes.length; p++) {
    const pane = column.panes[p]!;
    const bottomFr = topFr + pane.heightRatio;
    if (yFr < bottomFr || p === column.panes.length - 1) {
      const inBottomHalf = yFr > topFr + pane.heightRatio / 2;
      return {
        target: {
          kind: "seam",
          columnId: column.id,
          seamIndex: p + (inBottomHalf ? 1 : 0),
        },
        indicator: {
          kind: "seam",
          leftPx,
          widthPx: column.widthPx,
          topFr: inBottomHalf ? bottomFr : topFr,
        },
      };
    }
    topFr = bottomFr;
  }
  return null;
}

export function resolveDropTarget(
  columns: Column[],
  contentX: number,
  yFr: number,
): { target: MoveTarget; indicator: DropIndicator } | null {
  if (columns.length === 0) {
    return {
      target: { kind: "column", railIndex: 0 },
      indicator: { kind: "column", leftPx: 0 },
    };
  }
  let leftPx = 0;
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i]!;
    const rightPx = leftPx + column.widthPx;
    if (Math.abs(contentX - leftPx) < EDGE_ZONE_PX) {
      return {
        target: { kind: "column", railIndex: i },
        indicator: { kind: "column", leftPx },
      };
    }
    if (contentX < rightPx - EDGE_ZONE_PX) {
      return resolveSeamDropInColumn(column, yFr, leftPx);
    }
    leftPx = rightPx;
  }
  return {
    target: { kind: "column", railIndex: columns.length },
    indicator: { kind: "column", leftPx },
  };
}

function validateColumnWidth(
  widthPx: unknown,
  defaultWidthPx: number,
): number {
  return typeof widthPx === "number" &&
    Number.isFinite(widthPx) &&
    widthPx >= MIN_COLUMN_WIDTH_PX
    ? Math.round(widthPx)
    : defaultWidthPx;
}

function coerceHeightRatio(heightRatio: unknown): number {
  return typeof heightRatio === "number" && isUsableRatio(heightRatio)
    ? heightRatio
    : 0;
}

function validateColumnId(id: unknown, nextColumnId: () => string): string {
  return typeof id === "string" && id !== "" ? id : nextColumnId();
}

function validateAndProcessPane(
  rawPane: unknown,
  known: Map<string, { id: string; hidden?: boolean | undefined }>,
  seen: Set<string>,
  unhide: string[],
): PaneSlot | null {
  if (typeof rawPane !== "object" || rawPane === null) return null;
  const { itemId, heightRatio } = rawPane as Partial<PaneSlot>;
  if (typeof itemId !== "string") return null;
  const item = known.get(itemId);
  if (!item || seen.has(itemId)) return null;
  seen.add(itemId);
  if (item.hidden === true) unhide.push(itemId);
  return {
    itemId,
    heightRatio: coerceHeightRatio(heightRatio),
  };
}

function repairColumn(
  rawColumn: unknown,
  known: Map<string, { id: string; hidden?: boolean | undefined }>,
  seen: Set<string>,
  unhide: string[],
  defaultWidthPx: number,
  nextColumnId: () => string,
): Column | null {
  if (typeof rawColumn !== "object" || rawColumn === null) return null;
  const { id, widthPx, panes } = rawColumn as Partial<Column>;
  const validPanes: PaneSlot[] = [];
  for (const rawPane of Array.isArray(panes) ? panes : []) {
    const pane = validateAndProcessPane(rawPane, known, seen, unhide);
    if (pane) validPanes.push(pane);
  }
  if (validPanes.length === 0) return null;
  return {
    id: validateColumnId(id, nextColumnId),
    widthPx: validateColumnWidth(widthPx, defaultWidthPx),
    panes: normalizeRatios(validPanes),
  };
}

function appendOrphanColumns(
  columns: Column[],
  items: readonly { id: string; hidden?: boolean | undefined }[],
  seen: Set<string>,
  nextColumnId: () => string,
  defaultWidthPx: number,
): void {
  for (const item of items) {
    if (seen.has(item.id) || item.hidden === true) continue;
    columns.push({
      id: nextColumnId(),
      widthPx: defaultWidthPx,
      panes: [{ itemId: item.id, heightRatio: 1 }],
    });
  }
}

export function repairLayout(
  rawColumns: unknown,
  rawDefaultWidth: unknown,
  items: readonly { id: string; hidden?: boolean | undefined }[],
  nextColumnId: () => string,
): { columns: Column[]; defaultWidthPx: number; unhide: string[] } {
  const defaultWidthPx =
    typeof rawDefaultWidth === "number" &&
    Number.isFinite(rawDefaultWidth) &&
    rawDefaultWidth >= MIN_COLUMN_WIDTH_PX
      ? Math.round(rawDefaultWidth)
      : SEED_WIDTH_PX;

  const known = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const unhide: string[] = [];
  const columns: Column[] = [];

  for (const rawColumn of Array.isArray(rawColumns) ? rawColumns : []) {
    const column = repairColumn(
      rawColumn,
      known,
      seen,
      unhide,
      defaultWidthPx,
      nextColumnId,
    );
    if (column) columns.push(column);
  }

  appendOrphanColumns(columns, items, seen, nextColumnId, defaultWidthPx);

  return { columns, defaultWidthPx, unhide };
}

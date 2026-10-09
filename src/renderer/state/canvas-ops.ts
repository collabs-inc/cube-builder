/**
 * Pure ops for the canvas view's tiles: a flat list of `{ itemId, x, y, w,
 * h, z }` rects in world coordinates, one per placed item. No DOM, no
 * React, no store access — workspace.ts composes these into mutations the
 * same way it composes layout-ops.ts for columns. Nothing here mutates its
 * arguments; functions documented as returning "the same reference" on a
 * no-op do exactly that, so callers can identity-check to skip a
 * notify()/save cycle.
 *
 * Ported from cube-public's shell canvas (canvas-state.js /
 * canvas-rpc.js's findAutoPlacement), reshaped from that renderer's
 * module-global mutable `tiles` array into immutable functions.
 */

/** One item's placement on the canvas — identity stays in the catalog. */
export interface CanvasTile {
  itemId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

/** Minor grid cell — positions and sizes snap to this. */
export const CANVAS_GRID_PX = 20;

export const MIN_TILE_W = 200;
export const MIN_TILE_H = 120;

// Half again as large as the ported shell's defaults (400x520 / 440x540),
// which read cramped on a real display. Kept grid-aligned, and kept in step
// with the engine's own DEFAULT_TILE_SIZES (canvas/canvas-state.js): a tile
// opened from the sidebar is sized here, one created on the canvas itself
// (new-tile button, double-click) is sized there.
const DEFAULT_TERM_SIZE = { w: 600, h: 780 };
const DEFAULT_FILE_SIZE = { w: 660, h: 800 };
const DEFAULT_TREE_SIZE = { w: 360, h: 540 };

export type TileSize = { w: number; h: number };

/**
 * The two remembered-size buckets a manual tile resize teaches: resizing a
 * terminal or ACP conversation sets the default for future interactive tiles, resizing any
 * document tile (note/code/pdf) sets the document default. Two buckets,
 * not one and not one-per-type: a terminal aspect rarely suits a document,
 * but within the document family one preference is one preference. Types
 * outside both buckets (tree, image, browser) keep their fixed defaults —
 * an image sizes to its content and a tree pane is a narrow chrome
 * column, so "the last size I set" is not a preference worth propagating
 * from them.
 */
export type TileSizeBucket = "term" | "doc";
export type RememberedTileSizes = Partial<Record<TileSizeBucket, TileSize>>;

export function tileSizeBucket(itemType: string): TileSizeBucket | null {
  if (itemType === "term" || itemType === "agent") return "term";
  if (itemType === "note" || itemType === "code" || itemType === "pdf") return "doc";
  return null;
}

/** Grid-snaps and floor-clamps a size the user dragged out, so a remembered
 * default is always a size the engine could itself have produced. */
export function clampTileSize(size: TileSize): TileSize {
  return {
    w: Math.max(MIN_TILE_W, snap(size.w)),
    h: Math.max(MIN_TILE_H, snap(size.h)),
  };
}

/** Repairs a persisted remembered-sizes record — unknown JSON in, only
 * well-formed buckets out (same division of labor as repairCanvasTiles). */
export function repairRememberedTileSizes(raw: unknown): RememberedTileSizes {
  const out: RememberedTileSizes = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const bucket of ["term", "doc"] as const) {
    const v = (raw as Record<string, unknown>)[bucket];
    if (typeof v !== "object" || v === null) continue;
    const { w, h } = v as { w?: unknown; h?: unknown };
    if (typeof w !== "number" || !Number.isFinite(w)) continue;
    if (typeof h !== "number" || !Number.isFinite(h)) continue;
    out[bucket] = clampTileSize({ w, h });
  }
  return out;
}

/** Default tile size by catalog item type (grid-aligned): the remembered
 * size for the type's bucket when one has been taught, else the built-in. */
export function defaultTileSize(itemType: string, remembered?: RememberedTileSizes): TileSize {
  const bucket = tileSizeBucket(itemType);
  const taught = bucket ? remembered?.[bucket] : undefined;
  if (taught) return { ...taught };
  if (itemType === "term" || itemType === "agent") return { ...DEFAULT_TERM_SIZE };
  if (itemType === "tree") return { ...DEFAULT_TREE_SIZE };
  return { ...DEFAULT_FILE_SIZE };
}

const snap = (v: number): number => Math.round(v / CANVAS_GRID_PX) * CANVAS_GRID_PX;

/** Breathing room an auto-placed tile keeps from its neighbours — one minor
 * grid cell, so a new tile never lands flush against an existing one. */
export const PLACEMENT_GAP = CANVAS_GRID_PX;

/** How far from the origin the scan below is willing to walk. */
const SCAN_W = 4000;
const SCAN_H = 3000;

/** Fallback origin (and stagger step) when there is no viewport to center on. */
const MARGIN = 40;

/** The top-left a tile of this size takes to sit centered on a world point. */
export function originForCenter(
  center: { x: number; y: number },
  w: number,
  h: number,
): { x: number; y: number } {
  return { x: snap(center.x - w / 2), y: snap(center.y - h / 2) };
}

/**
 * First slot for a tile of the given size that clears every existing tile by
 * at least PLACEMENT_GAP: a row-major scan on the grid starting AT `origin`
 * and walking rightward, dropping a grid row at a time. `origin` is where the
 * user is looking (the caller centers it on the viewport), so a new tile
 * lands under the eye and cascades to the right of whatever is already
 * there — never back at the world origin, which is what the ported
 * findAutoPlacement did. Space to the left of `origin` is deliberately not
 * considered. Bounded and quadratic-ish, fine at this scale — same caveat as
 * the original.
 */
export function findPlacement(
  tiles: CanvasTile[],
  w: number,
  h: number,
  origin: { x: number; y: number } = { x: MARGIN, y: MARGIN },
): { x: number; y: number } {
  const startX = snap(origin.x);
  const startY = snap(origin.y);
  for (let y = startY; y <= startY + SCAN_H; y += CANVAS_GRID_PX) {
    for (let x = startX; x <= startX + SCAN_W; x += CANVAS_GRID_PX) {
      const overlaps = tiles.some(
        (t) =>
          x - PLACEMENT_GAP < t.x + t.w &&
          x + w + PLACEMENT_GAP > t.x &&
          y - PLACEMENT_GAP < t.y + t.h &&
          y + h + PLACEMENT_GAP > t.y,
      );
      if (!overlaps) return { x, y };
    }
  }
  const last = tiles[tiles.length - 1];
  if (last) return { x: last.x + MARGIN, y: last.y + MARGIN };
  return { x: startX, y: startY };
}

const topZ = (tiles: CanvasTile[]): number => tiles.reduce((m, t) => Math.max(m, t.z), 0);

/**
 * Places an item on the canvas at the first free slot, above everything.
 * `origin` is where the scan starts (the viewport center, from the caller);
 * without one it falls back to the world margin. Same reference if the item
 * already has a tile.
 */
export function addCanvasTile(
  tiles: CanvasTile[],
  itemId: string,
  size: { w: number; h: number },
  origin?: { x: number; y: number },
): CanvasTile[] {
  if (tiles.some((t) => t.itemId === itemId)) return tiles;
  const { x, y } = origin
    ? findPlacement(tiles, size.w, size.h, origin)
    : findPlacement(tiles, size.w, size.h);
  return [...tiles, { itemId, x, y, w: size.w, h: size.h, z: topZ(tiles) + 1 }];
}

/** Drops an item's tile. Same reference if it has none. */
export function removeCanvasTile(tiles: CanvasTile[], itemId: string): CanvasTile[] {
  if (!tiles.some((t) => t.itemId === itemId)) return tiles;
  return tiles.filter((t) => t.itemId !== itemId);
}




/**
 * Prunes tiles whose items the catalog no longer knows — the canvas
 * counterpart of layout-ops' reconcileColumns, run from the same place.
 * Same reference when every tile's item is known (this runs on every
 * accepted catalog snapshot).
 */
export function reconcileCanvasTiles(
  tiles: CanvasTile[],
  knownItemIds: Set<string>,
): CanvasTile[] {
  if (tiles.every((t) => knownItemIds.has(t.itemId))) return tiles;
  return tiles.filter((t) => knownItemIds.has(t.itemId));
}

const isFinitePos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Shape repair for persisted JSON: keeps only tiles with a string itemId
 * and finite numbers (first tile wins on duplicate ids), snaps geometry
 * and clamps sizes up to the minimum. Anything else repairs to empty —
 * hydrate never trusts the file.
 */
export function repairCanvasTiles(raw: unknown): CanvasTile[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CanvasTile[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const t = entry as Record<string, unknown>;
    if (typeof t.itemId !== "string" || seen.has(t.itemId)) continue;
    if (!isFinitePos(t.x) || !isFinitePos(t.y) || !isFinitePos(t.w) || !isFinitePos(t.h)) continue;
    const z = isFinitePos(t.z) ? t.z : 1;
    seen.add(t.itemId);
    out.push({
      itemId: t.itemId,
      x: snap(t.x),
      y: snap(t.y),
      w: Math.max(MIN_TILE_W, snap(t.w)),
      h: Math.max(MIN_TILE_H, snap(t.h)),
      z,
    });
  }
  return out;
}


// ── Viewport persistence (moved from canvas-viewport-ops.ts when the
// runtime viewport math returned to the ported engine's canvas-viewport.js;
// these are the persistence-side halves the store and CanvasView keep) ──

/** Runtime viewport: screen = world * zoom + pan. */
export interface CanvasViewport {
  panX: number;
  panY: number;
  zoom: number;
}

/** Persisted viewport: the world point at the viewport's center, plus zoom. */
export interface PersistedCanvasViewport {
  centerX: number;
  centerY: number;
  zoom: number;
}

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 1;

const DEFAULT_VIEWPORT: PersistedCanvasViewport = { centerX: 0, centerY: 0, zoom: 1 };


/** Restores runtime pan from the persisted center for the current viewport size. */
export function fromCenterPoint(
  c: PersistedCanvasViewport,
  viewportW: number,
  viewportH: number,
): CanvasViewport {
  return {
    panX: viewportW / 2 - c.centerX * c.zoom,
    panY: viewportH / 2 - c.centerY * c.zoom,
    zoom: c.zoom,
  };
}

/**
 * The runtime viewport a canvas should open with. A persisted center
 * restores by center point — except the untouched default (nothing ever
 * committed), which anchors the world origin at the viewport's top-left
 * instead, keeping a fresh canvas in positive world coordinates (the
 * fallback placement margin, and the first screenful either way, live
 * there).
 */
export function initialViewport(
  c: PersistedCanvasViewport,
  viewportW: number,
  viewportH: number,
): CanvasViewport {
  const untouched =
    c.centerX === DEFAULT_VIEWPORT.centerX &&
    c.centerY === DEFAULT_VIEWPORT.centerY &&
    c.zoom === DEFAULT_VIEWPORT.zoom;
  if (untouched) return { panX: 0, panY: 0, zoom: 1 };
  return fromCenterPoint(c, viewportW, viewportH);
}

/**
 * Shape repair for persisted JSON: finite numbers or the default, zoom
 * clamped into range (persisted state can never resurrect an unreachable
 * zoom, whatever wrote it).
 */
export function repairCanvasViewport(raw: unknown): PersistedCanvasViewport {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_VIEWPORT };
  const v = raw as Record<string, unknown>;
  if (!isFinitePos(v.centerX) || !isFinitePos(v.centerY) || !isFinitePos(v.zoom)) {
    return { ...DEFAULT_VIEWPORT };
  }
  return {
    centerX: v.centerX,
    centerY: v.centerY,
    zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom)),
  };
}

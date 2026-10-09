/**
 * A pull channel for the mounted canvas's viewport center, in world
 * coordinates — the counterpart to canvas-reveal's push signal, and kept
 * separate from the store for the same layering reason: the store must not
 * import the canvas engine, and the runtime viewport is the engine's, not
 * state the store holds.
 *
 * Why not read `canvasViewport` off the store instead: that field is the
 * PERSISTED center, written debounced (500 ms) by the engine's save, so it
 * lags a pan the user just finished — and its untouched default (0, 0) does
 * not describe the viewport center at all (a fresh canvas anchors the world
 * origin at the top-left, see initialViewport). Placement needs the live
 * number.
 */

/** Returns the world point at the viewport's center, or null if unmeasurable. */
type CenterProvider = () => { x: number; y: number } | null;

let provider: CenterProvider | null = null;

/** Registers the mounted canvas as the source; returns an unregister. */
export function setCanvasCenterProvider(next: CenterProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

/** The world point at the center of the view, or null when no canvas is up. */
export function canvasCenter(): { x: number; y: number } | null {
  return provider ? provider() : null;
}

/**
 * A one-way signal from the workspace store to whatever canvas surface is
 * mounted: "the user asked for this item — bring its tile into view."
 * Fired by focusItem's canvas branch (sidebar row clicks) for both an
 * already-placed item and a freshly placed one; CanvasView subscribes and
 * answers with focus + a pan-to-tile. Kept as its own tiny module because
 * the store must not import the canvas engine (layering), and the engine's
 * viewport is not state the store holds — a store field would need
 * awkward consume-and-clear semantics for what is genuinely an event.
 */

type RevealListener = (itemId: string) => void;

const listeners = new Set<RevealListener>();

export function onCanvasReveal(cb: RevealListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function requestCanvasReveal(itemId: string): void {
  for (const cb of listeners) cb(itemId);
}

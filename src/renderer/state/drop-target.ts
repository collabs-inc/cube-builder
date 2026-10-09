/**
 * Where a drag currently is — the zone under the pointer and, inside it,
 * the item slot. Same plain module-store shape as ui.ts and workspace.ts.
 *
 * A store rather than props because the writer and the readers are at
 * opposite ends of the tree: App's window listeners see every drag event,
 * while the surface that has to draw the affordance is a TerminalItem
 * several levels down inside Rail's slots. Threading a prop through would
 * mean Rail re-rendering on every dragover, which is the one thing this
 * has to avoid — see `setDropTarget`'s equality check.
 *
 * View state only, never persisted: a drag does not survive a reload.
 */



import { useSyncExternalStore } from "react";
import type { DropTarget } from "../drag-drop";

let state: DropTarget | null = null;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const callback of subscribers) callback();
}

/**
 * Publishes where the drag is now, or `null` when there is no drag.
 *
 * The equality check is load-bearing, not an optimization: `dragover`
 * fires continuously for as long as a drag hovers, and without it every
 * one of those events would notify — and so re-render — every subscribed
 * item for the whole duration of the drag. Holding the same object while
 * unchanged also keeps `getSnapshot` stable, which `useSyncExternalStore`
 * requires (a fresh object per read loops forever).
 */
export function setDropTarget(target: DropTarget | null): void {
  if (state === null && target === null) return;
  if (state !== null && target !== null) {
    if (state.zone === target.zone && state.itemId === target.itemId && state.drag === target.drag) return;
  }
  state = target;
  notify();
}

export const dropTargetStore = {
  subscribe(callback: () => void): () => void {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  },
  getSnapshot(): DropTarget | null {
    return state;
  },
};

/** Subscribes a component to the drag position. */
export function useDropTarget(): DropTarget | null {
  return useSyncExternalStore(dropTargetStore.subscribe, dropTargetStore.getSnapshot);
}

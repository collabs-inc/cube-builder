/**
 * One derived store for every surface's dots, so the sidebar, pane headers
 * and the screen strip read the same answer and none of them re-derives it.
 *
 * The map holds only rows that are not idle, and keeps its identity when a
 * catalog change moved nothing — a streaming title or cwd update must not
 * re-render every dot. A per-item selector returns a primitive, so a pane
 * header re-renders only when its own state changes.
 */



import { useSyncExternalStore } from "react";
import type { MergedCatalog } from "@port/shared/catalog";
import { catalogStore } from "../state/catalog";
import { deriveAttention, type Attention } from "./attention";
import { watermarkStore, type Watermarks } from "./watermarks";

let cache: { items: MergedCatalog["items"]; marks: Watermarks; map: ReadonlyMap<string, Attention> } | null = null;

function sameMap(a: ReadonlyMap<string, Attention>, b: ReadonlyMap<string, Attention>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, state] of a) if (b.get(id) !== state) return false;
  return true;
}

function snapshot(): ReadonlyMap<string, Attention> {
  const { items } = catalogStore.getSnapshot();
  const marks = watermarkStore.getSnapshot();
  if (cache && cache.items === items && cache.marks === marks) return cache.map;
  const map = new Map<string, Attention>();
  for (const item of items) {
    if (item.type !== "term" && item.type !== "agent") continue;
    const state = deriveAttention(item, marks[item.id]);
    if (state !== "idle") map.set(item.id, state);
  }
  cache = { items, marks, map: cache && sameMap(cache.map, map) ? cache.map : map };
  return cache.map;
}

function subscribe(callback: () => void): () => void {
  const offCatalog = catalogStore.subscribe(callback);
  const offMarks = watermarkStore.subscribe(callback);
  return () => {
    offCatalog();
    offMarks();
  };
}

export const attentionStore = { subscribe, getSnapshot: snapshot };

export function useAttentionMap(): ReadonlyMap<string, Attention> {
  return useSyncExternalStore(subscribe, snapshot);
}

export function useItemAttention(itemId: string): Attention {
  return useSyncExternalStore(subscribe, () => snapshot().get(itemId) ?? "idle");
}

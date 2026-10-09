/** Ephemeral in-gesture layout for one screen, so the screen strip's
 * indicator follows a divider or seam drag live. Never persisted; the
 * workspace store receives the committed layout when the gesture ends. */



import { useSyncExternalStore } from "react";
import type { ScreenColumn } from "./screen-ops";

export interface ScreenLayoutPreview {
  screenId: string;
  columns: ScreenColumn[];
}

let preview: ScreenLayoutPreview | null = null;
const listeners = new Set<() => void>();

export function setScreenLayoutPreview(next: ScreenLayoutPreview | null): void {
  if (preview?.screenId === next?.screenId && preview?.columns === next?.columns) return;
  preview = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useScreenLayoutPreview(): ScreenLayoutPreview | null {
  return useSyncExternalStore(subscribe, () => preview, () => preview);
}

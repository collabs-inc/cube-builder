/** Ephemeral rail position for the screen strip; never persisted or rendered
 * through workspace state on every animation frame. IDs survive tab removal. */
export interface ScreenScrollPosition {
  fromId: string;
  toId: string;
  progress: number;
}

let position: ScreenScrollPosition | null = null;
const listeners = new Set<(position: ScreenScrollPosition | null) => void>();

export function setScreenScrollPosition(next: ScreenScrollPosition | null): void {
  if (position?.fromId === next?.fromId && position?.toId === next?.toId && position?.progress === next?.progress) return;
  position = next;
  for (const listener of listeners) listener(position);
}

export function onScreenScrollPosition(listener: (position: ScreenScrollPosition | null) => void): () => void {
  listeners.add(listener);
  listener(position);
  return () => { listeners.delete(listener); };
}

export function getScreenScrollPosition(): ScreenScrollPosition | null {
  return position;
}

/**
 * The screen the rail is showing right now — the nearer of the two pages
 * a scroll sits between — or null when no rail is reporting (narrow mode,
 * a test). The active view only follows a native scroll once it settles;
 * this is what an open should target so it lands where the user is looking,
 * even mid-coast.
 */
export function visibleScreenId(): string | null {
  if (!position) return null;
  return position.progress < 0.5 ? position.fromId : position.toId;
}

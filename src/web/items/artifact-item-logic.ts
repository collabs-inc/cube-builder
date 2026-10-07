// Adapted from src/windows/app/src/items/artifact-item-logic.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
// Double-buffered frame state for ArtifactItem: an agent rewrites a screen
// many times during a build, and resetting one iframe's src white-flashes
// on every write. The next URL loads in the hidden frame; the swap happens
// on its load event.
export type FrameSide = "a" | "b";

export interface FrameState {
  front: FrameSide;
  a: string | null;
  b: string | null;
  loading: FrameSide | null;
}

export function initialFrameState(): FrameState {
  return { front: "a", a: null, b: null, loading: null };
}

export function beginLoad(state: FrameState, url: string): FrameState {
  const back: FrameSide = state.front === "a" ? "b" : "a";
  return { ...state, [back]: url, loading: back };
}

export function finishLoad(state: FrameState, side: FrameSide): FrameState {
  if (state.loading !== side) return state;
  return { ...state, front: side, loading: null };
}

export function artifactFileName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** Wait before retrying a ticket after `failures` consecutive failures (>= 1): 1 s, doubling, capped at 30 s. */
export function retryDelayMs(failures: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}

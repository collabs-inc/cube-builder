/**
 * The narrow-screen breakpoint, in one place.
 *
 * Narrow mode is a PROJECTION of the existing workspace model, never a
 * migration of it: this hook tells Rail.tsx to hold pane zoom on, tells
 * App.tsx to render the switcher, and tells Sidebar.tsx to be a drawer.
 * `columns` (state/workspace.ts) is untouched either way, so crossing the
 * breakpoint restores the same arrangement it left.
 *
 * Only phone-width viewports (below 520px) get the mobile projection.
 * Narrow desktop windows and tablets retain their apps and rail. This
 * is viewport-based, so a desktop window resized below 520px also lets
 * us exercise the phone UI. Keep the marked CSS media queries in sync.
 *
 * `matchMedia` is injectable for tests (`_setMatchMediaForTest`) rather
 * than read at module scope, so nothing here touches `window` until a
 * component actually renders.
 */



import { useMemo, useSyncExternalStore } from "react";

export const NARROW_MAX_WIDTH_PX = 519;
export const NARROW_QUERY = `(max-width: ${NARROW_MAX_WIDTH_PX}px)`;

/** The slice of `MediaQueryList` this hook uses — and all a test must fake. */
export interface MediaQueryLike {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export type MatchMedia = (query: string) => MediaQueryLike;

let matchMediaOverride: MatchMedia | null = null;

/** Test seam: pass a fake matcher, or `null` to restore `window.matchMedia`. */
export function _setMatchMediaForTest(impl: MatchMedia | null): void {
  matchMediaOverride = impl;
}

function resolveMatchMedia(): MatchMedia {
  if (matchMediaOverride) return matchMediaOverride;
  return (query) => window.matchMedia(query) as MediaQueryLike;
}

/** Subscribes to a media query and returns whether it currently matches. */
export function useMediaQuery(query: string): boolean {
  const mql = useMemo(() => resolveMatchMedia()(query), [query]);
  return useSyncExternalStore(
    (onStoreChange) => {
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    () => mql.matches,
  );
}

/** True below the narrow breakpoint — see this module's doc comment. */
export function useIsNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY);
}

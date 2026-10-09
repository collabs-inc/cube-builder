/**
 * Publishes the visual viewport's height as --app-viewport-height on the
 * root element while enabled (the narrow projection). This is the iOS
 * soft-keyboard fix (spec §3): Safari overlays the keyboard on the layout
 * viewport instead of resizing it, so a 100%-height shell keeps its
 * bottom — the terminal's input line — underneath the keys.
 * web.css consumes the var (`.web-host .app-shell`); the desktop app
 * never reads it, and an environment with no visualViewport (happy-dom,
 * old engines) is left exactly as it was. `scroll` is subscribed as well
 * as `resize` because iOS fires only a scroll when the keyboard's
 * interactive dismissal pans the viewport.
 *
 * The var is published only while the visual viewport is shorter than
 * the layout viewport by at least a keyboard's worth. Sized to the visual
 * viewport unconditionally, the installed PWA on iPhone showed a ~50px
 * band of page background under the shell with no keyboard up:
 * standalone Safari reports a visual viewport short of the layout
 * viewport there (2026-09-04, the status-bar band under
 * viewport-fit=cover, by the look of it), and no later resize corrects
 * it. A gap that small is not a keyboard, so the shell keeps its plain
 * 100% and reaches the bottom of the screen; the real keyboard is
 * hundreds of pixels and still shrinks the shell.
 */



import { useEffect } from "react";

/** Less than this between the two viewports is not a soft keyboard. */
export const KEYBOARD_MIN_PX = 120;

/** The shell height to publish, or null to leave it at 100%. */
export function keyboardViewportHeight(visual: number, layout: number): number | null {
  return layout - visual >= KEYBOARD_MIN_PX ? Math.round(visual) : null;
}

export interface ShellProbe {
  /** iOS's own flag for a home-screen (standalone) launch; undefined elsewhere. */
  standalone: boolean | undefined;
  innerWidth: number;
  innerHeight: number;
  screenHeight: number;
}

/** No shortfall larger than this is a status bar; treat it as unrelated. */
export const SHELL_EXTRA_MAX_PX = 100;

/**
 * How far the layout viewport falls short of the screen in an iOS
 * standalone launch — `--app-shell-extra`, which web.css adds to the root
 * element's height. Installed to the home screen with a translucent
 * status bar, iOS lays the page out from the top of the screen but sizes
 * `innerHeight` as if the status bar were opaque, so a 100% root ends a
 * status bar's height above the bottom edge and the page background
 * shows there (the PWA band under the key bar, 2026-09-04; plain Safari
 * has no such gap, and the visual-viewport rule above does not touch
 * it). Measured, not assumed: the difference between `screen.height`
 * and `innerHeight`, portrait only — iOS reports `screen.height` in
 * portrait terms regardless of orientation, and landscape hides the
 * status bar anyway — bounded to a status bar's size, and only under
 * `navigator.standalone`, which Android never sets. Zero everywhere the
 * quirk is absent, so a correct engine is a no-op.
 *
 * Measured ONCE per portrait session, never on every resize: growing the
 * root changes what iOS then reports for `innerHeight`, so a re-measure
 * after applying the extra reads no shortfall, removes it, the report
 * flips back, and the layout alternates between the two every frame
 * (2026-09-04, unusable). The hook latches the first portrait reading
 * and only lets go of it in landscape, where the status bar is gone.
 */
export function shellExtraHeight(p: ShellProbe): number {
  if (p.standalone !== true) return 0;
  if (p.innerWidth > p.innerHeight) return 0;
  const d = Math.round(p.screenHeight - p.innerHeight);
  return d > 0 && d <= SHELL_EXTRA_MAX_PX ? d : 0;
}

function probeShell(): ShellProbe {
  return {
    standalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    screenHeight: window.screen.height,
  };
}

export function useViewportHeightVar(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let latchedExtra: number | null = null;
    const apply = () => {
      const h = keyboardViewportHeight(vv.height, window.innerHeight);
      if (h === null) root.style.removeProperty("--app-viewport-height");
      else root.style.setProperty("--app-viewport-height", `${h}px`);
      if (window.innerWidth > window.innerHeight) latchedExtra = null;
      else if (latchedExtra === null) latchedExtra = shellExtraHeight(probeShell());
      const extra = latchedExtra ?? 0;
      if (extra === 0) root.style.removeProperty("--app-shell-extra");
      else root.style.setProperty("--app-shell-extra", `${extra}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    // Orientation changes reach the window, not always the visual viewport.
    window.addEventListener("resize", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--app-shell-extra");
    };
  }, [enabled]);
}

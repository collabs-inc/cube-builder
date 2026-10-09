/**
 * The web build's back-gesture story, whole (spec §4): opening an item
 * from the narrow home pushes ONE history entry, so Android's back
 * gesture and the browser back button mean "back to the list" instead of
 * "leave the app". Not routing — there are no URLs, no deep links; the
 * single entry upgrades cleanly to real routes when the notifications
 * project needs them.
 *
 * Detection is the `web-host` class src/windows/web/main.tsx puts on the
 * root element; on Electron every function here degrades to plain
 * setNarrowView, and installNarrowHistory installs nothing.
 *
 * `pushed` deliberately tolerates imbalance: a hide via the pane ✕
 * returns home without popping, and a reload forgets the flag while the
 * entry survives — in both cases the next hardware back is a no-op pop
 * to a state we are already showing, which is invisible.
 */



import { setNarrowView } from "./ui";
import { NARROW_QUERY } from "../hooks/useIsNarrow";

let pushed = false;
let installed = false;

function isWebHost(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("web-host");
}

/** Idempotent; returns a disposer. A no-op (noop disposer) off the web. */
export function installNarrowHistory(): () => void {
  if (installed || !isWebHost()) return () => {};
  installed = true;
  const onPop = () => {
    // The entry is consumed either way, but a stale entry popped after the
    // viewport widened must not touch narrowView — snapping it to "home"
    // here would strand the next narrow entry on the wrong screen when the
    // viewport narrows again.
    pushed = false;
    if (!window.matchMedia(NARROW_QUERY).matches) return;
    setNarrowView("home");
  };
  window.addEventListener("popstate", onPop);
  return () => {
    installed = false;
    window.removeEventListener("popstate", onPop);
  };
}

/** Call on each narrow home→item transition. Pushes at most one entry. */
export function noteNarrowItemOpened(): void {
  if (!isWebHost() || pushed) return;
  window.history.pushState({ cubeNarrowItem: true }, "");
  pushed = true;
}

/** The one back-to-home entry point: pops the pushed entry when there is one (so the history stack stays balanced), else sets the view directly. */
export function goNarrowHome(): void {
  if (isWebHost() && pushed) {
    window.history.back();
    return;
  }
  setNarrowView("home");
}

export function _resetForTest(): void {
  pushed = false;
  installed = false;
}

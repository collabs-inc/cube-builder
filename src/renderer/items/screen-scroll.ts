/** Continuous scrolling owns motion; selection changes only at a settled page. */



import type { ScreenScrollPosition } from "../state/screen-scroll-position";
export interface ScreenScrollOptions {
  ids: string[];
  activeId: string;
  width: number;
  enabled: boolean;
  /** How to reach `activeId` when it changed: the default slides; "instant"
   * cuts. A one-shot hint, read only on the update whose activeId changed. */
  behavior?: "smooth" | "instant";
}

export function canConsumeHorizontalWheel(target: EventTarget | null, rail: HTMLElement, deltaX: number): boolean {
  let element = target instanceof Element ? target : null;
  while (element && element !== rail) {
    if (element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1) {
      const overflow = getComputedStyle(element).overflowX;
      if ((overflow === "auto" || overflow === "scroll") && (
        deltaX < 0 ? element.scrollLeft > 0 : element.scrollLeft + element.clientWidth < element.scrollWidth - 1
      )) return true;
    }
    element = element.parentElement;
  }
  return false;
}

/** CSS scroll snap and the browser own all gesture/coasting motion. This
 * controller observes alignment and requests native scrolling for explicit
 * navigation; it never drives a competing frame loop or applies wheel deltas. */
export function createScreenScroller(
  rail: HTMLElement,
  select: (id: string) => void,
  showPages: (first: number, last: number) => void,
  showPosition: (position: ScreenScrollPosition | null) => void = () => {},
  onAligned: (id: string, nativeScrollEnd?: boolean) => void = () => {},
) {
  let options: ScreenScrollOptions | null = null;
  let requestedId: string | null = null;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let visible = "";
  const showVisible = () => {
    if (!options?.enabled || options.width <= 0) return;
    const page = Math.max(0, Math.min(options.ids.length - 1, rail.scrollLeft / options.width));
    const first = Math.floor(page);
    const last = Math.ceil(page);
    showPosition({ fromId: options.ids[first]!, toId: options.ids[last]!, progress: page - first });
    const key = `${first}:${last}`;
    if (key !== visible) { visible = key; showPages(first, last); }
  };
  const finish = (nativeScrollEnd = false) => {
    clearTimeout(fallback);
    if (!options?.enabled || options.width <= 0) return;
    const index = Math.max(0, Math.min(options.ids.length - 1, Math.round(rail.scrollLeft / options.width)));
    const id = options.ids[index];
    // Native snapping may still be coasting or an older scrollend may arrive
    // after a new navigation request. Neither is permission to move the rail.
    if (!id || Math.abs(rail.scrollLeft - index * options.width) > 1 || (requestedId !== null && id !== requestedId)) return;
    requestedId = null;
    delete rail.dataset.screenScrolling;
    showVisible();
    onAligned(id, nativeScrollEnd);
    if (id !== options.activeId) select(id);
  };
  const onScrollEnd = (event: Event) => { if (event.target === rail) finish(true); };
  const onScroll = (event: Event) => {
    if (event.target !== rail || !options?.enabled) return;
    rail.dataset.screenScrolling = "true";
    showVisible();
    clearTimeout(fallback);
    // Compatibility fallback only commits an already aligned page. It never
    // interprets a pause in input as a reason to start another animation.
    fallback = setTimeout(finish, 120);
  };
  const interrupt = () => { requestedId = null; };
  const onWheel = (event: WheelEvent) => {
    if (!options?.enabled || event.deltaX === 0) return;
    if (canConsumeHorizontalWheel(event.target, rail, event.deltaX)) return;
    interrupt();
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    rail.dataset.screenScrolling = "true";
    clearTimeout(fallback);
    fallback = setTimeout(finish, 120);
    // Protect native horizontal scrolling from terminal mouse reporting and
    // editor wheel handlers. Stopping propagation leaves the browser's
    // default action (including gesture phases and momentum) intact.
    event.stopPropagation();
  };
  rail.addEventListener("scroll", onScroll, { passive: true });
  rail.addEventListener("scrollend", onScrollEnd);
  rail.addEventListener("wheel", onWheel, { capture: true, passive: true });
  // A mouse click selects content; only scrolling input releases navigation.
  rail.addEventListener("touchstart", interrupt, { passive: true });
  const navigate = (id: string, behavior: "smooth" | "instant" = "smooth") => {
    if (!options?.enabled || options.width <= 0) return;
    const index = options.ids.indexOf(id);
    if (index < 0) return;
    clearTimeout(fallback);
    if (behavior === "instant") {
      // A cut, not a slide: land aligned in the same frame, with no request
      // outstanding for a later scrollend to commit or a gesture to cancel.
      requestedId = null;
      delete rail.dataset.screenScrolling;
      rail.scrollTo({ left: index * options.width, behavior: "instant" });
      showVisible();
      onAligned(id);
      return;
    }
    if (Math.abs(rail.scrollLeft - index * options.width) <= 1) {
      if (requestedId !== null) rail.scrollTo({ left: index * options.width, behavior: "instant" });
      requestedId = null;
      delete rail.dataset.screenScrolling;
      onAligned(id);
    } else {
      requestedId = id;
      rail.dataset.screenScrolling = "true";
      rail.scrollTo({ left: index * options.width, behavior: "smooth" });
    }
  };
  return {
    navigate,
    update(next: ScreenScrollOptions) {
      const previous = options;
      options = next;
      if (!next.enabled || next.width <= 0) {
        clearTimeout(fallback);
        if (previous?.enabled) rail.scrollTo({ left: rail.scrollLeft, behavior: "instant" });
        delete rail.dataset.screenScrolling;
        requestedId = null;
        onAligned(next.activeId);
        showPosition(next.ids.includes(next.activeId) ? { fromId: next.activeId, toId: next.activeId, progress: 0 } : null);
        return;
      }
      const index = next.ids.indexOf(next.activeId);
      if (index < 0) return;
      const topologyChanged = !previous || previous.ids.length !== next.ids.length || previous.ids.some((id, i) => id !== next.ids[i]);
      // Closing the trailing screen may append its empty replacement while
      // the outgoing page is retained. Existing offsets are still intact,
      // so the selected neighbor can slide in just like any navigation.
      if (previous?.enabled && previous.width === next.width && previous.activeId !== next.activeId
        && previous.ids.every((id, i) => next.ids[i] === id)) {
        navigate(next.activeId, next.behavior);
        return;
      }
      if (!previous?.enabled || topologyChanged || previous.width !== next.width) {
        // During a gesture, stable CSS snap targets let the browser account
        // for layout changes without resetting the user's coasting position.
        // A reorder cut (spec §3.3) arrives as an instant update with the same
        // active screen and a new topology. It must not be treated as a
        // coasting gesture, or the rail stays on the old offset and settles on
        // whichever screen now lives there.
        if (previous?.enabled && rail.dataset.screenScrolling && previous.activeId === next.activeId && next.behavior !== "instant") {
          showVisible();
          return;
        }
        requestedId = null;
        clearTimeout(fallback);
        delete rail.dataset.screenScrolling;
        rail.scrollTo({ left: index * next.width, behavior: "instant" });
        showVisible();
        onAligned(next.activeId);
      } else if (previous.activeId !== next.activeId || next.behavior === "instant") navigate(next.activeId, next.behavior);
    },
    destroy() {
      showPosition(null);
      clearTimeout(fallback);
      delete rail.dataset.screenScrolling;
      rail.removeEventListener("scroll", onScroll);
      rail.removeEventListener("scrollend", onScrollEnd);
      rail.removeEventListener("wheel", onWheel, { capture: true });
      rail.removeEventListener("touchstart", interrupt);
    },
  };
}

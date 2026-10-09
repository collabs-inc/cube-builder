import { useCallback, useEffect, useLayoutEffect, type RefObject } from "react";

/** Shared overflow treatment for the screen indicators and collapsed app strip. */
export function useEdgeFades(scrollRef: RefObject<HTMLDivElement | null>, content: unknown): void {
  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    el.style.setProperty("--fade-l", el.scrollLeft > 0 ? "16px" : "0px");
    el.style.setProperty("--fade-r", el.scrollLeft < maxScroll - 1 ? "16px" : "0px");
  }, [scrollRef]);
  useLayoutEffect(update, [update, content]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", update);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    // Include shrinking screen indicators and app labels changing width.
    for (const child of el.children) observer?.observe(child);
    return () => { el.removeEventListener("scroll", update); observer?.disconnect(); };
  }, [scrollRef, update, content]);
}

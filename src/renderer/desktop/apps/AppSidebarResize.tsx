import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { startPointerDrag } from "../../items/use-pointer-drag";
import { appNavigationStore, setContentSidebarWidth, useAppNavigation } from "../../state/app-navigation";
import "./AppSidebarResize.css";

/** One retained sidebar's resize target; shrinking the viewport preserves its saved width. */
export function AppSidebarResize({ app, label }: { app: "workspace" | "files"; label: string }) {
  const navigation = useAppNavigation();
  const savedWidth = app === "workspace" ? navigation.studioSidebarWidth : navigation.finderSidebarWidth;
  const grip = useRef<HTMLDivElement>(null);
  const cancel = useRef<(() => void) | null>(null);
  const [measured, setMeasured] = useState({ width: savedWidth, max: 480 });
  const geometry = () => {
    const sidebar = grip.current?.parentElement;
    const viewport = app === "workspace" ? sidebar?.parentElement?.querySelector(".studio-surface") : sidebar?.parentElement;
    return { width: sidebar?.getBoundingClientRect().width ?? savedWidth, available: viewport?.getBoundingClientRect().width ?? 0 };
  };
  useLayoutEffect(() => {
    const sidebar = grip.current?.parentElement;
    const viewport = app === "workspace" ? sidebar?.parentElement?.querySelector(".studio-surface") : sidebar?.parentElement;
    if (!sidebar || !viewport) return;
    const measure = () => {
      const width = sidebar.getBoundingClientRect().width;
      const available = viewport.getBoundingClientRect().width;
      if (width && available) setMeasured({ width, max: Math.max(160, Math.min(480, available - 280)) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sidebar); observer.observe(viewport);
    return () => observer.disconnect();
  }, [app]);
  useEffect(() => () => cancel.current?.(), []);
  const resize = (width: number) => {
    const max = Math.max(160, Math.min(480, geometry().available - 280));
    setContentSidebarWidth(app, Math.max(Math.min(200, max), Math.min(max, width)));
  };
  return <div ref={grip} className="app-sidebar-resize" role="separator" aria-label={label} aria-orientation="vertical"
    aria-valuenow={Math.round(measured.width)} aria-valuemin={Math.min(200, measured.max)} aria-valuemax={Math.round(measured.max)} tabIndex={0}
    onKeyDown={event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault(); resize(geometry().width + (event.key === "ArrowRight" ? 16 : -16));
    }}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); cancel.current?.();
      const startWidth = geometry().width;
      const accountId = navigation.accountId;
      cancel.current = startPointerDrag(event, {
        onMove: dx => { if (appNavigationStore.getSnapshot().accountId === accountId) resize(startWidth + dx); },
        onEnd: (_dx, _dy, canceled) => {
          cancel.current = null;
          if (canceled && appNavigationStore.getSnapshot().accountId === accountId) setContentSidebarWidth(app, savedWidth);
        },
      });
    }} />;
}

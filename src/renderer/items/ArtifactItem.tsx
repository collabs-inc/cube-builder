import { useCallback, useEffect, useRef, useState } from "react";
import type { OwnedItem } from "@port/shared/catalog";

import { ARTIFACT_FOCUS_MESSAGE, artifactOpenUrl } from "@port/shared/artifact";
import { services } from "../services";
import { useAppTheme } from "../hooks/useAppTheme";
import { ArtifactLoading } from "./ArtifactLoading";
import { fsChangeTouchesPath } from "./file-item-logic";
import { artifactFileName, beginLoad, finishLoad, initialFrameState, retryDelayMs, type FrameSide, type FrameState } from "./artifact-item-logic";
import "./ArtifactItem.css";

const RELOAD_DEBOUNCE_MS = 300;

/**
 * One HTML artifact: a sandboxed frame with scripts and downloads on cubed's origin.
 * The URL is minted per load (short-lived ticket) and carries the theme,
 * because a cross-origin sandboxed frame cannot see the app's dark class.
 */
export function ArtifactItem({ item, visible, onFocus, bare = false }: { item: OwnedItem; visible: boolean; onFocus?: () => void; bare?: boolean }) {
  const theme = useAppTheme();
  const [frames, setFrames] = useState<FrameState>(initialFrameState);
  const [error, setError] = useState<string | null>(null);
  const frameRefs = useRef<Record<FrameSide, HTMLIFrameElement | null>>({ a: null, b: null });
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const front = frameRefs.current[frames.front];
      // Sandboxed frames all have origin "null". Authenticate the window,
      // and ignore background buffers and hidden panes.
      if (!visible || !front?.contentWindow || event.source !== front.contentWindow) return;
      if (event.data === ARTIFACT_FOCUS_MESSAGE) onFocus?.();
      const url = artifactOpenUrl(event.data);
      if (url) services.desktop.openExternal(url);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frames.front, visible, onFocus]);
  const filePathRef = useRef(item.filePath);
  filePathRef.current = item.filePath;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards a load's async resolution against a superseded reload (e.g. the
  // theme flipping mid-flight) and against a resolution that lands after
  // unmount — beginLoad/setError must never fire for a load() call that is
  // no longer the current one.
  const loadSeqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    // StrictMode replays setup after cleanup while preserving this ref.
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // A ticket request can fail on an open socket (a machine busy just after
  // a reconnect), which no status event will retry, so a failure schedules
  // its own retry with backoff. Any newer load supersedes it.
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(function load(failures = 0) {
    if (retryRef.current) clearTimeout(retryRef.current);
    retryRef.current = null;
    const filePath = filePathRef.current;
    const repoId = item.repoId ?? item.id;
    if (!filePath) return;
    const seq = ++loadSeqRef.current;
    services.artifacts
      .artifactUrl(item.machineId, { repoId, file: artifactFileName(filePath), theme })
      .then((url) => {
        if (!mountedRef.current || loadSeqRef.current !== seq) return;
        setError(null);
        setFrames((s) => beginLoad(s, url));
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || loadSeqRef.current !== seq) return;
        const message = err instanceof Error ? err.message : String(err);
        // The machine stopped between the check and the request: stay on the
        // loading surface, which the veil covers, and reload when it runs again.
        setError(message);
        retryRef.current = setTimeout(() => load(failures + 1), retryDelayMs(failures + 1));
      });
  }, [item.machineId, item.repoId, item.updatedAt, theme]);
  useEffect(() => { load(); }, [load]);
  // A retry belongs to the `load` that scheduled it: stale inputs or unmount cancel it.
  useEffect(() => () => {
    if (retryRef.current) clearTimeout(retryRef.current);
    retryRef.current = null;
  }, [load]);

  // Cached artifacts can mount before the router has a cloud endpoint. Retry
  // on connection (including reconnects), subscribing before the first
  // request so an open event cannot fall between loading and subscribing.
  useEffect(() => {
    const unsubscribe = services.repos.onStatus(({ repoId, status }) => {
      if (status === "open" && (repoId === item.repoId || repoId === item.machineId)) load();
    });
    load();
    return unsubscribe;
  }, [load, item.repoId, item.machineId]);

  // Reload when this screen's file changes on disk — debounced, because a
  // build writes the file in bursts. The cleanup below cancels a pending
  // debounce timer, not just the listener subscription: a `load` identity
  // change (theme flip, repo/machine change) re-runs this effect, and
  // without clearing the timer here, an already-scheduled setTimeout keeps
  // running and eventually calls the OLD, now-stale `load` closure —
  // clobbering the back buffer with a reload minted under the wrong theme
  // after the correct newer reload already landed there.
  useEffect(() => {
    const unsubscribe = services.files.onFsChanged((events) => {
      if (!fsChangeTouchesPath(events, filePathRef.current ?? null)) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        load();
      }, RELOAD_DEBOUNCE_MS);
    });
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      unsubscribe();
    };
  }, [load]);

  const onLoad = (side: FrameSide) => () => setFrames((s) => finishLoad(s, side));
  const frame = (side: FrameSide) => {
    const url = frames[side];
    if (url === null) return null;
    return (
      <iframe
        key={side}
        ref={(element) => { frameRefs.current[side] = element; }}
        className={`artifact-frame${frames.front === side ? " artifact-frame-front" : ""}`}
        src={url}
        sandbox="allow-scripts allow-downloads"
        title={item.agentTitle ?? artifactFileName(item.filePath ?? "")}
        onLoad={onLoad(side)}
        data-side={side}
      />
    );
  };

  const status = <>
    {!error && frames[frames.front] === null && <ArtifactLoading />}
    {error && <div className="artifact-error">{error}</div>}
  </>;
  // Bare (the persona workspace's clipped viewer) hands the frames to the
  // pane directly; on a screen they sit in main's own wrapper.
  if (bare) return <>{status}{frame("a")}{frame("b")}</>;
  return (
    <div className="artifact-item" data-visible={visible}>
      {status}
      <div className="artifact-frames">
        {frame("a")}
        {frame("b")}
      </div>
    </div>
  );
}

export default ArtifactItem;

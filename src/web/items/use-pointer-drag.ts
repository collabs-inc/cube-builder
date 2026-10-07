// Adapted from src/windows/app/src/items/use-pointer-drag.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * Minimal pointer-capture drag helper for the rail's resize and move
 * gestures: captures the pointer on the pressed element or a stable host, streams
 * move deltas, ends exactly once on pointerup/pointercancel/lostpointercapture
 * /Escape. move/up/cancel listen on `window`, not `target`: pointer capture
 * routes events to `target` only while it stays connected to the document,
 * but a gesture can remove or reparent the captor mid-drag (e.g. a pty exit
 * pruning the column being dragged) — capture is then implicitly released,
 * and `target` never sees the terminating pointerup/pointercancel at all.
 * `window` keeps receiving the pointer regardless, so `finish` still runs.
 * `lostpointercapture` on the capture target is the belt-and-suspenders backstop for
 * any other implicit-release path (e.g. another element stealing capture).
 * While a drag is live, body.rail-dragging lets CSS disable pointer
 * events on pane bodies so terminals/editors don't swallow the gesture.
 */
export interface PointerDragHandlers {
  onMove(dx: number, dy: number, e: PointerEvent): void;
  onEnd(dx: number, dy: number, canceled: boolean): void;
}

export function startPointerDrag(
  e: React.PointerEvent,
  handlers: PointerDragHandlers,
  stableCaptureTarget?: HTMLElement | null,
): () => void {
  const pressedTarget = e.currentTarget as HTMLElement;
  // Pane slots are deliberately hidden when a dwell switches screens. Keep
  // pointer capture on a caller-provided host (Rail itself) that remains
  // rendered for the full gesture, so hiding an iframe/header cannot turn a
  // valid cross-screen drag into lostpointercapture cancellation.
  const captureTarget = stableCaptureTarget ?? pressedTarget;
  const startX = e.clientX;
  const startY = e.clientY;
  let lastX = startX;
  let lastY = startY;
  let done = false;

  const finish = (canceled: boolean): void => {
    if (done) return;
    done = true;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    captureTarget.removeEventListener("lostpointercapture", onLostPointerCapture);
    window.removeEventListener("keydown", onKeyDown, true);
    document.body.classList.remove("rail-dragging");
    if (captureTarget.hasPointerCapture?.(e.pointerId)) captureTarget.releasePointerCapture(e.pointerId);
    handlers.onEnd(lastX - startX, lastY - startY, canceled);
  };

  const onPointerMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== e.pointerId) return;
    lastX = ev.clientX;
    lastY = ev.clientY;
    handlers.onMove(lastX - startX, lastY - startY, ev);
  };
  const onPointerUp = (ev: PointerEvent): void => { if (ev.pointerId === e.pointerId) finish(false); };
  const onPointerCancel = (ev: PointerEvent): void => { if (ev.pointerId === e.pointerId) finish(true); };
  const onLostPointerCapture = (ev: PointerEvent): void => {
    if (ev.pointerId === e.pointerId) finish(true);
  };
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      finish(true);
    }
  };

  captureTarget.setPointerCapture?.(e.pointerId);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  captureTarget.addEventListener("lostpointercapture", onLostPointerCapture);
  window.addEventListener("keydown", onKeyDown, true);
  document.body.classList.add("rail-dragging");
  return () => finish(true);
}

// The one way a UI component emits an event.
//
// The observer (observer.ts) covers everything derivable from a store, which
// is most of the taxonomy. A handful of events are not derivable — they name
// an INTENT, not a state change: the user clicked Subscribe, opened the
// billing portal, confirmed a machine roll. Those have to be captured where
// the click is handled.
//
// Rather than thread a `Capture` down through every modal's props, the live
// capture is parked here by `useAnalytics` (App.tsx) — the same one the
// observer and heartbeat use, built once by `rendererCapture()`. Before that
// runs, and in any build with analytics off (where `rendererCapture()`
// returns null and nothing is ever parked), `captureEvent` is an honest
// no-op: it drops the event rather than buffering it, exactly as the rest of
// the renderer does.
import type { Capture } from "@port/shared/analytics";

let current: Capture | null = null;

/** Called by `useAnalytics` on start, and with `null` on teardown. */
export function setRendererCapture(capture: Capture | null): void {
  current = capture;
}

/** Opaque readiness/lifetime token for pairing async events; never sent as a property. */
export function rendererCaptureSession(): object | null {
  return current;
}

/** Typed against the closed event map, like every other emitter. */
export const captureEvent: Capture = ((name, props) => {
  current?.(name, props);
}) as Capture;

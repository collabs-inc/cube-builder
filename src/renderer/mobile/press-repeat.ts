/**
 * Key auto-repeat for a held key-bar button: fire once on press, then
 * after `delayMs` keep firing every `intervalMs` until released. The
 * timings are a hardware keyboard's (≈400ms typematic delay, ≈15 Hz), so
 * holding ↓ walks a list the way holding the real key would. The stop
 * function is idempotent and safe after the timers already ran out.
 */

export interface RepeatTiming {
  delayMs: number;
  intervalMs: number;
}

export const KEY_REPEAT: RepeatTiming = { delayMs: 400, intervalMs: 66 };

export function startRepeat(fire: () => void, timing: RepeatTiming = KEY_REPEAT): () => void {
  fire();
  let interval: ReturnType<typeof setInterval> | null = null;
  let delay: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    delay = null;
    interval = setInterval(fire, timing.intervalMs);
  }, timing.delayMs);
  return () => {
    if (delay !== null) clearTimeout(delay);
    if (interval !== null) clearInterval(interval);
    delay = null;
    interval = null;
  };
}

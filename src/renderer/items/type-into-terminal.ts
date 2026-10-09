/**
 * Issue #61: typing a command into a terminal the app just created.
 *
 * Writing the moment `createTerminalItem` resolves races the shell's own
 * startup: the early bytes are echoed by the tty's line discipline before
 * any prompt exists, then zsh's line editor redraws over them, and the
 * user's first sight of a correct command is it apparently mangled and
 * split across two prompt lines. The pty has no "prompt drawn" signal, so
 * the closest observable is its output going quiet: wait for the first
 * output, then for a `quietMs` gap (each burst resets the window), and
 * only then type. `timeoutMs` bounds the wait so a shell that never says
 * anything still gets its command.
 */



import type { PtyService } from "../services/types";

interface FreshTerminalTiming {
  quietMs: number;
  timeoutMs: number;
}

const DEFAULT_TIMING: FreshTerminalTiming = { quietMs: 150, timeoutMs: 2000 };

let timing = DEFAULT_TIMING;

/** Test-only: shrink the windows; `null` restores the defaults. */
export function _setFreshTerminalTimingForTest(override: FreshTerminalTiming | null): void {
  timing = override ?? DEFAULT_TIMING;
}

type FreshTerminalPty = Pick<PtyService, "write" | "onData" | "offData">;

/** Resolves once the write has gone out. Never rejects. */
export function typeIntoFreshTerminal(
  pty: FreshTerminalPty,
  sessionId: string,
  data: string,
): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let done = false;

    const fire = (): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(quietTimer);
      pty.offData(sessionId, onData);
      pty.write(sessionId, data);
      resolve();
    };

    const onData = (): void => {
      if (done) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(fire, timing.quietMs);
    };

    const deadline = setTimeout(fire, timing.timeoutMs);
    pty.onData(sessionId, onData);
  });
}

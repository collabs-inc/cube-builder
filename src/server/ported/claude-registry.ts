// Reading Claude Code's own live session registry.
//
// Claude writes `~/.claude/sessions/<pid>.json` for every running session,
// naming the conversation id it is attached to. That is the only way to
// learn the id of a session THIS app did not mint one for — a tile that
// predates `--session-id` pinning, or one whose conversation was started
// some other way. Without it such a session can never be resumed, because
// nothing on our side ever knew what to resume.
//
// Reads never throw. A registry that is missing, malformed, or written by a
// future version simply yields `null`: discovery is an enhancement, and a
// session that stays unresumable is strictly better than a daemon that
// falls over trying to read a file it does not control.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeRegistryDeps {
  /** Overrides $HOME — the registry lives beside the sessions it describes. */
  home?: string;
  /**
   * A process's start time in the same format the registry records
   * (`ps -o lstart=`), or null when it cannot be determined. Injected so
   * tests need not spawn real processes.
   */
  procStartOf?: (pid: number) => string | null;
}

/**
 * A process's start time in whatever form Claude records it on THIS
 * platform, or null when it cannot be read.
 *
 * The form differs, and assuming it doesn't is what made this silently
 * useless on every Linux machine: macOS records a ctime string ("Fri Aug 14
 * 20:22:10 2026", the shape `ps -o lstart=` prints), Linux records the
 * kernel's raw start-ticks from `/proc/<pid>/stat` field 22 ("76074").
 * Verified against a live session on both.
 *
 * Reading /proc directly on Linux is also cheaper than the `ps` subprocess
 * it replaces, and Windows has neither — where nothing can be read, the
 * caller must not guess (see `readClaudeSession`).
 */
function defaultProcStartOf(pid: number): string | null {
  if (process.platform === "linux") return linuxStartTicks(pid);
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Field 22 of `/proc/<pid>/stat` — start time in clock ticks since boot.
 *
 * Parsed from the LAST ')' rather than by splitting the whole line: field 2
 * is the executable name in parentheses and may itself contain spaces or
 * parentheses, so a naive split lands on the wrong field for any process
 * whose name is unusual. Everything after that closing paren is
 * space-separated and fixed-width, with field 22 at offset 20 of the
 * remainder (fields 3 onward).
 */
function linuxStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim();
    const ticks = afterComm.split(/\s+/)[19];
    return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function registryPath(home: string, pid: number): string {
  return join(home, ".claude", "sessions", `${pid}.json`);
}

/**
 * Both stamps are second-resolution renderings of the same kernel value, so
 * a match is exact; the tolerance only absorbs rounding between two
 * different formatters of the same second.
 */
const PROC_START_TOLERANCE_MS = 1000;

/**
 * Whether two process-start stamps describe the same instant.
 *
 * They are NOT comparable as strings, which is how this was first written
 * and why discovery silently never fired: Claude records the stamp in UTC
 * ("Sat Aug 15 18:23:10 2026") while `ps -o lstart=` prints local time
 * ("Sat Aug 15 11:23:10 2026") for the very same process. Identical
 * instants, seven hours apart on paper.
 *
 * The registry stamp is read as UTC first and as local second, so a
 * platform that records it in local time still matches rather than
 * disabling discovery outright. The `ps` stamp carries no zone, so it is
 * always local — which is what `Date.parse` assumes for this format.
 */
function sameInstant(registryStamp: string, actualStamp: string): boolean {
  const recorded = registryStamp.trim();
  const actual = actualStamp.trim();

  // Linux: both sides are the kernel's start-ticks, so identity is exact
  // and there is nothing to parse. Checked first because "76074" is also
  // something Date.parse will happily turn into a year.
  if (/^\d+$/.test(recorded) || /^\d+$/.test(actual)) return recorded === actual;

  const actualMs = Date.parse(actual);
  if (Number.isNaN(actualMs)) return false;
  for (const candidate of [Date.parse(`${recorded} UTC`), Date.parse(recorded)]) {
    if (Number.isNaN(candidate)) continue;
    if (Math.abs(candidate - actualMs) <= PROC_START_TOLERANCE_MS) return true;
  }
  return false;
}

/**
 * The conversation id Claude Code reports for the session running as `pid`,
 * or null.
 *
 * Null when the process is not a Claude session, when the registry entry
 * cannot be read, and — importantly — when the entry's identity cannot be
 * CONFIRMED. Pids are reused, and a stale registry file for a recycled pid
 * would otherwise hand back some unrelated conversation, which the caller
 * would durably record and later resume a tile into. `procStart` exists in
 * the registry for exactly this, so a mismatch, an absent stamp, or a
 * platform where process start times cannot be read all mean "don't know"
 * rather than "probably fine".
 */
export function readClaudeSession(
  pid: number,
  deps: ClaudeRegistryDeps = {},
): string | null {
  return createClaudeSessionReader(deps)(pid);
}

/**
 * A reader that remembers which pids it has already confirmed.
 *
 * The identity check costs a `ps` subprocess, and the caller re-reads every
 * live session on a timer — so checking on every read would spawn a process
 * per session per tick, forever, to re-derive a value that cannot change: a
 * process's start time is fixed for its lifetime. What DOES change is the
 * conversation id inside the entry, and that is a plain file read.
 *
 * The memo is keyed on the start time it confirmed, not just the pid, so a
 * recycled pid re-verifies: a different process writing that pid's entry
 * writes a different start time, which no longer matches what was
 * confirmed. Callers that want no memo at all can use `readClaudeSession`.
 */
export function createClaudeSessionReader(
  deps: ClaudeRegistryDeps = {},
): (pid: number) => string | null {
  const home = deps.home ?? homedir();
  const procStartOf = deps.procStartOf ?? defaultProcStartOf;
  /** pid -> the `procStart` value already confirmed against the process. */
  const confirmed = new Map<number, string>();

  return (pid: number): string | null => {
    let entry: { sessionId?: unknown; procStart?: unknown };
    try {
      entry = JSON.parse(readFileSync(registryPath(home, pid), "utf8")) as typeof entry;
    } catch {
      return null;
    }
    if (typeof entry.sessionId !== "string" || entry.sessionId.length === 0) return null;
    if (typeof entry.procStart !== "string" || entry.procStart.length === 0) return null;

    if (confirmed.get(pid) !== entry.procStart) {
      const actual = procStartOf(pid);
      if (actual === null) return null;
      if (!sameInstant(entry.procStart, actual)) return null;
      confirmed.set(pid, entry.procStart);
    }
    return entry.sessionId;
  };
}

// Reading Codex's own thread-writer locks.
//
// A running codex process holds an exclusive flock on
// `~/.codex/thread-writer-locks/<thread-uuid>.lock` for the whole life of
// the thread it is writing. One process can hold several locks, including
// children that cannot be resumed independently, so metadata must identify
// a unique held root before we select an id. The open fd cannot outlive
// its process, so a pid that has one is alive and on that thread. That is
// why there is no pid-reuse guard here and no analogue of
// claude-registry's `procStart` check — there is nothing to guard against.
//
// What must never be done is inferring liveness from the lock FILE. Stale
// `.lock` files persist indefinitely after their process dies (verified:
// killed sessions leave theirs behind with no holder). Only the fd counts.
//
// Quarantined by design: this module parses another product's internal
// layout, and this is the place to fix it when that layout changes. Reads
// never throw — anything unexpected is `null`, because a session that
// stays unresumable is strictly better than a daemon that falls over
// reading a file it does not control.
//
// Locks verified against codex-cli 0.147.0 on Linux and 0.154.0 on macOS;
// the latter also requires resolving multi-agent child threads. See
// docs/research/2026-08-17-codex-opencode-session-discovery-spike.md.
import { execFileSync } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";
import { resolveCodexRootThread } from "./codex-thread-root";

/**
 * The uuid match is load-bearing, not hygiene: the same directory holds
 * `.coordination.lock`, which is not a thread.
 */
const THREAD_LOCK_RE =
  /^(.*)\/thread-writer-locks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;

export interface CodexLocksDeps {
  rootThread?: (id: string, home: string) => string | null;
  /** Lists a pid's open fds. Injected so tests need no live codex. */
  listFds?: (pid: number) => string[];
  /** Resolves one of a pid's fds to its target path. */
  readFd?: (pid: number, fd: string) => string | null;
  /** Clock seam for the throttle. */
  now?: () => number;
  /**
   * Minimum gap between probes of the SAME pid. Zero on Linux, where a
   * probe is a readdir; ~15s on macOS, where it is an `lsof` subprocess
   * and `list()` can be called in bursts. Enforced here rather than at the
   * call sites so no caller can accidentally spawn a subprocess storm.
   */
  minIntervalMs?: number;
}

/**
 * macOS has no /proc. `lsof -Fn` prints one field per line, `n`-prefixed
 * for names — the fd-number lines are `f`-prefixed and irrelevant here,
 * since only the paths matter.
 *
 * Verified on macOS with Codex 0.154.0. Unknown layouts still return null
 * rather than guessing a conversation identity.
 */
function listFdPathsDarwin(pid: number): string[] {
  const out = execFileSync("lsof", ["-p", String(pid), "-Fn"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  return out.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
}

function defaultListFds(pid: number): string[] {
  return process.platform === "darwin" ? listFdPathsDarwin(pid) : readdirSync(`/proc/${pid}/fd`);
}

function defaultReadFd(pid: number, fd: string): string | null {
  // On darwin `listFds` already yielded the path itself; there is no
  // second lookup to do. On win32 the readdir above throws and the reader
  // answers null, which is correct — no agent runs there under a pty this
  // daemon owns.
  return process.platform === "darwin" ? fd : readlinkSync(`/proc/${pid}/fd/${fd}`);
}

/** The codex thread `pid` is writing, or null. Never throws. */
export function readCodexThread(pid: number, deps: CodexLocksDeps = {}): string | null {
  const listFds = deps.listFds ?? defaultListFds;
  const readFd = deps.readFd ?? defaultReadFd;

  let fds: string[];
  try {
    fds = listFds(pid);
  } catch {
    return null;
  }

  const held = new Map<string, string>();
  for (const fd of fds) {
    let target: string | null;
    try {
      target = readFd(pid, fd);
    } catch {
      // An fd closed under us mid-scan says nothing about the others.
      continue;
    }
    if (target === null) continue;
    const match = THREAD_LOCK_RE.exec(target);
    if (match) held.set(match[2]!, match[1]!);
  }
  const roots = new Set<string>();
  try {
    for (const [id, home] of held) {
      const root = (deps.rootThread ?? resolveCodexRootThread)(id, home);
      if (!root || held.get(root) !== home) return null;
      roots.add(root);
    }
  } catch { return null; }
  return roots.size === 1 ? [...roots][0]! : null;
}

/**
 * A reader bound to one set of deps, throttled per pid.
 *
 * Deliberately NOT memoized the way claude-registry's reader is. That one
 * caches because what it verifies — a process's start time — is fixed for
 * the process's life. The thread id is not: a user starting a new thread
 * inside a live tile changes it, and noticing that is the entire point of
 * re-reading. So the cost is bounded two other ways: only agent-target
 * sessions are probed at all (see agent-discovery.ts), and on a platform
 * where a probe costs a subprocess, repeat probes of the same pid inside
 * `minIntervalMs` reuse the last answer. On Linux the interval is 0 and
 * every call reads fresh.
 */
export function createCodexThreadReader(
  deps: CodexLocksDeps = {},
): (pid: number) => string | null {
  const now = deps.now ?? Date.now;
  const minIntervalMs = deps.minIntervalMs ?? (process.platform === "darwin" ? 15_000 : 0);
  /** pid -> when it was last really read, and what it answered. */
  const last = new Map<number, { at: number; answer: string | null }>();

  return (pid: number) => {
    if (minIntervalMs <= 0) return readCodexThread(pid, deps);
    const previous = last.get(pid);
    const at = now();
    if (previous && at - previous.at < minIntervalMs) return previous.answer;
    const answer = readCodexThread(pid, deps);
    last.set(pid, { at, answer });
    return answer;
  };
}

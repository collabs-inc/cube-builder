// Adapted from src/main/cubed/attention/spool.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * The directory hooks drop reports into, drained in arrival order.
 *
 * A directory rather than a socket because a hook is a one-line shell
 * command on whatever machine the session runs on — no helper binary, no
 * node on PATH, no client to authenticate. It is owner-only, and a report
 * can do nothing but move one session's dot: it names a launch id, and a
 * launch id the tracker does not know is dropped. There is no process
 * isolation to lose here — every session already runs as the daemon's own
 * user — so what this boundary protects is only that the endpoint cannot
 * be escalated into daemon control, which a file it merely reads cannot.
 */
import { chmodSync, closeSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { MAX_REPORT_BYTES } from "./hooks";

// `<launchId>.<kind>.<random>.json` from a git hook (../observe/git-hooks.ts);
// `<launchId>.<random>.json` from a harness hook, which has no kind.
const REPORT_NAME = /^([0-9A-Za-z-]{8,64})(?:\.(commit|push|merge))?\.([0-9A-Za-z]+)\.json$/;
// The same name before `mv`, so a hook that died between `mktemp` and the
// rename still gets reaped. Widen it with the regex above or a git hook's
// abandoned temp file lives in the spool forever.
const TEMP_NAME = /^[0-9A-Za-z-]{8,64}(?:\.(?:commit|push))?\.[0-9A-Za-z]+$/;

type ObservedKind = "commit" | "push" | "merge";

export interface SpoolReport {
  launchId: string;
  /** Unique per report; doubles as a permission request's identity. */
  name: string;
  text: string;
  /** `commit` or `push` for a git hook's report; null for a harness hook's. */
  kind: ObservedKind | null;
}

export interface AttentionSpoolOptions {
  dir: string;
  /** "unknown" holds the report (and every later one for that launch) briefly. */
  accept: (report: SpoolReport) => "consumed" | "unknown";
  /**
   * Where a git hook's report goes. A report carrying a kind NEVER reaches
   * `accept`: harness-attention parsing would read it as an unrecognized turn
   * event, and a commit is not a turn. With no observer it is consumed.
   */
  observe?: (report: SpoolReport & { kind: ObservedKind }) => "consumed" | "unknown";
  now?: () => number;
  pollMs?: number;
  /** How long a report for a launch nobody has registered is kept for. */
  holdUnknownMs?: number;
  log?: (line: string) => void;
}

export class AttentionSpool {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scheduled = false;
  private readonly now: () => number;

  constructor(private readonly opts: AttentionSpoolOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    try { chmodSync(this.opts.dir, 0o700); } catch { /* best effort */ }
    try {
      this.watcher = watch(this.opts.dir, () => this.schedule());
      this.watcher.unref?.();
      this.watcher.on("error", () => { this.watcher?.close(); this.watcher = null; });
    } catch {
      // The poll below still drains; a watch only makes it prompt.
    }
    this.timer = setInterval(() => this.drain(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
    this.drain();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  drain(): void {
    let names: string[];
    try {
      names = readdirSync(this.opts.dir);
    } catch {
      return;
    }
    const now = this.now();
    const reports: Array<{
      name: string; launchId: string; kind: ObservedKind | null; mtime: bigint; ageMs: number;
    }> = [];
    for (const name of names) {
      const path = join(this.opts.dir, name);
      const match = REPORT_NAME.exec(name);
      let stat;
      try {
        stat = statSync(path, { bigint: true });
      } catch {
        continue;
      }
      const ageMs = now - Number(stat.mtimeMs);
      if (!match) {
        // A hook that died between mktemp and rename leaves its temp file.
        if (TEMP_NAME.test(name) && ageMs > 60_000) this.unlink(path);
        continue;
      }
      const kind = (match[2] as ObservedKind | undefined) ?? null;
      reports.push({ name, launchId: match[1]!, kind, mtime: stat.mtimeNs, ageMs });
    }
    // mtime first: two hooks of one turn run in sequence, and their temp
    // names are random.
    reports.sort((a, b) => (a.mtime < b.mtime ? -1 : a.mtime > b.mtime ? 1 : a.name.localeCompare(b.name)));

    const held = new Set<string>();
    for (const report of reports) {
      if (held.has(report.launchId)) continue;
      const path = join(this.opts.dir, report.name);
      const text = this.read(path);
      if (text === null) continue;
      let verdict: "consumed" | "unknown";
      try {
        verdict = this.dispatch({
          launchId: report.launchId, name: report.name, text, kind: report.kind,
        });
      } catch (err) {
        this.opts.log?.(`attention: report ${report.name} threw: ${String(err)}`);
        verdict = "consumed";
      }
      if (verdict === "unknown" && report.ageMs < (this.opts.holdUnknownMs ?? 10_000)) {
        // Later reports for this launch must not overtake it.
        held.add(report.launchId);
        continue;
      }
      if (verdict === "unknown" && report.kind !== null) {
        this.opts.log?.(`attention: dropping ${report.name} for unknown launch ${report.launchId}`);
      }
      this.unlink(path);
    }
  }

  private dispatch(report: SpoolReport): "consumed" | "unknown" {
    if (report.kind === null) return this.opts.accept(report);
    return this.opts.observe?.({ ...report, kind: report.kind }) ?? "consumed";
  }

  private read(path: string): string | null {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return null;
    }
    try {
      const buffer = Buffer.alloc(MAX_REPORT_BYTES);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, length).toString("utf8");
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  private unlink(path: string): void {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}

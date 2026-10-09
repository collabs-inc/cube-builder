// Watches the one file that says which branch a checkout is on, so the
// sidebar follows a `git checkout` instead of showing whatever was checked
// out when the client connected.
//
// ── Why a watcher and not a timer ──
//
// A branch is state, and state read once is a bug (it was: `head` was
// written only by the attach-time sweep). The obvious fix is to re-read on
// an interval, and the obvious interval is wrong in both directions — long
// enough to be cheap is long enough to feel broken, and short enough to feel
// live means spawning `git worktree list` per repo forever, for a value that
// changes a few times a day.
//
// ── Why this is small ──
//
// This module does NOT parse HEAD. It could — the file is 41 bytes and says
// `ref: refs/heads/main` — but then it would also owe you ref resolution for
// the sha, packed-refs when the loose ref is absent, and a second
// implementation of everything `git worktree list` already answers
// authoritatively. So the watcher is a TRIGGER, not a reader: it fires, and
// `WorktreeCreation.refreshHeads` does the same read it always did. The
// subprocess cost is fine now precisely because it runs when a branch
// actually changed rather than on a clock.
//
// ── What is watched ──
//
// One non-recursive watch per checkout, on the DIRECTORY holding its HEAD:
//
//   repo             <root>/.git/HEAD
//   linked worktree  <repo>/.git/worktrees/<name>/HEAD
//
// A linked worktree's own `.git` is a FILE containing `gitdir: <path>`, so
// its directory has to be followed rather than watched.
//
// The directory, never the file. git writes HEAD atomically — write
// `HEAD.lock`, rename over — and under inotify a file watch follows the
// replaced inode, so it goes silently deaf after the first checkout. macOS
// happens to forgive this (FSEvents reports the rename to a file watcher
// too, verified by mutating the test), which is exactly why it is worth
// writing down: the bug would not show up here, only on Linux, only on the
// second checkout. Watching the directory and filtering by name is correct
// on both.
//
// Non-recursive, and that matters: `.git/objects` holds thousands of files
// (2,718 in this repo alone), so a recursive subscription would crawl the
// object store to watch a value that lives in one 41-byte file next to it.
// The direct children of `.git` do churn — `index` on every `git status`,
// `FETCH_HEAD` on every fetch — which is what the filename filter is for.
import { readFileSync, statSync } from "node:fs";
import { watch as fsWatch } from "node:fs";
import { dirname, join } from "node:path";
import type { CatalogRepo } from "@port/shared/catalog";

/** The subset of `fs.watch` this needs, injectable so tests need no real events. */
export type WatchFn = (
  dir: string,
  listener: (event: string, filename: string | null) => void,
) => { close: () => void };

export interface HeadWatcherDeps {
  /** Fired when some checkout's HEAD changed. Coalescing is the caller's job. */
  onChanged: () => void;
  watch?: WatchFn;
  /** Non-fatal news: a directory that could not be watched. */
  onWarning?: (message: string) => void;
}

const HEAD_FILE = "HEAD";
const GITDIR_PREFIX = "gitdir:";

/**
 * The directory holding `repo`'s HEAD, or null when it cannot be located
 * — a worktree still being created has no `.git` yet, and a repo whose
 * directory has been deleted has nothing to watch. Null is not an error
 * here: those rows simply do not update live, and the attach-time sweep
 * still corrects them.
 */
export function headDirOf(repo: CatalogRepo): string | null {
  const dotGit = join(repo.root, ".git");
  try {
    // A repo's `.git` is a directory and holds HEAD directly. A linked
    // worktree's is a file pointing at the real gitdir under its parent.
    if (statSync(dotGit).isDirectory()) return dotGit;
    const pointer = readFileSync(dotGit, "utf8").trim();
    if (!pointer.startsWith(GITDIR_PREFIX)) return null;
    const gitdir = pointer.slice(GITDIR_PREFIX.length).trim();
    return gitdir.length > 0 ? gitdir : null;
  } catch {
    return null;
  }
}

export class HeadWatcher {
  /** Keyed by watched DIRECTORY, not by repo: two rows can name one. */
  private readonly watches = new Map<string, { close: () => void }>();
  private readonly watch: WatchFn;

  constructor(private readonly deps: HeadWatcherDeps) {
    this.watch = deps.watch ?? ((dir, listener) => fsWatch(dir, { persistent: false }, listener));
  }

  /**
   * Brings the watch set in line with `rows`: opens what is new, closes
   * what is gone, and leaves the rest alone. Re-syncing the same rows must
   * not churn the watches — this runs on every catalog change, and most
   * catalog changes are about items, not checkouts.
   */
  async sync(rows: CatalogRepo[]): Promise<void> {
    const wanted = new Set<string>();
    for (const row of rows) {
      const dir = headDirOf(row);
      if (dir !== null) wanted.add(dir);
    }
    for (const [dir, sub] of this.watches) {
      if (wanted.has(dir)) continue;
      sub.close();
      this.watches.delete(dir);
    }
    for (const dir of wanted) {
      if (this.watches.has(dir)) continue;
      try {
        this.watches.set(
          dir,
          this.watch(dir, (_event, filename) => {
            // A missing filename means the platform did not tell us WHICH
            // child changed. Re-reading costs one `git worktree list` that
            // settles to a no-op; ignoring it would strand the row.
            if (filename !== null && basenameOf(filename) !== HEAD_FILE) return;
            this.deps.onChanged();
          }),
        );
      } catch (err) {
        // A network mount with no inotify, a permissions failure, a
        // directory deleted between the resolve above and here. That row
        // stops updating live; every other row keeps working.
        this.deps.onWarning?.(`head watch failed for ${dir}: ${String(err)}`);
      }
    }
  }

  async close(): Promise<void> {
    for (const sub of this.watches.values()) sub.close();
    this.watches.clear();
  }
}

/**
 * `fs.watch` reports a bare filename on most platforms but can report one
 * relative to the watched directory. Comparing the last segment is right for
 * both, and is why callers do not compare the raw name. Exported for
 * `worktree-watch.ts`, which filters its events the same way.
 */
export function basenameOf(filename: string): string {
  const dir = dirname(filename);
  return dir === "." ? filename : filename.slice(dir.length + 1);
}

// Watches git's own worktree records, so a worktree that appears or vanishes
// reaches the sidebar without waiting for a reattach.
//
// ── Why not watch.ts, and why not head-watch.ts ──
//
// Not `watch.ts`: that one is `@parcel/watcher` over repo roots with
// `**/.git/**` as its first ignore, and most of the watches here live inside
// `.git`.
//
// Not `head-watch.ts` either, and that split is the point. `HeadWatcher`
// watches per *catalog repo* — it structurally cannot see a worktree that
// has no row, which is exactly the thing adoption exists to find. The two
// answer different questions and key off different sets:
//
//   watcher           keyed by                     fires on            answers
//   HeadWatcher       every known checkout         HEAD written        which branch is in a
//                                                                      checkout we know about
//   WorktreeWatcher   every repo row that is       git's worktree      which checkouts exist
//                     a primary checkout           records, or a       at all
//                                                  worktree's parent
//
// So this does NOT watch `<gitdir>/worktrees/<name>/HEAD`. `HeadWatcher`
// already covers that file for every row, and the branch a not-yet-adopted
// worktree is on is uninteresting until it has a row — at which point
// `HeadWatcher` picks it up on its next `sync`.
//
// ── What is watched, per repo ──
//
//   <gitdir>                       `worktrees/` being born or removed. git
//                                  deletes it when the last worktree is
//                                  pruned, and a watch is tied to the inode
//                                  it was opened on — so a directory deleted
//                                  and reborn at the same path leaves the
//                                  child subscription dead. This event is
//                                  therefore handled twice over: it
//                                  re-triggers the PASS (a fresh `git
//                                  worktree list`), and it REOPENS the
//                                  `worktrees/` watch so events under the
//                                  reborn directory are seen again. If even
//                                  that were missed, the attach sweep is the
//                                  floor.
//   <gitdir>/worktrees             entries appearing and vanishing:
//                                  `worktree add`, `remove`, `prune`.
//   each distinct parent directory an external `rm -rf`, which touches
//   of a known worktree             nothing under `.git`. Filtered to the
//                                  basenames of the known worktrees in it:
//                                  an adopted worktree can sit in a busy
//                                  directory ($HOME, a crowded repos
//                                  dir), and unrelated churn there must not
//                                  cost a `git worktree list` per debounce.
//
// `<gitdir>` alone is noisy — it sees every `index`, `FETCH_HEAD` and
// `COMMIT_EDITMSG` write — so its events are filtered on the reported
// filename, to `worktrees` only. Whatever survives coalesces into one
// debounce per repo. The worst a busy repo can produce is one
// `git worktree list` per debounce window.
//
// ── Why every watch is non-recursive ──
//
// Recursive `fs.watch` does work on Linux since Node 20, but it shipped with
// a crash on deleting files fixed only in May 2024 (nodejs/node@e7d0d80) and
// further misbehaviour reports (nodejs/node#48437). Deletion is the main case
// here and cubed runs on Linux sprites, so the recursive form would buy one
// subscription at the cost of that history.
//
// ── Why the feedback cycle this creates terminates ──
//
// The sweep this fires can prune, and a prune runs `git worktree prune`,
// which deletes entries under `<gitdir>/worktrees/` — a directory watched
// right here. So a prune fires the watch that caused it. That settles rather
// than spins only because a pass is write-only-on-change: the second pass
// finds the row already gone and git listing nothing extra, writes nothing,
// and produces no third event. `WorktreeCreation.sweepRepo`'s single-flight
// and dirty bit coalesce anything concurrent into one re-run. The bound is
// pinned by a test in `worktree-watch.test.ts`; do not make a pass write
// unconditionally.
import { watch as fsWatch } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CatalogRepo } from "@port/shared/catalog";
import type { WatchFn } from "./head-watch";

export type { WatchFn } from "./head-watch";

export interface WorktreeWatcherDeps {
  /** Fired when some repo's worktree set may have changed. */
  onChanged: (repoId: string) => void;
  /** `git rev-parse --git-common-dir` for a repo root, or null when it fails. */
  gitCommonDir: (repoRoot: string) => Promise<string | null>;
  watch?: WatchFn;
  /** Non-fatal news: a directory that could not be watched. */
  onWarning?: (message: string) => void;
  /** Debounce window; overridden only by tests. */
  debounceMs?: number;
}

const WORKTREES_DIR = "worktrees";
const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Which child of the watched directory an event belongs to: the FIRST path
 * segment, not the last.
 *
 * `fs.watch` reports a bare child name on a non-recursive backend (inotify)
 * but a path relative to the watched directory on a recursive one (macOS's
 * FSEvents), so `rm -rf feature-x` arrives as `feature-x` on Linux and as
 * `feature-x/f.txt` on macOS. Both name the same child, and the child is the
 * only thing this watcher's filters ever ask about — `worktrees` under a git
 * dir, a known worktree's own directory under its parent.
 *
 * Deliberately NOT `head-watch.ts`'s `basenameOf`, which answers the opposite
 * question ("is this file named HEAD") and is right for that watcher.
 * Reducing a nested report with it yields the leaf — `f.txt` — which matches
 * no filter here, so every recursive-backend deletion was dropped and an
 * externally removed worktree kept its row until the next attach. Adoption
 * hid it by riding the unfiltered `worktrees/` watch, which is why this was
 * invisible on a Linux CI and to every test feeding bare child names.
 */
function firstSegmentOf(filename: string): string {
  const cut = filename.search(/[\\/]/);
  return cut === -1 ? filename : filename.slice(0, cut);
}

/**
 * Everything known about one watched directory, in one record so there is a
 * single place to insert and delete — three parallel maps here once let a
 * failed open leave owner entries behind forever.
 *
 * `names` is the event filter: which child basenames matter, or null for all
 * of them. `reopensChild` marks a git dir, whose `worktrees` event must also
 * reopen the child watch (see the header — a watch is bound to an inode, and
 * `worktrees/` dies and is reborn).
 */
interface DirState {
  sub: { close: () => void } | null;
  owners: Set<string>;
  names: Set<string> | null;
  reopensChild: boolean;
  /** Whether the current run of open failures has been reported yet. */
  warned: boolean;
}

type WantedDir = Omit<DirState, "sub" | "warned">;

export class WorktreeWatcher {
  /** Watched directory -> its state. One entry per directory, not per repo. */
  private readonly dirs = new Map<string, DirState>();
  /**
   * Repo root -> its common git dir, so the common case — a catalog change
   * that is about items, which is most of them — costs no subprocess at all.
   * Only successes are cached: a null means "not a repo yet" (a clone still
   * running, a directory not yet created), and caching that would keep the
   * repo unwatched for the daemon's whole life.
   */
  private readonly gitDirs = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watch: WatchFn;
  private readonly debounceMs: number;
  private closed = false;
  /** The doc waiting to be applied; only ever the newest one. */
  private queued: CatalogRepo[] | null = null;
  /** The drain currently applying `queued`, so syncs serialize. */
  private draining: Promise<void> | null = null;

  constructor(private readonly deps: WorktreeWatcherDeps) {
    this.watch = deps.watch ?? ((dir, listener) => fsWatch(dir, { persistent: false }, listener));
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Brings the watch set in line with `rows`: opens what is new, closes
   * what is gone, leaves the rest alone. Re-syncing the same rows must not
   * churn the watches — this runs on every catalog change, and a re-opened
   * watch is deaf for the gap between the close and the open.
   *
   * Serialized, latest-wins: `sync` awaits a git subprocess per uncached
   * repo, and two calls racing would otherwise let the OLDER doc reconcile
   * last — closing watches the newer one just opened and leaving the set
   * stale until the next catalog change. Overlapping calls coalesce onto the
   * newest doc; intermediate docs are skipped, which is correct because each
   * call carries the whole desired state.
   *
   * Never rejects: it runs from `catalog.onChange`, unattended, and an
   * unhandled rejection exits cubed and makes its supervisor crash-loop it.
   */
  sync(rows: CatalogRepo[]): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.queued = rows;
    this.draining ??= (async () => {
      try {
        while (this.queued !== null && !this.closed) {
          const next = this.queued;
          this.queued = null;
          await this.runSync(next);
        }
      } finally {
        this.draining = null;
        // A sync can land between the loop's last check and this finally;
        // re-arm so its doc is not stranded until the next catalog change.
        if (this.queued !== null && !this.closed) void this.sync(this.queued);
      }
    })();
    return this.draining;
  }

  private async runSync(rows: CatalogRepo[]): Promise<void> {
    const wanted = new Map<string, WantedDir>();
    const claim = (
      dir: string,
      repoId: string,
      names: string[] | null,
      reopensChild = false,
    ): void => {
      const entry = wanted.get(dir) ?? {
        owners: new Set<string>(),
        names: new Set<string>(),
        reopensChild: false,
      };
      entry.owners.add(repoId);
      // null means unfiltered, and unfiltered wins a merge: a second claim
      // narrowing an already-open filter would drop the first claim's events.
      if (names === null) entry.names = null;
      else if (entry.names !== null) for (const name of names) entry.names.add(name);
      entry.reopensChild ||= reopensChild;
      wanted.set(dir, entry);
    };
    const repos = rows.filter((r) => !r.worktreeOf);
    for (const repo of repos) {
      const gitDir = await this.resolveGitDir(repo.root);
      // Not a repo, gone, or git failed. No watches, and the attach sweep
      // remains the floor for this repo.
      if (gitDir === null) continue;
      claim(gitDir, repo.id, [WORKTREES_DIR], true);
      claim(join(gitDir, WORKTREES_DIR), repo.id, null);
      // Distinct parents only: a repo's worktrees usually share one. Each
      // claim contributes its own worktree's basename to the filter.
      for (const row of rows) {
        if (row.worktreeOf?.repoId !== repo.id) continue;
        claim(dirname(row.root), repo.id, [basename(row.root)]);
      }
    }
    // `close` may have landed while the resolves above were awaiting. Opening
    // now would leak every watch it just released.
    if (this.closed) return;
    this.forgetGitDirs(repos.map((r) => r.root));
    this.reconcile(wanted);
  }

  /** Cached, and only ever populated from a successful resolve. */
  private async resolveGitDir(repoRoot: string): Promise<string | null> {
    const cached = this.gitDirs.get(repoRoot);
    if (cached !== undefined) return cached;
    const resolved = await this.deps.gitCommonDir(repoRoot).catch(() => null);
    if (resolved !== null) this.gitDirs.set(repoRoot, resolved);
    return resolved;
  }

  /** Drops cache entries for roots the catalog no longer holds as repos. */
  private forgetGitDirs(roots: string[]): void {
    const live = new Set(roots);
    for (const root of this.gitDirs.keys()) {
      if (!live.has(root)) this.gitDirs.delete(root);
    }
  }

  private reconcile(wanted: Map<string, WantedDir>): void {
    for (const [dir, state] of this.dirs) {
      if (wanted.has(dir)) continue;
      state.sub?.close();
      this.dirs.delete(dir);
    }
    for (const [dir, want] of wanted) {
      const state = this.dirs.get(dir);
      if (state) {
        state.owners = want.owners;
        state.names = want.names;
        state.reopensChild = want.reopensChild;
        // A previous open failed; a directory can come into being (a clone
        // finishing, a mount returning), so failure is retried every sync.
        if (state.sub === null) state.sub = this.open(dir, state);
      } else {
        const created: DirState = { ...want, sub: null, warned: false };
        this.dirs.set(dir, created);
        created.sub = this.open(dir, created);
      }
    }
  }

  private open(dir: string, state: DirState): { close: () => void } | null {
    try {
      const sub = this.watch(dir, (_event, filename) => this.onEvent(dir, filename));
      state.warned = false;
      return sub;
    } catch (err) {
      // A missing directory is an ordinary state, not a failure: git deletes
      // `worktrees/` when the last worktree is pruned, and a repo that never
      // had one has none. The git dir watch reopens it when it is born, and
      // every sync retries — so reporting it would log once per catalog
      // change for the daemon's whole life.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      // A network mount with no inotify, a permissions failure. That repo
      // stops updating live through this one watch; every other watch keeps
      // working and the attach sweep remains the floor. Reported once per
      // run of failures, since every sync retries it.
      if (!state.warned) {
        state.warned = true;
        this.deps.onWarning?.(`worktree watch failed for ${dir}: ${String(err)}`);
      }
      return null;
    }
  }

  private onEvent(dir: string, filename: string | null): void {
    const state = this.dirs.get(dir);
    if (!state) return;
    // A null filename means the platform did not say which child changed —
    // re-reading costs one `git worktree list` that settles to a no-op,
    // while ignoring it would strand the row.
    if (filename !== null && state.names !== null && !state.names.has(firstSegmentOf(filename))) {
      return;
    }
    // `worktrees/` itself came or went under this git dir. Either way the
    // child watch is bound to the old inode and dead; reopen it so events
    // under the reborn directory are seen again.
    if (state.reopensChild && filename !== null && firstSegmentOf(filename) === WORKTREES_DIR) {
      this.reopenChild(join(dir, WORKTREES_DIR));
    }
    for (const repoId of state.owners) this.schedule(repoId);
  }

  private reopenChild(dir: string): void {
    const state = this.dirs.get(dir);
    if (!state || this.closed) return;
    state.sub?.close();
    state.sub = null;
    // Silently, unlike `open`: failing here usually just means the directory
    // is gone right now — the deletion half of the born/removed cycle — and
    // the next `worktrees` event under the git dir lands back here.
    try {
      state.sub = this.watch(dir, (_event, filename) => this.onEvent(dir, filename));
    } catch {
      // Gone right now; retried on the next event, and on every sync.
    }
  }

  /**
   * Coalesces a burst into one reconcile. `git worktree add` writes several
   * files under `worktrees/<name>/`, and `fs.watch` can report one write more
   * than once — none of which should cost a `git worktree list` each.
   *
   * The timer is dropped BEFORE `onChanged` runs, so a sweep that writes and
   * re-enters this watch schedules its own follow-up rather than being
   * swallowed. That is the prune cycle in the header, and it terminates
   * because the follow-up pass writes nothing.
   */
  private schedule(repoId: string): void {
    if (this.closed || this.timers.has(repoId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(repoId);
      if (this.closed) return;
      this.deps.onChanged(repoId);
    }, this.debounceMs);
    // Never hold the daemon open for a pending reconcile.
    timer.unref?.();
    this.timers.set(repoId, timer);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queued = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const state of this.dirs.values()) state.sub?.close();
    this.dirs.clear();
    this.gitDirs.clear();
  }
}

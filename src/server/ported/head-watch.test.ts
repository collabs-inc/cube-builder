import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogRepo } from "@port/shared/catalog";
import { HeadWatcher, type WatchFn } from "./head-watch";

const madeDirs: string[] = [];
afterEach(() => {
  while (madeDirs.length) rmSync(madeDirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cubed-head-watch-"));
  madeDirs.push(dir);
  return dir;
}

interface FakeWatch {
  watch: WatchFn;
  /** Directories currently under watch, in the order they were opened. */
  open: string[];
  closed: string[];
  /** Delivers one event to every live watcher on `dir`. */
  fire(dir: string, filename: string | null): void;
  failOn?: string;
}

function fakeWatch(): FakeWatch {
  const listeners = new Map<string, ((event: string, filename: string | null) => void)[]>();
  const state: FakeWatch = {
    open: [],
    closed: [],
    fire(dir, filename) {
      for (const listener of listeners.get(dir) ?? []) listener("change", filename);
    },
    watch: (dir, listener) => {
      if (state.failOn === dir) throw new Error("EPERM");
      state.open.push(dir);
      const forDir = listeners.get(dir) ?? [];
      forDir.push(listener);
      listeners.set(dir, forDir);
      return {
        close: () => {
          state.closed.push(dir);
          listeners.set(dir, (listeners.get(dir) ?? []).filter((l) => l !== listener));
        },
      };
    },
  };
  return state;
}

/** A repo checkout on disk: `<root>/.git/` as a real directory. */
function repoAt(root: string, id = "repo-1"): CatalogRepo {
  mkdirSync(join(root, ".git"), { recursive: true });
  return { id, name: "app", root, managed: false, createdAt: "t" };
}

/**
 * A linked worktree on disk: `<root>/.git` is a FILE pointing at the repo's
 * `.git/worktrees/<name>`, which is where its HEAD actually lives.
 */
function worktreeAt(root: string, repoRoot: string, name: string, id = "wt-1"): CatalogRepo {
  const gitdir = join(repoRoot, ".git", "worktrees", name);
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ".git"), `gitdir: ${gitdir}\n`);
  return {
    id,
    name,
    root,
    managed: true,
    createdAt: "t",
    worktreeOf: { repoId: "repo-1", createdOnBranch: name, source: { from: "new" } },
  };
}

/** Waits for `check`, or gives up — real fs events are not synchronous. */
async function waitFor(check: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Against the real `fs.watch`, not the fake above: proof that the module is
// wired to the actual API correctly — a watch opens, an event arrives, the
// filter lets it through. The fake covers the bookkeeping deterministically;
// this covers the part a fake cannot.
//
// It does NOT discriminate watching the directory from watching the file.
// Verified by mutation: pointing the watch at `<gitdir>/HEAD` instead keeps
// this green on macOS, because FSEvents still reports a rename-over to a
// file watcher. That distinction is an inotify property — on Linux a file
// watch follows the replaced inode and goes silently deaf — so it is a
// portability argument, not something a test on this machine can pin down.
describe("HeadWatcher — real fs.watch", () => {
  test("sees a HEAD rewritten the way git rewrites it: written aside, then renamed over", async () => {
    const root = tempDir();
    const gitDir = join(root, ".git");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");

    let changes = 0;
    const watcher = new HeadWatcher({ onChanged: () => { changes += 1; } });
    await watcher.sync([{ id: "r", name: "app", root, managed: false, createdAt: "t" }]);

    try {
      // git never writes HEAD in place — it writes `HEAD.lock` and renames.
      writeFileSync(join(gitDir, "HEAD.lock"), "ref: refs/heads/new-sidebar\n");
      renameSync(join(gitDir, "HEAD.lock"), join(gitDir, "HEAD"));

      await waitFor(() => changes > 0, "the HEAD rename to be reported");
    } finally {
      await watcher.close();
    }
  });
});

describe("HeadWatcher", () => {
  test("watches the directory holding a repo's HEAD", async () => {
    const root = tempDir();
    const w = fakeWatch();
    const watcher = new HeadWatcher({ watch: w.watch, onChanged: () => {} });

    await watcher.sync([repoAt(root)]);

    expect(w.open).toEqual([join(root, ".git")]);
    await watcher.close();
  });

  test("follows a linked worktree's gitdir pointer instead of watching its own .git file", async () => {
    // A worktree's `.git` is a file, not a directory — watching it directly
    // would watch the pointer and never see the HEAD it points at.
    const repoRoot = tempDir();
    const wtRoot = join(tempDir(), "feat-x");
    const w = fakeWatch();
    const watcher = new HeadWatcher({ watch: w.watch, onChanged: () => {} });

    await watcher.sync([repoAt(repoRoot), worktreeAt(wtRoot, repoRoot, "feat-x")]);

    expect(w.open).toEqual([
      join(repoRoot, ".git"),
      join(repoRoot, ".git", "worktrees", "feat-x"),
    ]);
    await watcher.close();
  });

  test("a HEAD write reports a change", async () => {
    const root = tempDir();
    const w = fakeWatch();
    let changes = 0;
    const watcher = new HeadWatcher({ watch: w.watch, onChanged: () => { changes += 1; } });
    await watcher.sync([repoAt(root)]);

    w.fire(join(root, ".git"), "HEAD");

    expect(changes).toBe(1);
    await watcher.close();
  });

  test("the rest of .git is ignored", async () => {
    // These are direct children of `.git` and churn on ordinary git commands,
    // so a watcher that reacted to them would re-read on every `git status`.
    const root = tempDir();
    const w = fakeWatch();
    let changes = 0;
    const watcher = new HeadWatcher({ watch: w.watch, onChanged: () => { changes += 1; } });
    await watcher.sync([repoAt(root)]);

    for (const name of ["index", "FETCH_HEAD", "ORIG_HEAD", "COMMIT_EDITMSG", "config"]) {
      w.fire(join(root, ".git"), name);
    }

    expect(changes).toBe(0);
    await watcher.close();
  });

  test("an event with no filename reports a change", async () => {
    // Some platforms drop the filename. Re-reading costs one `git worktree
    // list` and settles to a no-op, where ignoring it would strand the row.
    const root = tempDir();
    const w = fakeWatch();
    let changes = 0;
    const watcher = new HeadWatcher({ watch: w.watch, onChanged: () => { changes += 1; } });
    await watcher.sync([repoAt(root)]);

    w.fire(join(root, ".git"), null);

    expect(changes).toBe(1);
    await watcher.close();
  });

  test("re-syncing the same rows keeps the existing watches rather than churning them", async () => {
    const root = tempDir();
    const w = fakeWatch();
    const watcher = new HeadWatcher({ watch: w.watch, onChanged: () => {} });
    const rows = [repoAt(root)];

    await watcher.sync(rows);
    await watcher.sync(rows);

    expect(w.open).toHaveLength(1);
    expect(w.closed).toHaveLength(0);
    await watcher.close();
  });

  test("a row that goes away has its watch closed", async () => {
    const repoRoot = tempDir();
    const wtRoot = join(tempDir(), "feat-x");
    const w = fakeWatch();
    const watcher = new HeadWatcher({ watch: w.watch, onChanged: () => {} });
    const repo = repoAt(repoRoot);
    await watcher.sync([repo, worktreeAt(wtRoot, repoRoot, "feat-x")]);

    await watcher.sync([repo]);

    expect(w.closed).toEqual([join(repoRoot, ".git", "worktrees", "feat-x")]);
    await watcher.close();
  });

  test("close drops every watch", async () => {
    const repoRoot = tempDir();
    const wtRoot = join(tempDir(), "feat-x");
    const w = fakeWatch();
    const watcher = new HeadWatcher({ watch: w.watch, onChanged: () => {} });
    await watcher.sync([repoAt(repoRoot), worktreeAt(wtRoot, repoRoot, "feat-x")]);

    await watcher.close();

    expect(w.closed).toHaveLength(2);
  });

  test("a watch that cannot be opened is skipped, not fatal", async () => {
    // A network mount with no inotify, a permissions failure. That row stops
    // updating live; every other row keeps working, and the attach-time sweep
    // still corrects it.
    const rootA = tempDir();
    const rootB = tempDir();
    const w = fakeWatch();
    w.failOn = join(rootA, ".git");
    const watcher = new HeadWatcher({ watch: w.watch, onChanged: () => {} });

    await watcher.sync([repoAt(rootA, "repo-1"), repoAt(rootB, "repo-2")]);

    expect(w.open).toEqual([join(rootB, ".git")]);
    await watcher.close();
  });

  test("a worktree whose gitdir pointer is unreadable is skipped, not fatal", async () => {
    const repoRoot = tempDir();
    const wtRoot = join(tempDir(), "gone");
    const w = fakeWatch();
    const watcher = new HeadWatcher({ watch: w.watch, onChanged: () => {} });

    // No `.git` file at all — a pending worktree, whose directory does not
    // exist yet.
    await watcher.sync([
      repoAt(repoRoot),
      { id: "wt-1", name: "gone", root: wtRoot, managed: true, createdAt: "t",
        worktreeOf: { repoId: "repo-1", createdOnBranch: "gone", source: { from: "new" } } },
    ]);

    expect(w.open).toEqual([join(repoRoot, ".git")]);
    await watcher.close();
  });

  test("two rows sharing one directory open one watch and survive the first being dropped", async () => {
    // Not a normal layout, but `sync` must key on the directory it watches
    // rather than on the row, or a duplicate would double-watch and a removal
    // would close a directory another row still needs.
    const root = tempDir();
    const w = fakeWatch();
    let changes = 0;
    const watcher = new HeadWatcher({ watch: w.watch, onChanged: () => { changes += 1; } });
    const a = repoAt(root, "repo-1");
    const b = { ...repoAt(root, "repo-2") };

    await watcher.sync([a, b]);
    expect(w.open).toHaveLength(1);

    await watcher.sync([b]);
    expect(w.closed).toHaveLength(0);
    w.fire(join(root, ".git"), "HEAD");
    expect(changes).toBe(1);

    await watcher.close();
  });
});

import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogRepo } from "@port/shared/catalog";
import { WorktreeWatcher, type WatchFn } from "./worktree-watch";

const madeDirs: string[] = [];
afterEach(() => {
  while (madeDirs.length) rmSync(madeDirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-watch-"));
  madeDirs.push(dir);
  return dir;
}

interface FakeWatch {
  watch: WatchFn;
  /** Watched directory -> its listener. */
  open: Map<string, (event: string, filename: string | null) => void>;
  closed: string[];
}

function fakeWatch(failFor: string[] = [], code?: string): FakeWatch {
  const open = new Map<string, (event: string, filename: string | null) => void>();
  const closed: string[] = [];
  const watch: WatchFn = (dir, listener) => {
    if (failFor.includes(dir)) {
      throw Object.assign(new Error(`${code ?? "ENOENT"}: ${dir}`), code ? { code } : {});
    }
    open.set(dir, listener);
    return {
      close: () => {
        open.delete(dir);
        closed.push(dir);
      },
    };
  };
  return { watch, open, closed };
}

function makeRepo(id: string, root: string): CatalogRepo {
  return { id, name: "repo", root, managed: false, createdAt: "2026-01-01T00:00:00.000Z" };
}

async function settle(ms = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("WorktreeWatcher", () => {
  test("watches the git dir and its worktrees directory", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    mkdirSync(join(gitDir, "worktrees"), { recursive: true });
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: () => {},
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      debounceMs: 5,
    });
    await watcher.sync([makeRepo("r1", join(base, "repo"))]);
    expect([...fake.open.keys()]).toContain(gitDir);
    expect([...fake.open.keys()]).toContain(join(gitDir, "worktrees"));
    await watcher.close();
  });

  test("fires on an entry appearing under worktrees/", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    mkdirSync(join(gitDir, "worktrees"), { recursive: true });
    const fired: string[] = [];
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: (id) => fired.push(id),
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      debounceMs: 5,
    });
    await watcher.sync([makeRepo("r1", join(base, "repo"))]);
    fake.open.get(join(gitDir, "worktrees"))?.("rename", "feature");
    await settle();
    expect(fired).toEqual(["r1"]);
    await watcher.close();
  });

  test("filters a sibling index write under the git dir", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    mkdirSync(join(gitDir, "worktrees"), { recursive: true });
    const fired: string[] = [];
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: (id) => fired.push(id),
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      debounceMs: 5,
    });
    await watcher.sync([makeRepo("r1", join(base, "repo"))]);
    fake.open.get(gitDir)?.("change", "index");
    fake.open.get(gitDir)?.("change", "FETCH_HEAD");
    await settle();
    expect(fired).toEqual([]);
    // ...but `worktrees` itself is the signal this watch exists for.
    fake.open.get(gitDir)?.("rename", "worktrees");
    await settle();
    expect(fired).toEqual(["r1"]);
    await watcher.close();
  });

  test("coalesces a burst into one fire", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    mkdirSync(join(gitDir, "worktrees"), { recursive: true });
    const fired: string[] = [];
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: (id) => fired.push(id),
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      debounceMs: 20,
    });
    await watcher.sync([makeRepo("r1", join(base, "repo"))]);
    const listener = fake.open.get(join(gitDir, "worktrees"));
    for (let i = 0; i < 5; i += 1) listener?.("rename", `wt-${i}`);
    await settle(60);
    expect(fired).toEqual(["r1"]);
    await watcher.close();
  });

  // The sweep's prune path calls `removeRepo`, which runs `git worktree
  // prune`, which DELETES entries under `<gitdir>/worktrees/` — the very
  // directory this watcher watches. So a prune fires the watch that triggered
  // it, and the only reason that is a settling cycle rather than a spin is
  // that a pass is WRITE-ONLY-ON-CHANGE: the second pass finds the row
  // already gone and git listing nothing extra, writes nothing, touches no
  // watched directory, and the cycle stops.
  //
  // Nothing else pins that, so this does. The fake pass below writes exactly
  // once — the prune — and re-enters the watch the way a real prune would;
  // every later pass is a no-op. The bound asserted is TWO fires: the one the
  // external event asked for, and the one the prune's own write provokes. A
  // watcher that re-armed on its own, or a `schedule` that stacked a timer
  // per event, would show three and keep counting.
  test("a prune-shaped feedback cycle settles at two fires", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    mkdirSync(join(gitDir, "worktrees"), { recursive: true });
    const fired: string[] = [];
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: (id) => {
        fired.push(id);
        // Only the first pass finds a row to prune. Its write lands under
        // `worktrees/`, so the watch that started it fires again.
        if (fired.length === 1) fake.open.get(join(gitDir, "worktrees"))?.("rename", "feature");
      },
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      debounceMs: 5,
    });
    await watcher.sync([makeRepo("r1", join(base, "repo"))]);

    fake.open.get(join(gitDir, "worktrees"))?.("rename", "feature");

    // Many debounce windows, so an unbounded cycle would be obvious.
    await settle(120);
    expect(fired).toEqual(["r1", "r1"]);
    // And it stays settled rather than merely being slow.
    await settle(60);
    expect(fired).toHaveLength(2);
    await watcher.close();
  });

  test("watches each distinct parent of a known worktree", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    mkdirSync(join(gitDir, "worktrees"), { recursive: true });
    const parent = join(base, "trees");
    mkdirSync(join(parent, "a"), { recursive: true });
    mkdirSync(join(parent, "b"), { recursive: true });
    const fired: string[] = [];
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: (id) => fired.push(id),
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      debounceMs: 5,
    });
    const repo = makeRepo("r1", join(base, "repo"));
    const rowA: CatalogRepo = {
      id: "a",
      name: "a",
      root: join(parent, "a"),
      managed: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      worktreeOf: { repoId: "r1", createdOnBranch: "a", source: { from: "branch" } },
    };
    const rowB: CatalogRepo = { ...rowA, id: "b", name: "b", root: join(parent, "b") };
    await watcher.sync([repo, rowA, rowB]);
    // Two rows, one shared parent, one watch.
    expect([...fake.open.keys()].filter((d) => d === parent)).toHaveLength(1);
    fake.open.get(parent)?.("rename", "a");
    await settle();
    expect(fired).toEqual(["r1"]);
    await watcher.close();
  });

  // An adopted worktree can sit in a busy directory — $HOME, a crowded
  // repos dir — and every unrelated write there would otherwise cost a
  // debounced `git worktree list`. Only the known worktrees' own names count.
  test("unrelated churn in a worktree's parent directory does not fire", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    mkdirSync(join(gitDir, "worktrees"), { recursive: true });
    const parent = join(base, "busy-home");
    mkdirSync(join(parent, "wt"), { recursive: true });
    const fired: string[] = [];
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: (id) => fired.push(id),
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      debounceMs: 5,
    });
    const row: CatalogRepo = {
      id: "wt",
      name: "wt",
      root: join(parent, "wt"),
      managed: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      worktreeOf: { repoId: "r1", createdOnBranch: "wt", source: { from: "branch" } },
    };
    await watcher.sync([makeRepo("r1", join(base, "repo")), row]);
    fake.open.get(parent)?.("change", ".DS_Store");
    fake.open.get(parent)?.("rename", "some-unrelated-checkout");
    await settle();
    expect(fired).toEqual([]);
    // ...while the worktree's own name is exactly the signal.
    fake.open.get(parent)?.("rename", "wt");
    await settle();
    expect(fired).toEqual(["r1"]);
    await watcher.close();
  });

  // The parent watch's whole job is `rm -rf` on a worktree, and the platform
  // decides what that looks like: inotify (non-recursive) reports the direct
  // child, `feature-x`, while a recursive backend like macOS's FSEvents
  // reports paths RELATIVE to the watched directory — `feature-x/f.txt` — and
  // may coalesce the bare entry away entirely. This filter therefore asks
  // "which child of the watched directory does this event belong to", which
  // is the FIRST segment. `head-watch.ts`'s `basenameOf` answers the opposite
  // question ("is this file named HEAD") and is right for that; borrowing it
  // here dropped every nested report, so an externally deleted worktree kept
  // its row on any recursive backend while adoption — which rides the
  // unfiltered `worktrees/` watch — kept working, exactly the asymmetry that
  // makes this platform-specific bug invisible on a Linux CI.
  test("fires on a nested path report, as a recursive watch backend gives", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    mkdirSync(join(gitDir, "worktrees"), { recursive: true });
    const parent = join(base, "trees");
    mkdirSync(join(parent, "feature-x"), { recursive: true });
    const fired: string[] = [];
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: (id) => fired.push(id),
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      debounceMs: 5,
    });
    const row: CatalogRepo = {
      id: "wt",
      name: "feature-x",
      root: join(parent, "feature-x"),
      managed: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      worktreeOf: { repoId: "r1", createdOnBranch: "feature-x", source: { from: "branch" } },
    };
    await watcher.sync([makeRepo("r1", join(base, "repo")), row]);
    // What `rm -rf feature-x` looks like through a recursive backend: the
    // files inside it, reported beneath the worktree's own directory.
    fake.open.get(parent)?.("rename", join("feature-x", "f.txt"));
    await settle();
    expect(fired).toEqual(["r1"]);
    await watcher.close();
  });

  // The narrowing above must not widen: a nested report under some OTHER
  // directory is still unrelated churn, and the busy-parent case is why the
  // filter exists at all.
  test("a nested path under an unrelated sibling still does not fire", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    mkdirSync(join(gitDir, "worktrees"), { recursive: true });
    const parent = join(base, "busy-home");
    mkdirSync(join(parent, "wt"), { recursive: true });
    const fired: string[] = [];
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: (id) => fired.push(id),
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      debounceMs: 5,
    });
    const row: CatalogRepo = {
      id: "wt",
      name: "wt",
      root: join(parent, "wt"),
      managed: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      worktreeOf: { repoId: "r1", createdOnBranch: "wt", source: { from: "branch" } },
    };
    await watcher.sync([makeRepo("r1", join(base, "repo")), row]);
    fake.open.get(parent)?.("rename", join("some-other-checkout", "wt"));
    await settle();
    expect(fired).toEqual([]);
    await watcher.close();
  });

  // A watch is bound to the inode it was opened on. git deletes `worktrees/`
  // with the last worktree and recreates it on the next add, so the child
  // subscription dies across that cycle — the git dir event for `worktrees`
  // must reopen it, or every LATER add (which writes only under the reborn
  // directory) goes unseen until a reattach.
  test("the worktrees/ watch is reopened when the directory is reborn", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    const worktreesDir = join(gitDir, "worktrees");
    mkdirSync(worktreesDir, { recursive: true });
    const fired: string[] = [];
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: (id) => fired.push(id),
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      debounceMs: 5,
    });
    await watcher.sync([makeRepo("r1", join(base, "repo"))]);

    // `worktrees/` reborn: the git dir reports it, and the stale child watch
    // is closed and replaced.
    fake.open.get(gitDir)?.("rename", "worktrees");
    expect(fake.closed).toContain(worktreesDir);
    expect(fake.open.has(worktreesDir)).toBe(true);
    await settle();
    expect(fired).toEqual(["r1"]);

    // The replacement watch is live: an event under the reborn directory
    // still reaches the repo.
    fake.open.get(worktreesDir)?.("rename", "feature");
    await settle();
    expect(fired).toEqual(["r1", "r1"]);
    await watcher.close();
  });

  test("a directory that cannot be watched warns and does not throw", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    const warnings: string[] = [];
    const fake = fakeWatch([join(gitDir, "worktrees")]);
    const watcher = new WorktreeWatcher({
      onChanged: () => {},
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      onWarning: (m) => warnings.push(m),
      debounceMs: 5,
    });
    await watcher.sync([makeRepo("r1", join(base, "repo"))]);
    expect(warnings).toHaveLength(1);
    expect([...fake.open.keys()]).toContain(gitDir);
    await watcher.close();
  });

  test("a repo with no worktrees directory is retried without warning", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    const worktreesDir = join(gitDir, "worktrees");
    const warnings: string[] = [];
    const failFor = [worktreesDir];
    const fake = fakeWatch(failFor, "ENOENT");
    const watcher = new WorktreeWatcher({
      onChanged: () => {},
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      onWarning: (m) => warnings.push(m),
      debounceMs: 5,
    });
    const rows = [makeRepo("r1", join(base, "repo"))];
    for (let i = 0; i < 3; i++) await watcher.sync(rows);
    expect(warnings).toEqual([]);

    failFor.length = 0;
    await watcher.sync(rows);
    expect(fake.open.has(worktreesDir)).toBe(true);
    await watcher.close();
  });

  test("a directory that keeps failing to open warns once, not on every sync", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    const warnings: string[] = [];
    const fake = fakeWatch([join(gitDir, "worktrees")], "EACCES");
    const watcher = new WorktreeWatcher({
      onChanged: () => {},
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      onWarning: (m) => warnings.push(m),
      debounceMs: 5,
    });
    const rows = [makeRepo("r1", join(base, "repo"))];
    for (let i = 0; i < 3; i++) await watcher.sync(rows);
    expect(warnings).toHaveLength(1);
    await watcher.close();
  });

  test("a repo whose git dir cannot be resolved is skipped", async () => {
    const base = tempDir();
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: () => {},
      gitCommonDir: async () => null,
      watch: fake.watch,
      debounceMs: 5,
    });
    await watcher.sync([makeRepo("r1", join(base, "repo"))]);
    expect([...fake.open.keys()]).toEqual([]);
    await watcher.close();
  });

  test("a gitCommonDir that rejects is skipped, not fatal", async () => {
    // `sync` runs from `catalog.onChange`, unattended: a rejection escaping
    // here would be an unhandled rejection, which exits cubed and makes
    // its supervisor crash-loop it.
    const base = tempDir();
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: () => {},
      gitCommonDir: async () => {
        throw new Error("git is gone");
      },
      watch: fake.watch,
      debounceMs: 5,
    });
    await watcher.sync([makeRepo("r1", join(base, "repo"))]);
    expect([...fake.open.keys()]).toEqual([]);
    await watcher.close();
  });

  test("drops watches for a repo that is gone, and close releases everything", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    mkdirSync(join(gitDir, "worktrees"), { recursive: true });
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: () => {},
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      debounceMs: 5,
    });
    await watcher.sync([makeRepo("r1", join(base, "repo"))]);
    expect(fake.open.size).toBeGreaterThan(0);
    await watcher.sync([]);
    expect(fake.open.size).toBe(0);
    await watcher.sync([makeRepo("r1", join(base, "repo"))]);
    await watcher.close();
    expect(fake.open.size).toBe(0);
  });

  test("re-syncing the same rows keeps the existing watches, not churning them", async () => {
    // This runs on every catalog change, and most catalog changes are about
    // items. Re-opening every watch each time would drop events in the gap.
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    mkdirSync(join(gitDir, "worktrees"), { recursive: true });
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: () => {},
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      debounceMs: 5,
    });
    const rows = [makeRepo("r1", join(base, "repo"))];
    await watcher.sync(rows);
    const opened = fake.open.size;
    await watcher.sync(rows);
    expect(fake.open.size).toBe(opened);
    expect(fake.closed).toHaveLength(0);
    await watcher.close();
  });

  test("a sync racing close leaves no watch open", async () => {
    // `sync` awaits a git subprocess per repo, so a close landing mid-resolve
    // would otherwise open watches nothing is ever going to release.
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    mkdirSync(join(gitDir, "worktrees"), { recursive: true });
    const fake = fakeWatch();
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const watcher = new WorktreeWatcher({
      onChanged: () => {},
      gitCommonDir: async () => {
        await gate;
        return gitDir;
      },
      watch: fake.watch,
      debounceMs: 5,
    });
    const syncing = watcher.sync([makeRepo("r1", join(base, "repo"))]);
    await watcher.close();
    release();
    await syncing;
    expect(fake.open.size).toBe(0);
  });

  test("does not fire after close", async () => {
    const base = tempDir();
    const gitDir = join(base, "repo", ".git");
    mkdirSync(join(gitDir, "worktrees"), { recursive: true });
    const fired: string[] = [];
    const fake = fakeWatch();
    const watcher = new WorktreeWatcher({
      onChanged: (id) => fired.push(id),
      gitCommonDir: async () => gitDir,
      watch: fake.watch,
      debounceMs: 20,
    });
    await watcher.sync([makeRepo("r1", join(base, "repo"))]);
    const listener = fake.open.get(join(gitDir, "worktrees"));
    listener?.("rename", "feature");
    await watcher.close();
    await settle(60);
    expect(fired).toEqual([]);
  });
});

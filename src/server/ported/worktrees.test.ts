import { afterEach, describe, expect, test } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CubedWorktrees } from "./worktrees";
import type { ExecCommand, ExecResult } from "./exec";

interface Call {
  cmd: string;
  args: string[];
  opts?: { cwd?: string; timeoutMs?: number };
}

function fakeExec(script: (cmd: string, args: string[]) => ExecResult): {
  exec: ExecCommand;
  calls: Call[];
} {
  const calls: Call[] = [];
  const exec: ExecCommand = (cmd, args, opts) => {
    calls.push({ cmd, args, ...(opts ? { opts } : {}) });
    return Promise.resolve(script(cmd, args));
  };
  return { exec, calls };
}

/** Argument vectors only, for asserting the shape of a command line. */
const argv = (calls: Call[]): string[][] => calls.map((c) => [c.cmd, ...c.args]);

const ok = (stdout = ""): ExecResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr = ""): ExecResult => ({ ok: false, stdout: "", stderr });

const REPO = "/home/u/repos/cube-computer";
const WT = "/home/u/.cube/worktrees/cube-computer/fix";
const ROOT = "/home/u/.cube/worktrees";

/** Temp directories every test in this file cleans up after itself. */
const madeDirs: string[] = [];
afterEach(() => {
  while (madeDirs.length) rmSync(madeDirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cubed-wt-")));
  madeDirs.push(dir);
  return dir;
}

describe("CubedWorktrees.add", () => {
  test("a new branch fetches, prunes, then adds from the local base", async () => {
    // Every ref resolves, so local and origin both exist: local wins.
    const { exec, calls } = fakeExec(() => ok());
    await new CubedWorktrees(exec).add({
      repoPath: REPO,
      path: WT,
      branch: "fix",
      source: { from: "new", baseBranch: "main" },
    });
    expect(argv(calls)).toEqual([
      ["git", "fetch", "origin"],
      ["git", "worktree", "prune"],
      ["git", "rev-parse", "--verify", "--quiet", "refs/heads/main"],
      ["git", "worktree", "add", "-b", "fix", WT, "main"],
    ]);
    for (const call of calls) expect(call.opts?.cwd).toBe(REPO);
  });

  test("a local-only base is cut from the local ref, origin never consulted", async () => {
    const { exec, calls } = fakeExec((cmd, args) =>
      args.includes("origin/main") ? fail("unknown revision") : ok(),
    );
    await new CubedWorktrees(exec).add({
      repoPath: REPO,
      path: WT,
      branch: "fix",
      source: { from: "new", baseBranch: "main" },
    });
    expect(argv(calls)).toContainEqual(["git", "worktree", "add", "-b", "fix", WT, "main"]);
  });

  test("a base that exists only on origin is cut from origin/<base>", async () => {
    const { exec, calls } = fakeExec((cmd, args) =>
      args[0] === "rev-parse" && args.includes("refs/heads/main") ? fail() : ok(),
    );
    await new CubedWorktrees(exec).add({
      repoPath: REPO,
      path: WT,
      branch: "fix",
      source: { from: "new", baseBranch: "main" },
    });
    expect(argv(calls)).toContainEqual(["git", "worktree", "add", "-b", "fix", WT, "origin/main"]);
  });

  test("a failed fetch does not abort the add", async () => {
    const { exec, calls } = fakeExec((cmd, args) =>
      args[0] === "fetch" ? fail("could not resolve host") : ok(),
    );
    const result = await new CubedWorktrees(exec).add({
      repoPath: REPO,
      path: WT,
      branch: "fix",
      source: { from: "new", baseBranch: "main" },
    });
    expect(result.fetchWarning).toBe(true);
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(true);
  });

  test("an existing local branch is checked out without -b", async () => {
    const { exec, calls } = fakeExec((cmd, args) =>
      args.includes("--verify") ? ok("abc123") : ok(),
    );
    await new CubedWorktrees(exec).add({
      repoPath: REPO,
      path: WT,
      branch: "spike/oauth",
      source: { from: "branch" },
    });
    expect(argv(calls)).toContainEqual(["git", "worktree", "add", WT, "spike/oauth"]);
  });

  test("a remote-only branch is tracked into a new local branch", async () => {
    const { exec, calls } = fakeExec((cmd, args) =>
      args.includes("--verify") && args.includes("refs/heads/spike/oauth") ? fail() : ok(),
    );
    await new CubedWorktrees(exec).add({
      repoPath: REPO,
      path: WT,
      branch: "spike/oauth",
      source: { from: "branch" },
    });
    expect(argv(calls)).toContainEqual([
      "git", "worktree", "add", "--track", "-b", "spike/oauth", WT, "origin/spike/oauth",
    ]);
  });

  test("branch source keeps the branch name verbatim (no slugging)", async () => {
    const { exec, calls } = fakeExec((cmd, args) =>
      args.includes("--verify") ? ok("abc123") : ok(),
    );
    await new CubedWorktrees(exec).add({
      repoPath: REPO,
      path: WT,
      branch: "Fix_Bug",
      source: { from: "branch" },
    });
    expect(argv(calls)).toContainEqual(["git", "worktree", "add", WT, "Fix_Bug"]);
  });

  test("a PR detaches first, then runs gh pr checkout inside the worktree", async () => {
    const { exec, calls } = fakeExec(() => ok());
    await new CubedWorktrees(exec).add({
      repoPath: REPO,
      path: WT,
      branch: "fix-oauth-retry",
      source: { from: "pr", number: 412 },
    });
    expect(argv(calls)).toContainEqual(["git", "worktree", "add", "--detach", WT, "HEAD"]);
    expect(argv(calls)).toContainEqual([
      "gh", "pr", "checkout", "412", "--branch", "fix-oauth-retry",
    ]);
    const detachAt = calls.findIndex((c) => c.args.includes("--detach"));
    const checkoutAt = calls.findIndex((c) => c.cmd === "gh");
    expect(detachAt).toBeLessThan(checkoutAt);
  });

  test("pr source: the branch the caller decided is the one gh checks out", async () => {
    const { exec, calls } = fakeExec(() => ok());
    await new CubedWorktrees(exec).add({
      repoPath: REPO,
      path: WT,
      branch: "412-review",
      source: { from: "pr", number: 412 },
    });
    // Without --branch, gh names the local branch after the PR head, and the
    // catalog row's branch would disagree with the worktree's.
    expect(calls.find((c) => c.cmd === "gh")?.args).toEqual([
      "pr", "checkout", "412", "--branch", "412-review",
    ]);
  });

  test("pr source: gh pr checkout runs with cwd = the new worktree", async () => {
    const { exec, calls } = fakeExec(() => ok());
    await new CubedWorktrees(exec).add({
      repoPath: REPO,
      path: WT,
      branch: "fix-oauth-retry",
      source: { from: "pr", number: 412 },
    });
    const checkout = calls.find((c) => c.cmd === "gh");
    expect(checkout?.opts?.cwd).toBe(WT);
    expect(checkout?.args).not.toContain("-R");
  });

  test("a failed gh pr checkout removes the detached worktree and throws", async () => {
    const { exec, calls } = fakeExec((cmd) => (cmd === "gh" ? fail("no such pull request") : ok()));
    const promise = new CubedWorktrees(exec).add({
      repoPath: REPO,
      path: WT,
      branch: "fix-oauth-retry",
      source: { from: "pr", number: 412 },
    });
    await expect(promise).rejects.toThrow(/no such pull request/);
    expect(argv(calls)).toContainEqual(["git", "worktree", "remove", "--force", WT]);
  });

  test("a branch already checked out reports the holding path, not a raw error", async () => {
    const { exec } = fakeExec((cmd, args) =>
      cmd === "git" && args[0] === "worktree" && args[1] === "add"
        ? fail("fatal: 'fix' is already used by worktree at '/home/u/.cube/worktrees/c/fix'")
        : ok(),
    );
    const promise = new CubedWorktrees(exec).add({
      repoPath: REPO,
      path: WT,
      branch: "fix",
      source: { from: "new", baseBranch: "main" },
    });
    await expect(promise).rejects.toThrow(/already used by worktree/);
  });
});

describe("CubedWorktrees.checkouts", () => {
  const porcelain = (path: string): string =>
    [
      `worktree ${REPO}`,
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      `worktree ${path}`,
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/fix",
      "",
    ].join("\n");

  test("reports the primary checkout too, flagged, with its branch", async () => {
    const { exec, calls } = fakeExec(() => ok(porcelain(WT)));
    const { checkouts } = await new CubedWorktrees(exec).checkouts({ repoPath: REPO });
    expect(checkouts).toEqual([
      {
        path: REPO,
        branch: "main",
        head: "1111111111111111111111111111111111111111",
        primary: true,
        missing: true,
      },
      {
        path: WT,
        branch: "fix",
        head: "2222222222222222222222222222222222222222",
        primary: false,
        missing: true,
      },
    ]);
    // One git call answers "what is checked out where" for the whole repo.
    expect(calls.length).toBe(1);
    expect(calls[0]?.opts?.cwd).toBe(REPO);
  });

  test("a detached checkout reports branch null, not an empty string", async () => {
    // Null and "" would both be falsy, but only one of them can be told apart
    // from a branch whose name failed to read.
    const detached = [
      `worktree ${WT}`,
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
      "",
    ].join("\n");
    const { exec } = fakeExec(() => ok(detached));
    const { checkouts } = await new CubedWorktrees(exec).checkouts({ repoPath: REPO });
    expect(checkouts[0]?.branch).toBeNull();
    expect(checkouts[0]?.head).toBe("3333333333333333333333333333333333333333");
  });

  test("a symlinked repoPath still identifies its own checkout as primary", async () => {
    // git prints real paths; a lexically-resolved repoPath (the e2e harness's
    // $TMPDIR HOME is itself a symlink) would flag nothing as primary and the
    // repo would be swept as a removable worktree.
    const realRepo = tempDir();
    const link = join(tempDir(), "repo-link");
    symlinkSync(realRepo, link);
    const { exec } = fakeExec(() =>
      ok([`worktree ${realRepo}`, "HEAD 1111111111111111111111111111111111111111", "branch refs/heads/main", ""].join("\n")),
    );
    const { checkouts } = await new CubedWorktrees(exec).checkouts({ repoPath: link });
    expect(checkouts.map((c) => c.primary)).toEqual([true]);
  });

  // root ignores directory permission bits, so a 0o000 parent would still be
  // readable and this case would never fire — skip rather than assert
  // something false.
  test.skipIf(process.getuid?.() === 0)(
    "an entry that exists but cannot be stat'd is reported present, not missing",
    async () => {
      const parent = tempDir();
      const unreadable = join(parent, "unreadable");
      mkdirSync(unreadable, { recursive: true });
      chmodSync(parent, 0o000);
      try {
        const { exec } = fakeExec(() =>
          ok(
            [
              `worktree ${unreadable}`,
              "HEAD 1111111111111111111111111111111111111111",
              "branch refs/heads/fix",
              "",
            ].join("\n"),
          ),
        );
        const { checkouts } = await new CubedWorktrees(exec).checkouts({ repoPath: REPO });
        expect(checkouts[0]?.missing).toBe(false);
      } finally {
        chmodSync(parent, 0o755);
      }
    },
  );
});

describe("CubedWorktrees.list", () => {
  const porcelain = (path: string): string =>
    [
      `worktree ${REPO}`,
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      `worktree ${path}`,
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/fix",
      "",
    ].join("\n");

  test("parses porcelain output and omits the primary checkout", async () => {
    const { exec, calls } = fakeExec(() => ok(porcelain(WT)));
    const result = await new CubedWorktrees(exec).list({ repoPath: REPO });
    expect(result.worktrees).toEqual([
      {
        path: WT,
        branch: "fix",
        head: "2222222222222222222222222222222222222222",
        missing: true,
      },
    ]);
    expect(calls[0]?.opts?.cwd).toBe(REPO);
  });

  test("list marks a listed worktree whose directory is gone as missing", async () => {
    const root = tempDir();
    const gone = join(root, "app", "gone");
    const { exec } = fakeExec(() => ok(porcelain(gone)));
    const { worktrees } = await new CubedWorktrees(exec, root).list({ repoPath: REPO });
    expect(worktrees[0]?.missing).toBe(true);
  });

  test("a worktree whose directory still exists is not missing", async () => {
    const root = tempDir();
    const live = join(root, "fix");
    mkdirSync(live, { recursive: true });
    const { exec } = fakeExec(() => ok(porcelain(live)));
    const { worktrees } = await new CubedWorktrees(exec, root).list({ repoPath: REPO });
    expect(worktrees[0]?.missing).toBe(false);
  });

  test("a symlinked repo path does not leak the primary checkout into the list", async () => {
    // git always prints real paths, so a lexically-resolved repoPath (the e2e
    // harness's $TMPDIR HOME is itself a symlink) would miss the filter and
    // report the repo itself as a removable worktree.
    const realRepo = tempDir();
    const link = join(tempDir(), "repo-link");
    symlinkSync(realRepo, link);
    const porcelainFromReal = [
      `worktree ${realRepo}`,
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
    ].join("\n");
    const { exec } = fakeExec(() => ok(porcelainFromReal));
    const result = await new CubedWorktrees(exec).list({ repoPath: link });
    expect(result.worktrees).toEqual([]);
  });

  test("a detached worktree reports an empty branch rather than being dropped", async () => {
    const detached = [
      `worktree ${WT}`,
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
      "",
    ].join("\n");
    const { exec } = fakeExec(() =>
      ok(`worktree ${REPO}\nHEAD 1\nbranch refs/heads/main\n\n${detached}`),
    );
    const result = await new CubedWorktrees(exec).list({ repoPath: REPO });
    expect(result.worktrees[0]?.branch).toBe("");
  });

  test("a failed list throws with git's stderr tail", async () => {
    const { exec } = fakeExec(() => fail("not a git repository"));
    await expect(new CubedWorktrees(exec).list({ repoPath: REPO })).rejects.toThrow(
      /not a git repository/,
    );
  });
});

describe("CubedWorktrees.branches", () => {
  // Shaped like real `git for-each-ref --format=%(refname)` output (git
  // 2.50.1): refs/heads first, then refs/remotes/origin with its HEAD
  // pointer. The short form would render that HEAD as bare "origin".
  const FOR_EACH_REF = [
    "refs/heads/main",
    "refs/heads/spike/oauth",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
    "refs/remotes/origin/release",
    "",
  ].join("\n");

  test("lists local branches, then remote-only ones, marked", async () => {
    const { exec, calls } = fakeExec(() => ok(FOR_EACH_REF));
    const result = await new CubedWorktrees(exec).branches({ repoPath: REPO });
    expect(result.branches).toEqual([
      { name: "main", remote: false },
      { name: "spike/oauth", remote: false },
      { name: "release", remote: true },
    ]);
    expect(argv(calls)).toEqual([
      ["git", "fetch", "--prune", "origin"],
      ["git", "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"],
    ]);
    for (const call of calls) expect(call.opts?.cwd).toBe(REPO);
  });

  test("a failed fetch still lists whatever refs the clone already has", async () => {
    const { exec, calls } = fakeExec((_cmd, args) =>
      args[0] === "fetch" ? fail("could not resolve host") : ok(FOR_EACH_REF),
    );
    const result = await new CubedWorktrees(exec).branches({ repoPath: REPO });
    expect(result.branches.map((b) => b.name)).toEqual(["main", "spike/oauth", "release"]);
    expect(argv(calls)[1]?.[1]).toBe("for-each-ref");
  });

  test("the fetch before listing is bounded by the short default, not the long one", async () => {
    const { exec, calls } = fakeExec(() => ok(FOR_EACH_REF));
    await new CubedWorktrees(exec).branches({ repoPath: REPO });
    expect(calls[0]?.opts?.timeoutMs).toBeUndefined();
  });

  test("origin/HEAD is dropped rather than offered as a phantom branch", async () => {
    const { exec } = fakeExec(() => ok(FOR_EACH_REF));
    const result = await new CubedWorktrees(exec).branches({ repoPath: REPO });
    const names = result.branches.map((b) => b.name);
    expect(names).not.toContain("HEAD");
    // git shortens refs/remotes/origin/HEAD to bare "origin" — a branch that
    // does not exist, and one every clone would otherwise be offered.
    expect(names).not.toContain("origin");
  });

  test("a branch present locally and remotely is listed once, as local", async () => {
    const { exec } = fakeExec(() => ok(FOR_EACH_REF));
    const result = await new CubedWorktrees(exec).branches({ repoPath: REPO });
    expect(result.branches.filter((b) => b.name === "main")).toEqual([
      { name: "main", remote: false },
    ]);
  });

  test("a local branch literally named origin/x is local, not remote", async () => {
    const refs = ["refs/heads/origin/x", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"];
    const { exec } = fakeExec(() => ok(refs.join("\n")));
    const result = await new CubedWorktrees(exec).branches({ repoPath: REPO });
    expect(result.branches).toEqual([
      { name: "origin/x", remote: false },
      { name: "main", remote: true },
    ]);
  });

  test("a repo with no origin remote still lists its local branches", async () => {
    const { exec } = fakeExec(() => ok("refs/heads/main\nrefs/heads/fix\n"));
    const result = await new CubedWorktrees(exec).branches({ repoPath: REPO });
    expect(result.branches).toEqual([
      { name: "main", remote: false },
      { name: "fix", remote: false },
    ]);
  });
});

describe("CubedWorktrees.inspect", () => {
  test("counts dirty files and unpushed commits", async () => {
    const path = tempDir();
    const { exec, calls } = fakeExec((cmd, args) => {
      if (args.includes("status")) return ok(" M a.ts\n?? b.ts\n");
      if (args.includes("rev-list")) return ok("2\n");
      return ok();
    });
    expect(await new CubedWorktrees(exec).inspect({ path })).toEqual({
      dirty: 2,
      unpushedCommits: 2,
      missing: false,
    });
    for (const call of calls) expect(call.opts?.cwd).toBe(path);
  });

  test("a branch with no upstream counts every commit no remote holds", async () => {
    const path = tempDir();
    const { exec, calls } = fakeExec((cmd, args) => {
      if (args.includes("status")) return ok("");
      if (args.includes("@{u}..HEAD")) return fail("no upstream configured for branch");
      if (args.includes("--remotes")) return ok("5\n");
      return ok();
    });
    // The never-pushed branch is exactly where the work-loss guard matters:
    // reporting 0 here would tell the user nothing would be discarded.
    expect(await new CubedWorktrees(exec).inspect({ path })).toEqual({
      dirty: 0,
      unpushedCommits: 5,
      missing: false,
    });
    expect(argv(calls)).toContainEqual([
      "git", "rev-list", "--count", "HEAD", "--not", "--remotes",
    ]);
  });

  test("a failed status throws rather than reporting a clean worktree", async () => {
    const { exec } = fakeExec((cmd, args) =>
      args.includes("status") ? fail("not a git repository") : ok(),
    );
    await expect(new CubedWorktrees(exec).inspect({ path: tempDir() })).rejects.toThrow(
      /not a git repository/,
    );
  });

  test("both commit probes failing throws rather than reporting zero unpushed", async () => {
    const { exec } = fakeExec((cmd, args) => {
      if (args.includes("status")) return ok("");
      if (args.includes("rev-list")) return fail("bad revision 'HEAD'");
      return ok();
    });
    await expect(new CubedWorktrees(exec).inspect({ path: tempDir() })).rejects.toThrow(
      /bad revision/,
    );
  });

  test("reports a vanished worktree as missing rather than throwing", async () => {
    const base = tempDir();
    const { exec } = fakeExec(() => fail("not a git repository"));
    const worktrees = new CubedWorktrees(exec, join(base, "managed"));
    expect(await worktrees.inspect({ path: join(base, "gone") })).toEqual({
      dirty: 0,
      unpushedCommits: 0,
      missing: true,
    });
  });

  test("still throws when git status fails for a directory that is there", async () => {
    const base = tempDir();
    const there = join(base, "there");
    mkdirSync(there, { recursive: true });
    const { exec } = fakeExec(() => fail("fatal: not a git repository"));
    const worktrees = new CubedWorktrees(exec, join(base, "managed"));
    await expect(worktrees.inspect({ path: there })).rejects.toThrow(/git status failed/);
  });

  // root ignores directory permission bits, so a 0o000 parent would still be
  // readable and this case would never fire — skip rather than assert
  // something false.
  test.skipIf(process.getuid?.() === 0)(
    "a path that exists but cannot be stat'd throws, not reports missing",
    async () => {
      const parent = tempDir();
      const child = join(parent, "unreadable");
      mkdirSync(child, { recursive: true });
      chmodSync(parent, 0o000);
      try {
        const { exec } = fakeExec(() => fail("not a git repository"));
        const worktrees = new CubedWorktrees(exec);
        await expect(worktrees.inspect({ path: child })).rejects.toThrow(/inspect failed/);
      } finally {
        chmodSync(parent, 0o755);
      }
    },
  );
});

describe("CubedWorktrees.repoInfo", () => {
  test("a github.com origin reports hasGithubRemote true", async () => {
    const { exec, calls } = fakeExec((cmd, args) => {
      if (args.includes("get-url")) return ok("git@github.com:o/r.git\n");
      if (args.includes("symbolic-ref")) return ok("origin/main\n");
      return ok();
    });
    const result = await new CubedWorktrees(exec).repoInfo({ repoPath: REPO });
    expect(result).toEqual({ hasGithubRemote: true, defaultBranch: "main" });
    expect(argv(calls)).toContainEqual(["git", "remote", "get-url", "origin"]);
    expect(calls[0]?.opts?.cwd).toBe(REPO);
  });

  test("a non-github origin (e.g. gitlab) reports hasGithubRemote false", async () => {
    const { exec } = fakeExec((cmd, args) => {
      if (args.includes("get-url")) return ok("git@gitlab.com:o/r.git\n");
      if (args.includes("symbolic-ref")) return ok("origin/main\n");
      return ok();
    });
    const result = await new CubedWorktrees(exec).repoInfo({ repoPath: REPO });
    expect(result.hasGithubRemote).toBe(false);
  });

  test("no origin at all reports hasGithubRemote false rather than throwing", async () => {
    const { exec } = fakeExec((cmd, args) => {
      if (args.includes("get-url")) return fail("No such remote 'origin'");
      if (args.includes("symbolic-ref")) return fail("no such ref");
      if (args.includes("rev-parse")) return ok("main\n");
      return ok();
    });
    const result = await new CubedWorktrees(exec).repoInfo({ repoPath: REPO });
    expect(result.hasGithubRemote).toBe(false);
  });

  test("falls back to the checked-out branch when origin/HEAD isn't tracked", async () => {
    const { exec, calls } = fakeExec((cmd, args) => {
      if (args.includes("get-url")) return ok("git@github.com:o/r.git\n");
      if (args.includes("symbolic-ref")) {
        return fail("ref refs/remotes/origin/HEAD is not a symbolic ref");
      }
      if (args.includes("rev-parse")) return ok("spike/oauth\n");
      return ok();
    });
    const result = await new CubedWorktrees(exec).repoInfo({ repoPath: REPO });
    expect(result).toEqual({ hasGithubRemote: true, defaultBranch: "spike/oauth" });
    expect(argv(calls)).toContainEqual(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  });

  test("both branch probes failing reports a null default branch, not a throw", async () => {
    const { exec } = fakeExec((cmd, args) => {
      if (args.includes("get-url")) return ok("git@github.com:o/r.git\n");
      if (args.includes("symbolic-ref")) return fail();
      if (args.includes("rev-parse")) return fail("not a git repository");
      return ok();
    });
    const result = await new CubedWorktrees(exec).repoInfo({ repoPath: REPO });
    expect(result).toEqual({ hasGithubRemote: true, defaultBranch: null });
  });
});

describe("CubedWorktrees.gitCommonDir", () => {
  test("resolves the relative answer a primary checkout gives against its root", async () => {
    // `git rev-parse --git-common-dir` answers `.git` from inside the repo,
    // and the watcher keys its subscriptions on the path, so a relative one
    // would watch a directory relative to cubed's own cwd.
    const { exec, calls } = fakeExec(() => ok(".git\n"));
    const result = await new CubedWorktrees(exec).gitCommonDir(REPO);
    expect(result).toBe(join(REPO, ".git"));
    expect(argv(calls)).toEqual([["git", "rev-parse", "--git-common-dir"]]);
    expect(calls[0]?.opts?.cwd).toBe(REPO);
  });

  test("keeps the absolute answer a linked worktree gives", async () => {
    // From a linked worktree git names the PARENT repo's git dir, which is
    // exactly the shared `worktrees/` directory the watcher wants.
    const { exec } = fakeExec(() => ok(`${join(REPO, ".git")}\n`));
    expect(await new CubedWorktrees(exec).gitCommonDir(join(REPO, "wt"))).toBe(
      join(REPO, ".git"),
    );
  });

  test("a directory that is not a repo answers null rather than throwing", async () => {
    // The caller runs unattended behind a filesystem watch: a throw here
    // would be an unhandled rejection, which exits cubed.
    const { exec } = fakeExec(() => fail("not a git repository"));
    expect(await new CubedWorktrees(exec).gitCommonDir(REPO)).toBeNull();
  });

  test("empty output answers null, not the repo root", async () => {
    const { exec } = fakeExec(() => ok("\n"));
    expect(await new CubedWorktrees(exec).gitCommonDir(REPO)).toBeNull();
  });
});

describe("CubedWorktrees.worktreesDir", () => {
  test("is realpath'd so a symlinked HOME compares equal to git's output", () => {
    const realRoot = tempDir();
    const link = join(tempDir(), "link");
    symlinkSync(realRoot, link);
    const { exec } = fakeExec(() => ok());
    expect(new CubedWorktrees(exec, link).worktreesDir).toBe(realpathSync(realRoot));
  });

  test("a root that does not exist yet resolves without throwing", () => {
    const { exec } = fakeExec(() => ok());
    expect(new CubedWorktrees(exec, ROOT).worktreesDir).toBe(ROOT);
  });
});

describe("CubedWorktrees timeouts", () => {
  const LONG_MS = 10 * 60_000;
  const timeouts = (calls: Call[]): (number | undefined)[] =>
    calls.map((c) => c.opts?.timeoutMs);

  test("only the data-moving commands get the long timeout", async () => {
    const { exec, calls } = fakeExec(() => ok());
    await new CubedWorktrees(exec).add({
      repoPath: REPO,
      path: WT,
      branch: "fix",
      source: { from: "new", baseBranch: "main" },
    });
    // fetch, prune, rev-parse, worktree add — the prune and the ref probe are
    // local reads and must not inherit the ten minutes the add needs.
    expect(timeouts(calls)).toEqual([LONG_MS, undefined, undefined, LONG_MS]);
  });

  test("the read commands run on the short default", async () => {
    const { exec, calls } = fakeExec(() => ok(""));
    const worktrees = new CubedWorktrees(exec, ROOT);
    await worktrees.list({ repoPath: REPO });
    await worktrees.prune({ repoPath: REPO });
    await worktrees.branches({ repoPath: REPO });
    await worktrees.repoInfo({ repoPath: REPO });
    for (const call of calls) expect(call.opts?.timeoutMs).toBeUndefined();
  });

  test("remove gets the long timeout", async () => {
    const listing = `worktree ${REPO}\nHEAD ${"0".repeat(40)}\nbranch refs/heads/main\n
worktree ${WT}\nHEAD ${"0".repeat(40)}\nbranch refs/heads/fix\n`;
    const { exec, calls } = fakeExec((_cmd, args) =>
      args[0] === "worktree" && args[1] === "list" ? ok(listing) : ok(),
    );
    await new CubedWorktrees(exec, ROOT).remove({ repoPath: REPO, path: WT });
    const removal = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "remove");
    expect(removal?.opts?.timeoutMs).toBe(LONG_MS);
  });
});

describe("CubedWorktrees.prune and exists", () => {
  test("prune runs git worktree prune in the repo", async () => {
    const { exec, calls } = fakeExec(() => ok());
    await new CubedWorktrees(exec).prune({ repoPath: REPO });
    expect(argv(calls)).toEqual([["git", "worktree", "prune"]]);
    expect(calls[0]?.opts?.cwd).toBe(REPO);
  });

  test("exists reports whether the directory is still on disk", () => {
    const root = tempDir();
    const { exec } = fakeExec(() => ok());
    const worktrees = new CubedWorktrees(exec, root);
    expect(worktrees.exists(root)).toBe(true);
    expect(worktrees.exists(join(root, "gone"))).toBe(false);
  });
});

describe("CubedWorktrees.remove", () => {
  // Every test in this block now needs `worktree list` to answer with a
  // listing that names the target, since `remove` validates against it
  // before doing anything else. One shared shape: REPO as the primary
  // checkout, the given path as a second, non-primary entry.
  const porcelain = (path: string): string =>
    [
      `worktree ${REPO}`,
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      `worktree ${path}`,
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/fix",
      "",
    ].join("\n");
  const listOr = (path: string, otherwise: (cmd: string, args: string[]) => ExecResult) =>
    (cmd: string, args: string[]) =>
      args[0] === "worktree" && args[1] === "list" ? ok(porcelain(path)) : otherwise(cmd, args);

  test("removes without --force by default, then prunes", async () => {
    const { exec, calls } = fakeExec(listOr(WT, () => ok()));
    await new CubedWorktrees(exec, ROOT).remove({ repoPath: REPO, path: WT });
    expect(argv(calls)).toContainEqual(["git", "worktree", "remove", WT]);
    expect(argv(calls)).toContainEqual(["git", "worktree", "prune"]);
    for (const call of calls) expect(call.opts?.cwd).toBe(REPO);
  });

  test("force is passed only when asked", async () => {
    const { exec, calls } = fakeExec(listOr(WT, () => ok()));
    await new CubedWorktrees(exec, ROOT).remove({ repoPath: REPO, path: WT, force: true });
    expect(argv(calls)).toContainEqual(["git", "worktree", "remove", "--force", WT]);
  });

  test("an unforced removal git refuses surfaces the refusal", async () => {
    const { exec } = fakeExec(listOr(WT, () => fail("contains modified or untracked files")));
    const promise = new CubedWorktrees(exec, ROOT).remove({ repoPath: REPO, path: WT });
    await expect(promise).rejects.toThrow(/modified or untracked/);
  });

  test("remove throws when a forced remove exits non-zero", async () => {
    const { exec } = fakeExec(
      listOr(WT, (_cmd, args) => (args.includes("remove") ? fail("locked") : ok())),
    );
    const promise = new CubedWorktrees(exec, ROOT).remove({
      repoPath: REPO,
      path: WT,
      force: true,
    });
    await expect(promise).rejects.toThrow(/locked/);
  });

  test("removes a worktree git lists, even outside the managed root", async () => {
    const base = tempDir();
    const repo = join(base, "repo");
    const outside = join(base, "elsewhere", "feature");
    mkdirSync(outside, { recursive: true });
    const { exec, calls } = fakeExec((_cmd, args) =>
      args[0] === "worktree" && args[1] === "list"
        ? ok(`worktree ${repo}\nHEAD ${"0".repeat(40)}\nbranch refs/heads/main\n
worktree ${outside}\nHEAD ${"0".repeat(40)}\nbranch refs/heads/feature\n`)
        : ok(),
    );
    const worktrees = new CubedWorktrees(exec, join(base, "managed"));
    await worktrees.remove({ repoPath: repo, path: outside });
    expect(argv(calls)).toContainEqual(["git", "worktree", "remove", outside]);
  });

  test("refuses a path git does not list for that repo", async () => {
    const base = tempDir();
    const repo = join(base, "repo");
    const { exec } = fakeExec((_cmd, args) =>
      args[0] === "worktree" && args[1] === "list"
        ? ok(`worktree ${repo}\nHEAD ${"0".repeat(40)}\nbranch refs/heads/main\n`)
        : ok(),
    );
    const worktrees = new CubedWorktrees(exec, join(base, "managed"));
    await expect(
      worktrees.remove({ repoPath: repo, path: join(base, "not-a-worktree") }),
    ).rejects.toThrow(/not a worktree of/);
  });

  test("refuses the repo's primary checkout", async () => {
    const base = tempDir();
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    const { exec } = fakeExec((_cmd, args) =>
      args[0] === "worktree" && args[1] === "list"
        ? ok(`worktree ${repo}\nHEAD ${"0".repeat(40)}\nbranch refs/heads/main\n`)
        : ok(),
    );
    const worktrees = new CubedWorktrees(exec, join(base, "managed"));
    await expect(worktrees.remove({ repoPath: repo, path: repo })).rejects.toThrow(
      /primary checkout/,
    );
  });

  test("runs the precondition listing on the long timeout", async () => {
    const base = tempDir();
    const repo = join(base, "repo");
    const wt = join(base, "wt");
    mkdirSync(wt, { recursive: true });
    const { exec, calls } = fakeExec((_cmd, args) =>
      args[0] === "worktree" && args[1] === "list"
        ? ok(`worktree ${repo}\nHEAD ${"0".repeat(40)}\nbranch refs/heads/main\n
worktree ${wt}\nHEAD ${"0".repeat(40)}\nbranch refs/heads/wt\n`)
        : ok(),
    );
    const worktrees = new CubedWorktrees(exec, join(base, "managed"));
    await worktrees.remove({ repoPath: repo, path: wt });
    const listing = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "list");
    expect(listing?.opts?.timeoutMs).toBe(10 * 60_000);
  });

  // These two use a REAL temp directory rather than a fake path, deliberately:
  // the git-records check calls realpathSync/existsSync against the actual
  // filesystem, and a fake, never-created target would skip that machinery
  // entirely — which would hide a regression where the check itself deletes
  // the target before git's own worktree remove ever runs. Only a root and
  // target that actually exist on disk can catch that.
  describe("against a real temp directory", () => {
    test("an unforced removal git refuses leaves the directory untouched", async () => {
      const root = tempDir();
      const wt = join(root, "fix");
      mkdirSync(wt);
      const keep = join(wt, "keep.txt");
      writeFileSync(keep, "uncommitted work");

      const { exec } = fakeExec(listOr(wt, () => fail("contains modified or untracked files")));
      const promise = new CubedWorktrees(exec, root).remove({ repoPath: REPO, path: wt });
      await expect(promise).rejects.toThrow(/modified or untracked/);

      expect(existsSync(wt)).toBe(true);
      expect(existsSync(keep)).toBe(true);
    });

    test("force passes --force to git rather than deleting in the git-records check", async () => {
      const root = tempDir();
      const wt = join(root, "fix");
      mkdirSync(wt);
      writeFileSync(join(wt, "keep.txt"), "uncommitted work");

      const { exec, calls } = fakeExec(listOr(wt, () => ok()));
      await new CubedWorktrees(exec, root).remove({ repoPath: REPO, path: wt, force: true });

      expect(argv(calls)).toContainEqual(["git", "worktree", "remove", "--force", wt]);
      expect(existsSync(wt)).toBe(true);
    });
  });
});

// Real temp directories throughout: what is under test is what lands on disk,
// and no exec is involved — `copyFiles` is the one operation in this class
// that does its own filesystem work rather than driving git.
describe("CubedWorktrees.copyFiles", () => {
  interface Pair {
    repo: string;
    worktree: string;
    worktrees: CubedWorktrees;
  }

  function pair(): Pair {
    const base = tempDir();
    const repo = join(base, "repo");
    const worktree = join(base, "worktrees", "repo", "fix");
    mkdirSync(repo, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    const { exec } = fakeExec(() => ok());
    return { repo, worktree, worktrees: new CubedWorktrees(exec, join(base, "worktrees")) };
  }

  test("copies each listed file into the worktree", async () => {
    const { repo, worktree, worktrees } = pair();
    writeFileSync(join(repo, ".env"), "TOKEN=1");
    writeFileSync(join(repo, ".envrc"), "use flake");

    const { failures } = await worktrees.copyFiles({
      repoPath: repo,
      path: worktree,
      entries: [".env", ".envrc"],
    });

    expect(failures).toEqual([]);

    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("TOKEN=1");
    expect(readFileSync(join(worktree, ".envrc"), "utf8")).toBe("use flake");
  });

  test("creates the destination's parent directories", async () => {
    const { repo, worktree, worktrees } = pair();
    mkdirSync(join(repo, "config", "local"), { recursive: true });
    writeFileSync(join(repo, "config", "local", "dev.json"), "{}");

    await worktrees.copyFiles({
      repoPath: repo,
      path: worktree,
      entries: ["config/local/dev.json"],
    });

    expect(readFileSync(join(worktree, "config", "local", "dev.json"), "utf8")).toBe("{}");
  });

  test("copies a directory entry with its contents", async () => {
    const { repo, worktree, worktrees } = pair();
    mkdirSync(join(repo, "secrets"), { recursive: true });
    writeFileSync(join(repo, "secrets", "a.pem"), "key");

    await worktrees.copyFiles({ repoPath: repo, path: worktree, entries: ["secrets"] });

    expect(readFileSync(join(worktree, "secrets", "a.pem"), "utf8")).toBe("key");
  });

  test("overwrites a file the checkout already has", async () => {
    const { repo, worktree, worktrees } = pair();
    writeFileSync(join(repo, "local.json"), "parent");
    writeFileSync(join(worktree, "local.json"), "committed");

    await worktrees.copyFiles({ repoPath: repo, path: worktree, entries: ["local.json"] });

    expect(readFileSync(join(worktree, "local.json"), "utf8")).toBe("parent");
  });

  test("a missing source is skipped silently and the rest still copy", async () => {
    const { repo, worktree, worktrees } = pair();
    writeFileSync(join(repo, ".env"), "TOKEN=1");

    await worktrees.copyFiles({
      repoPath: repo,
      path: worktree,
      entries: ["nope.json", ".env", "also/missing"],
    });

    expect(existsSync(join(worktree, "nope.json"))).toBe(false);
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("TOKEN=1");
  });

  test("an empty entry list touches nothing", async () => {
    const { repo, worktree, worktrees } = pair();
    const { failures } = await worktrees.copyFiles({ repoPath: repo, path: worktree, entries: [] });
    expect(failures).toEqual([]);
    expect(readdirSync(worktree)).toEqual([]);
  });

  test("a `~` entry is a literal directory name, not the home directory", async () => {
    const { repo, worktree, worktrees } = pair();
    const { failures } = await worktrees.copyFiles({
      repoPath: repo,
      path: worktree,
      entries: ["~/.env"],
    });
    // Nothing at `<repo>/~/.env`, so it is absent rather than refused.
    expect(failures).toEqual([]);
    expect(readdirSync(worktree)).toEqual([]);
  });

  // A repo whose `.env` is a symlink into the user's secrets store is a
  // normal convention, and is exactly the file this feature exists to carry.
  // The check on the source is therefore lexical, and the copy dereferences.
  test("copies through a symlink whose target is outside the repository", async () => {
    const { repo, worktree, worktrees } = pair();
    const secrets = join(tempDir(), "app.env");
    writeFileSync(secrets, "TOKEN=from-outside");
    symlinkSync(secrets, join(repo, ".env"));

    const { failures } = await worktrees.copyFiles({
      repoPath: repo,
      path: worktree,
      entries: [".env"],
    });

    expect(failures).toEqual([]);
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("TOKEN=from-outside");
    // The contents, not the link: a copied link would break if the target moved.
    expect(lstatSync(join(worktree, ".env")).isSymbolicLink()).toBe(false);
  });

  test("a broken symlink is skipped like any other missing source", async () => {
    const { repo, worktree, worktrees } = pair();
    symlinkSync(join(tempDir(), "gone.env"), join(repo, ".env"));

    const { failures } = await worktrees.copyFiles({
      repoPath: repo,
      path: worktree,
      entries: [".env"],
    });

    expect(failures).toEqual([]);
    expect(readdirSync(worktree)).toEqual([]);
  });

  describe("refusals are reported, never thrown, and never stop the list", () => {
    test("an entry that escapes the repository is refused, its neighbours still copy", async () => {
      const { repo, worktree, worktrees } = pair();
      writeFileSync(join(repo, ".env"), "TOKEN=1");
      writeFileSync(join(repo, "..", "outside.txt"), "secret");

      const { failures } = await worktrees.copyFiles({
        repoPath: repo,
        path: worktree,
        entries: ["../outside.txt", ".env"],
      });

      expect(failures).toHaveLength(1);
      expect(failures[0]?.entry).toBe("../outside.txt");
      expect(failures[0]?.error).toMatch(/outside the repository/);
      expect(existsSync(join(worktree, "outside.txt"))).toBe(false);
      expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("TOKEN=1");
    });

    test("an absolute entry is refused", async () => {
      const { repo, worktree, worktrees } = pair();
      const { failures } = await worktrees.copyFiles({
        repoPath: repo,
        path: worktree,
        entries: ["/etc/hosts"],
      });
      expect(failures[0]?.error).toMatch(/outside the repository/);
    });

    test("an entry naming the repository root itself is refused", async () => {
      const { repo, worktree, worktrees } = pair();
      const { failures } = await worktrees.copyFiles({
        repoPath: repo,
        path: worktree,
        entries: ["."],
      });
      expect(failures[0]?.error).toMatch(/outside the repository/);
    });

    // The destination check IS symlink-aware, unlike the source one: a
    // worktree carrying `cfg -> /outside` would otherwise let a committed
    // config write straight through it.
    test("a destination reached through a symlinked directory is refused", async () => {
      const { repo, worktree, worktrees } = pair();
      const outside = tempDir();
      mkdirSync(join(repo, "cfg"), { recursive: true });
      writeFileSync(join(repo, "cfg", "x.txt"), "payload");
      symlinkSync(outside, join(worktree, "cfg"));

      const { failures } = await worktrees.copyFiles({
        repoPath: repo,
        path: worktree,
        entries: ["cfg/x.txt"],
      });

      expect(failures).toHaveLength(1);
      expect(failures[0]?.error).toMatch(/outside the worktree/);
      expect(existsSync(join(outside, "x.txt"))).toBe(false);
    });
  });

  test("an unreadable source is reported without stopping the list", async () => {
    const { repo, worktree, worktrees } = pair();
    // A directory where the entry claims a file, copied non-recursively by
    // naming it through a child that does not exist: EACCES is not reliably
    // reproducible as an unprivileged user, so this stands in for "cpSync
    // itself failed" — the entry resolves to an existing path whose copy
    // cannot succeed.
    mkdirSync(join(repo, "a"), { recursive: true });
    writeFileSync(join(repo, ".env"), "TOKEN=1");
    writeFileSync(join(worktree, "a"), "a file where the entry wants a directory");

    const { failures } = await worktrees.copyFiles({
      repoPath: repo,
      path: worktree,
      entries: ["a", ".env"],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.entry).toBe("a");
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("TOKEN=1");
  });
});

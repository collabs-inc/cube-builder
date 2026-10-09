import { expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CubedClones } from "./clones";
import { CubedRepoPublisher } from "./repo-publish";
import type { ExecCommand } from "./exec";

const target = { repoId: "repo", owner: "alice", name: "coffee", visibility: "private" as const };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "publish-"));
  const repo = await new CubedClones({ reposDir: dir }).create({ name: "coffee" });
  const real: ExecCommand = async (cmd, args, opts) => {
    if (cmd !== "git") throw new Error("Denied external command");
    try {
      return { ok: true, stdout: execFileSync(cmd, args, { cwd: opts?.cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }), stderr: "" };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return { ok: false, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? "") };
    }
  };
  const calls: { cmd: string; args: string[]; stdin?: string }[] = [];
  let failPush = false;
  let refuseCreate = false;
  let failReceipt = false;
  let remoteVisibility = "private";
  const exec: ExecCommand = async (cmd, args, opts) => {
    calls.push({ cmd, args, ...(opts?.stdin ? { stdin: opts.stdin } : {}) });
    if (cmd === "gh") {
      if (args.includes("POST") && refuseCreate) return { ok: false, stdout: "", stderr: "name already exists" };
      const stdout = args.includes("repos/alice/coffee") ? JSON.stringify({ full_name: "alice/coffee", visibility: remoteVisibility, permissions: { push: true } })
        : args.includes("user") ? JSON.stringify({ login: "alice", id: 1, name: "Alice" })
        : args.includes("--slurp") ? JSON.stringify([[{ login: "team" }], [{ login: "other" }]]) : "{}";
      return { ok: true, stdout, stderr: "" };
    }
    // Never allow these tests to touch the developer's global Git config.
    if (args.includes("--global")) return { ok: true, stdout: "configured", stderr: "" };
    if (failReceipt && args.includes("cube.publish-receipt") && !args.includes("--get")) {
      failReceipt = false;
      return { ok: false, stdout: "", stderr: "config locked" };
    }
    if (args.includes("push")) return { ok: !failPush, stdout: "", stderr: failPush ? "push rejected" : "" };
    return real(cmd, args, opts);
  };
  return { dir, repo, real, exec, calls, failPush: () => { failPush = true; }, allowPush: () => { failPush = false; }, refuseCreate: () => { refuseCreate = true; }, failReceipt: () => { failReceipt = true; }, visibility: (value: string) => { remoteVisibility = value; } };
}

test("publishes private committed branch, and retries failed pushes across publisher restarts", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo.repoPath, "secret.env"), "must stay untracked");
    f.failPush();
    await expect(new CubedRepoPublisher(f.exec).publish(f.repo.repoPath, target)).rejects.toThrow("push rejected");
    f.allowPush();
    expect(await new CubedRepoPublisher(f.exec).publish(f.repo.repoPath, target)).toEqual({ url: "https://github.com/alice/coffee" });
    const posts = f.calls.filter(c => c.args.includes("POST"));
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.stdin!)).toEqual({ name: "coffee", private: true, auto_init: false });
    const pushes = f.calls.filter(c => c.args.includes("push"));
    expect(pushes[0]!.args).toContain("refs/heads/main:refs/heads/main");
    expect(pushes[0]!.args).not.toContain("--force");
    expect((await f.real("git", ["status", "--porcelain"], { cwd: f.repo.repoPath })).stdout).toContain("?? secret.env");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("organization publication and paginated owners", async () => {
  const f = await fixture();
  try {
    const publisher = new CubedRepoPublisher(f.exec);
    expect((await publisher.owners()).owners.map(o => o.login)).toEqual(["alice", "team", "other"]);
    await publisher.publish(f.repo.repoPath, { ...target, owner: "team", visibility: "public" });
    const post = f.calls.find(c => c.args.includes("POST"))!;
    expect(post.args).toContain("orgs/team/repos");
    expect(JSON.parse(post.stdin!).private).toBe(false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("rejects a relative push destination that collides with the GitHub remote normalizer", async () => {
  const f = await fixture();
  try {
    const cwd = f.repo.repoPath;
    const destination = "github.com/alice/coffee";
    const git = (args: string[]) => f.real("git", args, { cwd });
    expect((await git(["init", "--bare", destination])).ok).toBe(true);
    await git(["remote", "add", "origin", "https://github.com/alice/coffee.git"]);
    await git(["config", "remote.origin.pushurl", destination]);
    const exec: ExecCommand = async (cmd, args, opts) => {
      if (cmd === "gh" || (cmd === "git" && args.includes("--global"))) return f.exec(cmd, args, opts);
      if (cmd !== "git") throw new Error("Denied external command");
      if (args.includes("push")) {
        const effective = await git(["remote", "get-url", "--push", "--all", "origin"]);
        if (effective.stdout.trim() !== destination) throw new Error("Denied nonfixture push");
      }
      return git(args);
    };
    let rejected = false;
    try { await new CubedRepoPublisher(exec).publish(cwd, { ...target, useExisting: true }); }
    catch (error) { expect(String(error)).toContain("push destination"); rejected = true; }
    expect((await git(["--git-dir", destination, "rev-parse", "--verify", "refs/heads/main"])).ok).toBe(false);
    expect(rejected).toBe(true);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

for (const remote of ["github.com/alice/coffee", "file://github.com/alice/coffee", "http://github.com/alice/coffee", "https://github.com.evil.test/alice/coffee", "https://github.com/alice/coffee?redirect=other", "https://github.com/alice/../coffee"]) {
  test(`rejects noncanonical GitHub push transport ${remote}`, async () => {
    const f = await fixture();
    try {
      const cwd = f.repo.repoPath;
      await f.real("git", ["remote", "add", "origin", "https://github.com/alice/coffee.git"], { cwd });
      await f.real("git", ["config", "remote.origin.pushurl", remote], { cwd });
      await expect(new CubedRepoPublisher(f.exec).publish(cwd, { ...target, useExisting: true })).rejects.toThrow("push destination");
      expect(f.calls.some(call => call.args.includes("push"))).toBe(false);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}

for (const remote of ["https://github.com/Alice/Coffee.git", "git@github.com:alice/coffee.git", "ssh://git@github.com/alice/coffee.git", "ssh://git@github.com:22/alice/coffee.git"]) {
  test(`retains normal GitHub transport ${remote}`, async () => {
    const f = await fixture();
    try {
      await f.real("git", ["remote", "add", "origin", remote], { cwd: f.repo.repoPath });
      expect(await new CubedRepoPublisher(f.exec).publish(f.repo.repoPath, { ...target, useExisting: true })).toEqual({ url: "https://github.com/alice/coffee" });
      expect(f.calls.some(call => call.args.includes("push"))).toBe(true);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}

for (const [label, remote] of [
  ["HTTPS username", "https://fixture-user@github.com/alice/coffee.git"],
  ["HTTPS userinfo", "https://fixture-user:fixture-password@github.com/alice/coffee.git"],
  ["HTTPS explicit default port", "https://github.com:443/alice/coffee.git"],
] as const) {
  test(`retains an existing ${label} origin across publication retry`, async () => {
    const f = await fixture();
    try {
      await f.real("git", ["remote", "add", "origin", remote], { cwd: f.repo.repoPath });
      f.failPush();
      await expect(new CubedRepoPublisher(f.exec).publish(f.repo.repoPath, { ...target, useExisting: true })).rejects.toThrow("push rejected");
      f.allowPush();
      expect(await new CubedRepoPublisher(f.exec).publish(f.repo.repoPath, target)).toEqual({ url: "https://github.com/alice/coffee" });
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}

for (const mode of ["pushurl", "multiple", "insteadOf", "pushInsteadOf", "retry"] as const) {
  test(`rejects unchecked effective push destination (${mode}) before any commit arrives`, async () => {
    const f = await fixture();
    try {
      const cwd = f.repo.repoPath;
      const destination = join(f.dir, "unchecked.git");
      const git = (args: string[]) => f.real("git", args, { cwd });
      await git(["init", "--bare", destination]);
      await git(["remote", "add", "origin", "https://github.com/alice/coffee.git"]);
      if (mode === "multiple") await git(["config", "--add", "remote.origin.pushurl", "https://github.com/alice/coffee.git"]);
      if (mode === "insteadOf" || mode === "pushInsteadOf") {
        await git(["config", `url.${destination}.${mode}`, "https://github.com/alice/coffee.git"]);
      } else await git(["config", "--add", "remote.origin.pushurl", destination]);
      if (mode === "retry") await git(["config", "cube.publish-receipt", JSON.stringify({ remote: "https://github.com/alice/coffee.git", visibility: "private" })]);
      // Real Git for all commands including push; GitHub metadata alone is mocked.
      let attemptedPush = false;
      const exec: ExecCommand = async (cmd, args, opts) => {
        if (cmd === "gh" || args.includes("--global")) return f.exec(cmd, args, opts);
        if (args.includes("push")) {
          attemptedPush = true;
          const effective = (await git(["remote", "get-url", "--push", "--all", "origin"])).stdout.trim();
          if (effective !== destination) throw new Error("Denied nonfixture push destination");
        }
        return f.real(cmd, args, opts);
      };
      await expect(new CubedRepoPublisher(exec).publish(cwd, { ...target, useExisting: true })).rejects.toThrow("push destination");
      expect(attemptedPush).toBe(false);
      expect((await git(["--git-dir", destination, "rev-parse", "--verify", "refs/heads/main"])).ok).toBe(false);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}

test("conflicts and invalid targets never overwrite a remote or alter the checkout", async () => {
  const f = await fixture();
  try {
    const publisher = new CubedRepoPublisher(f.exec);
    await expect(publisher.publish(f.repo.repoPath, { ...target, name: "../oops" })).rejects.toThrow("valid");
    f.refuseCreate();
    await expect(publisher.publish(f.repo.repoPath, target)).rejects.toThrow("name already exists");
    expect((await f.real("git", ["remote"], { cwd: f.repo.repoPath })).stdout.trim()).toBe("");
    await f.real("git", ["remote", "add", "origin", "https://github.com/someone/existing.git"], { cwd: f.repo.repoPath });
    await expect(publisher.publish(f.repo.repoPath, target)).rejects.toThrow("already has an origin");
    expect((await f.real("git", ["remote", "get-url", "origin"], { cwd: f.repo.repoPath })).stdout.trim()).toBe("https://github.com/someone/existing.git");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("explicit recovery can connect the remote after the receipt could not be saved", async () => {
  const f = await fixture();
  try {
    f.failReceipt();
    await expect(new CubedRepoPublisher(f.exec).publish(f.repo.repoPath, target)).rejects.toThrow("config locked");
    expect((await f.real("git", ["remote"], { cwd: f.repo.repoPath })).stdout.trim()).toBe("");
    await new CubedRepoPublisher(f.exec).publish(f.repo.repoPath, { ...target, useExisting: true });
    expect(f.calls.filter(c => c.args.includes("POST"))).toHaveLength(1);
    const receipt = await f.real("git", ["config", "--local", "--get", "cube.publish-receipt"], { cwd: f.repo.repoPath });
    expect(JSON.parse(receipt.stdout)).toEqual({ remote: "https://github.com/alice/coffee.git", visibility: "private" });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("recovery checks visibility before touching origin, including organization internal repos", async () => {
  const f = await fixture();
  try {
    const publisher = new CubedRepoPublisher(f.exec);
    for (const visibility of ["public", "internal"]) {
      f.visibility(visibility);
      await expect(publisher.publish(f.repo.repoPath, { ...target, useExisting: true })).rejects.toThrow("different visibility");
      expect((await f.real("git", ["remote"], { cwd: f.repo.repoPath })).stdout.trim()).toBe("");
    }
    expect(f.calls.some(c => c.args.includes("push") || c.args.includes("POST"))).toBe(false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

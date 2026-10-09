import { describe, expect, test } from "vitest";
import { CubedGithub } from "./github";
import type { ExecCommand, ExecResult } from "./exec";

interface Call {
  cmd: string;
  args: string[];
  opts?: { cwd?: string };
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
const enoent = (): ExecResult => ({ ok: false, stdout: "", stderr: "", enoent: true });

const REPO = "/home/u/repos/cube-computer";
const USER_JSON = JSON.stringify({ login: "octocat", name: "Mona Lisa", id: 1 });

/** Signed-in exec: auth probes succeed, the caller's script handles the rest. */
function signedIn(script: (cmd: string, args: string[]) => ExecResult) {
  return fakeExec((cmd, args) => {
    if (cmd === "gh" && args[0] === "auth") return ok();
    if (cmd === "gh" && args[0] === "api" && args[1] === "user") return ok(USER_JSON);
    if (cmd === "git") return ok();
    return script(cmd, args);
  });
}

describe("CubedGithub.listPrs", () => {
  test("requests the fields the dialog renders", async () => {
    const { exec, calls } = signedIn(() => ok("[]"));
    await new CubedGithub(exec).listPrs({ repoPath: REPO });
    expect(argv(calls)).toContainEqual([
      "gh", "pr", "list",
      "--state", "open", "--limit", "100",
      "--json", "number,title,url,headRefName,isCrossRepository",
    ]);
  });

  test("gh runs with cwd = repoPath and no -R", async () => {
    const { exec, calls } = signedIn(() => ok("[]"));
    await new CubedGithub(exec).listPrs({ repoPath: REPO });
    const listCall = calls.find((c) => c.cmd === "gh" && c.args[1] === "list");
    expect(listCall?.opts?.cwd).toBe(REPO);
    expect(listCall?.args).not.toContain("-R");
    for (const call of calls) expect(call.args).not.toContain(REPO);
  });

  test("parses the PR list", async () => {
    const payload = JSON.stringify([
      {
        number: 412,
        title: "Retry OAuth token refresh on 401",
        url: "https://github.com/o/r/pull/412",
        headRefName: "fix-oauth-retry",
        isCrossRepository: false,
      },
    ]);
    const { exec } = signedIn((cmd, args) => (args[1] === "list" ? ok(payload) : ok()));
    const result = await new CubedGithub(exec).listPrs({ repoPath: REPO });
    expect(result.prs).toEqual([
      {
        number: 412,
        title: "Retry OAuth token refresh on 401",
        url: "https://github.com/o/r/pull/412",
        headRefName: "fix-oauth-retry",
        isCrossRepository: false,
      },
    ]);
  });

  test("signed out throws the same reason github:auth-status reports", async () => {
    const { exec } = fakeExec((cmd, args) =>
      cmd === "gh" && args[0] === "auth" && args[1] === "status" ? fail("not logged in") : ok(),
    );
    await expect(new CubedGithub(exec).listPrs({ repoPath: REPO })).rejects.toThrow(
      "not signed in",
    );
  });

  test("gh missing throws the install reason", async () => {
    const { exec } = fakeExec(() => enoent());
    await expect(new CubedGithub(exec).listPrs({ repoPath: REPO })).rejects.toThrow(
      "gh is not installed on this machine",
    );
  });

  test("malformed JSON throws rather than yielding a silently empty list", async () => {
    const { exec } = signedIn((cmd, args) => (args[1] === "list" ? ok("not json") : ok()));
    await expect(new CubedGithub(exec).listPrs({ repoPath: REPO })).rejects.toThrow(
      /could not read/,
    );
  });
});

describe("CubedGithub.listIssues", () => {
  test("parses the issue list", async () => {
    const payload = JSON.stringify([
      {
        number: 88,
        title: "OAuth refresh loops on expired device code",
        url: "https://github.com/o/r/issues/88",
      },
    ]);
    const { exec, calls } = signedIn((cmd, args) => (args[1] === "list" ? ok(payload) : ok()));
    const result = await new CubedGithub(exec).listIssues({ repoPath: REPO });
    expect(result.issues).toEqual([
      {
        number: 88,
        title: "OAuth refresh loops on expired device code",
        url: "https://github.com/o/r/issues/88",
      },
    ]);
    expect(calls.find((c) => c.args[0] === "issue")?.opts?.cwd).toBe(REPO);
  });
});

describe("CubedGithub.resolve", () => {
  test("resolves a single PR by number", async () => {
    const payload = JSON.stringify({
      number: 412,
      title: "Retry OAuth token refresh on 401",
      url: "https://github.com/o/r/pull/412",
      headRefName: "fix-oauth-retry",
      isCrossRepository: true,
    });
    const { exec, calls } = signedIn((cmd, args) => (args[1] === "view" ? ok(payload) : ok()));
    const result = await new CubedGithub(exec).resolve({
      repoPath: REPO,
      kind: "pr",
      number: 412,
    });
    expect(argv(calls)).toContainEqual([
      "gh", "pr", "view", "412",
      "--json", "number,title,url,headRefName,isCrossRepository",
    ]);
    expect(calls.find((c) => c.args[1] === "view")?.opts?.cwd).toBe(REPO);
    expect(result).toEqual({
      kind: "pr",
      pr: {
        number: 412,
        title: "Retry OAuth token refresh on 401",
        url: "https://github.com/o/r/pull/412",
        headRefName: "fix-oauth-retry",
        isCrossRepository: true,
      },
    });
  });

  test("a number that does not exist throws gh's message", async () => {
    const { exec } = signedIn((cmd, args) =>
      args[1] === "view" ? fail("could not find pull request") : ok(),
    );
    await expect(
      new CubedGithub(exec).resolve({ repoPath: REPO, kind: "pr", number: 9999 }),
    ).rejects.toThrow(/could not find pull request/);
  });
});

import { describe, expect, test } from "vitest";
import { CubedGithubAuth, type ExecCommand, type ExecResult } from "./github-auth";

function fakeExec(
  script: (cmd: string, args: string[]) => ExecResult,
): { exec: ExecCommand; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecCommand = (cmd, args) => {
    calls.push([cmd, ...args]);
    return Promise.resolve(script(cmd, args));
  };
  return { exec, calls };
}

const ok = (stdout = ""): ExecResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr = ""): ExecResult => ({ ok: false, stdout: "", stderr });
const enoent = (): ExecResult => ({ ok: false, stdout: "", stderr: "", enoent: true });

const USER_JSON = JSON.stringify({ login: "octocat", name: "Mona Lisa", id: 583231 });

describe("CubedGithubAuth.seed", () => {
  test("pipes the token to gh auth login over stdin, then reports status", async () => {
    const stdins: (string | undefined)[] = [];
    const { exec } = fakeExec((cmd, args) => {
      if (cmd === "gh" && args[0] === "api") return ok(USER_JSON);
      return ok();
    });
    const spying: ExecCommand = (cmd, args, opts) => {
      if (cmd === "gh" && args[1] === "login") stdins.push(opts?.stdin);
      return exec(cmd, args, opts);
    };
    const result = await new CubedGithubAuth(spying).seed("gho_secret");
    expect(result).toEqual({ authenticated: true, login: "octocat" });
    expect(stdins).toEqual(["gho_secret"]);
  });

  test("a rejected token reports not signed in, never throws", async () => {
    const { exec } = fakeExec((cmd, args) =>
      cmd === "gh" && args[1] === "login" ? fail("error validating token") : ok(),
    );
    const result = await new CubedGithubAuth(exec).seed("gho_bad");
    expect(result).toEqual({ authenticated: false, reason: "not signed in" });
  });

  test("gh missing reports the install reason", async () => {
    const { exec } = fakeExec((cmd) => (cmd === "gh" ? enoent() : ok()));
    const result = await new CubedGithubAuth(exec).seed("gho_x");
    expect(result).toEqual({
      authenticated: false,
      reason: "gh is not installed on this machine",
    });
  });

  test("a non-string token is rejected without ever spawning gh", async () => {
    const { exec, calls } = fakeExec(() => ok());
    await expect(new CubedGithubAuth(exec).seed(42)).rejects.toThrow(
      "github:seed needs a token",
    );
    expect(calls).toEqual([]);
  });
});

describe("CubedGithubAuth.status", () => {
  test("gh missing reports an install problem, not 'not signed in'", async () => {
    const { exec } = fakeExec((cmd) => (cmd === "gh" ? enoent() : ok()));
    const result = await new CubedGithubAuth(exec).status();
    expect(result).toEqual({
      authenticated: false,
      reason: "gh is not installed on this machine",
    });
  });

  test("signed out reports not signed in and never touches git config", async () => {
    const { exec, calls } = fakeExec((cmd, args) =>
      cmd === "gh" && args[0] === "auth" && args[1] === "status" ? fail("not logged in") : ok(),
    );
    const result = await new CubedGithubAuth(exec).status();
    expect(result).toEqual({ authenticated: false, reason: "not signed in" });
    expect(calls.some(([cmd]) => cmd === "git")).toBe(false);
  });

  test("signed in repairs setup-git and unset identity from the gh profile", async () => {
    const { exec, calls } = fakeExec((cmd, args) => {
      if (cmd === "gh" && args[0] === "api") return ok(USER_JSON);
      if (cmd === "git" && args[2] === "user.name" && args.length === 3) return fail();
      if (cmd === "git" && args[2] === "user.email" && args.length === 3) return fail();
      return ok();
    });
    const result = await new CubedGithubAuth(exec).status();
    expect(result).toEqual({ authenticated: true, login: "octocat" });
    expect(calls).toContainEqual(["gh", "auth", "setup-git", "--hostname", "github.com"]);
    expect(calls).toContainEqual(["git", "config", "--global", "user.name", "Mona Lisa"]);
    expect(calls).toContainEqual([
      "git", "config", "--global", "user.email", "583231+octocat@users.noreply.github.com",
    ]);
  });

  test("already-set identity is never overwritten", async () => {
    const { exec, calls } = fakeExec((cmd, args) => {
      if (cmd === "gh" && args[0] === "api") return ok(USER_JSON);
      if (cmd === "git" && args[2] === "user.name" && args.length === 3) return ok("Existing Name\n");
      if (cmd === "git" && args[2] === "user.email" && args.length === 3) return ok("me@example.com\n");
      return ok();
    });
    await new CubedGithubAuth(exec).status();
    const writes = calls.filter(([cmd, , , key]) => cmd === "git" && key !== undefined);
    expect(writes.filter((c) => c.length === 5)).toEqual([]);
  });

  test("a null profile name falls back to the login", async () => {
    const { exec, calls } = fakeExec((cmd, args) => {
      if (cmd === "gh" && args[0] === "api")
        return ok(JSON.stringify({ login: "octocat", name: null, id: 583231 }));
      if (cmd === "git" && args.length === 3) return fail();
      return ok();
    });
    await new CubedGithubAuth(exec).status();
    expect(calls).toContainEqual(["git", "config", "--global", "user.name", "octocat"]);
  });

  test("a failed profile fetch still reports authenticated, skips identity repair", async () => {
    const { exec, calls } = fakeExec((cmd, args) => {
      if (cmd === "gh" && args[0] === "api") return fail("network");
      return ok();
    });
    const result = await new CubedGithubAuth(exec).status();
    expect(result).toEqual({ authenticated: true });
    expect(calls).toContainEqual(["gh", "auth", "setup-git", "--hostname", "github.com"]);
    expect(calls.some(([cmd]) => cmd === "git")).toBe(false);
  });
});

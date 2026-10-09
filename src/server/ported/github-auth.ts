// GitHub-readiness for the machine, as one check-and-repair op: every
// status() call that finds the user signed in also leaves git's credential
// helper configured and git identity set, so no caller anywhere has to
// know when a login "finished" — the next check repairs whatever the login
// made possible. Signed out (or gh missing) is reported, never thrown:
// it's an expected state the Add Repo modal renders, not an error.
import type { GithubAuthStatus } from "@port/shared/types";
import { makeExec, type ExecCommand, type ExecResult } from "./exec";

export type { ExecCommand, ExecResult };

const EXEC_TIMEOUT_MS = 30_000;

const defaultExec: ExecCommand = makeExec({ timeoutMs: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 });

interface GhUser {
  login: string;
  name: string | null;
  id: number;
}

export class CubedGithubAuth {
  private readonly exec: ExecCommand;

  constructor(exec: ExecCommand = defaultExec) {
    this.exec = exec;
  }

  async status(): Promise<GithubAuthStatus> {
    const auth = await this.exec("gh", ["auth", "status", "--hostname", "github.com"]);
    if (auth.enoent) {
      return { authenticated: false, reason: "gh is not installed on this machine" };
    }
    if (!auth.ok) return { authenticated: false, reason: "not signed in" };

    // Idempotent: (re)writes the gh credential helper into global git
    // config, so plain `git push`/`fetch` authenticate, not just `gh`.
    await this.exec("gh", ["auth", "setup-git", "--hostname", "github.com"]);

    const profile = await this.exec("gh", ["api", "user"]);
    if (!profile.ok) return { authenticated: true };
    let user: GhUser;
    try {
      user = JSON.parse(profile.stdout) as GhUser;
    } catch {
      return { authenticated: true };
    }

    await this.repairIdentity(user);
    return { authenticated: true, login: user.login };
  }

  /**
   * Writes the given OAuth token as gh's credential (stdin, never argv —
   * argv is visible in `ps`), then runs the same check-and-repair as
   * status(). A rejected token is data, not an exception — the caller
   * (reconciler or the ensure Edge Function) routes on `authenticated`.
   * The token itself must never appear in any error or log line.
   */
  async seed(token: unknown): Promise<GithubAuthStatus> {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("github:seed needs a token");
    }
    const login = await this.exec(
      "gh",
      ["auth", "login", "--with-token", "--hostname", "github.com"],
      { stdin: token },
    );
    if (login.enoent) {
      return { authenticated: false, reason: "gh is not installed on this machine" };
    }
    if (!login.ok) return { authenticated: false, reason: "not signed in" };
    return this.status();
  }

  /** Fills global user.name/user.email where unset; never overwrites. */
  private async repairIdentity(user: GhUser): Promise<void> {
    const name = await this.exec("git", ["config", "--global", "user.name"]);
    if (!name.ok || !name.stdout.trim()) {
      await this.exec("git", ["config", "--global", "user.name", user.name ?? user.login]);
    }
    const email = await this.exec("git", ["config", "--global", "user.email"]);
    if (!email.ok || !email.stdout.trim()) {
      await this.exec("git", [
        "config", "--global", "user.email",
        `${user.id}+${user.login}@users.noreply.github.com`,
      ]);
    }
  }
}

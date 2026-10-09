// PR and issue listing for the New Worktree dialog. Reuses CubedGithubAuth's
// status gate so a gh-missing or signed-out machine throws the exact same
// reason text github:auth-status reports — the dialog's signed-out copy keys on
// that string, the same contract github-repos.ts already relies on.
//
// Unlike github-repos.ts these do not paginate: `gh pr list --limit 100` is a
// dialog's worth of rows, and a repo with more than 100 open PRs is served by
// the paste-a-number path, not by scrolling.
import { CubedGithubAuth } from "./github-auth";
import { makeExec, type ExecCommand } from "./exec";

export interface GithubPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  isCrossRepository: boolean;
}

export interface GithubIssue {
  number: number;
  title: string;
  url: string;
}

const LIMIT = "100";
const PR_FIELDS = "number,title,url,headRefName,isCrossRepository";
const ISSUE_FIELDS = "number,title,url";
const ERROR_TAIL_CHARS = 2000;

export class CubedGithub {
  private readonly exec: ExecCommand;
  private readonly githubAuth: CubedGithubAuth;

  constructor(exec: ExecCommand = makeExec()) {
    this.exec = exec;
    this.githubAuth = new CubedGithubAuth(exec);
  }

  private async requireAuth(): Promise<void> {
    const status = await this.githubAuth.status();
    if (!status.authenticated) throw new Error(status.reason ?? "not signed in");
  }

  private async gh(repoPath: string, args: string[]): Promise<string> {
    // gh -R takes an OWNER/REPO, never a filesystem path — the repo is
    // selected by running in it.
    const result = await this.exec("gh", args, { cwd: repoPath });
    if (!result.ok) {
      throw new Error(result.stderr.slice(-ERROR_TAIL_CHARS) || "gh failed");
    }
    return result.stdout;
  }

  private parse<T>(raw: string, what: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`could not read ${what} from gh`);
    }
  }

  async listPrs(args: { repoPath: string }): Promise<{ prs: GithubPr[] }> {
    await this.requireAuth();
    const raw = await this.gh(args.repoPath, [
      "pr", "list", "--state", "open", "--limit", LIMIT, "--json", PR_FIELDS,
    ]);
    return { prs: this.parse<GithubPr[]>(raw, "pull requests") };
  }

  async listIssues(args: { repoPath: string }): Promise<{ issues: GithubIssue[] }> {
    await this.requireAuth();
    const raw = await this.gh(args.repoPath, [
      "issue", "list", "--state", "open", "--limit", LIMIT, "--json", ISSUE_FIELDS,
    ]);
    return { issues: this.parse<GithubIssue[]>(raw, "issues") };
  }

  async resolve(args: {
    repoPath: string;
    kind: "pr" | "issue";
    number: number;
  }): Promise<{ kind: "pr"; pr: GithubPr } | { kind: "issue"; issue: GithubIssue }> {
    await this.requireAuth();
    if (args.kind === "pr") {
      const raw = await this.gh(args.repoPath, [
        "pr", "view", String(args.number), "--json", PR_FIELDS,
      ]);
      return { kind: "pr", pr: this.parse<GithubPr>(raw, "pull request") };
    }
    const raw = await this.gh(args.repoPath, [
      "issue", "view", String(args.number), "--json", ISSUE_FIELDS,
    ]);
    return { kind: "issue", issue: this.parse<GithubIssue>(raw, "issue") };
  }
}

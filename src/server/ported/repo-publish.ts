import { CubedGithubAuth } from "./github-auth";
import { makeExec, type ExecCommand } from "./exec";
import { validGithubTarget, type GithubOwnersResult, type PublishRepoArgs, type PublishRepoResult } from "@port/shared/repo-create";

/** Git treats host-looking relative paths as local repositories. Establish
 * transport and host before comparing repository identity; clone deduplication's
 * permissive path normalizer is not a publication destination validator. */
function sameGithubRepository(destination: string, selected: string): boolean {
  const repository = (remote: string): string | undefined => {
    const match = /^(?:https:\/\/(?:[^/?#@\\\s]+@)?github\.com(?::443)?\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/)([a-z0-9-]+\/[a-z0-9_.-]+)\/?$/i.exec(remote);
    return match?.[1]?.replace(/\.git$/i, "").toLowerCase();
  };
  const actual = repository(destination);
  return actual !== undefined && actual === repository(selected);
}

/** Publication is explicit and only pushes the current committed branch.
 * The Git-local receipt survives restart, allowing a failed push to retry
 * without creating another GitHub repo or adopting an unrelated origin. */
export class CubedRepoPublisher {
  private readonly auth: CubedGithubAuth;
  private readonly busy = new Set<string>();
  constructor(private readonly exec: ExecCommand = makeExec()) { this.auth = new CubedGithubAuth(exec); }

  private async requireAuth(): Promise<void> {
    const status = await this.auth.status();
    if (!status.authenticated) throw new Error(status.reason ?? "not signed in");
  }

  private async run(cmd: string, args: string[], cwd?: string, stdin?: string): Promise<string> {
    if (cmd === "gh" && args[0] === "api") args = [...args, "--hostname", "github.com"];
    const result = await this.exec(cmd, args, { ...(cwd ? { cwd } : {}), ...(stdin ? { stdin } : {}), timeoutMs: 120_000 });
    if (!result.ok) throw new Error(result.stderr.slice(-2000) || `${cmd} failed`);
    return result.stdout.trim();
  }

  async owners(): Promise<GithubOwnersResult> {
    await this.requireAuth();
    const user = JSON.parse(await this.run("gh", ["api", "user"])) as { login: string };
    const pages = JSON.parse(await this.run("gh", ["api", "--paginate", "--slurp", "user/orgs?per_page=100"])) as { login: string }[][];
    return { owners: [{ login: user.login, kind: "user" }, ...pages.flat().map(org => ({ login: org.login, kind: "organization" as const }))] };
  }

  async publish(root: string, args: PublishRepoArgs, onTarget?: () => Promise<void>): Promise<PublishRepoResult> {
    if (!validGithubTarget(args)) throw new Error("Choose a valid GitHub owner, repository name, and visibility.");
    if (this.busy.has(root)) throw new Error("This repository is already being published.");
    this.busy.add(root);
    try { return await this.publishOnce(root, args, onTarget); }
    finally { this.busy.delete(root); }
  }

  private async publishOnce(root: string, args: PublishRepoArgs, onTarget?: () => Promise<void>): Promise<PublishRepoResult> {
    await this.requireAuth();
    const git = (args: string[]) => this.run("git", args, root);
    const config = async (key: string) => {
      const result = await this.exec("git", ["config", "--local", "--get", key], { cwd: root });
      return result.ok ? result.stdout.trim() : "";
    };
    const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    await git(["rev-parse", "--verify", "HEAD"]);
    const url = `https://github.com/${args.owner}/${args.name}`;
    const remote = `${url}.git`;
    const saved = await config("cube.publish-receipt");
    let receipt: { remote: string; visibility: string } | null = null;
    if (saved) {
      try { receipt = JSON.parse(saved); }
      catch { throw new Error("Could not read the previous GitHub publication receipt."); }
      if (!receipt || typeof receipt.remote !== "string" || typeof receipt.visibility !== "string") throw new Error("Invalid GitHub publication receipt.");
    }
    const origin = await config("remote.origin.url");
    if (receipt && !sameGithubRepository(receipt.remote, remote)) throw new Error("A previous publish created a different GitHub repository. Retry with that owner and name.");
    if (origin && ((!receipt && args.useExisting !== true) || !sameGithubRepository(origin, remote))) throw new Error("This repo already has an origin. Its remote will not be replaced.");
    if (receipt && receipt.visibility !== args.visibility) {
      throw new Error("Retry with the visibility chosen when this GitHub repository was created.");
    }
    await onTarget?.();
    if (receipt || args.useExisting === true) {
      const existing = JSON.parse(await this.run("gh", ["api", `repos/${args.owner}/${args.name}`])) as { full_name: string; visibility: string; permissions?: { push?: boolean } };
      if (existing.full_name?.toLowerCase() !== `${args.owner}/${args.name}`.toLowerCase() || existing.permissions?.push !== true) {
        throw new Error("You do not have push access to this GitHub repository.");
      }
      if (existing.visibility !== args.visibility) throw new Error(receipt
        ? `The GitHub repo has different visibility. Restore it to ${receipt.visibility} on GitHub before retrying.`
        : "The existing GitHub repo has different visibility. Choose its actual visibility before connecting.");
    }
    if (!receipt) {
      if (args.useExisting !== true) {
        const user = JSON.parse(await this.run("gh", ["api", "user"])) as { login: string };
        const endpoint = user.login.toLowerCase() === args.owner.toLowerCase() ? "user/repos" : `orgs/${args.owner}/repos`;
        await this.run("gh", ["api", "--method", "POST", endpoint, "--input", "-"], undefined,
          JSON.stringify({ name: args.name, private: args.visibility === "private", auto_init: false }));
      }
      await git(["config", "--local", "cube.publish-receipt", JSON.stringify({ remote, visibility: args.visibility })]);
    }
    if (!origin) await git(["remote", "add", "origin", remote]);
    // Ask Git for EVERY effective destination: pushurl and both forms of
    // url rewriting are independent of remote.origin.url.
    const destinations = (await git(["remote", "get-url", "--push", "--all", "origin"])).split(/\r?\n/);
    if (destinations.length === 0 || destinations.some(destination => !sameGithubRepository(destination, remote))) {
      throw new Error("The effective Git push destination differs from the selected GitHub repository.");
    }
    // Use gh's existing credential helper without installing global config.
    // Explicit refspec avoids push.default, push.followTags, or force settings.
    await git(["-c", "credential.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential",
      "-c", "push.followTags=false", "push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    return { url };
  }
}

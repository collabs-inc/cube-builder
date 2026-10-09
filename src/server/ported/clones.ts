// src/main/cubed/clones.ts
//
// Managed repo clones for the machine's data plane. Clones land under one
// managed directory (default $HOME/repos); remove refuses to act outside it
// so no caller bug can ever aim a recursive delete at $HOME. Clone is
// temp-dir atomic: a failed clone leaves no half-repo for the next attempt
// to trip over. The daemon stays repo-blind — these are stateless
// commands over a directory, not a repo registry.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { guardedRemove } from "./managed-paths";
import { repoSlug, validRepoName, type CreateRepoArgs } from "@port/shared/repo-create";

export interface CubedClonesOptions {
  /** Managed clones directory. Default: $HOME/repos. */
  reposDir?: string;
}

const CLONE_TIMEOUT_MS = 10 * 60_000;
const CONFIG_TIMEOUT_MS = 5_000;
const ERROR_TAIL_CHARS = 2000;

export interface ManagedClone {
  repoPath: string;
  originUrl: string | null;
  name: string;
}

function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "repo";
}

/** repo basename from a git URL: strips a trailing .git and any query/fragment. */
function repoBasename(gitUrl: string): string {
  const tail = basename(gitUrl.replace(/[?#].*$/, "").replace(/\/+$/, ""));
  return tail.replace(/\.git$/, "") || "repo";
}

/**
 * Whether two git URLs name the same remote. Compared on host plus path
 * with a trailing `.git` and any credentials stripped, so the SSH and
 * HTTPS spellings of one repo match — a user who cloned over SSH and then
 * picks the same repo from the HTTPS-based GitHub list must not get a
 * second copy.
 */
export function sameRemote(a: string, b: string): boolean {
  return normalizeRemote(a) === normalizeRemote(b);
}

function normalizeRemote(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const scp = /^[^@/]+@([^:]+):(.+)$/.exec(trimmed);
  if (scp) return `${scp[1]!.toLowerCase()}/${scp[2]!.toLowerCase()}`;
  try {
    const parsed = new URL(trimmed);
    return `${parsed.host.toLowerCase()}${parsed.pathname.toLowerCase()}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function git(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) {
        resolvePromise();
        return;
      }
      const tail = String(stderr).slice(-ERROR_TAIL_CHARS);
      reject(new Error(`git ${args[0]} failed: ${tail || err.message}`));
    });
  });
}

/** `git config --get remote.origin.url` for a repo. Null on any failure (no origin, not a repo, …). */
function originUrl(repoPath: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["-C", repoPath, "config", "--get", "remote.origin.url"],
      { timeout: CONFIG_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        resolvePromise(err ? null : stdout.trim() || null);
      },
    );
  });
}

export class CubedClones {
  private readonly reposDir: string;

  constructor(opts: CubedClonesOptions = {}) {
    this.reposDir = resolve(opts.reposDir ?? join(homedir(), "repos"));
  }

  /**
   * Whether `root` is one of this machine's managed clones — a direct
   * descendant of the managed dir. Lexical on purpose: it answers "did
   * cubed create this?", which decides whether removing a repo may
   * delete the directory, and a path that no longer exists must still
   * answer truthfully.
   */
  isManaged(root: string): boolean {
    return resolve(root).startsWith(this.reposDir + sep);
  }

  /** First free of <slug>, <slug>-2, <slug>-3, … */
  private freePath(slug: string): string {
    let candidate = join(this.reposDir, slug);
    for (let n = 2; existsSync(candidate); n += 1) {
      candidate = join(this.reposDir, `${slug}-${n}`);
    }
    return candidate;
  }

  async clone(args: { gitUrl: string; name?: string }): Promise<ManagedClone & { adopted: boolean }> {
    mkdirSync(this.reposDir, { recursive: true });

    // A clone already on disk for this origin is THE clone for it. Cloning
    // beside it would leave two working copies of one repo, and the older
    // one may hold uncommitted work — so adopt rather than duplicate. This
    // is also what makes an empty catalog beside a populated repos dir
    // self-healing, with no startup repair pass.
    for (const existing of await this.list()) {
      if (existing.originUrl !== null && sameRemote(existing.originUrl, args.gitUrl)) {
        return { ...existing, adopted: true };
      }
    }

    const slug = slugify(args.name ?? repoBasename(args.gitUrl));
    const repoPath = this.freePath(slug);
    const tmpPath = join(this.reposDir, `.tmp-${randomBytes(6).toString("hex")}`);
    try {
      await git(["clone", "--", args.gitUrl, tmpPath], CLONE_TIMEOUT_MS);
      renameSync(tmpPath, repoPath);
      return { repoPath, originUrl: await originUrl(repoPath), name: basename(repoPath), adopted: false };
    } catch (err) {
      rmSync(tmpPath, { recursive: true, force: true });
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(message);
    }
  }

  async create(args: CreateRepoArgs): Promise<ManagedClone> {
    if (!validRepoName(args.name)) throw new Error("Choose a repo name of 1–100 characters without slashes.");
    mkdirSync(this.reposDir, { recursive: true });
    const slug = repoSlug(args.name);
    let repoPath: string;
    // Reserve the directory before awaiting Git; concurrent creates cannot
    // choose the same path or overwrite an existing checkout.
    for (let n = 1; ; n++) {
      repoPath = join(this.reposDir, n === 1 ? slug : `${slug}-${n}`);
      try { mkdirSync(repoPath); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    try {
      await git(["-C", repoPath, "init", "-q", "--initial-branch=main"], CONFIG_TIMEOUT_MS);
      await git(["-C", repoPath, "-c", "user.name=Cube", "-c", "user.email=cube@localhost",
        "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "Initialize repository"], CONFIG_TIMEOUT_MS);
      return { repoPath, originUrl: null, name: args.name.trim() };
    } catch (error) {
      rmSync(repoPath, { recursive: true, force: true });
      throw error;
    }
  }

  /** Immediate children of the managed dir that contain `.git`. Empty/missing dir → []. */
  async list(): Promise<ManagedClone[]> {
    let entries: string[];
    try {
      entries = readdirSync(this.reposDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
      throw err;
    }

    const repos: ManagedClone[] = [];
    for (const name of entries) {
      const repoPath = join(this.reposDir, name);
      if (!existsSync(join(repoPath, ".git"))) continue;
      repos.push({ repoPath, name, originUrl: await originUrl(repoPath) });
    }
    return repos;
  }

  async remove(args: { repoPath: string }): Promise<void> {
    try {
      guardedRemove(this.reposDir, args.repoPath, "managed repos directory");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(message.replace(/^refused: /, "clones:remove refused: "));
    }
  }
}

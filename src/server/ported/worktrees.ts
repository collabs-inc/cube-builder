// Managed git worktrees for the machine's data plane. Repo-blind, like
// repos.ts: these are stateless commands over a directory, not registry
// operations. The registry row is written by the main process BEFORE any of
// this runs, so a failure here leaves a visible, retryable row rather than an
// invisible directory.
//
// Every git and gh command runs with `cwd` set to the directory it acts on —
// never `git -C` and never `gh -R <path>` (gh's -R takes an OWNER/REPO, so a
// filesystem path there is simply invalid).
//
// `add` prunes before adding so it doubles as retry: a previous failed attempt
// can leave a stale worktree record that would make a blind re-run collide
// with itself.
import { cpSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { makeExec, type ExecCommand } from "./exec";
import { assertContained, assertLexicallyContained } from "./managed-paths";

export interface WorktreeAddArgs {
  repoPath: string;
  path: string;
  /** Already decided by the caller — this module never slugs a branch name. */
  branch: string;
  source:
    | { from: "new" | "issue"; baseBranch: string }
    | { from: "branch" }
    | { from: "pr"; number: number };
}

export interface WorktreeCopyArgs {
  /** The parent repo's primary checkout — every entry is relative to this. */
  repoPath: string;
  /** The new worktree's directory. */
  path: string;
  /** Repo-relative entries from `.cube/worktree.json`'s `copy`. */
  entries: string[];
}

export interface WorktreeCopyFailure {
  /** The `copy` entry as the config wrote it. */
  entry: string;
  error: string;
}

export interface WorktreeCopyResult {
  /** Entries that could not be copied. Empty when every entry landed or was absent. */
  failures: WorktreeCopyFailure[];
}

export interface WorktreeEntry {
  path: string;
  branch: string;
  head: string;
  /** The directory is gone but git still lists the record as prunable. */
  missing: boolean;
}

/** One row of `git worktree list`, primary checkout included. */
export interface CheckoutEntry {
  path: string;
  /** Null when HEAD is detached — a state, not a failure to read. */
  branch: string | null;
  head: string;
  /** This is the repo's own working copy, not a linked worktree. */
  primary: boolean;
  /** The directory is gone but git still lists the record as prunable. */
  missing: boolean;
}

export interface WorktreeInspect {
  dirty: number;
  unpushedCommits: number;
  /**
   * The directory is gone. Distinct from a `git status` failure, which still
   * throws: "I could not tell" must never render as "nothing to lose", but
   * "there is nothing there" is a real answer and the one that lets a
   * stranded row be removed without a dialog that can name nothing.
   */
  missing: boolean;
}

export interface BranchRef {
  name: string;
  /** Only on origin — checking it out needs a tracking branch. */
  remote: boolean;
}

export interface RepoInfo {
  hasGithubRemote: boolean;
  /** Short name, e.g. "main". Null when it cannot be determined. */
  defaultBranch: string | null;
}

const ERROR_TAIL_CHARS = 2000;
/**
 * For the commands that move data: a fetch, an add that materializes a
 * checkout, a remove that deletes one. Everything else here is a local read
 * and runs on the exec's own (short) default, because the sweep behind
 * `catalog:get` runs `list` and `prune` on every client attach — a wedged
 * git there must fail, not hang the attach for ten minutes.
 */
const LONG_TIMEOUT_MS = 10 * 60_000;
const LONG = { timeoutMs: LONG_TIMEOUT_MS };
const ORIGIN_PREFIX = "origin/";
const LOCAL_REF_PREFIX = "refs/heads/";
const REMOTE_REF_PREFIX = "refs/remotes/origin/";

/**
 * `path` through any symlinks, or its lexical resolution when it is gone.
 *
 * The `realpathSync` is guarded by a catch, not by the `existsSync` above
 * it: the two calls race — a worktree directory can be deleted between them,
 * by a user or by a concurrent removal — and an ENOENT thrown here would
 * come out of `worktree:list`, whose whole job is to report exactly that
 * directory as gone.
 */
function realPath(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return resolved;
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** git's `--count` output as a number; an ok exit always prints one. */
function countOf(stdout: string): number {
  return Number.parseInt(stdout.trim(), 10) || 0;
}

/**
 * Whether `path` is genuinely gone, as opposed to merely unreadable. A
 * `missing` checkout is dropped from the sweep's live map and its row is
 * pruned — which for `removeRepo` means killing the repo's ptys — so
 * "I could not tell" must collapse to "present", never to "gone". `existsSync`
 * cannot make this distinction: it returns false for EACCES, ESTALE, EIO and
 * a disconnected mount exactly as it does for a real absence, so a flapping
 * mount would otherwise churn row identity and kill live agent sessions on
 * every sweep. `statSync`'s `throwIfNoEntry: false` gives the discrimination
 * this needs — `undefined` for a real absence, a throw for everything else —
 * and the throw is swallowed here (as present) so one unreadable entry never
 * fails the whole `checkouts()` listing.
 */
function isGenuinelyMissing(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false }) === undefined;
  } catch {
    return false;
  }
}

/** The managed worktree root on whichever machine this daemon runs on. */
export function defaultWorktreesDir(): string {
  return join(homedir(), ".cube", "worktrees");
}

export class CubedWorktrees {
  private readonly exec: ExecCommand;
  private readonly worktreesRoot: string;

  constructor(exec: ExecCommand = makeExec(), worktreesDir?: string) {
    this.exec = exec;
    this.worktreesRoot = resolve(worktreesDir ?? defaultWorktreesDir());
  }

  /**
   * The managed root, resolved through symlinks whenever it exists. `git
   * worktree list` reports real paths, so a symlinked HOME would otherwise
   * make every containment and ownership comparison miss. Resolved on read
   * rather than frozen in the constructor: the driver creates the root before
   * first use, and a root that did not exist yet at construction has no real
   * path to resolve to.
   */
  get worktreesDir(): string {
    return realPath(this.worktreesRoot);
  }

  /**
   * Whether a worktree directory is still on disk. Same discrimination as
   * `isGenuinelyMissing`, for the same reason: the one caller
   * (`server.ts`'s `removeRepo`) uses this to pick `git worktree remove`
   * versus prune-the-record, and an EACCES/ESTALE path read as "gone" would
   * prune the record out from under a checkout that is still there —
   * stranding it on disk with its row deleted. Unreadable means present;
   * the removal git then attempts fails loudly and leaves the row
   * retryable.
   */
  exists(path: string): boolean {
    return !isGenuinelyMissing(path);
  }

  private async git(
    repoPath: string,
    args: string[],
    opts: { timeoutMs?: number } = {},
  ): Promise<string> {
    const result = await this.exec("git", args, { cwd: repoPath, ...opts });
    if (!result.ok) {
      const tail = result.stderr.slice(-ERROR_TAIL_CHARS);
      throw new Error(`git ${args[0]} failed: ${tail || "unknown error"}`);
    }
    return result.stdout;
  }

  async add(args: WorktreeAddArgs, mayWrite: () => boolean = () => true): Promise<{ fetchWarning: boolean }> {
    assertCreationAuthority(mayWrite);
    const fetch = await this.exec("git", ["fetch", "origin"], { cwd: args.repoPath, ...LONG });
    // Offline is a warning, not an abort: the local base ref is usually fine.
    const fetchWarning = !fetch.ok;

    // Idempotent repair — clears any stale record from a failed attempt so a
    // retry does not collide with its own leftovers.
    assertCreationAuthority(mayWrite);
    await this.prune({ repoPath: args.repoPath });

    if (args.source.from === "pr") {
      await this.addFromPr(args, args.source.number, mayWrite);
      return { fetchWarning };
    }

    if (args.source.from === "branch") {
      await this.addFromBranch(args, mayWrite);
      return { fetchWarning };
    }

    const base = await this.baseRef(args.repoPath, args.source.baseBranch);
    assertCreationAuthority(mayWrite);
    await this.git(args.repoPath, ["worktree", "add", "-b", args.branch, args.path, base], LONG);
    return { fetchWarning };
  }

  /**
   * The local `<base>` when that ref exists, else `origin/<base>`. Local
   * first so branching off a local-only feature branch works and a failed
   * fetch simply falls back to whatever is already here; `origin/` covers
   * the base that exists only on the remote, and when neither resolves the
   * add fails with `invalid reference` — a failed row, which is the right
   * place for it.
   */
  private async baseRef(repoPath: string, baseBranch: string): Promise<string> {
    const local = await this.exec(
      "git",
      ["rev-parse", "--verify", "--quiet", `${LOCAL_REF_PREFIX}${baseBranch}`],
      { cwd: repoPath },
    );
    return local.ok ? baseBranch : `${ORIGIN_PREFIX}${baseBranch}`;
  }

  private async addFromBranch(args: WorktreeAddArgs, mayWrite: () => boolean): Promise<void> {
    const local = await this.exec(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${args.branch}`],
      { cwd: args.repoPath },
    );
    assertCreationAuthority(mayWrite);
    if (local.ok) {
      await this.git(args.repoPath, ["worktree", "add", args.path, args.branch], LONG);
      return;
    }
    await this.git(
      args.repoPath,
      [
        "worktree", "add", "--track", "-b", args.branch, args.path,
        `${ORIGIN_PREFIX}${args.branch}`,
      ],
      LONG,
    );
  }

  /**
   * A PR head may live on a fork, so the checkout is gh's job: detach a
   * worktree at HEAD first, then let `gh pr checkout` fetch the head branch
   * into it. gh needs the worktree it is acting on as its working directory,
   * and `--branch` because gh would otherwise name the local branch itself —
   * the caller already decided the name, and the catalog row records it.
   */
  private async addFromPr(args: WorktreeAddArgs, number: number, mayWrite: () => boolean): Promise<void> {
    assertCreationAuthority(mayWrite);
    await this.git(args.repoPath, ["worktree", "add", "--detach", args.path, "HEAD"], LONG);
    assertCreationAuthority(mayWrite);
    const checkout = await this.exec(
      "gh",
      ["pr", "checkout", String(number), "--branch", args.branch],
      { cwd: args.path, ...LONG },
    );
    if (!checkout.ok) {
      assertCreationAuthority(mayWrite);
      // Undo the detached worktree so the path is free for a retry.
      await this.exec("git", ["worktree", "remove", "--force", args.path], {
        cwd: args.repoPath,
        ...LONG,
      });
      throw new Error(`gh pr checkout failed: ${checkout.stderr.slice(-ERROR_TAIL_CHARS)}`);
    }
  }

  /**
   * Copies `.cube/worktree.json`'s `copy` entries out of the parent repo
   * and into a freshly added worktree — the untracked files (`.env` and
   * friends) a checkout is useless without and git will never bring along.
   *
   * **Never throws, and never abandons the rest of the list.** A worktree
   * whose `.env` could not be copied is still a usable checkout, so no entry
   * is allowed to fail the creation that asked for it: each failure is
   * returned for the driver to surface as a warning on a row that still goes
   * ready. A **missing source is not a failure at all** — a config lists what
   * a worktree *would* like, and a `.env` nobody has created is the normal
   * case. Nothing here shell-expands, so a `~/x` entry is a literal `~`
   * directory that simply is not there (see `WorktreeConfig.copy`).
   *
   * The two containment checks are deliberately different strengths:
   *
   * - The **source** is checked lexically, so a repo whose `.env` is a
   *   symlink to `~/secrets/app.env` — a normal convention, and exactly the
   *   file this feature exists to carry — is copied rather than refused. The
   *   copy dereferences, so the worktree gets the contents, not a link that
   *   would break if the target moved. `@port/shared/worktree-config`
   *   already drops textual escapes at parse; this layer holds even if a
   *   future caller hands over entries that never went through it.
   * - The **destination** is checked through symlinks, before any directory
   *   is created. A worktree that contains `cfg -> /outside` would otherwise
   *   let the entry `cfg/x` write outside the worktree entirely.
   */
  async copyFiles(args: WorktreeCopyArgs, mayWrite: () => boolean = () => true): Promise<WorktreeCopyResult> {
    const failures: WorktreeCopyFailure[] = [];
    for (const entry of args.entries) {
      assertCreationAuthority(mayWrite);
      try {
        this.copyEntry(args.repoPath, args.path, entry);
      } catch (err) {
        failures.push({ entry, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { failures };
  }

  /** One `copy` entry. Throws on refusal or I/O failure; absent is a no-op. */
  private copyEntry(repoPath: string, worktreePath: string, entry: string): void {
    const source = resolve(repoPath, entry);
    assertLexicallyContained(repoPath, source, "repository");
    if (!existsSync(source)) return;
    const destination = resolve(worktreePath, entry);
    assertContained(worktreePath, destination, "worktree");
    mkdirSync(dirname(destination), { recursive: true });
    // Recursive so a directory entry copies as one; force so the parent's
    // copy wins over anything the checkout already carries (the entry named
    // the file it wants, not a file it might want); dereference so a
    // symlinked source arrives as its contents.
    cpSync(source, destination, { recursive: true, force: true, dereference: true });
  }

  /**
   * Best-effort repo metadata for the New Worktree dialog's source gating
   * and base-branch prefill. Neither probe throws — a repo with no `origin`
   * (or an unreachable one) is not an error here, just a "no" / a null.
   */
  async repoInfo(args: { repoPath: string }): Promise<RepoInfo> {
    const remote = await this.exec("git", ["remote", "get-url", "origin"], { cwd: args.repoPath });
    const hasGithubRemote = remote.ok && remote.stdout.includes("github.com");

    const symbolicRef = await this.exec(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd: args.repoPath },
    );
    if (symbolicRef.ok) {
      const trimmed = symbolicRef.stdout.trim();
      const defaultBranch = trimmed.startsWith(ORIGIN_PREFIX)
        ? trimmed.slice(ORIGIN_PREFIX.length)
        : trimmed;
      return { hasGithubRemote, defaultBranch: defaultBranch || null };
    }

    // No tracked origin/HEAD (e.g. a fresh clone before the remote's default
    // branch is known) — fall back to whatever branch is actually checked out.
    const head = await this.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: args.repoPath,
    });
    const defaultBranch = head.ok ? head.stdout.trim() || null : null;
    return { hasGithubRemote, defaultBranch };
  }

  /**
   * The repo's common git directory — `.git` for a primary checkout, and the
   * SAME path for any of its linked worktrees, which is the point:
   * `worktrees/` lives there and nowhere else. Absolute, because
   * `--git-common-dir` answers relatively (`.git`) for a primary checkout.
   *
   * Returns null rather than throwing: a repo whose directory is gone or
   * is not a repo simply gets no watches, and the caller runs unattended.
   */
  async gitCommonDir(repoRoot: string): Promise<string | null> {
    const result = await this.exec("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot });
    if (!result.ok) return null;
    const raw = result.stdout.trim();
    if (raw === "") return null;
    return isAbsolute(raw) ? raw : resolve(repoRoot, raw);
  }

  /**
   * Every checkout `git worktree list` knows about, primary included and
   * flagged. One git call answers "what is checked out where" for the whole
   * repo, which is what the catalog's branch reconciliation needs — the
   * primary working copy is a checkout like any other, and reading it
   * through a second code path is how the two ranks drift apart.
   */
  async checkouts(
    args: { repoPath: string },
    execOpts?: { timeoutMs: number },
  ): Promise<{ checkouts: CheckoutEntry[] }> {
    const stdout = await this.git(args.repoPath, ["worktree", "list", "--porcelain"], execOpts);
    // git prints real paths, so the primary checkout has to be compared as
    // one: `resolve` is lexical, and under a symlinked HOME (the e2e harness,
    // any macOS $TMPDIR) the repo itself would otherwise not match.
    const primary = realPath(args.repoPath);
    const checkouts: CheckoutEntry[] = [];
    for (const block of stdout.split(/\n\s*\n/)) {
      const lines = block.split("\n").filter(Boolean);
      const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
      if (!path) continue;
      // A listed worktree whose directory is gone stays in git's output as a
      // prunable record, so absence is reported, not filtered out. See
      // `isGenuinelyMissing` for why this cannot be a bare `existsSync`.
      const missing = isGenuinelyMissing(path);
      const head = lines.find((l) => l.startsWith("HEAD "))?.slice("HEAD ".length) ?? "";
      // No `branch` line means a detached HEAD — a real state a checkout can
      // sit in, distinct from "unknown". Null, not "", so a caller cannot
      // mistake it for a branch whose name it failed to read.
      const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length);
      checkouts.push({
        path,
        head,
        branch: ref === undefined ? null : ref.replace(/^refs\/heads\//, ""),
        // Through realPath, not a bare realpathSync: a directory deleted
        // between the existsSync above and the resolve would otherwise throw
        // ENOENT out of a read whose job is to report it as gone.
        primary: realPath(path) === primary,
        missing,
      });
    }
    return { checkouts };
  }

  /**
   * Every worktree of `repoPath` except its primary checkout — the removal
   * and pruning view, where the primary is not a candidate. Derived from
   * `checkouts` so there is one parser, not two.
   */
  async list(args: { repoPath: string }): Promise<{ worktrees: WorktreeEntry[] }> {
    const { checkouts } = await this.checkouts(args);
    const worktrees = checkouts
      .filter((entry) => !entry.primary)
      // A detached worktree keeps this shape's `branch: string`, as "" — the
      // callers here key on path and only ever show the branch, and none of
      // them can act on a name that is not there.
      .map(({ path, head, branch, missing }) => ({ path, head, branch: branch ?? "", missing }));
    return { worktrees };
  }

  /**
   * Branches the dialog can start a worktree from: every local branch, plus
   * the origin-only ones. A branch that exists in both places is listed once,
   * as local — checking it out needs no tracking branch.
   *
   * Classified by full refname, not `%(refname:short)`: git shortens
   * `refs/remotes/origin/HEAD` to plain `origin`, which would sail past a
   * short-name filter and be offered as a local branch that does not exist.
   * Full refs also disambiguate a local branch literally named `origin/x`.
   *
   * Fetched first, so the list reflects what is on GitHub now rather than
   * what was there the last time something fetched — a branch pushed from
   * another machine is otherwise invisible until the add's own fetch, which
   * runs only after a branch has already been picked. `--prune` is what
   * stops a branch deleted upstream from being offered. Offline is not an
   * error: the clone's own refs are the list then, exactly as `add` treats
   * a failed fetch. It stays on the exec's short default: a fetch that
   * cannot finish in that time should give the dialog a stale list, not a
   * ten-minute spinner.
   */
  async branches(args: { repoPath: string }): Promise<{ branches: BranchRef[] }> {
    await this.exec("git", ["fetch", "--prune", "origin"], { cwd: args.repoPath });
    const stdout = await this.git(args.repoPath, [
      "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin",
    ]);
    const locals: string[] = [];
    const remotes: string[] = [];
    for (const line of stdout.split("\n")) {
      const ref = line.trim();
      // origin/HEAD is a pointer at the default branch, not a branch of its own.
      if (!ref || ref === REMOTE_REF_PREFIX + "HEAD") continue;
      if (ref.startsWith(LOCAL_REF_PREFIX)) locals.push(ref.slice(LOCAL_REF_PREFIX.length));
      else if (ref.startsWith(REMOTE_REF_PREFIX)) remotes.push(ref.slice(REMOTE_REF_PREFIX.length));
    }
    const seen = new Set(locals);
    const branches: BranchRef[] = locals.map((name) => ({ name, remote: false }));
    for (const name of remotes) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      branches.push({ name, remote: true });
    }
    return { branches };
  }

  /**
   * What removing this worktree would discard. Throws rather than reporting
   * zero when git cannot answer: this feeds the confirm dialog's work-loss
   * guard, and "I could not tell" must never render as "nothing to lose".
   */
  async inspect(args: { path: string }): Promise<WorktreeInspect> {
    // throwIfNoEntry: false is the discrimination this needs in one call —
    // it returns undefined for a genuinely absent path but still throws for
    // EACCES, ESTALE and the like, so a path we simply cannot read is never
    // mistaken for one that is gone.
    let stat: ReturnType<typeof statSync> | undefined;
    try {
      stat = statSync(args.path, { throwIfNoEntry: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`inspect failed for ${args.path}: ${message}`);
    }
    if (!stat) return { dirty: 0, unpushedCommits: 0, missing: true };
    const status = await this.exec("git", ["status", "--porcelain"], { cwd: args.path });
    if (!status.ok) {
      const tail = status.stderr.slice(-ERROR_TAIL_CHARS);
      throw new Error(`git status failed: ${tail || "unknown error"}`);
    }
    const dirty = status.stdout.split("\n").filter((l) => l.trim() !== "").length;
    return { dirty, unpushedCommits: await this.unpushedCommits(args.path), missing: false };
  }

  /**
   * Commits removal would lose. A branch that has never been pushed has no
   * upstream, so `@{u}..HEAD` fails — and that is exactly the case where
   * every commit is unpushed, so it falls back to counting what no
   * remote-tracking ref contains rather than reporting a reassuring zero.
   */
  private async unpushedCommits(path: string): Promise<number> {
    const upstream = await this.exec("git", ["rev-list", "--count", "@{u}..HEAD"], { cwd: path });
    if (upstream.ok) return countOf(upstream.stdout);
    const unmerged = await this.exec("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], {
      cwd: path,
    });
    if (!unmerged.ok) {
      const tail = unmerged.stderr.slice(-ERROR_TAIL_CHARS);
      throw new Error(`git rev-list failed: ${tail || "unknown error"}`);
    }
    return countOf(unmerged.stdout);
  }

  /**
   * Drops records whose directory is gone. Best-effort by design: it is
   * repair, and a repo that cannot be pruned is not a reason to fail the
   * operation that asked for it.
   */
  async prune(args: { repoPath: string }): Promise<void> {
    await this.exec("git", ["worktree", "prune"], { cwd: args.repoPath });
  }

  /**
   * `force` defaults to false so git's own refusal on a dirty worktree stands
   * as a second line of defense: the UI reaches force only after the confirm
   * dialog has named what would be discarded. A future caller that forgets the
   * dialog gets git's refusal, not a silent delete.
   *
   * Any non-zero exit throws, force or not — a swallowed forced failure would
   * report success while the worktree was still there, and the caller's row
   * would disappear with no way to retry. That includes a worktree whose
   * directory is already gone (git: "is not a working tree"): clearing a
   * `missing` record is `prune`'s job, not this one's.
   *
   * Abandoned creation supplies its cleanup lease. An awaited listing or
   * removal may outlive that authority, so each later mutation checks again.
   */
  async remove(
    args: { repoPath: string; path: string; force?: boolean },
    mayDelete: () => boolean = () => true,
  ): Promise<void> {
    // Containment first: never hand git a path we do not manage. Validated
    // against git's own worktree records rather than a prefix under
    // `~/.cube/worktrees`, because an adopted worktree lives wherever its
    // author put it. Stronger than the old guard against one threat: git
    // will never list `/etc`, or any other directory that is not a
    // registered worktree of this repo, so an arbitrary or attacker-
    // influenced path can never reach `git worktree remove`. Weaker against
    // another: the old guard trusted nothing about `repoPath`, while this
    // one trusts it to scope what is removable, so a caller bug that pairs
    // the wrong `repoPath` with a path that genuinely is a worktree of THAT
    // repo would now be admitted. Both call sites (`server.ts`'s
    // `removeRepo` and `drive`'s abandon cleanup in worktree-creation.ts)
    // supply both arguments from the daemon's own catalog, not from wire
    // input, which keeps that gap narrow rather than
    // closing it. Checks only — it must not delete anything itself, or an
    // unforced removal of a dirty worktree would be silently discarded
    // before git ever gets a chance to refuse it.
    //
    // On the long timeout, like the removal it precedes: this is part of a
    // data-moving operation, not one of the cheap local reads on the attach
    // path that must fail fast.
    const { checkouts } = await this.checkouts({ repoPath: args.repoPath }, LONG);
    const target = realPath(args.path);
    const entry = checkouts.find((checkout) => realPath(checkout.path) === target);
    if (!entry) {
      throw new Error(
        `worktree remove refused: ${args.path} is not a worktree of ${args.repoPath}`,
      );
    }
    if (entry.primary) {
      throw new Error(`worktree remove refused: ${args.path} is the repo's primary checkout`);
    }
    if (!mayDelete()) return;
    const flags = args.force ? ["--force"] : [];
    const result = await this.exec("git", ["worktree", "remove", ...flags, args.path], {
      cwd: args.repoPath,
      ...LONG,
    });
    if (!result.ok) {
      throw new Error(`git worktree remove failed: ${result.stderr.slice(-ERROR_TAIL_CHARS)}`);
    }
    if (!mayDelete()) return;
    await this.prune({ repoPath: args.repoPath });
  }
}

function assertCreationAuthority(mayWrite: () => boolean): void {
  if (!mayWrite()) throw new Error("registration_changed: worktree creation detached");
}

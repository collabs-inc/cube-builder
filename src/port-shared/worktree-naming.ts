// Pure derivation of branch names and worktree paths. Shared so the create
// dialog previews exactly what the daemon will do — the user never discovers
// the slugging after the fact. This module ships in the renderer bundle, so
// it must not import any Node-only path module — the daemon's worktree
// roots are always POSIX paths (macOS/Linux), so a hand-rolled forward-slash
// join is enough.

/** Joins path segments with `/`, trimming redundant slashes at each boundary. */
function joinPosix(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter((p) => p.length > 0)
    .join("/");
}

/**
 * A git-legal branch name derived from free text. Slashes survive (they are
 * legal and idiomatic); git's reserved sequences (`..`, `@{`, a `.lock`
 * suffix) are flattened to a single hyphen rather than rejected, since this
 * runs on every keystroke of a preview.
 */
export function slugifyBranch(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/\.lock(?=\/|$)/g, "-lock")
    .replace(/@\{|\.\./g, "-")
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .replace(/-*\/-*/g, "/");
  return slug || "worktree";
}

/** `<number>-<slugged title>`, or just the number when the title slugs away. */
export function issueBranchName(number: number, title: string): string {
  const slug = slugifyBranch(title);
  return slug === "worktree" ? String(number) : `${number}-${slug}`;
}

/**
 * The worktree directory for a branch. The branch slug is flattened to one
 * path segment — a branch named `feat/cloud` must not create a nested
 * `feat/` directory, or two branches sharing a prefix would collide as
 * directories.
 */
export function worktreePath(root: string, repoSlug: string, branchSlug: string): string {
  return joinPosix(root, repoSlug, branchSlug.replace(/\//g, "-"));
}

/** First free of `<path>`, `<path>-2`, `<path>-3`, … given the taken set. */
export function freeWorktreePath(
  root: string,
  repoSlug: string,
  branchSlug: string,
  taken: string[],
): string {
  const base = worktreePath(root, repoSlug, branchSlug);
  const takenSet = new Set(taken);
  if (!takenSet.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!takenSet.has(candidate)) return candidate;
  }
}

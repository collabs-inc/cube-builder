// `.cube/worktree.json` configures files copied from the parent repo.
// Parsing is total: malformed files and unknown keys (including legacy
// `setup` commands) are ignored without preventing worktree creation.
//
// The escape rule is enforced HERE, at the edge, not only at the copy: a
// `copy` entry is repo-relative by definition, so `../../.ssh/id_rsa` is not
// a path to refuse later, it is not a `copy` entry at all. The daemon still
// re-checks containment before it touches the filesystem (worktrees.ts's
// `copyFiles`) — this is the first of the two, not the only one.

/** Where a repo commits its worktree setup, relative to its own root. */
export const WORKTREE_CONFIG_PATH = ".cube/worktree.json";

export interface WorktreeConfig {
  /**
   * Repo-relative paths cubed copies from the parent repo into the
   * worktree. Nothing here is shell-expanded: `~/x` names a directory
   * literally called `~`, which almost never exists and is therefore
   * skipped silently rather than resolving to the home directory.
   */
  copy: string[];
}

/** Splits on both separators: a Windows-style `..\x` escapes just as well. */
const SEPARATORS = /[/\\]/;
const WINDOWS_DRIVE = /^[a-zA-Z]:/;

function emptyConfig(): WorktreeConfig {
  return { copy: [] };
}

/** `value`'s string members, trimmed, with the blanks and non-strings dropped. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    entries.push(trimmed);
  }
  return entries;
}

/**
 * Whether `entry` names something strictly inside the repo it is relative to.
 *
 * A `..` segment is refused wherever it appears, including `a/../b`, which
 * does land back inside: the honest reasons to write one are none, and a
 * rule with no exception is one a reader of the config can apply themselves.
 * An entry that reduces to the repo root (`.`, `./`) is refused too — it is
 * not a file to copy, it is the whole checkout.
 */
function isRepoRelative(entry: string): boolean {
  if (entry.startsWith("/") || entry.startsWith("\\") || WINDOWS_DRIVE.test(entry)) return false;
  const segments = entry.split(SEPARATORS);
  if (segments.some((segment) => segment === "..")) return false;
  return segments.some((segment) => segment !== "" && segment !== ".");
}

/**
 * Reads a `.cube/worktree.json` body.
 *
 * Args:
 *   raw: The file's contents. Empty, unparseable, or not a JSON object all
 *     mean "no files to copy".
 *
 * Returns:
 *   The `copy` list, filtered to repo-relative file paths.
 */
export function parseWorktreeConfig(raw: string): WorktreeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyConfig();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return emptyConfig();
  }
  const record = parsed as Record<string, unknown>;
  return {
    copy: stringList(record.copy).filter(isRepoRelative),
  };
}

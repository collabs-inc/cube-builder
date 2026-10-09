// Containment guard for destructive operations on managed directories: a
// removal may only ever touch something strictly inside a root this app
// owns, so no caller bug can aim a recursive delete at $HOME. Moved out of
// repos.ts when worktrees gained a second managed root — one implementation,
// two roots, rather than a second hand-rolled copy.
//
// NOTE: this answers "may I delete this", not "may this caller read this".
// The read-side equivalent is files.ts's resolveScopedPath.
import { realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * `path` through any symlinks, or itself when it cannot be resolved (gone,
 * unreadable, still being created). The one root-comparison primitive for
 * catalog rows: `WorktreeCreation`'s claimed set, `CatalogStore`'s adoption
 * dedup and the sweep's listing keys all go through this, so a symlinked
 * HOME (the e2e harness, any macOS $TMPDIR) can never make one copy of the
 * comparison disagree with another. Deliberately not `existsSync` then
 * `realpathSync`: that pair races (the directory can go between the two
 * calls) and the ENOENT would throw out of sweeps that must never reject.
 */
export function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * `path` with its deepest existing ancestor realpathed and the missing tail
 * re-joined, so a file that is gone or never existed still canonicalizes the
 * way its symlinked parent does. Falls back to `path` itself, like
 * `realpathOrSelf`, when no ancestor resolves.
 */
export function realpathThroughAncestor(path: string): string {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/** Real path of `targetPath` if it exists, else of its deepest existing ancestor. */
function findRealAncestorPath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return walkUpToExistingAncestor(dirname(targetPath));
    }
    throw err;
  }
}

function walkUpToExistingAncestor(checkPath: string): string {
  let current = checkPath;
  for (;;) {
    try {
      return realpathSync(current);
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
      const parent = dirname(current);
      if (parent === current) {
        throw new Error("refused: unable to verify containment — no ancestor directories exist");
      }
      current = parent;
    }
  }
}

/**
 * Throws unless `target` is strictly inside `root` LEXICALLY — `..` segments
 * are normalized away, but no symlink is followed.
 *
 * The weaker of the two checks here, and deliberately so: it answers "is this
 * path expressed as something inside the root", not "does it land inside the
 * root". Use it where following a symlink would be wrong rather than unsafe —
 * reading a repo-relative source file that the repo itself has symlinked out
 * (`.env -> ~/secrets/app.env`, a normal convention), where refusing would
 * break the common case to guard against a repo that can already run
 * arbitrary commands. For anything that DELETES, or that writes to a path an
 * attacker could aim elsewhere, use `assertContained` instead.
 */
export function assertLexicallyContained(root: string, target: string, label: string): void {
  const resolvedRoot = resolve(root);
  const resolved = resolve(target);
  if (resolved !== resolvedRoot && resolved.startsWith(resolvedRoot + sep)) return;
  throw new Error(`refused: ${resolved} is outside the ${label} ${resolvedRoot}`);
}

/** Throws unless `target` resolves strictly inside `root`. Deletes nothing. */
export function assertContained(root: string, target: string, label = "managed directory"): void {
  const resolvedRoot = resolve(root);
  const resolved = resolve(target);

  if (resolved === resolvedRoot || resolved === resolvedRoot + sep) {
    throw new Error(`refused: ${resolved} is outside the ${label} ${resolvedRoot}`);
  }

  let realRoot: string;
  try {
    realRoot = realpathSync(resolvedRoot);
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
    // The root does not exist yet, so nothing can exist beneath it and no
    // symlink can be in play — containment is a lexical check.
    if (resolved.startsWith(resolvedRoot + sep)) return;
    throw new Error(`refused: ${resolved} is outside the ${label} ${resolvedRoot}`);
  }

  const realCheckPath = findRealAncestorPath(resolved);
  const contained = realCheckPath === realRoot || realCheckPath.startsWith(realRoot + sep);
  if (!contained) {
    throw new Error(`refused: ${resolved} is outside the ${label} ${resolvedRoot}`);
  }
}

/**
 * Recursively removes `target`, but only if it resolves strictly inside
 * `root`. An absent target is success. Throws otherwise, naming the path.
 */
export function guardedRemove(root: string, target: string, label = "managed directory"): void {
  assertContained(root, target, label);
  rmSync(resolve(target), { recursive: true, force: true });
}

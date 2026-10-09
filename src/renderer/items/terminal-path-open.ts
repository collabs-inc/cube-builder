/**
 * Resolves a path clicked in terminal output (issue #25) into the
 * renderer's own path space — absolute for local, virtual `/@cloud/…`
 * for cloud — which is the space `openFile`/`repoForAbsPath` speak.
 *
 * A cloud shell prints machine-native paths the renderer's REPO VIEW
 * deliberately strips (state/repo-views.ts) — but the catalog cache
 * still holds every cloud repo's daemon-side root, and that is enough
 * to rebase an absolute machine path into the virtual space the same
 * way the router's own virtualizeHostPath does: longest owning root →
 * `/@cloud/<repoId>/<rel>`. Callers pass those roots as `repoRoots`;
 * without them (or for a path no root owns), a remote absolute path
 * still resolves to null — better no link action than a catalog item
 * pointing nowhere. Relative paths join onto the tile's
 * already-virtualized cwd exactly as before, and a remote cwd outside
 * the virtual space, or a join that climbs out of it, stays null.
 *
 * Hand-rolled posix math because this runs in the renderer bundle,
 * where node:path does not exist.
 */



import { CLOUD_PATH_PREFIX } from "@port/shared/types";

/** `src/a.ts:12:3` → `src/a.ts` — the viewer has no line jump to give. */
function stripLocation(raw: string): string {
  return raw.replace(/:\d+(?::\d+)?$/, "");
}

function normalizePosix(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/** A repo the tile's machine holds: its id and daemon-side absolute root. */
export interface RemoteRepoRoot {
  repoId: string;
  root: string;
}

/** Longest owning root wins, so a worktree checked out inside its parent
 *  repo owns its own subtree — the same rule as the router's `route()`. */
function rebaseOntoRepoRoot(path: string, repoRoots: RemoteRepoRoot[]): string | null {
  let best: RemoteRepoRoot | null = null;
  for (const candidate of repoRoots) {
    if (path !== candidate.root && !path.startsWith(`${candidate.root}/`)) continue;
    if (best === null || candidate.root.length > best.root.length) best = candidate;
  }
  if (best === null) return null;
  const rel = path.slice(best.root.length).replace(/^\//, "");
  const virtualRoot = `${CLOUD_PATH_PREFIX}${best.repoId}`;
  return rel.length === 0 ? virtualRoot : `${virtualRoot}/${rel}`;
}

export function resolveTerminalPath(
  raw: string,
  opts: { cwd: string | undefined; remote: boolean; repoRoots?: RemoteRepoRoot[] },
): string | null {
  const path = stripLocation(raw);
  if (path.startsWith("/")) {
    if (opts.remote) {
      if (path.startsWith(CLOUD_PATH_PREFIX)) return path;
      if (opts.repoRoots === undefined) return null;
      return rebaseOntoRepoRoot(normalizePosix(path), opts.repoRoots);
    }
    return normalizePosix(path);
  }
  const { cwd } = opts;
  if (cwd === undefined || cwd.length === 0 || !cwd.startsWith("/")) return null;
  if (opts.remote && !cwd.startsWith(CLOUD_PATH_PREFIX)) return null;
  const joined = normalizePosix(`${cwd}/${path}`);
  if (opts.remote && !joined.startsWith(CLOUD_PATH_PREFIX)) return null;
  return joined;
}

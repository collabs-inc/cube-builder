import { CLOUD_PATH_PREFIX } from "@port/shared/types";
import { displayBasename } from "@port/shared/path-utils";

/**
 * Pane display name for a root path: the repo's name when the path IS the
 * repo's root, else the folder's basename. Both spellings of a repo root
 * count — a local repo's real `path`, and a cloud repo's virtual
 * `/@cloud/<id>` root, which has no `path` at all (see RepoInfo). Opening a
 * repo's own root as a pane should read "My Repo", not the directory the
 * clone happens to sit in.
 */
export function treePaneNameFor(
  path: string,
  repo: { id: string; name: string; path?: string } | null,
): string {
  if (repo && (repo.path === path || path === `${CLOUD_PATH_PREFIX}${repo.id}`)) return repo.name;
  return displayBasename(path);
}

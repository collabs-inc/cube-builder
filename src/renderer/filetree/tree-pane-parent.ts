import { normalizePathForComparison, parentPath, parseCloudPath, pathKind } from "@port/shared/path-utils";
import { CLOUD_PATH_PREFIX } from "@port/shared/types";

/** One folder up, bounded by the native filesystem or the cloud routing root. */
export function treePaneParent(root: string): string | null {
  if (root.startsWith(CLOUD_PATH_PREFIX)) {
    const cloud = parseCloudPath(root);
    if (!cloud?.rel) return null;
    const parent = cloud.rel.split("/").slice(0, -1).join("/");
    return `${CLOUD_PATH_PREFIX}${cloud.repoId}/${parent}`;
  }
  const kind = pathKind(root);
  const normalized = normalizePathForComparison(root);
  if (kind === "unknown" || normalized === "/"
    || /^[a-z]:\\$/i.test(normalized)
    || /^\\\\[^\\]+\\[^\\]+$/.test(normalized)) return null;
  // parentPath intentionally keeps a top-level POSIX path unchanged;
  // filesystem navigation needs its actual parent, /.
  return kind === "posix" && normalized.lastIndexOf("/") === 0 ? "/" : parentPath(root);
}

import type { OwnedItem, OwnedRepo } from "@port/shared/catalog";
import { normalizePathForComparison, parentPath, parseCloudPath } from "@port/shared/path-utils";
import { CLOUD_PATH_PREFIX, LOCAL_MACHINE_ID } from "@port/shared/types";

function trimSlash(path: string): string {
  return path === "/" || /^[A-Za-z]:[\\/]$/.test(path) ? path : path.replace(/[\\/]+$/, "");
}

/** Resolve renderer paths on their owning machine, as the Files branch's pin-paths does. */
function nativePath(path: string, machineId: string, repos: readonly OwnedRepo[]): string | null {
  if (!path.startsWith(CLOUD_PATH_PREFIX)) return trimSlash(path);
  const cloud = parseCloudPath(path);
  if (!cloud) return null;
  if (cloud.repoId === machineId) return trimSlash(`/${cloud.rel}`);
  const repo = repos.find(row => row.id === cloud.repoId && row.machineId === machineId);
  return repo ? trimSlash(`${trimSlash(repo.root)}${cloud.rel ? `/${cloud.rel}` : ""}`) : null;
}

export interface UnscopedDirectory<T> {
  key: string;
  path: string;
  entries: T[];
}

/** Current cwd groups, in first-session order, with full native paths as labels. */
export function unscopedDirectories<T extends { id: string }>(
  entries: readonly T[], items: readonly OwnedItem[], repos: readonly OwnedRepo[], localHome: string | null,
): UnscopedDirectory<T>[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const groups = new Map<string, UnscopedDirectory<T>>();
  for (const entry of entries) {
    const item = byId.get(entry.id);
    if (!item) continue;
    const file = item.filePath ? nativePath(item.filePath, item.machineId, repos) : null;
    // workingDir is daemon-native and tracks live cwd. cwd may instead be
    // renderer-virtualized, so resolve its machine/repo prefix before grouping.
    const path = (item.workingDir ? trimSlash(item.workingDir) : null)
      ?? (item.cwd ? nativePath(item.cwd, item.machineId, repos) : null)
      ?? (file ? file.lastIndexOf("/") === 0 ? "/" : parentPath(file) : null)
      ?? (item.machineId === LOCAL_MACHINE_ID ? localHome ?? "~" : "/workspace/home");
    const key = JSON.stringify([item.machineId, normalizePathForComparison(path)]);
    let group = groups.get(key);
    if (!group) { group = { key, path, entries: [] }; groups.set(key, group); }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

import type { OwnedItem } from "@port/shared/catalog";
import { isSiteItem } from "@port/shared/site";

/**
 * A site with no checkout belongs to its machine, so it renders under the machine
 * header rather than in the cross-machine Unscoped group.
 */
export function splitMachineEntries<T extends { id: string }>(
  entries: T[],
  items: OwnedItem[],
): { rest: T[]; entriesByMachine: Map<string, T[]> } {
  const byId = new Map(items.map((item) => [item.id, item]));
  const rest: T[] = [];
  const entriesByMachine = new Map<string, T[]>();
  for (const entry of entries) {
    const item = byId.get(entry.id);
    if (item && isSiteItem(item) && item.repoId === undefined) {
      entriesByMachine.set(item.machineId, [...(entriesByMachine.get(item.machineId) ?? []), entry]);
    } else {
      rest.push(entry);
    }
  }
  return { rest, entriesByMachine };
}

/**
 * Arrow-key order, which must match what ReposSidebar draws: cloud machine rows, cloud
 * repos, then — only on a host that draws a local machine — local machine rows and
 * local repos, then the Unscoped group.
 */
export function sidebarNavigationOrder<T>(parts: {
  cloudMachineEntries: readonly T[];
  cloudGroups: readonly { entries: readonly T[] }[];
  localMachineEntries: readonly T[];
  localGroups: readonly { entries: readonly T[] }[];
  showLocalMachine: boolean;
  unscoped: { entries: readonly T[] } | null;
}): T[] {
  return [
    ...parts.cloudMachineEntries,
    ...parts.cloudGroups.flatMap((group) => group.entries),
    ...(parts.showLocalMachine ? [...parts.localMachineEntries, ...parts.localGroups.flatMap((group) => group.entries)] : []),
    ...(parts.unscoped ? parts.unscoped.entries : []),
  ];
}

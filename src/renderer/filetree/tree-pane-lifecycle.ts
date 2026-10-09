import { useEffect, useRef } from "react";
import { useCatalog } from "../state/catalog";
import { closeTreePane, useWorkspace, type TreePaneRecord } from "../state/workspace";

/**
 * Tree panes do not outlive their repo — but only a WITNESSED removal
 * closes them: previousRepoIds === null (no snapshot seen yet this
 * session) closes nothing, so an empty catalog at boot — before any
 * machine has reported — cannot mass-close panes it merely hasn't heard
 * about yet.
 */
export function panesToClose(
  treePanes: Record<string, TreePaneRecord>,
  currentRepoIds: ReadonlySet<string>,
  previousRepoIds: ReadonlySet<string> | null,
): string[] {
  if (previousRepoIds === null) return [];
  const out: string[] = [];
  for (const [id, pane] of Object.entries(treePanes)) {
    if (pane.repoId === null) continue;
    if (previousRepoIds.has(pane.repoId) && !currentRepoIds.has(pane.repoId)) out.push(id);
  }
  return out;
}

export function useTreePaneLifecycle(): void {
  const catalog = useCatalog();
  const { treePanes } = useWorkspace();
  const prevRepoIdsRef = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const current = new Set(catalog.repos.map((r) => r.id));
    for (const id of panesToClose(treePanes, current, prevRepoIdsRef.current)) closeTreePane(id);
    prevRepoIdsRef.current = current;
  }, [catalog.repos, treePanes]);
}

// The renderer's repo list is a VIEW of the machine catalogs, not a
// list of its own: which repos exist is a fact about each daemon
// (docs/superpowers/specs/2026-08-15-machine-side-catalog-design.md), and
// `RepoInfo` is the shape every sidebar/tree/shortcut consumer already
// takes, so it keeps that shape and changes only its source. `kind` is
// which machine owns the row; `path` exists only for the local machine,
// where the root is a real path on this filesystem — a cloud root is a
// daemon-native path that must never reach the renderer un-virtualized.
import type { MergedCatalog, OwnedRepo } from "@port/shared/catalog";
import { LOCAL_MACHINE_ID, type RepoInfo } from "@port/shared/types";

export function repoViewFrom(repo: OwnedRepo): RepoInfo {
  // Spread-in rather than always-present: under exactOptionalPropertyTypes
  // an explicit `worktreeOf: undefined` is not the same as an absent field,
  // and every consumer gates on absence meaning "this is a repo row".
  const worktreeOf = repo.worktreeOf ? { worktreeOf: repo.worktreeOf } : {};
  // Same spread-in treatment, same reason: absent `head` means the machine
  // has not observed this checkout, which every consumer reads as unknown.
  const head = repo.head ? { head: repo.head } : {};
  const view = { id: repo.id, name: repo.name, managed: repo.managed, ...worktreeOf, ...head };
  if (repo.machineId === LOCAL_MACHINE_ID) {
    return { ...view, kind: "local", path: repo.root };
  }
  return { ...view, kind: "cloud" };
}

export function repoViewsFrom(catalog: MergedCatalog): RepoInfo[] {
  return catalog.repos.map(repoViewFrom);
}

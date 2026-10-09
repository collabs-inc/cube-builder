/**
 * Open the default agent once a repo added by THIS client is ready.
 * Tracking is explicit: catalog hydration, worktree adoption and another
 * client's creations must never open extra sessions here.
 */



import type { OwnedRepo } from "@port/shared/catalog";
import { CLOUD_PATH_PREFIX, LOCAL_MACHINE_ID } from "@port/shared/types";
import { createTerminalItem } from "../items/TerminalItem";
import { launchFailureMessage } from "../items/terminal-item-logic";
import { getDefaultAgent } from "../items/agent/default-agent";
import { catalogStore } from "./catalog";
import { focusItem } from "./workspace";

/**
 * Repo and worktree rows this client added that have not gone ready yet. An id
 * leaves the map the moment it is acted on, so the terminal is opened
 * exactly once however many snapshots report the same ready row.
 *
 * `seen` records whether the row has ever appeared in a snapshot. Absent
 * from the catalog means two opposite things — "the broadcast carrying this
 * pending row has not been applied yet" and "the row was removed" — and only
 * the second may drop the id. Tracking the difference explicitly is what
 * keeps this independent of whether the `catalog:changed` broadcast happens
 * to beat `services.worktrees.create`'s reply.
 */
const awaiting = new Map<string, { seen: boolean }>();

/**
 * The path this renderer can hand to a terminal or a file read. A local
 * repo's root is a real path on this filesystem; a cloud repo's is
 * daemon-native and must never be used raw, so it is named by the virtual
 * `/@cloud/<id>` root main routes back — the same rule
 * `state/repos.ts`'s `routablePath` applies.
 */
function routablePath(repo: OwnedRepo): string {
  return repo.machineId === LOCAL_MACHINE_ID
    ? repo.root
    : `${CLOUD_PATH_PREFIX}${repo.id}`;
}

/** Open the chosen agent in a terminal, without executing repository commands. */
async function openFirstTerminal(repo: OwnedRepo): Promise<void> {
  const target = await getDefaultAgent();
  const item = await createTerminalItem({
    repoId: repo.id,
    cwd: routablePath(repo),
    machineId: repo.machineId,
    target,
    view: "terminal",
  });
  focusItem(item.id, item.type, item.repoId ?? null);
}

/**
 * Acts on every tracked row the current snapshot reports as built. A row
 * that has vanished (removed after it was seen at least once) is dropped, a
 * row not yet in any snapshot is left alone, and a row still pending or
 * failed is left tracked — a retry can still make it ready.
 */
function check(): void {
  const { repos } = catalogStore.getSnapshot();
  const built: OwnedRepo[] = [];
  const vanished: string[] = [];
  for (const [id, entry] of awaiting) {
    const repo = repos.find((r) => r.id === id);
    if (!repo) {
      // Only a row that HAS been in a snapshot can have left one. An id
      // tracked before its row arrives is still waiting for its first.
      if (entry.seen) vanished.push(id);
      continue;
    }
    entry.seen = true;
    if (repo.worktreeOf?.creation) continue;
    built.push(repo);
  }
  // Both loops mutate `awaiting`, so neither runs while it is being iterated.
  for (const id of vanished) awaiting.delete(id);
  for (const repo of built) {
    // Untracked BEFORE the async work, so a snapshot arriving mid-open
    // cannot open a second terminal for the same row.
    awaiting.delete(repo.id);
    void openFirstTerminal(repo).catch((err: unknown) => {
      // A worktree's first terminal has no row message of its own (the row
      // is the worktree's, and it went ready successfully), so this stays
      // the console — carrying the user-facing sentence now.
      console.error(
        `[repo-ready] failed to open a terminal for ${repo.id}:`,
        launchFailureMessage(err),
      );
    });
  }
}

/**
 * Registers a repo or worktree row this client just added. Checked immediately:
 * `services.worktrees.create` resolves on the pending row, but the catalog
 * broadcast that marks it ready can already have landed by the time this is
 * called, and that snapshot would otherwise never be revisited.
 */
export function trackCreatedRepo(id: string): void {
  if (!awaiting.has(id)) awaiting.set(id, { seen: false });
  check();
}

/** Watches the catalog for tracked rows going ready. Started from App.tsx. */
export function startRepoReady(): () => void {
  const unsubscribe = catalogStore.subscribe(check);
  check();
  return unsubscribe;
}

/** Test-only: forgets every tracked id, so one test's row cannot reach another's. */
export function resetRepoReady(): void {
  awaiting.clear();
}

/**
 * Artifacts this client has hidden from the sidebar. Client-local and
 * persisted through prefs, like collapsed rows (sidebar-disclosure.ts):
 * hiding changes nothing on the machine, the artifact's file or its tile,
 * only whether this device draws its row. A repo row's menu brings them back.
 */



import { useSyncExternalStore } from "react";
import { services } from "../services";

export const SIDEBAR_HIDDEN_ARTIFACTS_PREF = "sidebar-hidden-artifacts";

let hidden: ReadonlySet<string> = new Set();
let hydration: "idle" | "loading" | "done" = "idle";
/** Choices made before prefs answered; true means hidden. */
const pending = new Map<string, boolean>();
const listeners = new Set<() => void>();

function publish(next: ReadonlySet<string>): void {
  hidden = next;
  if (hydration === "done") void services.prefs.set(SIDEBAR_HIDDEN_ARTIFACTS_PREF, [...next]);
  for (const listener of listeners) listener();
}

function hydrate(): void {
  if (hydration !== "idle") return;
  hydration = "loading";
  const finish = (stored: unknown) => {
    const next = new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
    for (const [id, value] of pending) {
      if (value) next.add(id);
      else next.delete(id);
    }
    const changed = pending.size > 0;
    pending.clear();
    hydration = "done";
    hidden = next;
    if (changed) void services.prefs.set(SIDEBAR_HIDDEN_ARTIFACTS_PREF, [...next]);
    for (const listener of listeners) listener();
  };
  services.prefs.get(SIDEBAR_HIDDEN_ARTIFACTS_PREF).then(finish, () => finish(undefined));
}

function change(ids: readonly string[], value: boolean): void {
  hydrate();
  if (hydration !== "done") for (const id of ids) pending.set(id, value);
  const next = new Set(hidden);
  for (const id of ids) {
    if (value) next.add(id);
    else next.delete(id);
  }
  publish(next);
}

export function hideArtifact(id: string): void {
  change([id], true);
}

export function showArtifacts(ids: readonly string[]): void {
  change(ids, false);
}

export const hiddenArtifactsStore = {
  subscribe(listener: () => void) {
    hydrate();
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot: () => hidden,
};

export function useHiddenArtifacts(): ReadonlySet<string> {
  return useSyncExternalStore(hiddenArtifactsStore.subscribe, hiddenArtifactsStore.getSnapshot);
}

/** Test-only: nothing hidden, prefs not yet read. */
export function _resetHiddenArtifactsForTest(): void {
  hidden = new Set();
  hydration = "idle";
  pending.clear();
  for (const listener of listeners) listener();
}

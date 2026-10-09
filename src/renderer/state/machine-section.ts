// Which tab each machine page shows under its title — Repos, Agents, Apps or
// Machine (MachineTitle.tsx). Per machine, so each page keeps its own;
// never persisted.
import { useSyncExternalStore } from "react";

export type MachineSection = "repos" | "agents" | "apps" | "machine";
type Machine = "cloud" | "local";

let state: Readonly<Record<Machine, MachineSection>> = { cloud: "repos", local: "repos" };
const listeners = new Set<() => void>();

export const machineSectionStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => state,
};

export function setMachineSection(machine: Machine, section: MachineSection): void {
  if (state[machine] === section) return;
  state = { ...state, [machine]: section };
  for (const listener of listeners) listener();
}

export function useMachineSections(): Readonly<Record<Machine, MachineSection>> {
  return useSyncExternalStore(machineSectionStore.subscribe, machineSectionStore.getSnapshot);
}

/** Test-only: every page back on its repos. */
export function _resetMachineSectionsForTest(): void {
  state = { cloud: "repos", local: "repos" };
  for (const listener of listeners) listener();
}

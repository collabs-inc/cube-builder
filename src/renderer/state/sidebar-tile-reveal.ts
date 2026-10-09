import { LOCAL_MACHINE_ID } from "@port/shared/types";
import { itemAncestorKeys, machineKey } from "../sidebar/disclosure";
import { catalogStore } from "./catalog";
import { desktopStore, setNavigatorCategory, setSurface } from "./desktop";
import { expandKeys } from "./sidebar-disclosure";
import { setMachineSection } from "./machine-section";
import { setSidebarMachine } from "./ui";

// Retain the request until Repos mounts: switching navigator surfaces
// unmounts the sidebar, so a transient event alone would be lost.
let request: { itemId: string } | null = null;
const listeners = new Set<() => void>();

export function revealTileInSidebar(itemId: string): void {
  if (!desktopStore.getSnapshot().open) return;
  setSurface("projects");
  setNavigatorCategory("repos");
  const catalog = catalogStore.getSnapshot();
  const item = catalog.items.find(candidate => candidate.id === itemId);
  request = null;
  // Every tile brings the sidebar to its machine's Repos view, even one
  // with no row there (a file, an image): the page to find it from.
  if (item) {
    const machine = item.machineId === LOCAL_MACHINE_ID ? "local" : "cloud";
    setSidebarMachine(machine);
    setMachineSection(machine, "repos");
  }
  if (item && ["term", "agent", "artifact"].includes(item.type)) {
    expandKeys([machineKey(item.machineId), ...itemAncestorKeys(item, catalog.repos)]);
    request = { itemId };
  }
  for (const listener of listeners) listener();
}

export const sidebarTileRevealStore = {
  getSnapshot: () => request,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  consume(value: { itemId: string }) {
    if (request !== value) return;
    request = null;
    for (const listener of listeners) listener();
  },
};

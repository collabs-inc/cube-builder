import { useSyncExternalStore } from "react";
import { mountPersonaItems, activateMountedItem } from "./workspace";

let focused: string | null = null;
const listeners = new Set<() => void>();
export function clearSidebarFocus(): void {
  focused = null;
  for (const listener of listeners) listener();
}
export function openSidebarItem(id: string): void {
  mountPersonaItems([id]);
  activateMountedItem(id);
  focused = id;
  for (const listener of listeners) listener();
}
export function useSidebarFocus(): string | null {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => focused);
}

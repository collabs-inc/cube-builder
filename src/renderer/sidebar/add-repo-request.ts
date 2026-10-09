// An add-repository request from outside the sidebar — the foot's folder,
// ⇧⌘O (desktop/add-repo.ts) — answered by the mounted ReposSidebar, which
// owns the modals the menu's choices open (create, add existing). Asking
// the menu directly showed it and then dropped the choice on the floor.
// A request made before the sidebar has mounted (the shortcut opens the
// panel in the same breath) waits for it.
const listeners = new Set<(machineId: string) => void>();
let pending: string | null = null;

export function requestAddRepo(machineId: string): void {
  if (listeners.size === 0) { pending = machineId; return; }
  for (const listener of listeners) listener(machineId);
}

export function onAddRepoRequest(listener: (machineId: string) => void): () => void {
  listeners.add(listener);
  if (pending !== null) { const machineId = pending; pending = null; listener(machineId); }
  return () => { listeners.delete(listener); };
}

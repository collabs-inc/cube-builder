/**
 * Which mounted `FileTreeHost` owns the document-level tree shortcuts
 * (arrow-key row navigation, F2/Delete/Escape).
 *
 * `shouldHandleSidebarKey` (sidebar/focus-guard.ts) answers a different,
 * coarser question: is focus somewhere this host may act on, treating the
 * common "nothing more specific than `body` is focused" case as "focus is
 * still here". That was sound while the file tree had exactly one host. With
 * a tree also rendered into workspace panes there can be several mounted at
 * once, and every one of them would read body-focus as its own — so an arrow
 * key would move the cursor in all of them at the same time.
 *
 * This is the tie-break layered on top: a host claims the keys when it is
 * pointed at (`onPointerDownCapture`) and releases them on unmount. Until
 * anything has been clicked the claim is null, and the host flagged
 * `isDefault` — the sidebar — handles keys, which is exactly today's
 * behaviour on a first launch where the user has touched nothing yet.
 *
 * Module-level rather than React state on purpose: the holder is read from
 * inside window-level keydown listeners, which must not be torn down and
 * rebuilt every time some other host is clicked.
 */
let activeHostId: string | null = null;

export function claimTreeHostKeys(hostId: string): void {
  activeHostId = hostId;
}

/** A no-op unless `hostId` is the current holder — a host unmounting after
 * some other host has already taken the claim must not steal it back. */
export function releaseTreeHostKeys(hostId: string): void {
  if (activeHostId === hostId) activeHostId = null;
}

export function treeHostHoldsKeys(hostId: string, isDefault: boolean): boolean {
  if (activeHostId === null) return isDefault;
  return activeHostId === hostId;
}

export function resetTreeHostKeysForTest(): void {
  activeHostId = null;
}

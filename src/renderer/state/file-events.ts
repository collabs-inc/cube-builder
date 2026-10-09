/**
 * Wires `services.files.onFileRenamed`/`onFilesDeleted` onto the catalog's
 * rename/delete side effects — a `services.catalog.updateItem`/`removeItem`
 * patch for every catalog item whose `filePath` matches, since item
 * identity (including `filePath`) is the catalog's now, not the workspace
 * store's (see state/catalog.ts). These events fire app-wide — subscribed
 * once here (alongside `state/live-status.ts`'s pattern), not
 * per-component, so a rename or delete that originates from anywhere
 * (nav's own actions, another window, a filesystem watcher) keeps every
 * matching item in sync regardless of what triggered it.
 *
 * Neither handler touches the workspace store's arrangement directly: once
 * the daemon's own catalog:changed broadcast round-trips back through
 * acceptSnapshot, Rail.tsx's reconcile(catalog's known ids) drops the pane
 * of anything removeItem just deleted on its own — see catalog.ts's module
 * doc comment for that division.
 *
 * Pure — no DOM/React — so it's testable directly against the catalog
 * store and a fake services instance; App.tsx's useEffect only calls
 * start()/dispose().
 */



import { isSubpath } from "@port/shared/path-utils";
import { services } from "../services";
import { catalogStore, inferItemType } from "./catalog";

/** Subscribes to `services.files.onFileRenamed`/`onFilesDeleted`. Returns a dispose function. */
export function startFileEvents(): () => void {
  const offRenamed = services.files.onFileRenamed((oldPath, newPath) => {
    const item = catalogStore.getSnapshot().items.find((i) => i.filePath === oldPath);
    if (!item) return;
    void services.catalog.updateItem(item.machineId, item.id, {
      filePath: newPath,
      type: inferItemType(newPath),
    });
  });

  // `paths` may name a deleted directory, not only individual files — a
  // deleted item's filePath is matched by isSubpath against every deleted
  // path (matching the deleted workspace.ts's own closeItemsForDeletedPaths),
  // not by exact-string membership.
  const offDeleted = services.files.onFilesDeleted((paths) => {
    const items = catalogStore
      .getSnapshot()
      .items.filter(
        (i) => i.filePath !== undefined && paths.some((deleted) => isSubpath(deleted, i.filePath!)),
      );
    for (const item of items) void services.catalog.removeItem(item.machineId, item.id);
  });

  return () => {
    offRenamed();
    offDeleted();
  };
}

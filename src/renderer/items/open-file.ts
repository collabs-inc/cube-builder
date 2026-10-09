/**
 * Opens a file path as a catalog item, then displays it — the file-side
 * counterpart to `createTerminalItem` (TerminalItem.tsx): identity (the
 * catalog item) is minted via `services.catalog.addItem`, and only once
 * that resolves does `focusItem` give it a pane. Two callers need exactly
 * this: the file tree's row click and drag-drop.ts's Finder/nav-internal
 * drop, both of which used to call the deleted `workspace.ts`'s `openFile`
 * directly.
 */



import { LOCAL_MACHINE_ID } from "@port/shared/types";
import type { CatalogItemType } from "@port/shared/catalog";
import type { CatalogAddItemArgs } from "../services/types";
import { services } from "../services";
import { catalogStore, inferItemType } from "../state/catalog";
import { focusItem } from "../state/workspace";

/** Resolve only catalog ownership on this installation; never route remotely. */
export function resolveMachineId(repoId: string | undefined, _path?: string): string | null {
  const repo = catalogStore.getSnapshot().repos.find(r => r.id === repoId);
  return repo === undefined || repo.machineId === LOCAL_MACHINE_ID ? LOCAL_MACHINE_ID : null;
}

/**
 * The catalog item already open on `path` AS `type`, if any. Compared in
 * the renderer's own path space — absolute for local, virtual `/@cloud/…`
 * for cloud — which is exactly how the catalog store reports `filePath`, so
 * a plain equality is the right test. Scoped to the machine the path would
 * be handed to: two machines can each hold a `/repo/README.md`.
 *
 * The type is part of the question because one file can be open more than
 * one way. cubed registers every top-level `.html` file in a repo as an
 * `artifact` item (cubed/artifact-watch.ts), so a path match alone made a
 * tree click on an HTML file focus its rendered artifact instead of opening
 * an editor — the one file type the tree could not open as code. Matching
 * the type keeps the editor and the artifact as separate items on the same
 * file, and still refuses to mint a second editor for it.
 */
function existingItemFor(machineId: string, path: string, type: CatalogItemType, personaId?: string): string | null {
  const item = catalogStore
    .getSnapshot()
    .items.find((i) => i.machineId === machineId && i.filePath === path && i.type === type && (personaId === undefined || i.personaId === personaId));
  return item?.id ?? null;
}

/**
 * Displays `path`: brings its existing item into view when one is already
 * open on this machine (opening the same file twice should not mint two
 * items), otherwise creates a catalog item for it and displays that.
 * Fire-and-forget by design — callers (tree clicks, drops) are synchronous
 * UI handlers with nothing to await.
 */
/**
 * The catalog item for `path` on its machine — the existing one, else one
 * minted now — WITHOUT displaying it. What a caller that decides the
 * placement itself (a new screen, say) uses; `openFile` is this plus the
 * default placement. Null when no machine can take the file.
 */
export async function ensureFileItem(path: string, options: { repoId?: string; personaId?: string }): Promise<string | null> {
  const machineId = resolveMachineId(options.repoId, path);
  if (machineId === null) return null;
  const type = inferItemType(path);
  // A persona reuses only its own item on the path: one opened onto the
  // main rail earlier is not in its workspace and could not be picked.
  const existing = existingItemFor(machineId, path, type, options.personaId);
  if (existing !== null) return existing;
  const args: CatalogAddItemArgs = { machineId, type, filePath: path };
  if (options.repoId !== undefined) args.repoId = options.repoId;
  // A file opened from a persona's tree pane is the persona's: it lists in
  // its workspace and opens in its column, never on the main rail.
  if (options.personaId !== undefined) args.personaId = options.personaId;
  const { item } = await services.catalog.addItem(args);
  return item.id;
}

export function openFile(path: string, options: { repoId?: string }): void {
  const machineId = resolveMachineId(options.repoId, path);
  if (machineId === null) {
    console.error(`[open-file] no machine to hand ${path} to (cloud repo, none paired)`);
    return;
  }
  const type = inferItemType(path);
  const existing = existingItemFor(machineId, path, type);
  if (existing !== null) {
    focusItem(existing, undefined, options.repoId);
    return;
  }
  const args: CatalogAddItemArgs = { machineId, type, filePath: path };
  if (options.repoId !== undefined) args.repoId = options.repoId;
  services.catalog
    .addItem(args)
    .then(({ item }) => focusItem(item.id, item.type, item.repoId ?? null))
    .catch((err: unknown) => {
      console.error("[open-file] failed to open file:", path, err);
    });
}

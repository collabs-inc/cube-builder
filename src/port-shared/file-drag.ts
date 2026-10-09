/**
 * Whether a drag carries OS files. The affordance promises what dropping
 * will do, so it must not appear for a drag that carries no files: a text
 * selection dragged across the window would otherwise light up every
 * terminal it crossed while offering an upload that cannot happen.
 *
 * A nav-internal TreeView drag sets only `text/plain` (useDragDrop.ts) and
 * so shows no affordance either. It still drops and still opens — the
 * gesture works, it just does not advertise itself. The sidebar's file
 * tree is a drop TARGET as of the external-file drop mode
 * (`packages/components/src/TreeView/external-drop.ts`); the affordance for
 * an OS drag there is the tree's own — hint via `dropHintText("sidebar")`,
 * highlight via `useDragDrop`'s `externalTargetFolder`.
 */
export function carriesFiles(
  dataTransfer:
    | { types?: readonly string[]; items?: ArrayLike<{ kind: string }> | null }
    | null
    | undefined,
): boolean {
  if (dataTransfer?.types?.includes("Files") === true) return true;
  // Not redundant with the above: `types` is what the spec says to read,
  // while scanning `items` for a file is what holds up where a
  // DataTransfer reports its types less faithfully. Both are readable
  // during dragover; `dataTransfer.files` is NOT — browsers keep it empty
  // until the drop, so it cannot be used here.
  const items = dataTransfer?.items;
  if (!items) return false;
  for (let i = 0; i < items.length; i++) {
    if (items[i]?.kind === "file") return true;
  }
  return false;
}

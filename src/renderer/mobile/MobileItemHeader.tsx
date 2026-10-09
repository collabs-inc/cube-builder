/**
 * The narrow item screen's own chrome — back, title, rename — in
 * place of the desktop PaneHeader, which Rail.tsx no longer renders below
 * the breakpoint (its verbs are pane management: zoom, hide, drag — the
 * column vocabulary a phone screen must not speak). Rendered by App.tsx
 * only while narrow with the item screen showing, as a normal flex
 * sibling above the rail, so it also supplies the top clearance the
 * rail's titlebar padding used to (App.css zeroes that under
 * .rail-narrow).
 *
 * Back goes through goNarrowHome — the one back-to-home entry point, so
 * the web build's pushed history entry stays balanced. Rename is the
 * touch home for the verb (the home list's rows deliberately carry only
 * their ✕, per the drawer-era promotion recipe): the pencil swaps the
 * title for an input, Enter/blur commits, Escape cancels — same
 * empty-string-clears semantics as ReposSidebar's commitRename, since
 * both write the same `userTitle` patch and build-item-entry treats a
 * falsy title as absent.
 *
 * No data-tooltip anywhere in mobile chrome: the tooltip system is
 * hover-driven and a tap's synthetic mouseenter strands the label on
 * touch screens (useTooltips now also gates itself on hover support, but
 * mobile surfaces simply don't participate).
 */



import { useEffect, useMemo, useRef, useState } from "react";
import "./MobileItemHeader.css";
import { CaretLeft } from '@phosphor-icons/react/dist/csr/CaretLeft';
import { PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { useWorkspace } from "../state/workspace";
import { useCatalog } from "../state/catalog";
import { goNarrowHome } from "../state/narrow-history";
import { services } from "../services";
import { paneTitle } from "../items/rail-slot";
import { textPresentation } from "../sidebar/text-presentation";
import { TerminalHeaderIcon } from "../items/TerminalHeaderIcon";

export function MobileItemHeader() {
  const { activeItemId, treePanes, machineStatusPanes } = useWorkspace();
  const catalog = useCatalog();
  const item = useMemo(
    () => catalog.items.find((i) => i.id === activeItemId) ?? null,
    [catalog.items, activeItemId],
  );
  // A `tree:` id is never a catalog item — it resolves against `treePanes`
  // instead (see workspace.ts). Reachable narrow only by dragging a window
  // under the breakpoint with a tree pane active; the header still owes
  // that screen its back button.
  const treePane = (activeItemId !== null && !item && (treePanes[activeItemId] ?? machineStatusPanes[activeItemId])) || null;

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);
  // A different item arriving mid-edit (back gesture races, another
  // client's activity) must not commit the old draft against it.
  useEffect(() => {
    setRenaming(false);
  }, [activeItemId]);

  if (!item && !treePane) return null;

  // Tree panes are client-local (never catalog items): no rename verb to
  // offer and no session to report, so their header is just back + name.
  if (!item) {
    return (
      <header className="mobile-item-header">
        <button
          type="button"
          className="mobile-item-back"
          aria-label="Back to list"
          onClick={goNarrowHome}
        >
          <CaretLeft size={16} weight="bold" />
        </button>
        <span className="mobile-item-title" title={treePane!.name}>
          {treePane!.name}
        </span>
      </header>
    );
  }

  const title = paneTitle(item);

  const commit = () => {
    const trimmed = draft.trim();
    // Same clearing sentinel as ReposSidebar's commitRename: an empty
    // rename clears the custom title back to the default label.
    void services.catalog.updateItem(item.machineId, item.id, { userTitle: trimmed });
    setRenaming(false);
  };

  return (
    <header className={`mobile-item-header${item.type === "agent" ? " mobile-item-header-conversation" : ""}`}>
      <button
        type="button"
        className="mobile-item-back"
        aria-label="Back to list"
        onClick={goNarrowHome}
      >
        <CaretLeft size={16} weight="bold" />
      </button>
      {item.type === "term" && <TerminalHeaderIcon target={item.target} />}
      {renaming ? (
        <input
          ref={inputRef}
          className="mobile-item-rename-input"
          aria-label="Item name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setRenaming(false);
            }
          }}
          onBlur={commit}
        />
      ) : (
        <>
          <span className="mobile-item-title" title={title}>
            {textPresentation(title)}
          </span>
          <button
            type="button"
            className="mobile-item-rename"
            aria-label={`Rename ${title}`}
            onClick={() => {
              setDraft(item.userTitle ?? title);
              setRenaming(true);
            }}
          >
            <PencilSimple size={14} weight="regular" />
          </button>
        </>
      )}
    </header>
  );
}

export default MobileItemHeader;

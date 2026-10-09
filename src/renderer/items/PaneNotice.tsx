import { CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import type { CatalogItemType } from "@port/shared/catalog";
import { PaneSkeleton } from "./PaneSkeleton";

/**
 * A pane that cannot show its content yet, or right now: its type's static
 * skeleton under one sentence on a pill of the pane's own surface, with a
 * spinner while something is under way. The one element for every such
 * state — the machine paused, pausing, starting or updating, an artifact
 * loading, a site stopped — so they cannot drift apart.
 */
export function PaneNotice({ type, text, busy = false, className }: {
  type: CatalogItemType | "tree";
  text: string;
  busy?: boolean;
  className?: string;
}) {
  return (
    <div className={`rail-placeholder-body rail-pane-veil${className ? ` ${className}` : ""}`} role="status">
      <PaneSkeleton type={type} />
      <span className="rail-pane-veil-text">
        <span>{busy && <CircleNotch className="manual-machine-spinner" size={13} aria-hidden="true" />}{text}</span>
      </span>
    </div>
  );
}

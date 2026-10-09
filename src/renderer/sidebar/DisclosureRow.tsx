/**
 * The chevron on a sidebar row that can hold children (spec §2.2, §2.6).
 *
 * It takes the row icon's place while the pointer is over the row or focus
 * is within it, so it adds no slot: labels, rails and ticks never move. A
 * row with no children never swaps its icon. The Unscoped header has no
 * icon, so its chevron follows the label instead, hidden at rest without
 * giving up its space. State is rotation only; weight and ink stay put.
 */



import { CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import type { ReactNode } from "react";

export interface RowDisclosure {
  expanded: boolean;
  hasChildren: boolean;
  label: string;
  controls: string;
  summary: { count: number; waiting: boolean };
  onToggle: () => void;
}

export function DisclosureButton({ expanded, label, controls, onToggle }: {
  expanded: boolean;
  label: string;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="disclosure-toggle"
      aria-expanded={expanded}
      aria-controls={controls}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      onClick={(event) => { event.stopPropagation(); onToggle(); }}
      onDoubleClick={(event) => event.stopPropagation()}
      // A press on the chevron must not start a row drag once rows are
      // sortable, and must not read as a row click either.
      onMouseDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <CaretRight size={10} weight="bold" className="disclosure-caret" />
    </button>
  );
}

/**
 * A row's icon box, which also hosts the chevron when the row has children.
 * The chevron is absolutely positioned over the icon and only shown while
 * the row is hovered or focused (ReposSidebar.css), so the box keeps the
 * icon's exact geometry either way.
 */
export function RowLead({ className, title, disclosure, children }: {
  className: string;
  title?: string | undefined;
  disclosure: RowDisclosure | undefined;
  children: ReactNode;
}) {
  const swaps = disclosure !== undefined && disclosure.hasChildren;
  return (
    <span className={`${className}${swaps ? " has-disclosure" : ""}`} title={title}>
      {children}
      {swaps && (
        <DisclosureButton
          expanded={disclosure.expanded}
          label={disclosure.label}
          controls={disclosure.controls}
          onToggle={disclosure.onToggle}
        />
      )}
    </span>
  );
}

export function HiddenSummary({ count, waiting }: { count: number; waiting: boolean }) {
  if (count === 0) return null;
  return (
    <>
      {waiting && (
        <span className="status-dot status-waiting" role="img" title="Waiting for your approval" aria-label="Waiting for your approval" />
      )}
      <span className="disclosure-count" aria-label={`${count} hidden`}>{count}</span>
    </>
  );
}

export const disclosureRegionId = (key: string): string => `disclosure-${key.replace(/:/g, "-")}`;

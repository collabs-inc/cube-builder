// Adapted from src/windows/app/src/sidebar/MiniFolderRow.tsx at 600e05f2294df5c71026b723915306a74c8cfd3a.
import type { MouseEvent, ReactNode } from "react";
import { HiddenSummary, RowLead, type RowDisclosure } from "./DisclosureRow";
import type { SortableBind } from "./SortableRow";
import { RepoIcon } from "./row-icons";

/** Shared folder heading for repos and cwd groups; repo-specific controls are optional. */
export function MiniFolderRow({ name, iconTitle, className, title, active, disclosure, sortable, onClick, onContextMenu, nameAdornment, children }: {
  name: ReactNode;
  iconTitle: string;
  className?: string | undefined;
  title?: string | undefined;
  active?: boolean | undefined;
  disclosure?: RowDisclosure | undefined;
  sortable?: SortableBind | undefined;
  onClick?: (() => void) | undefined;
  onContextMenu?: ((event: MouseEvent) => void) | undefined;
  /** A view control beside the name, before the space reserved for trailing actions. */
  nameAdornment?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`repo-row mini-repo-row${active ? " active-checkout" : ""}${className ? ` ${className}` : ""}`}
      title={title} ref={sortable?.setActivatorNodeRef} {...sortable?.activatorProps}
      onClick={onClick} onContextMenu={onContextMenu}>
      <RowLead className="row-icon" title={iconTitle} disclosure={disclosure}><RepoIcon /></RowLead>
      <span className="row-name">{name}</span>
      {disclosure && !disclosure.expanded && <HiddenSummary {...disclosure.summary} />}
      {nameAdornment}
      {/* The name and collapsed count stay together; controls trail at the right edge. */}
      <span className="mini-repo-spacer" aria-hidden="true" />
      {children}
    </div>
  );
}

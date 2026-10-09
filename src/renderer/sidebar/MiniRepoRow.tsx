/**
 * The mini sidebar's repo row: a folder, the name, and on hover the three
 * actions for its primary checkout. Its worktrees are not rows; their
 * terminals list beneath it with a label (see working-checkout.ts) — unless
 * the row's worktree toggle switches this repo to the nested view.
 */



import { FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import { Sparkle } from '@phosphor-icons/react/dist/csr/Sparkle';
import { Terminal } from '@phosphor-icons/react/dist/csr/Terminal';
import type { RowDisclosure } from "./DisclosureRow";
import type { SortableBind } from "./SortableRow";
import { MiniFolderRow } from "./MiniFolderRow";
import type { RepoInfo } from "./group-entries";

const stopDrag = {
  onMouseDown: (event: React.MouseEvent) => event.stopPropagation(),
  onTouchStart: (event: React.TouchEvent) => event.stopPropagation(),
};

export interface MiniRepoRowProps {
  repo: RepoInfo;
  active: boolean;
  message: { text: string; isError: boolean } | null;
  disclosure?: RowDisclosure | undefined;
  sortable?: SortableBind | undefined;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onRetryRemoval?: (() => void) | undefined;
  onNewAgent?: (() => void) | undefined;
  onNewTerminal?: (() => void) | undefined;
  onOpenFiles?: (() => void) | undefined;
  /** The nested worktree view's switch; absent on the phone list. */
  worktreeView?: { on: boolean; onToggle: () => void } | undefined;
}

function RowAction({ label, tooltip, popup, onAction, children }: {
  label: string; tooltip: string; popup?: "menu"; onAction: () => void; children: React.ReactNode;
}) {
  return (
    <button type="button" {...stopDrag} className="row-action" data-tooltip={tooltip} aria-label={label}
      aria-haspopup={popup} onClick={(event) => { event.stopPropagation(); onAction(); }}>
      {children}
    </button>
  );
}

export function MiniRepoRow(props: MiniRepoRowProps) {
  const { repo, active, message, disclosure, sortable } = props;
  return (
    <MiniFolderRow name={repo.name} iconTitle="Repository" active={active} disclosure={disclosure} sortable={sortable}
      onClick={props.onClick} onContextMenu={props.onContextMenu}
      nameAdornment={props.worktreeView && (
        <button type="button" {...stopDrag} className="mini-worktree-toggle" aria-label="Show worktrees"
          data-tooltip={props.worktreeView.on ? "Hide worktrees" : "Show worktrees"} aria-pressed={props.worktreeView.on}
          onClick={(event) => { event.stopPropagation(); props.worktreeView?.onToggle(); }}>
          <GitBranch size={12} />
        </button>
      )}>
      {message && <span className={`row-detail${message.isError ? " error" : ""}`} title={message.text}>{message.text}</span>}
      {props.onRetryRemoval && (
        <button type="button" {...stopDrag} className="row-action retry-removal" aria-label="Retry removal"
          onClick={(event) => { event.stopPropagation(); props.onRetryRemoval?.(); }}>Retry</button>
      )}
      {props.onNewAgent && <RowAction label="New agent" tooltip="New agent…" popup="menu" onAction={props.onNewAgent}><Sparkle size={12} /></RowAction>}
      {props.onNewTerminal && <RowAction label="New terminal here" tooltip="New terminal here" onAction={props.onNewTerminal}><Terminal size={12} /></RowAction>}
      {props.onOpenFiles && <RowAction label="Browse files" tooltip="Browse files" onAction={props.onOpenFiles}><FolderOpen size={12} /></RowAction>}
    </MiniFolderRow>
  );
}

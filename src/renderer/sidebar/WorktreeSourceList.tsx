// The New Worktree dialog's browsable list: a filter box, the rows for
// whichever of the three list sources is active, and the "Go to #412" escape
// hatch for a PR or issue the fetched page doesn't contain.
//
// One list, not three. `sourceListView` (worktree-lists.ts) reduces PRs,
// issues, and branches to the same row shape, so selection, the dimmed
// already-open treatment, and the empty state are written once here.
import { useState, type ReactNode } from "react";
import { MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import { GitPullRequest } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { Circle } from '@phosphor-icons/react/dist/csr/Circle';
import "../overlays/SearchPicker.css";
import { services } from "../services";
import { parsePastedRef, type DialogState, type SelectableItem } from "./worktree-source";
import { errorText, sourceListView, type CheckedOutRows, type ListState, type SourceLists } from "./worktree-lists";

const FIND_PLACEHOLDER: Record<"pr" | "issue" | "branch", string> = {
  pr: "Filter pull requests, or paste a number or URL",
  issue: "Filter issues, or paste a number or URL",
  branch: "Filter branches",
};

interface Props {
  state: DialogState;
  lists: SourceLists;
  checkedOutBy: CheckedOutRows;
  machineId: string;
  parentId: string;
  query: string;
  onQueryChange: (query: string) => void;
  onPick: (item: SelectableItem) => void;
  /** Focuses the sibling row already holding a branch, instead of picking it. */
  onOpenExisting: (row: { id: string }) => void;
}

function rowClass(picked: boolean, unavailable: boolean): string {
  return `new-worktree-list-row search-picker-row${unavailable ? " unavailable" : ""}${picked ? " selected" : ""}`;
}

/** The list that is being fetched, or the one that failed. Null once loaded. */
function listNote(list: ListState<unknown>): ReactNode {
  if (list.status === "error") {
    return (
      <p className="new-worktree-error search-picker-empty" role="alert">
        {list.error}
      </p>
    );
  }
  if (list.status === "loaded") return null;
  return <p className="search-picker-empty">Loading…</p>;
}

function activeList(state: DialogState, lists: SourceLists): ListState<unknown> {
  if (state.source === "pr") return lists.prs;
  if (state.source === "issue") return lists.issues;
  return lists.branches;
}

export default function WorktreeSourceList(props: Props) {
  const { state, lists, checkedOutBy, query } = props;
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pastePending, setPastePending] = useState(false);

  const view = sourceListView(state, lists, query, checkedOutBy);
  // A pasted `#412` or PR/issue URL the fetched page doesn't already contain.
  const pastedNumber = parsePastedRef(query);
  const pasteKind = state.source === "pr" || state.source === "issue" ? state.source : null;
  const alreadyListed = view.rows.some(
    (r) => r.item.kind !== "branch" && r.item.number === pastedNumber,
  );
  const pasteTarget =
    pasteKind !== null && pastedNumber !== null && !alreadyListed
      ? { kind: pasteKind, number: pastedNumber }
      : null;

  /** Jumps to a PR or issue the fetched page doesn't contain — the daemon
   * looks it up by number, so a pasted link reaches a row the filter can't. */
  async function resolvePasted(kind: "pr" | "issue", number: number): Promise<void> {
    setPastePending(true);
    setPasteError(null);
    try {
      const { machineId, parentId } = props;
      const result = await services.worktrees.resolve(machineId, parentId, kind, number);
      if (result.kind === "pr") {
        const at = checkedOutBy.get(result.pr.headRefName)?.name;
        props.onPick({
          kind: "pr",
          ...result.pr,
          ...(at === undefined ? {} : { checkedOutAt: at }),
        });
      } else {
        props.onPick({ kind: "issue", ...result.issue });
      }
      props.onQueryChange("");
    } catch (err) {
      setPasteError(errorText(err));
    } finally {
      setPastePending(false);
    }
  }

  const note = listNote(activeList(state, lists));
  const SourceIcon = state.source === "branch" ? GitBranch : state.source === "pr" ? GitPullRequest : Circle;

  return (
    <div className="search-picker">
      <label className="search-picker-search" htmlFor="new-worktree-find">
        <MagnifyingGlass className="search-picker-icon" aria-hidden />
        <input
          id="new-worktree-find"
          className="search-picker-input"
          aria-label="Find"
          autoFocus
          placeholder={FIND_PLACEHOLDER[state.source as "pr" | "issue" | "branch"]}
          value={query}
          onChange={(e) => props.onQueryChange(e.target.value)}
        />
      </label>
      {note ? <div className="search-picker-list">{note}</div> : (
        <ul className="new-worktree-list search-picker-list" role="listbox" aria-label={view.ariaLabel}>
          {pasteTarget && (
            <li role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="new-worktree-list-row new-worktree-paste-row search-picker-row"
                disabled={pastePending}
                onClick={() => void resolvePasted(pasteTarget.kind, pasteTarget.number)}
              >
                Go to #{pasteTarget.number}
              </button>
            </li>
          )}
          {view.rows.map((row) => (
            // The <li>s only position; a listbox's children have to be its
            // options, so they hand their implicit listitem role back.
            <li key={row.key} role="presentation">
              <button
                type="button"
                // The listbox's options are these buttons, not the <li>s
                // that position them — without the role a screen reader
                // announces a listbox with nothing in it.
                role="option"
                aria-selected={row.picked}
                className={rowClass(row.picked, Boolean(row.checkedOutAt))}
                onClick={() =>
                  row.checkedOutAt ? props.onOpenExisting(row.checkedOutAt) : props.onPick(row.item)
                }
              >
                <SourceIcon className="search-picker-icon" aria-hidden />
                <span className="search-picker-name" title={row.title}>{row.title}</span>
                {row.checkedOutAt && (
                  <span className="new-worktree-row-note search-picker-meta">Open as "{row.checkedOutAt.name}"</span>
                )}
              </button>
            </li>
          ))}
          {view.rows.length === 0 && !pasteTarget && (
            <li className="new-worktree-list-empty search-picker-empty" role="presentation">
              {view.emptyText}
            </li>
          )}
          {pasteError && (
            <li className="new-worktree-list-error search-picker-empty" role="alert">
              {pasteError}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

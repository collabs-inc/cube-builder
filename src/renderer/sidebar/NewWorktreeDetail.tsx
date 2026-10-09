// The New Worktree dialog's right-hand pane: whichever source list is being
// browsed, the Name and Base fields, and the branch/path preview.
//
// `visibleFields` decides which of the three blocks show, so the asymmetry
// between the four sources stays written down in exactly one place
// (worktree-source.ts). NewWorktreeModal owns the dialog's state and its
// submit; nothing is decided here that isn't a pure function of that state.
import { CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import type { Dispatch, RefObject, SetStateAction } from "react";
import WorktreeSourceList from "./WorktreeSourceList";
import { baseOptions, derivedBranch, selectItem, setBase, setName, visibleFields, type BranchItem, type DialogState } from "./worktree-source";
import type { CheckedOutRows, ListState, SourceLists } from "./worktree-lists";

interface Props {
  state: DialogState;
  setState: Dispatch<SetStateAction<DialogState>>;
  lists: SourceLists;
  checkedOutBy: CheckedOutRows;
  machineId: string;
  parentId: string;
  query: string;
  onQueryChange: (query: string) => void;
  /** Focuses the sibling row already holding a branch, instead of picking it. */
  onOpenExisting: (row: { id: string }) => void;
  collision: boolean;
  previewPath: string;
  nameInputRef: RefObject<HTMLInputElement | null>;
}

/**
 * The Base field: a picker over the repo's own branches, so a base that does
 * not exist stops being expressible.
 *
 * Typing one used to be silently accepted — `canCreate` only rejects a blank
 * base — and the dialog closed on submit, leaving the failure to surface much
 * later as a `failed` worktree row carrying git's `invalid reference` (the
 * daemon resolves `<base>` then `origin/<base>` and gives up; see cubed's
 * `WorktreesService.baseRef`). Nowhere near the field that caused it.
 *
 * A failed branch listing falls back to the free-text input rather than to a
 * picker with nothing in it: `gh`/git failing is not a reason to make the
 * dialog unusable, and a typed base still works whenever the ref is real.
 */
function BaseField({
  base,
  setState,
  branches,
}: {
  base: string;
  setState: Dispatch<SetStateAction<DialogState>>;
  branches: ListState<BranchItem>;
}) {
  const onChange = (value: string): void => setState((s) => setBase(s, value));
  const label = (
    <label className="new-worktree-label" htmlFor="new-worktree-base">
      Base
    </label>
  );

  if (branches.status === "error") {
    return (
      <>
        {label}
        <input
          id="new-worktree-base"
          className="new-worktree-input"
          value={base}
          onChange={(e) => onChange(e.target.value)}
        />
        <p className="new-worktree-hint">Couldn't list branches — type one: {branches.error}</p>
      </>
    );
  }

  return (
    <>
      {label}
      <div className="new-worktree-select-wrap">
        <select
          id="new-worktree-base"
          className="new-worktree-input new-worktree-select"
          value={base}
          onChange={(e) => onChange(e.target.value)}
        >
          {baseOptions(base, branches.items).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <CaretDown className="new-worktree-select-caret" size={11} weight="bold" aria-hidden />
      </div>
    </>
  );
}

function Preview({ branch, path }: { branch: string; path: string }) {
  return (
    <div className="new-worktree-preview">
      <div className="new-worktree-preview-row">
        <span className="new-worktree-preview-label">branch</span>
        <span className="new-worktree-preview-value">{branch}</span>
      </div>
      <div className="new-worktree-preview-row">
        <span className="new-worktree-preview-label">path</span>
        <span className="new-worktree-preview-value">{path}</span>
      </div>
    </div>
  );
}

export default function NewWorktreeDetail(props: Props) {
  const { state, setState, collision } = props;
  // Derived here rather than passed: both are pure functions of `state`, and
  // the fields' asymmetry across the four sources is worktree-source.ts's to
  // own, not something the host should be re-deciding for this pane.
  const fields = visibleFields(state.source);
  const branch = derivedBranch(state);
  return (
    <div className="new-worktree-detail">
      {fields.list && (
        // Keyed by source so switching pr↔issue REMOUNTS the pane. Its
        // paste state (`pasteError`) is about the source it was typed
        // under, and a "no such PR" left standing under the Issue list
        // would be a lie about the list it now sits below.
        <WorktreeSourceList
          key={state.source}
          state={state}
          lists={props.lists}
          checkedOutBy={props.checkedOutBy}
          machineId={props.machineId}
          parentId={props.parentId}
          query={props.query}
          onQueryChange={props.onQueryChange}
          onPick={(item) => setState((s) => selectItem(s, item))}
          onOpenExisting={props.onOpenExisting}
        />
      )}

      {fields.name && (
        <>
          <label className="new-worktree-label" htmlFor="new-worktree-name">
            Name
          </label>
          <input
            id="new-worktree-name"
            ref={props.nameInputRef}
            className="new-worktree-input"
            autoFocus={!fields.list}
            value={state.name}
            onChange={(e) => setState((s) => setName(s, e.target.value))}
          />
          {collision && (
            <p className="new-worktree-error" role="alert">
              A branch named "{branch}" already exists.
            </p>
          )}
        </>
      )}

      {fields.base && (
        <BaseField base={state.base} setState={setState} branches={props.lists.branches} />
      )}

      {branch && <Preview branch={branch} path={props.previewPath} />}
    </div>
  );
}

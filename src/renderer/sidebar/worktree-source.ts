// The New Worktree dialog's logic, kept free of React and IPC so it can be
// unit tested without a DOM — the same split modal-state.ts already uses.
//
// The four sources are NOT parallel: only `new` and `issue` take a base, only
// `new` has no list, and only `issue` prefills a name from what you picked.
// visibleFields is the single place that asymmetry is written down.
import type { WorktreeSource } from "@port/shared/catalog";
import { issueBranchName, slugifyBranch } from "@port/shared/worktree-naming";

export type SourceKind = "new" | "pr" | "issue" | "branch";

export interface PrItem {
  kind: "pr";
  number: number;
  title: string;
  url: string;
  headRefName: string;
  isCrossRepository: boolean;
  /** Name of the worktree row already holding this branch, if any. */
  checkedOutAt?: string;
}

export interface IssueItem {
  kind: "issue";
  number: number;
  title: string;
  url: string;
}

export interface BranchItem {
  kind: "branch";
  name: string;
  remote: boolean;
  checkedOutAt?: string;
}

export type SelectableItem = PrItem | IssueItem | BranchItem;

export interface DialogState {
  source: SourceKind;
  name: string;
  /** True once the user edits the name, so a later selection stops overwriting it. */
  nameEdited: boolean;
  base: string;
  selected: SelectableItem | null;
}

export function initialDialogState(defaultBase: string): DialogState {
  return { source: "new", name: "", nameEdited: false, base: defaultBase, selected: null };
}

export function visibleFields(source: SourceKind): {
  list: boolean;
  name: boolean;
  base: boolean;
} {
  switch (source) {
    case "new":
      return { list: false, name: true, base: true };
    case "issue":
      return { list: true, name: true, base: true };
    default:
      return { list: true, name: false, base: false };
  }
}

export function selectSource(state: DialogState, source: SourceKind): DialogState {
  return { ...state, source, selected: null, name: "", nameEdited: false };
}

export function setName(state: DialogState, name: string): DialogState {
  return { ...state, name, nameEdited: true };
}

/** The base-branch field — only meaningful while `visibleFields(...).base`. */
export function setBase(state: DialogState, base: string): DialogState {
  return { ...state, base };
}

/**
 * The Base picker's options: every branch the repo has, in the order the
 * daemon listed them (locals first, then origin-only ones — see cubed's
 * `WorktreesService.branches`), with `base` guaranteed present.
 *
 * That guarantee is what keeps the picker honest. `base` starts as the repo's
 * default branch, resolved by a `repoInfo` round trip that can land before,
 * after, or instead of the branch list — and a `<select>` whose value matches
 * no option renders the first one instead, which would submit a base the user
 * never chose. Prepending covers all three cases at once: nothing fetched yet
 * (loading), nothing fetchable (the error fallback's own state), and a default
 * branch the listing genuinely doesn't carry.
 */
export function baseOptions(base: string, branches: BranchItem[]): string[] {
  const names = branches.map((b) => b.name);
  if (base === "" || names.includes(base)) return names;
  return [base, ...names];
}

export function selectItem(state: DialogState, item: SelectableItem): DialogState {
  const next = { ...state, selected: item };
  if (item.kind === "issue" && !state.nameEdited) {
    return { ...next, name: item.title };
  }
  return next;
}

/**
 * The branch that will be created or checked out, live for the preview.
 *
 * An issue-sourced branch always keeps its `<number>-` prefix, even after
 * the name is edited — that prefix is what ties the branch back to the
 * issue (`src/main/cubed/worktree-creation.ts`'s `deriveBranch` applies
 * `issueBranchName` unconditionally for an `issue` source, so a preview
 * that dropped the number on edit would show a branch name the daemon
 * would never actually create). The daemon reads the title off
 * `source.title`, so the dialog sends the edited name there too.
 */
export function derivedBranch(state: DialogState): string {
  const selected = state.selected;
  if (state.source === "pr") return selected?.kind === "pr" ? selected.headRefName : "";
  if (state.source === "branch") return selected?.kind === "branch" ? selected.name : "";
  if (state.source === "issue" && selected?.kind === "issue") {
    return issueBranchName(selected.number, state.name);
  }
  return state.name.trim() === "" ? "" : slugifyBranch(state.name);
}

function checkedOutAt(item: SelectableItem | null): string | undefined {
  if (!item) return undefined;
  return item.kind === "issue" ? undefined : item.checkedOutAt;
}

export function canCreate(state: DialogState): boolean {
  if (checkedOutAt(state.selected)) return false;
  const fields = visibleFields(state.source);
  if (fields.list && !state.selected) return false;
  // An empty Base would reach `git worktree add` as `-b <branch> ""` and land
  // as a failed row. The picker can't produce one, but its free-text fallback
  // (a failed branch listing — see NewWorktreeDetail's BaseField) can, and so
  // can a repo whose default branch never resolved.
  if (fields.base && state.base.trim() === "") return false;
  return derivedBranch(state) !== "";
}

/** A pasted `#412`, `412`, or GitHub PR/issue URL, else null. */
export function parsePastedRef(input: string): number | null {
  const trimmed = input.trim();
  const url = /github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)/.exec(trimmed);
  if (url?.[1]) return Number.parseInt(url[1], 10);
  const bare = /^#?(\d+)$/.exec(trimmed);
  return bare?.[1] ? Number.parseInt(bare[1], 10) : null;
}

/**
 * True when the branch this dialog is about to *cut* (only `new` and
 * `issue` cut a new branch — `pr` and `branch` check out one that already
 * exists) exactly matches a branch name already known to be taken.
 * `existingBranches` is caller-supplied: sibling worktree rows' branches at
 * minimum, plus any fetched branch list.
 */
export function branchCollision(state: DialogState, existingBranches: string[]): boolean {
  if (state.source !== "new" && state.source !== "issue") return false;
  const branch = derivedBranch(state);
  return branch !== "" && existingBranches.includes(branch);
}

/**
 * The `{ name, source }` the daemon will re-derive the branch from —
 * `WorktreeCreation.deriveBranch` reads `source.title` for an issue and
 * `name` for everything else, so the two halves have to agree.
 *
 * That is why an issue's title is `state.name` rather than the picked
 * issue's own title: the name field is editable, and sending the original
 * title would land the row on a branch this dialog never previewed.
 */
export function createPayload(state: DialogState): { name: string; source: WorktreeSource } {
  const selected = state.selected;
  if (state.source === "pr" && selected?.kind === "pr") {
    return {
      name: selected.headRefName,
      source: { from: "pr", number: selected.number, url: selected.url, title: selected.title },
    };
  }
  if (state.source === "branch" && selected?.kind === "branch") {
    return { name: selected.name, source: { from: "branch" } };
  }
  if (state.source === "issue" && selected?.kind === "issue") {
    return {
      name: state.name,
      source: { from: "issue", number: selected.number, url: selected.url, title: state.name },
    };
  }
  return { name: state.name, source: { from: "new" } };
}

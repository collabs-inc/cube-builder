// The New Worktree dialog's data plumbing: fetching the three browsable
// source lists off the owning machine, and deciding which of their rows a
// sibling worktree row already holds. Split out of NewWorktreeModal so the
// component is presentation — the same split worktree-source.ts makes for
// the dialog's decisions.
import { useEffect, useMemo, useRef, useState } from "react";
import type { RepoInfo } from "@port/shared/types";
import { services } from "../services";
import { visibleFields, type BranchItem, type DialogState, type IssueItem, type PrItem, type SelectableItem, type SourceKind } from "./worktree-source";

export type ListStatus = "idle" | "loading" | "loaded" | "error";

export interface ListState<T> {
  status: ListStatus;
  items: T[];
  /** Set only for `status: "error"` — the daemon's own reason text. */
  error?: string;
}

function idleList<T>(): ListState<T> {
  return { status: "idle", items: [] };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The worktree row holding a given branch, keyed by that branch. */
export type CheckedOutRows = Map<string, { id: string; name: string }>;

/**
 * One browsable list — PR, issue, or branch — fetched at most once per
 * `resetKey` and only once `active` (its source is the one being browsed).
 *
 * Two effects rather than one because the fetch's cleanup must not be torn
 * down by the very state change that armed it: the first effect only flips
 * idle -> loading, the second owns the request. `resetKey` is in both, so a
 * reopen (or a different repo) discards a list AND cancels an in-flight
 * fetch that would otherwise resolve into the new repo's dialog.
 */
function useRemoteList<T>(
  active: boolean,
  resetKey: string,
  fetchList: () => Promise<T[]>,
): ListState<T> {
  const [state, setState] = useState<ListState<T>>(() => idleList<T>());
  const fetchRef = useRef(fetchList);

  // Declared first so it has already republished the current render's closure
  // by the time the fetch effect below reads it in the same commit. Writing a
  // ref during render would be simpler and is what React tells you not to do.
  useEffect(() => {
    fetchRef.current = fetchList;
  });

  useEffect(() => {
    setState((s) => (s.status === "idle" ? s : idleList<T>()));
  }, [resetKey]);

  useEffect(() => {
    if (!active) return;
    setState((s) => (s.status === "idle" ? { status: "loading", items: [] } : s));
  }, [active, resetKey]);

  useEffect(() => {
    if (state.status !== "loading") return;
    let cancelled = false;
    fetchRef
      .current()
      .then((items) => {
        if (!cancelled) setState({ status: "loaded", items });
      })
      .catch((err: unknown) => {
        // The daemon's reason, verbatim and inline. There is deliberately no
        // sign-in affordance here: a signed-out `gh` is one of many reasons
        // this can fail, and the app-wide gate owns sign-in.
        if (!cancelled) setState({ status: "error", items: [], error: errorText(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [state.status, resetKey]);

  return state;
}

/**
 * Every branch this repo already has checked out somewhere, keyed by the
 * VERBATIM branch name, so a PR's `headRefName` or a branch row's name is
 * compared against it as-is; the `new` and `issue` sources reach the same map
 * through `derivedBranch`, which applies the daemon's own derivation. Slugging
 * either side would put the two out of step.
 *
 * Keyed on the LIVE branch (`head`), not on the branch a row was created
 * with: git refuses a second checkout of a branch that is checked out
 * anywhere right now, so the question this answers is a question about now.
 * A row whose head is not yet known — a worktree still being created — falls
 * back to `createdOnBranch`, which is the branch it is in the middle of
 * claiming.
 *
 * The parent repo's own working copy is in the map too. It is a checkout like
 * any other and git blocks it like any other; leaving it out offered branches
 * that could only fail.
 */
export function useCheckedOutRows(
  repos: RepoInfo[],
  parentId: string,
): { siblings: RepoInfo[]; checkedOutBy: CheckedOutRows } {
  const siblings = useMemo(
    () => repos.filter((p) => p.worktreeOf?.repoId === parentId),
    [repos, parentId],
  );
  const parent = useMemo(() => repos.find((p) => p.id === parentId), [repos, parentId]);
  const checkedOutBy = useMemo(() => {
    const map: CheckedOutRows = new Map();
    for (const row of parent ? [parent, ...siblings] : siblings) {
      const branch = row.head ? row.head.branch : (row.worktreeOf?.createdOnBranch ?? null);
      if (branch !== null) map.set(branch, { id: row.id, name: row.name });
    }
    return map;
  }, [parent, siblings]);
  return { siblings, checkedOutBy };
}

export interface SourceLists {
  prs: ListState<PrItem>;
  issues: ListState<IssueItem>;
  branches: ListState<BranchItem>;
  /** Every branch name known to be taken — the collision check's input. */
  existingBranches: string[];
}

interface SourceListsArgs {
  open: boolean;
  source: SourceKind;
  machineId: string | null;
  parentId: string;
  checkedOutBy: CheckedOutRows;
}

/**
 * The three lists, each fetched the first time it is needed and decorated
 * with the sibling row already holding that branch. `resetKey` goes empty
 * while the dialog is closed or unroutable, which is what discards a previous
 * repo's lists.
 *
 * The branch list is needed by more than the source that browses it: it also
 * populates the Base picker, so it loads for any source showing that field
 * (`visibleFields(source).base` — `new` and `issue`). That is also what gives
 * `branchCollision` a real branch list under those two sources, instead of
 * only the branches sibling worktree rows happen to hold.
 */
export function useSourceLists({
  open,
  source,
  machineId,
  parentId,
  checkedOutBy,
}: SourceListsArgs): SourceLists {
  const resetKey = open && machineId && parentId ? `${machineId}:${parentId}` : "";

  const prs = useRemoteList(open && source === "pr", resetKey, async () => {
    if (!machineId) return [];
    const { prs: fetched } = await services.worktrees.listPrs(machineId, parentId);
    return fetched.map((pr): PrItem => ({ kind: "pr", ...pr }));
  });
  const issues = useRemoteList(open && source === "issue", resetKey, async () => {
    if (!machineId) return [];
    const { issues: fetched } = await services.worktrees.listIssues(machineId, parentId);
    return fetched.map((issue): IssueItem => ({ kind: "issue", ...issue }));
  });
  const branchesNeeded = source === "branch" || visibleFields(source).base;
  const branches = useRemoteList(open && branchesNeeded, resetKey, async () => {
    if (!machineId) return [];
    const { branches: fetched } = await services.worktrees.listBranches(machineId, parentId);
    return fetched.map((b): BranchItem => ({ kind: "branch", ...b }));
  });

  // Decorated after the fetch, not inside it: which row holds a branch changes
  // as sibling rows come and go, and re-fetching a PR list to notice that
  // would be absurd.
  const decoratedPrs = useMemo(
    () => decorate(prs, (pr) => checkedOutBy.get(pr.headRefName)?.name),
    [prs, checkedOutBy],
  );
  const decoratedBranches = useMemo(
    () => decorate(branches, (b) => checkedOutBy.get(b.name)?.name),
    [branches, checkedOutBy],
  );
  const existingBranches = useMemo(
    () => [...checkedOutBy.keys(), ...branches.items.map((b) => b.name)],
    [checkedOutBy, branches.items],
  );

  return { prs: decoratedPrs, issues, branches: decoratedBranches, existingBranches };
}

function decorate<T extends { checkedOutAt?: string }>(
  list: ListState<T>,
  rowFor: (item: T) => string | undefined,
): ListState<T> {
  return {
    ...list,
    items: list.items.map((item) => {
      const at = rowFor(item);
      return at === undefined ? item : { ...item, checkedOutAt: at };
    }),
  };
}

/** One row of whichever list is being browsed, ready to render. */
export interface SourceRow {
  key: string;
  /** The row's whole visible label, `#412 Bump lodash` for a PR. */
  title: string;
  /** The sibling worktree row already holding this branch, if any. */
  checkedOutAt?: { id: string; name: string };
  item: SelectableItem;
  picked: boolean;
}

export interface SourceListView {
  ariaLabel: string;
  /** Shown when `rows` is empty and no pasted-ref row is offered. */
  emptyText: string;
  rows: SourceRow[];
}

function isPicked(selected: SelectableItem | null, item: SelectableItem): boolean {
  if (!selected || selected.kind !== item.kind) return false;
  if (item.kind === "branch") return selected.kind === "branch" && selected.name === item.name;
  return selected.kind !== "branch" && selected.number === item.number;
}

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.trim().toLowerCase());
}

/**
 * The filtered rows for the source being browsed. The three lists differ only
 * in their label, their empty-state copy, and how a row reads — everything
 * downstream (selection, dimming, the "Open as" note) is uniform, so it is
 * written once here instead of three times in JSX.
 *
 * `checkedOutAt` is carried on the items themselves (useSourceLists decorates
 * them); this only looks the row back up so a click can focus it.
 */
export function sourceListView(
  state: DialogState,
  lists: SourceLists,
  query: string,
  checkedOutBy: CheckedOutRows,
): SourceListView {
  const row = (key: string, title: string, item: SelectableItem, branch?: string): SourceRow => {
    const at = branch === undefined ? undefined : checkedOutBy.get(branch);
    return {
      key,
      title,
      item,
      picked: isPicked(state.selected, item),
      ...(at ? { checkedOutAt: at } : {}),
    };
  };
  if (state.source === "pr") {
    const rows = lists.prs.items
      .filter((pr) => matches(pr.title, query) || String(pr.number).includes(query))
      .map((pr) => row(String(pr.number), `#${pr.number} ${pr.title}`, pr, pr.headRefName));
    return { ariaLabel: "Pull requests", emptyText: "No open pull requests.", rows };
  }
  if (state.source === "issue") {
    const rows = lists.issues.items
      .filter((issue) => matches(issue.title, query) || String(issue.number).includes(query))
      .map((issue) => row(String(issue.number), `#${issue.number} ${issue.title}`, issue));
    return { ariaLabel: "Issues", emptyText: "No open issues.", rows };
  }
  const rows = lists.branches.items
    .filter((b) => matches(b.name, query))
    .map((b) => row(b.name, b.name, b, b.name));
  return { ariaLabel: "Branches", emptyText: "No branches match.", rows };
}

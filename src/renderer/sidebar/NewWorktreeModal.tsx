// New Worktree dialog: a source (new branch / PR / issue / existing branch)
// picked from a left rail, a detail pane on the right, and a live branch +
// path preview. This file is the dialog shell and the submit; the decisions
// live in worktree-source.ts, the fetching in worktree-lists.ts, and the pane
// in NewWorktreeDetail.tsx / WorktreeSourceList.tsx.
//
// Every `services.worktrees.*` call takes the owning machine's id first:
// the repo whose worktree is being cut lives in exactly one machine's
// catalog, and the sidebar already knows which (see ReposSidebar's
// `machineIdForRepo`), so nothing here has to look a machine up.
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Dialog, DialogButton } from "../overlays/Dialog";
import { freeWorktreePath, slugifyBranch } from "@port/shared/worktree-naming";
import type { RepoInfo } from "@port/shared/types";
import { services } from "../services";
import { setActive as setActiveRepo, useRepos } from "../state/repos";
import { trackCreatedRepo } from "../state/repo-ready";
import NewWorktreeDetail from "./NewWorktreeDetail";
import { errorText, useCheckedOutRows, useSourceLists } from "./worktree-lists";
import { branchCollision, canCreate, createPayload, derivedBranch, initialDialogState, selectSource, visibleFields, type DialogState, type SourceKind } from "./worktree-source";
import "./NewWorktreeModal.css";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The repo worktrees will be cut from; null while none is chosen. */
  parent: RepoInfo | null;
  /**
   * The machine whose catalog holds `parent`. Null only for a cloud repo
   * whose machine isn't known yet — the dialog renders nothing rather than
   * offering calls it cannot route.
   */
  machineId: string | null;
}

/**
 * What the rail and the base field show until `repoInfo()` answers. Both are
 * fail-open guesses, not configuration: hiding the GitHub sources while that
 * round trip is in flight would flicker away two of the four sources on every
 * open, and every repo this dialog can reach has SOME default branch.
 */
const ASSUME_GITHUB_REMOTE = true;
const ASSUME_BASE = "main";

const RAIL: { kind: SourceKind; label: string }[] = [
  { kind: "new", label: "New branch" },
  { kind: "pr", label: "Pull request" },
  { kind: "issue", label: "Issue" },
  { kind: "branch", label: "Existing branch" },
];

/**
 * The daemon's managed worktrees root is `$HOME/.cube/worktrees` (cubed's
 * `worktreesDir` — src/main/cubed/server.ts). The renderer cannot know that
 * HOME (a cloud repo's daemon has a different one), so the preview shows the
 * tilde form and maps sibling rows' absolute paths into the same root, which
 * is what makes the `-2` collision suffix comparable at all.
 */
const MANAGED_ROOT = "~/.cube/worktrees";
const MANAGED_ROOT_MARKER = "/.cube/worktrees/";

function underManagedRoot(absPath: string): string {
  const at = absPath.indexOf(MANAGED_ROOT_MARKER);
  if (at === -1) return absPath;
  return `${MANAGED_ROOT}/${absPath.slice(at + MANAGED_ROOT_MARKER.length)}`;
}

/**
 * Where the worktree will land. The daemon builds the directory under
 * `basename(parent.root)` and slugs the branch first (WorktreeCreation.create),
 * so a PR branch like `dependabot/npm_and_yarn/x` previews as the path it will
 * actually get rather than a hand-flattened variant. A cloud repo has no
 * renderer-visible root, so its name — the bare repo name it was cloned as —
 * stands in for the basename.
 */
function previewPathFor(parent: RepoInfo, branch: string, siblings: RepoInfo[]): string {
  if (!branch) return "";
  const repoSlug = parent.path
    ? (parent.path.split("/").filter(Boolean).pop() ?? parent.name)
    : parent.name;
  const taken = siblings
    .map((w) => w.path)
    .filter((p): p is string => Boolean(p))
    .map(underManagedRoot);
  return freeWorktreePath(MANAGED_ROOT, repoSlug, slugifyBranch(branch), taken);
}

/**
 * Asks the owning machine what the repo actually is — no prop can substitute
 * for that. Fetches once per open and republishes the real answer (see
 * CubedWorktrees.repoInfo). A source showing on the fail-open guess gets
 * swapped back to `new` if the repo turns out to have no GitHub remote; the
 * base field is only overwritten while the user hasn't changed it themselves.
 */
function useRepoInfo(
  open: boolean,
  machineId: string | null,
  parentId: string,
  setState: Dispatch<SetStateAction<DialogState>>,
): boolean {
  const [hasGithubRemote, setHasGithubRemote] = useState(ASSUME_GITHUB_REMOTE);

  useEffect(() => {
    if (!open) return;
    setHasGithubRemote(ASSUME_GITHUB_REMOTE);
  }, [open, parentId]);

  useEffect(() => {
    if (!open || !machineId || !parentId) return;
    let cancelled = false;
    services.worktrees
      .repoInfo(machineId, parentId)
      .then((info) => {
        if (cancelled) return;
        setHasGithubRemote(info.hasGithubRemote);
        if (!info.hasGithubRemote) {
          setState((s) => (s.source === "pr" || s.source === "issue" ? selectSource(s, "new") : s));
        }
        const resolved = info.defaultBranch;
        if (resolved) setState((s) => (s.base === ASSUME_BASE ? { ...s, base: resolved } : s));
      })
      .catch(() => {
        // Best-effort metadata — keep showing the fail-open guesses.
      });
    return () => {
      cancelled = true;
    };
  }, [open, machineId, parentId, setState]);

  return hasGithubRemote;
}

interface DialogForm {
  state: DialogState;
  setState: Dispatch<SetStateAction<DialogState>>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  submitError: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
}

/**
 * The dialog's own form state, wiped on every open. The modal stays mounted
 * across close/reopen (ReposSidebar toggles `open`), so without the reset a
 * reopen would show the previous repo's selection. The source lists reset
 * themselves, off their own key.
 */
function useDialogForm(open: boolean, parentId: string): DialogForm {
  const [state, setState] = useState<DialogState>(() => initialDialogState(ASSUME_BASE));
  const [query, setQuery] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setState(initialDialogState(ASSUME_BASE));
    setQuery("");
    setSubmitError(null);
  }, [open, parentId]);

  return { state, setState, query, setQuery, submitError, setError: setSubmitError };
}

/**
 * Creation is row-first: this resolves as soon as the pending row is in the
 * catalog, so the dialog closes immediately and the row itself is the progress
 * indicator. Nothing waits on git. A rejection is the daemon refusing to write
 * the row at all, and surfaces inline with the dialog still open.
 *
 * The returned id opens an empty checkout screen immediately, before this
 * client necessarily receives the catalog row. It is also registered with
 * `state/repo-ready.ts`, which is what makes THIS client — and only this
 * client — open the worktree's default agent terminal once the
 * row goes ready.
 */
async function submitWorktree(
  machineId: string,
  parentId: string,
  state: DialogState,
): Promise<void> {
  const { name, source } = createPayload(state);
  const fields = visibleFields(state.source);
  const { id } = await services.worktrees.create(machineId, {
    parentId,
    name,
    source,
    ...(fields.base ? { baseBranch: state.base.trim() } : {}),
  });
  setActiveRepo(id, { allowPending: true });
  trackCreatedRepo(id);
}

function ModalFooter({
  disabled,
  onCancel,
  onCreate,
}: {
  disabled: boolean;
  onCancel: () => void;
  onCreate: () => void;
}) {
  return (
    <>
      <div className="new-worktree-actions">
        <DialogButton shortcut="Escape" className="new-worktree-button" onClick={onCancel}>
          Cancel
        </DialogButton>
        <DialogButton
          variant="primary"
          className="new-worktree-button primary"
          disabled={disabled}
          onClick={onCreate}
        >
          Create worktree
        </DialogButton>
      </div>
    </>
  );
}

function SourceRail({
  source,
  hasGithubRemote,
  onSelect,
}: {
  source: SourceKind;
  hasGithubRemote: boolean;
  onSelect: (kind: SourceKind) => void;
}) {
  const rail = RAIL.filter((r) => hasGithubRemote || (r.kind !== "pr" && r.kind !== "issue"));
  return (
    <div className="new-worktree-rail" role="tablist" aria-label="Worktree source">
      {rail.map((r) => (
        <button
          key={r.kind}
          type="button"
          role="tab"
          aria-selected={source === r.kind}
          className={`new-worktree-rail-item${source === r.kind ? " active" : ""}`}
          onClick={() => onSelect(r.kind)}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

export default function NewWorktreeModal({ open, onClose, parent, machineId }: Props) {
  const { repos } = useRepos();
  const parentId = parent?.id ?? "";

  const { state, setState, query, setQuery, submitError, setError } = useDialogForm(open, parentId);
  const [pending, setPending] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const hasGithubRemote = useRepoInfo(open, machineId, parentId, setState);
  const { siblings, checkedOutBy } = useCheckedOutRows(repos, parentId);
  const lists = useSourceLists({ open, source: state.source, machineId, parentId, checkedOutBy });

  const collision = branchCollision(state, lists.existingBranches);
  useEffect(() => {
    if (collision) nameInputRef.current?.focus();
  }, [collision]);

  const branch = derivedBranch(state);
  const submittable = canCreate(state) && !collision;

  if (!open || !parent || !machineId) return null;
  const routedMachineId = machineId;

  function close(): void {
    setError(null);
    onClose();
  }

  function switchSource(kind: SourceKind): void {
    setState((s) => selectSource(s, kind));
    setQuery("");
    setError(null);
  }

  function openExisting(row: { id: string }): void {
    const repo = repos.find((repo) => repo.id === row.id);
    if (!repo) return;
    setActiveRepo(row.id);
    close();
  }

  async function handleCreate(): Promise<void> {
    if (!submittable || pending) return;
    setPending(true);
    setError(null);
    try {
      await submitWorktree(routedMachineId, parentId, state);
      close();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      title="New worktree"
      size="lg"
      className="new-worktree-modal"
      overlayClassName="new-worktree-overlay"
      onClose={close}
      actions={<ModalFooter disabled={!submittable || pending} onCancel={close} onCreate={() => void handleCreate()} />}
    >
        <p className="new-worktree-subtitle">{parent.name}</p>

        <div className="new-worktree-body">
          <SourceRail
            source={state.source}
            hasGithubRemote={hasGithubRemote}
            onSelect={switchSource}
          />
          <NewWorktreeDetail
            state={state}
            setState={setState}
            lists={lists}
            checkedOutBy={checkedOutBy}
            machineId={routedMachineId}
            parentId={parentId}
            query={query}
            onQueryChange={setQuery}
            onOpenExisting={openExisting}
            collision={collision}
            previewPath={previewPathFor(parent, branch, siblings)}
            nameInputRef={nameInputRef}
          />
        </div>

      {submitError && <p className="new-worktree-error" role="alert">{submitError}</p>}
    </Dialog>
  );
}

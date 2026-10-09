// The remove-confirm detail is assembled, not templated: git refuses a dirty
// worktree on its own, but discards unpushed commits without complaint, so
// both counts have to be named — and a count of zero must be omitted rather
// than printed as "0 unpushed commits", which reads as a warning about
// nothing.
//
// Two removals, two functions, and they are not variants of each other.
// Removing a WORKTREE leaves the repo and its branches standing, so its copy
// can reassure. Removing a REPO may delete the clone that holds every one of
// those branches, so its copy has a fate to establish before it can name any
// count at all — which is what issue #139's "Files on disk are untouched."
// got wrong on a row that was deleting them.

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The confirm dialog's detail line for removing a worktree, naming exactly
 * what the removal discards.
 *
 * Args:
 *   inspect: The daemon's count of uncommitted files and unpushed commits.
 *
 * Returns:
 *   The detail text — what is lost plus "The branch is kept.", or, with
 *   nothing to lose, the reassurance that only the checkout goes.
 */
export function removeConfirmDetail(inspect: {
  dirty: number;
  unpushedCommits: number;
}): string {
  const parts: string[] = [];
  if (inspect.dirty > 0) parts.push(plural(inspect.dirty, "uncommitted file", "uncommitted files"));
  if (inspect.unpushedCommits > 0) {
    parts.push(plural(inspect.unpushedCommits, "unpushed commit", "unpushed commits"));
  }
  if (parts.length === 0) return "The branch is kept. Only the checkout is removed.";
  return `${parts.join(" and ")} will be discarded. The branch is kept.`;
}

/**
 * What removal does to the repo's OWN working copy — the fact the confirm
 * copy turns on, and the one the old copy got wrong. A directory the user
 * picked is `"kept"`: cubed only ever references it, so removal really is
 * registry-only. cubed's own clones are deleted outright, `.git` included,
 * which is why they read as a different thing entirely.
 */
export type RepoCheckoutFate = "kept" | "deleted" | "deleted-on-cloud";

export interface RepoRemoveConfirmInput {
  checkout: RepoCheckoutFate;
  /** What the daemon found in the repo's own working copy. Null when there
   * is nothing to lose (`"kept"`) or nothing to read (the directory is
   * already gone) — never a fabricated zero, which would read as a promise. */
  inspect: { dirty: number; unpushedCommits: number } | null;
  /** The branch those counts belong to. They are HEAD's, not the clone's, so
   * they are always attributed rather than left to imply a whole-clone tally. */
  branch: string | null;
  /** How many worktree rows nest under the repo (`worktreeCountFor`). */
  worktreeCount: number;
}

const CHECKOUT_FATE_COPY: Record<RepoCheckoutFate, string> = {
  kept: "Its items will be closed. The repo folder on disk is untouched.",
  deleted: "Its clone will be deleted, with every branch in it.",
  "deleted-on-cloud":
    "Its clone on the cloud machine will be deleted, with every branch in it.",
};

/** The counts sentence, or null when there is nothing to name. Attributed to
 * a branch on purpose: `worktree:inspect` answers for HEAD, and an
 * unattributed "12 unpushed commits" would read as the clone's whole total. */
function checkoutLoss(input: RepoRemoveConfirmInput): string | null {
  const { inspect } = input;
  if (!inspect) return null;
  const parts: string[] = [];
  if (inspect.dirty > 0) parts.push(plural(inspect.dirty, "uncommitted file", "uncommitted files"));
  if (inspect.unpushedCommits > 0) {
    parts.push(plural(inspect.unpushedCommits, "unpushed commit", "unpushed commits"));
  }
  if (parts.length === 0) return null;
  return `${parts.join(" and ")} on ${input.branch ?? "the current branch"} will be discarded.`;
}

/**
 * The confirm dialog's detail line for removing a REPO, assembled from what
 * the removal actually does rather than templated per `kind`.
 *
 * Three sentences, each earning its place. What happens to the repo's own
 * working copy comes first, because that is the difference between a
 * registry entry going away and a clone being deleted. The daemon's
 * inspection of that working copy comes next, and only when the checkout is
 * one that goes — a kept folder discards nothing, so there is nothing to
 * count. The worktree cascade comes last: `catalog:remove-repo` on a repo
 * force-removes its worktrees before the repo itself, with
 * `git worktree remove --force`, which deletes those checkout directories —
 * uncommitted work included — rather than just detaching the rows.
 *
 * "Branches are kept." rides on the cascade line ONLY when the repo's own
 * checkout survives. A worktree removal inside a surviving repo really does
 * keep its branch, which is what that sentence promises; when the clone is
 * going, the `.git` holding those branches goes with it and the promise
 * would be a lie.
 *
 * Returns:
 *   The assembled detail, one to three sentences, space-joined.
 */
export function repoRemoveConfirmDetail(input: RepoRemoveConfirmInput): string {
  const sentences: string[] = [CHECKOUT_FATE_COPY[input.checkout]];
  const loss = checkoutLoss(input);
  if (loss) sentences.push(loss);
  if (input.worktreeCount > 0) {
    const checkouts = plural(input.worktreeCount, "worktree checkout", "worktree checkouts");
    sentences.push(`Its ${checkouts} will be deleted too, uncommitted work included.`);
    if (input.checkout === "kept") sentences.push("Branches are kept.");
  }
  return sentences.join(" ");
}

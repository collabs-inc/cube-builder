/**
 * The sidebar's icon vocabulary, in one place because its whole value is
 * being one system rather than five local choices.
 *
 * Two rules hold it together:
 *
 * 1. **Shape carries rank, and every rank's shape is distinct.** A repo is a
 *    folder, a checkout is that folder counted — one for the repo's own,
 *    doubled for a linked worktree — and an item is its own kind of thing. Before this, repos and worktrees shared `BookBookmark` and
 *    the only thing separating the two ranks was 14px of indent.
 * 2. **Color carries which agent a terminal is running** — the fact that
 *    actually varies row to row and the one people scan for. The one other
 *    hue is the artifact globe's light blue, because at 14px a monochrome
 *    globe reads as the eye of the visibility toggle beside it. Everything
 *    else — repos, checkouts, notes, code, images, PDFs, plain shells — is
 *    monochrome. A PDF glyph already says PDF; it does not also need to be
 *    red.
 */



import type { Icon } from "@phosphor-icons/react";
import { AppWindow } from '@phosphor-icons/react/dist/csr/AppWindow';
import { BracketsAngle } from '@phosphor-icons/react/dist/csr/BracketsAngle';
import { Code } from '@phosphor-icons/react/dist/csr/Code';
import { FilePdf } from '@phosphor-icons/react/dist/csr/FilePdf';
import { Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { Folders } from '@phosphor-icons/react/dist/csr/Folders';
import { GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import { GitCommit } from '@phosphor-icons/react/dist/csr/GitCommit';
import { Globe } from '@phosphor-icons/react/dist/csr/Globe';
import { HardDrive } from '@phosphor-icons/react/dist/csr/HardDrive';
import { Image } from '@phosphor-icons/react/dist/csr/Image';
import { Note } from '@phosphor-icons/react/dist/csr/Note';
import { Terminal } from '@phosphor-icons/react/dist/csr/Terminal';
import type { CatalogItemType } from "@port/shared/catalog";
import { AGENT_HARNESS_IDS, type AgentHarnessId } from "@port/shared/types";
import type { RepoInfo } from "@port/shared/types";
import { PrismMark } from "./prism-mark";
import claudeLogo from "../assets/claude-logo.png";

/**
 * The agent a terminal was launched into, or null for a shell.
 *
 * Reads `TerminalTarget`'s agent members off the shared const array rather
 * than a second literal list here, so a new harness cannot be added to the
 * union and silently render as a plain shell.
 */
export function harnessOf(target: string | null): AgentHarnessId | null {
  return AGENT_HARNESS_IDS.find((id) => id === target) ?? null;
}

/**
 * Per-agent marks, each a nod to the thing it stands for and — this is the
 * part that matters at 14px — a different silhouette from the others. Three
 * variations on a robot head would be indistinguishable at this size.
 */
const HARNESS_ICONS: Record<Exclude<AgentHarnessId, "claude" | "codex">, Icon> = {
  opencode: BracketsAngle,
};

/** OpenAI's own mark (assets/openai-logo.svg), inline so it takes the row's ink. */
function OpenAIMark() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

/**
 * The class that paints an item row's icon, or null for the ranks that just
 * inherit their row's ink.
 *
 * The hue used to be an inline `style` on the glyph, which made it the one
 * value in the panel a stylesheet could not reach: inline styles outrank
 * every selector, so `.hidden-item .tile-icon { color: … }` lost to it and
 * a hidden agent row had to be special-cased in the component. As a class
 * it is an ordinary participant in the cascade, and the hidden rank wins on
 * specificity like any other override.
 */
export function itemIconClass(type: CatalogItemType, target: string | null): string | null {
  if (type === "artifact") return "item-artifact";
  // Harness color stays the same in conversation and terminal mode.
  if (type !== "term" && type !== "agent") return null;
  const harness = harnessOf(target);
  return harness ? `agent-${harness}` : null;
}

/** Non-terminal items. Monochrome but for the artifact globe (see `itemIconClass`). */
const FILE_ICONS: Record<Exclude<CatalogItemType, "term" | "agent">, Icon> = {
  note: Note,
  code: Code,
  image: Image,
  pdf: FilePdf,
  artifact: Globe,
  app: AppWindow,
};

export interface ItemIconProps {
  type: CatalogItemType;
  /** The item's `TerminalTarget`, when it is a terminal. */
  target: string | null;
}

/**
 * A terminal's icon comes from what it was launched into; everything else
 * from its type. A terminal whose target is a shell, a WSL distro, or absent
 * (an older row that predates the field) lands on the plain prompt, which is
 * the honest answer for all three.
 */
export function ItemIcon({ type, target }: ItemIconProps) {
  if (type !== "term" && type !== "agent") {
    const Glyph = FILE_ICONS[type];
    return <Glyph size={14} weight="regular" />;
  }
  const harness = harnessOf(target);
  if (!harness) return <Terminal size={14} weight="regular" />;
  if (harness === "claude") return <img src={claudeLogo} width={14} height={14} alt="" aria-hidden="true" />;
  if (harness === "codex") return <OpenAIMark />;
  // The hue itself comes from `itemIconClass` on the wrapper, so this glyph
  // simply inherits `color` like every other icon here.
  const Glyph = HARNESS_ICONS[harness];
  return <Glyph size={14} weight="bold" />;
}

/**
 * A checkout row's mark: what KIND of working copy this is. The branch it
 * holds is not this icon's job — that moved inside the branch pill, where
 * it labels the value it belongs to instead of competing with the row's own
 * identity from the far side of the name.
 *
 * A worktree gets stacked folders, and the reasoning is worth writing down
 * because the obvious answer is wrong. "Worktree" is short for WORKING
 * TREE, and "tree" there is git's object-model word for a directory
 * listing — it was never arboreal. A plant glyph would be a pun on a word
 * that is not a pun, which reads as a mistake to anyone who knows git and
 * says nothing to anyone who does not; `TreeStructure`, the node diagram,
 * means hierarchy, and a worktree is not a hierarchy. What a worktree
 * literally IS is a second directory holding the same repo, so it is the
 * repo's own folder, doubled.
 *
 * PR and issue rows used to keep their own marks — a pull-request glyph, a
 * dashed circle — on the reasoning that provenance is the useful thing to
 * know at a glance. It isn't, for two reasons. Once a worktree exists it
 * behaves identically however it was made: same directory, same actions,
 * same removal. And the split could never be drawn honestly anyway, because
 * a worktree cubed did not cut is adopted as `branch` whatever created it
 * (`adoptWorktrees`, cubed/catalog.ts) — so the mark was not reporting
 * provenance, it was reporting whether this client happened to be the one
 * that made the row.
 *
 * The mark now answers the one question it can answer for every row: is
 * there a single directory here, or more than one. Provenance moved to the
 * label, where a PR row reads `PR #412` and an issue row `Issue #88`
 * (`checkoutName` in group-entries.ts) — which says it in words instead of
 * asking the eye to learn two glyphs.
 */
export function CheckoutIcon({ repo }: { repo: RepoInfo }) {
  // The repo's own working copy — a plain, closed folder.
  //
  // It was FolderOpen, on the reasoning that this is the checkout you are
  // already inside. That reads well in isolation and badly in the column,
  // which is the only place it is ever read: these two marks exist to be
  // told apart from each other, and open-vs-doubled asks the eye to
  // resolve two differences at once (a lid, and a count) to answer one
  // question. Closed-vs-doubled asks it to resolve exactly one — is there
  // a single directory here or more than one — which is the fact the two
  // ranks actually differ on. It also frees the open folder to mean
  // "open the files", which is the job it does on the row's own action
  // button a few pixels away.
  if (!repo.worktreeOf) return <Folder size={13} weight="regular" />;
  return <Folders size={13} weight="regular" />;
}

/**
 * The mark inside a branch pill. Sized and weighted to sit on the pill's
 * text baseline rather than to be read on its own — it is there to say
 * "this string is a ref", which a bare `main` next to a prose name does not
 * say by itself.
 */
export function BranchPillIcon({ detached }: { detached: boolean }) {
  const Glyph = detached ? GitCommit : GitBranch;
  return <Glyph size={11} weight="regular" aria-hidden />;
}

/** Repositories use the same plain folder mark as their primary checkout. */
export function RepoIcon() {
  return <Folder size={13} weight="regular" />;
}

/**
 * A machine header's mark. The two sections name two places your work can
 * live, and the marks say which is which without either one restating the
 * label beside it: the prism is the product, so the cloud section reads as
 * "the machine Collab runs for you", and a hard drive is the one object
 * that still means local storage to everyone, whatever the local machine
 * actually is.
 *
 * This is the header rank's one glyph, and a rank the panel deliberately
 * kept clear until now — the note it replaces argued that a mark in front
 * of a header only restates the words. That holds for a laptop-and-cloud
 * pair, which is a picture of the label. It does not hold for the prism,
 * which is the one thing here the words cannot say.
 *
 * `fill` rather than the `regular` every row below uses, and the exception
 * is what keeps the pair coherent: the prism is a solid mark and has no
 * outline form to offer, so a hairline drive beside it made one section
 * look emphasized and the other look faint — a difference in ink where the
 * two sections differ in nothing. Solid is therefore the HEADER rank's
 * weight, the same way outline is the row ranks', and the two never meet
 * in a column where the difference could be misread as status.
 */
export function MachineIcon({ kind }: { kind: RepoInfo["kind"] }) {
  if (kind === "local") return <HardDrive size={13} weight="fill" />;
  return <PrismMark size={13} />;
}

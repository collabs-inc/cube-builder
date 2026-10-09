/**
 * Derives a sidebar row entry from a catalog item plus this client's local,
 * ephemeral view of it — pure and DOM/IPC-free so it's unit-testable
 * without a store or services. Ports `buildTileListEntry`
 * (src/windows/shell/src/renderer.js:300-342) and the `getTileLabel`
 * helper it uses (src/windows/shell/src/tile-renderer.js), minus the
 * `browser` branch — the single-renderer app has no webview tiles — plus a
 * `pdf` branch, since `CatalogItem` (unlike the old canvas `Tile`) has one.
 *
 * Unlike before Task 10, the item and its live status are two separate
 * inputs rather than one flat object: identity (title material, cwd,
 * session state) is the catalog's, `hidden`/`closing`/the live foreground
 * command/last-touched-file are this client's own local facts — see
 * state/live-status.ts for where the latter three come from, and
 * ReposSidebar.tsx for `hidden` ("this item id appears in no column").
 * `liveForegroundDetail`'s shell-name filtering moved to live-status.ts
 * along with the raw event handling — `LiveStatus.liveCommand` is already
 * filtered by the time it reaches this file, so there's nothing left to
 * filter here.
 */



import { withTranscript, type Attention } from "../attention/attention";
import { splitDisplayPath } from "@port/shared/path-utils";
import type { CatalogItemType, OwnedItem } from "@port/shared/catalog";
import type { AgentStatus } from "../items/agent/agent-status";
import type { LiveState } from "../state/live-status";

/**
 * This client's local view of an item — see state/live-status.ts
 * (liveCommand/touchedFile/closing) and ReposSidebar.tsx (hidden).
 *
 * `recovering` is deliberately omitted from `LiveState`: it exists for the
 * rail's exit sweep, and a row mid-respawn is still just a row — it reads
 * as idle until its new session lands, exactly as it did before.
 */
export interface LiveStatus extends Omit<LiveState, "recovering"> {
  /** True when this item id appears in no column of this client's layout. */
  hidden: boolean;
}

export interface ItemListEntry {
  id: string;
  /** What the row asks of this client — attention/attention.ts. Absent on file rows. */
  attention?: Attention;
  type: CatalogItemType;
  title: string;
  description: string;
  /** Display name of the persona that spawned this session. */
  personaName?: string;
  /**
   * "waiting" is an `agent` row only, and it is louder than "running" on
   * purpose: it means the conversation is blocked on a permission this
   * user has to answer. A terminal never reports it — a pty blocked on a
   * prompt is indistinguishable from one busy working.
   */
  status: "running" | "idle" | "waiting" | null;
  repoId: string | null;
  /**
   * What this terminal was LAUNCHED into — a `TerminalTarget` (an agent
   * harness id, a shell, a WSL distro), or, for an `agent` item, its
   * `harness` (which is where that item keeps the same fact — see
   * CatalogItem). Null for a non-terminal item.
   *
   * The row's icon is keyed on this rather than on `liveCommand` on purpose.
   * The live command is what happens to be in the foreground right now — an
   * agent that exited leaves a bare shell behind — and a row whose icon
   * changes under the user is a row that has lost its identity. What it was
   * opened as does not move.
   */
  target: string | null;
  /** Live foreground command for a terminal item (e.g. "claude"), or null. */
  liveCommand: string | null;
  /** Latest file-touched relpath for a linked agent session, or null. */
  touchedFile: string | null;
  hidden: boolean;
  /** A close is in flight: the kill was sent, the daemon hasn't confirmed yet. */
  closing: boolean;
  /** A site whose server is down or not yet serving again. */
  stopped: boolean;
}

const FILE_TYPE_LABELS: Record<Exclude<CatalogItemType, "term" | "agent">, string> = {
  note: "Note",
  code: "Code",
  image: "Image",
  pdf: "Pdf",
  artifact: "Artifact",
  app: "App",
};

/** Ports tile-renderer.js's `getTileLabel`'s term branch. */
function terminalLabel(item: OwnedItem): { parent: string; name: string } {
  if (item.userTitle) return { parent: "", name: item.userTitle };
  if (item.agentTitle) return { parent: "", name: item.agentTitle };
  if (item.cwd) return splitDisplayPath(item.cwd);
  return { parent: "", name: "Terminal" };
}

/**
 * An agent row's last-resort name. The harness IS the item's identity
 * before a conversation has said anything about itself, so an unnamed row
 * reads "Claude Code" rather than the generic "Agent" — which is reserved
 * for a row whose harness we cannot name (an older row, or a harness this
 * build does not know).
 *
 * A local map rather than the router's `AGENT_TARGETS.displayName`: the
 * renderer does not import `@cube/router`, and these three strings are
 * already written by hand in the New agent menus either side of this file
 * (ReposSidebar.tsx, CanvasView.tsx).
 */
const HARNESS_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
};

function agentLabel(item: OwnedItem): { parent: string; name: string } {
  if (item.userTitle) return { parent: "", name: item.userTitle };
  if (item.agentTitle) return { parent: "", name: item.agentTitle };
  if (item.role === "persona") return { parent: "", name: "Persona" };
  if (item.cwd) return splitDisplayPath(item.cwd);
  return { parent: "", name: HARNESS_DISPLAY_NAMES[item.harness ?? ""] ?? "Agent" };
}

function fileTitle(item: OwnedItem, fallback: string): string {
  if (item.userTitle) return item.userTitle;
  if (item.type === "app" && item.app) return item.app.name;
  if (item.type === "artifact" && item.agentTitle) return item.agentTitle;
  if (item.type === "artifact" && item.port !== undefined) return `localhost:${item.port}`;
  if (!item.filePath) return fallback;
  return item.filePath.split("/").pop() || fallback;
}

/**
 * A terminal's run status: "running" only while it has a live pty and
 * hasn't exited; "idle" otherwise — including an item whose session
 * exited (`exitedAt` set, `ptySessionId` cleared alongside it by
 * cubed's `markExited`), which must never read as "running" just
 * because nothing has cleared a stale identifier client-side.
 */
export function terminalStatus(item: OwnedItem): "running" | "idle" {
  return item.ptySessionId !== undefined && item.exitedAt === undefined ? "running" : "idle";
}

/**
 * `agentStatus` is the caller's transcript-derived verdict for an `agent`
 * row (`agentStatus(getTranscript(item.id), item)` — ReposSidebar.tsx),
 * passed in rather than read here so this file stays pure and store-free.
 * Absent means this client holds no transcript for the item, which reads
 * idle for the same reason `agent-status.ts` says it does: the sidebar
 * lists every item on the machine and must not invent state for one whose
 * stream it has never read.
 */
export function buildItemListEntry(
  item: OwnedItem,
  live: LiveStatus,
  agentStatus?: AgentStatus,
  attention: Attention = "idle",
  persona?: OwnedItem,
): ItemListEntry {
  const repoId = item.repoId ?? null;

  if (item.type === "term" || item.type === "agent") {
    const isAgent = item.type === "agent";
    const label = isAgent ? agentLabel(item) : terminalLabel(item);
    return {
      id: item.id,
      type: item.type,
      title: label.parent ? label.parent + label.name : label.name,
      description: item.cwd || "~",
      ...(item.personaId ? { personaName: persona ? agentLabel(persona).name : item.personaId } : {}),
      status: isAgent ? (agentStatus ?? "idle") : terminalStatus(item),
      attention: isAgent ? withTranscript(attention, agentStatus) : attention,
      repoId,
      target: (isAgent ? item.harness : item.target) ?? null,
      liveCommand: live.liveCommand,
      touchedFile: live.touchedFile,
      hidden: live.hidden,
      closing: live.closing,
      stopped: false,
    };
  }

  const label = FILE_TYPE_LABELS[item.type as Exclude<CatalogItemType, "term" | "agent">];
  return {
    id: item.id,
    type: item.type,
    title: fileTitle(item, label),
    description: label,
    status: null,
    repoId,
    target: null,
    liveCommand: null,
    touchedFile: null,
    hidden: live.hidden,
    closing: live.closing,
    stopped: item.stopped === true,
  };
}

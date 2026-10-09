import { AGENT_HARNESS_IDS, type AgentHarnessId, type ContextMenuItem } from "./types";
import { catalogAgent } from "./agent-catalog";

export interface LaunchChoice {
  view: "conversation" | "terminal";
  target: string;
}

const labels: Record<AgentHarnessId, string> = {
  claude: "Claude Code", codex: "Codex", opencode: "OpenCode",
};

export const NEW_AGENT_SUBMENU: ContextMenuItem[] = AGENT_HARNESS_IDS.map((id) => ({
  id: `new-agent-${id}`, label: labels[id],
}));
export const NEW_TERMINAL_SUBMENU: ContextMenuItem[] = [
  { id: "new-terminal-shell", label: "Shell" },
  { id: "separator", label: "" },
  ...AGENT_HARNESS_IDS.map((id) => ({ id: `new-terminal-${id}`, label: labels[id] })),
];
export const NEW_SESSION_MENU: ContextMenuItem[] = [
  { id: "new-agent", label: "New agent", submenu: NEW_AGENT_SUBMENU },
  { id: "new-terminal", label: "New terminal", submenu: NEW_TERMINAL_SUBMENU },
];

/**
 * The menu that offered sessions before conversations existed: "New
 * terminal" as a leaf that opens a shell at once, and the harness submenu
 * — whose picks, with conversations gated off, `planLaunch` turns into
 * terminals running that harness. Shared with main's File menu so the
 * desktop menu bar and the in-app menus cannot disagree about the shape.
 */
const PRE_CONVERSATION_SESSION_MENU: ContextMenuItem[] = [
  { id: "new-terminal", label: "New terminal" },
  { id: "new-agent", label: "New agent", submenu: NEW_AGENT_SUBMENU },
];

/** Which session menu a client offers, by its ACP conversation gate. */
export function newSessionMenu(acpConversations: boolean): ContextMenuItem[] {
  return acpConversations ? NEW_SESSION_MENU : PRE_CONVERSATION_SESSION_MENU;
}

/**
 * Accept only leaf choices; dismissals and submenu headings never launch.
 * The bare `new-terminal` is a leaf only on the pre-conversation menu; on
 * the other it is a submenu parent, which a menu never resolves, so the
 * mapping is safe to keep unconditional.
 */
export function launchChoiceOf(id: string | null): LaunchChoice | null {
  if (id?.startsWith("new-terminal-catalog:") && catalogAgent(id.slice("new-terminal-".length))) return { view: "terminal", target: id.slice("new-terminal-".length) };
  if (id === "new-terminal" || id === "new-terminal-shell") return { view: "terminal", target: "shell" };
  for (const target of AGENT_HARNESS_IDS) {
    if (id === `new-agent-${target}`) return { view: "conversation", target };
    if (id === `new-terminal-${target}`) return { view: "terminal", target };
  }
  return null;
}

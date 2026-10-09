import type { ContextMenuItem } from "@port/shared/types";
import { catalogAgent } from "@port/shared/agent-catalog";
import { availableAgentTargets } from "./available-agents";

/** Expand any shared agent picker with terminal-only agents on its machine. */
export async function installedAgentMenu(menu: ContextMenuItem[], machineId?: string | null): Promise<ContextMenuItem[]> {
  const targets = await availableAgentTargets(machineId).catch(() => []);
  const additions = targets.filter(target => target.installed && catalogAgent(target.id))
    .map(target => ({ id: `new-terminal-${target.id}`, label: target.label }));
  const expand = (items: ContextMenuItem[]): ContextMenuItem[] => {
    const next = items.map(item => item.submenu ? { ...item, submenu: expand(item.submenu) } : item);
    if (items.some(item => item.id === "new-agent-claude" || item.id === "new-terminal-claude")) next.push(...additions);
    return next;
  };
  return expand(menu);
}

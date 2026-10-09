import { services } from "../../services";
import type { TerminalTargetOption } from "../../services/types";

/** Global preferences can name an agent installed on any attached machine. */
export async function availableAgentTargets(machineId?: string | null): Promise<TerminalTargetOption[]> {
  if (machineId) return services.desktop.listTerminalTargets(machineId).catch(() => []);
  const local = await services.desktop.listTerminalTargets().catch(() => []);
  const machines = await services.catalog.get().catch(() => []);
  const remote = await Promise.all(machines.map(machine => services.desktop.listTerminalTargets(machine.machineId).catch(() => [])));
  const targets = new Map(local.map(target => [target.id, target]));
  for (const target of remote.flat()) {
    if (!targets.has(target.id) || target.installed) targets.set(target.id, target);
  }
  return [...targets.values()];
}

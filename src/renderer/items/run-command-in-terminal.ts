import type { OwnedItem } from "@port/shared/catalog";
import { AGENT_HARNESS_IDS, LOCAL_MACHINE_ID } from "@port/shared/types";
import { services } from "../services";
import { createTerminalItem } from "./TerminalItem";
import { typeIntoFreshTerminal } from "./type-into-terminal";
import { activeCheckoutId, focusItem } from "../state/workspace";
import { catalogStore } from "../state/catalog";

// Cloud entrypoint.sh sets HOME here. The router requires an explicit host
// cwd for machine-level terminals; local terminals resolve their own home.
const machineHome = (machineId: string) => machineId === LOCAL_MACHINE_ID ? {} : { cwd: "/workspace/home" };

/** A plain shell at the machine's home (the machine page title's New terminal), focused. */
export async function openShellAtHome(machineId: string): Promise<void> {
  const item = await createTerminalItem({ machineId, target: "shell", ...machineHome(machineId) });
  focusItem(item.id, item.type, item.repoId ?? null);
}

/**
 * Runs a recipe in a fresh shell on `machineId`: the terminal is forced to
 * `target: "shell"` (a default agent would take the line as a prompt),
 * opens at the machine's home, and each command is sent WITH Enter — a
 * click runs the recipe on that machine. The button that calls this shows
 * the command and names the machine.
 *
 * A recipe may be several commands (`hermes` and `fx` install in two
 * steps). Submit one shell sequence so later steps run only after earlier
 * steps succeed. Output silence is not evidence that an installer finished.
 */
export async function runCommandInFreshTerminal({ machineId, command }: { machineId: string; command: string | readonly string[] }): Promise<OwnedItem> {
  const commands = typeof command === "string" ? [command] : [...command];
  if (!commands.length || commands.some(line => !line.trim())) throw new Error("No install command is available.");
  const item = await createTerminalItem({ machineId, target: "shell", ...machineHome(machineId) });
  focusItem(item.id, item.type, item.repoId ?? null);
  if (!item.ptySessionId) throw new Error("The terminal could not be started. Try again.");
  const recipe = commands.length === 1 ? commands[0]! : commands.map(line => `{ ${line.trim().replace(/;$/, "")}; }`).join(" && ");
  await typeIntoFreshTerminal(services.pty, item.ptySessionId, `${recipe}\r`);
  return item;
}

/** Opens a terminal running `target` on `machineId`, in the active checkout when it lives there, else at home. */
export async function launchAgent({ machineId, target }: { machineId: string; target: string }): Promise<OwnedItem> {
  const checkoutId = activeCheckoutId();
  const repo = checkoutId ? catalogStore.getSnapshot().repos.find(r => r.id === checkoutId && r.machineId === machineId) : undefined;
  const conversation = (AGENT_HARNESS_IDS as readonly string[]).includes(target);
  const item = await createTerminalItem({ machineId, target, ...(repo ? { repoId: repo.id } : machineHome(machineId)), ...(conversation ? { view: "conversation" as const } : {}) });
  focusItem(item.id, item.type, item.repoId ?? null);
  return item;
}

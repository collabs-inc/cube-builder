import { services } from "../services";
import { isInstallationMachine } from "../services/machine";

/** Shared entry menu for the sidebar and empty-screen quick action. */
export async function chooseRepoAction(machineId: string): Promise<string | null> {
  if (!isInstallationMachine(machineId)) return null;
  const action = await services.desktop.showContextMenu([
    { id: "create-repo", label: "Create repo…" },
    { id: "add-existing-repo", label: "Add existing repo…" },
  ]);
  return isInstallationMachine(machineId) ? action : null;
}

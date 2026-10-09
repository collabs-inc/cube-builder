// The one way into the add-repository flow from outside the sidebar: the
// ⌘-shortcut (Desktop.tsx) and the title's "+" (SystemPanel.tsx).
// It asks the mounted sidebar to run its own flow — the menu, then the
// create or add-existing modal it owns — for the machine it is showing. It used to click the machine
// page's "Add repo" row, but the personas sidebar hides the repos section
// (Yiliu, 2026-09-19), so there is no row to click there.
import { LOCAL_MACHINE_ID } from "@port/shared/types";
import { requestAddRepo } from "../sidebar/add-repo-request";
import { setStudioSidebarOpen } from "../state/app-navigation";

export function openAddRepo(): void {
  setStudioSidebarOpen(true);
  requestAddRepo(LOCAL_MACHINE_ID);
}

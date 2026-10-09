import { useEffect } from "react";
import { SidebarSimple } from '@phosphor-icons/react/dist/csr/SidebarSimple';
import { SHORTCUT_ACCELERATORS } from "@port/shared/shortcuts";
import { services } from "../../services";
import { useUiState } from "../../state/ui";
import { appNavigationStore, setStudioSidebarOpen, useAppNavigation } from "../../state/app-navigation";
import { ViewSwitcher } from "../../items/ViewSwitcher";
import { openAddRepo } from "../add-repo";
import "./AppDesktop.css";

/** Builder controls extracted from the host's AppDesktop. */
export function AppDesktop({ wide }: { wide: boolean }) {
  const nav = useAppNavigation();
  const { settingsModalOpen } = useUiState();
  useEffect(() => services.desktop.onShortcut(action => {
    const current = appNavigationStore.getSnapshot();
    if (action === "studio-sidebar" && wide && !settingsModalOpen) {
      setStudioSidebarOpen(!current.studioSidebarOpen);
    }
    if (action === "add-repo") openAddRepo();
  }), [wide, settingsModalOpen]);
  return wide ? <>
      <button type="button" className="app-shell-icon-button studio-sidebar-toggle"
        aria-label={nav.studioSidebarOpen ? "Hide Cube Builder sidebar" : "Show Cube Builder sidebar"}
        data-tooltip={nav.studioSidebarOpen ? "Hide Cube Builder sidebar" : "Show Cube Builder sidebar"}
        data-tooltip-side="right" data-shortcut={SHORTCUT_ACCELERATORS["studio-sidebar"]}
        aria-expanded={nav.studioSidebarOpen} aria-controls="studio-sidebar"
        onClick={() => setStudioSidebarOpen(!nav.studioSidebarOpen)}><SidebarSimple size={17} /></button>
      <div className="workspace-screen-controls"><ViewSwitcher /></div>
  </> : null;
}

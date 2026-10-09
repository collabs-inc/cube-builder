import { FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { Terminal } from '@phosphor-icons/react/dist/csr/Terminal';
import { LOCAL_MACHINE_ID } from "@port/shared/types";
import { ReposSidebar } from "../../sidebar/ReposSidebar";
import { RepoListHeading } from "../../sidebar/SidebarSections";
import { toggleStudioRepoView, useStudioRepoView } from "../../state/studio-repo-view";
import { useLocalInfo } from "../../sections/BrowseFiles";
import { openShellAtHome } from "../../items/run-command-in-terminal";
import { openTreePane } from "../../state/workspace";
import { AppSidebarResize } from "./AppSidebarResize";
import "../../sidebar/Sidebar.css";
import "../FilesWindow.css";

/** Original Builder project navigation, scoped to the installation machine. */
export function WorkspaceNavigation({ visible }: { visible: boolean }) {
  const repoView = useStudioRepoView();
  const localInfo = useLocalInfo();
  const actions = (target: "local" | "cloud") => {
    const machineId = LOCAL_MACHINE_ID;
    const homeRoot = localInfo?.homeDir;
    return <>
      <button type="button" className="sidebar-section-row" disabled={!machineId} onClick={() => {
        if (machineId) void openShellAtHome(machineId).catch(error => console.error("[studio] create terminal failed", error));
      }}>
        <span className="row-icon"><Terminal size={14} /></span><span className="row-name">Create terminal</span>
      </button>
      <button type="button" className="sidebar-section-row" disabled={!homeRoot} onClick={() => {
        if (homeRoot) openTreePane({ repoId: null, root: homeRoot, name: "Home" });
      }}>
        <span className="row-icon"><FolderOpen size={14} /></span><span className="row-name">Browse files</span>
      </button>
    </>;
  };
  return <section id="studio-sidebar" className="workspace-navigation navigator-files" aria-label="Cube Builder projects" inert={!visible} data-visible={visible}>
    <div className="workspace-navigation-heading" />
    <div className="files-repos"><div className="app-sidebar"><div className="sidebar-panel">
      <ReposSidebar visible={visible} layout="mini" machineActions={actions} allowLocal
        machineTitle={target => <h2 className="studio-machine-label">{target === "cloud" ? "Cloud Machine" : "Local Machine"}</h2>}
        repoListHeader={<RepoListHeading view={repoView} onToggle={toggleStudioRepoView} />}
        showWorktrees={repoView.showWorktrees} showArtifacts={repoView.showArtifacts}
        groupUnscopedByDirectory localHome={localInfo?.homeDir ?? null} />
    </div></div></div>
    <AppSidebarResize app="workspace" label="Cube Builder sidebar width" />
  </section>;
}

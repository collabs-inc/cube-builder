import { Rail } from "../../items/Rail";
import { AttentionObserver } from "../../attention/AttentionObserver";
import { MobileHome } from "../../mobile/MobileHome";
import { MobileItemHeader } from "../../mobile/MobileItemHeader";
import { MobileKeyBar } from "../../mobile/MobileKeyBar";
import { effectiveNarrowView, useUiState } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { useAppNavigation } from "../../state/app-navigation";
import { AppDesktop } from "./AppDesktop";
import { WorkspaceNavigation } from "./WorkspaceNavigation";

/** One permanent Rail owns sessions and app frames at every viewport width. */
export function AppViewport({ isNarrow, workspaceDropHint }: { isNarrow: boolean; workspaceDropHint: string | null }) {
  const navigation = useAppNavigation();
  const { narrowView } = useUiState();
  const { activeItemId } = useWorkspace();
  const workspaceVisible = true;
  const studioScreen = effectiveNarrowView(narrowView, activeItemId);
  const itemVisible = isNarrow && workspaceVisible && studioScreen === "item";
  return <div className={isNarrow ? "app-main app-main-narrow mobile-app-shell" : "app-main app-main-desktop app-main-apps"}
    data-workspace-visible={workspaceVisible} data-studio-sidebar-open={navigation.studioSidebarOpen}>
    {isNarrow && <MobileHome visible={workspaceVisible && studioScreen === "home"} />}
    {itemVisible && <MobileItemHeader />}
    <AttentionObserver visible={workspaceVisible} />
    {!isNarrow && <div className="studio-surface" data-visible={workspaceVisible} aria-hidden="true" />}
    <Rail visible={workspaceVisible} />
    <AppDesktop wide={!isNarrow} />
    <WorkspaceNavigation visible={!isNarrow && workspaceVisible && navigation.studioSidebarOpen} />
    {itemVisible && <MobileKeyBar />}
    {workspaceVisible && workspaceDropHint !== null && <div className="app-main-drop-hint" aria-hidden="true">
      <span className="app-main-drop-hint-label">{workspaceDropHint}</span>
    </div>}
  </div>;
}

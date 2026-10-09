// Opening actions use the repository tree's row geometry. Studio supplies
// terminal and file-browser buttons above the shared Add Repo action.
import { FileHtml } from '@phosphor-icons/react/dist/csr/FileHtml';
import { GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import { Plus } from '@phosphor-icons/react/dist/csr/Plus';
import type { ReactNode } from "react";
import type { StudioRepoView } from "../state/studio-repo-view";
import "./SidebarSections.css";

export function SidebarSections({ onAddRepo, children }: { onAddRepo: () => void; children?: ReactNode }) {
  return (
    <div className="sidebar-add-repo-row">
      {children}
      {/* On the desktop the machine header — and its New repo action — is
          out of the Cube window; the action takes a row here, on the strip's
          own register, so it reads as one more thing the panel does. */}
      <button type="button" className="sidebar-section-row sidebar-add-repo" aria-haspopup="dialog" onClick={onAddRepo}>
        <span className="row-icon"><Plus size={14} /></span>
        <span className="row-name">Add Repo</span>
      </button>
    </div>
  );
}

export function RepoListHeading({ view, onToggle }: { view: StudioRepoView; onToggle: (key: keyof StudioRepoView) => void }) {
  return <div className="sidebar-repos-heading studio-repos-heading">
    <span>Repos</span>
    <div className="studio-repo-view-controls">
      <button type="button" className="studio-repo-view-toggle" aria-pressed={view.showWorktrees}
        aria-label={view.showWorktrees ? "Hide worktrees" : "Show worktrees"}
        data-tooltip={view.showWorktrees ? "Hide worktrees" : "Show worktrees"}
        onClick={() => onToggle("showWorktrees")}><GitBranch size={14} /></button>
      <button type="button" className="studio-repo-view-toggle" aria-pressed={view.showArtifacts}
        aria-label={view.showArtifacts ? "Hide artifacts" : "Show artifacts"}
        data-tooltip={view.showArtifacts ? "Hide artifacts" : "Show artifacts"}
        onClick={() => onToggle("showArtifacts")}><FileHtml size={14} /></button>
    </div>
  </div>;
}

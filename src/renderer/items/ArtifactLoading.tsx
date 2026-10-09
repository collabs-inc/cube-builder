import { PaneNotice } from "./PaneNotice";
import "./ArtifactLoading.css";

/** The same loading notice for a single HTML file and a launched site, in the paused-machine design. */
export function ArtifactLoading({ label = "Loading artifact…" }: { label?: string }) {
  return <PaneNotice type="artifact" text={label} busy className="artifact-loading pane-notice-overlay" />;
}

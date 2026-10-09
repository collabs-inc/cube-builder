import { useEffect, useMemo, useState } from "react";
import { ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { isSubpath, parentPath, parseCloudPath } from "@port/shared/path-utils";
import type { TreePaneRecord } from "../state/workspace";
import { hideItem, navigateTreePaneUp } from "../state/workspace";
import { services } from "../services";
import { FileTreeHost } from "../filetree/FileTreeHost";
import { treePaneParent } from "../filetree/tree-pane-parent";
import { useRepos } from "../state/repos";
import { resolveStatus, type DotStatus } from "../sidebar/group-entries";
import { isCloudPath } from "./cloud-placeholder";
import "./FileTreeItem.css";

/**
 * Whether a `false` from `services.files.isDirectory` should be trusted as
 * "this folder is really gone." The IPC layer never rejects — main
 * swallows every error to `false` (`src/main/ipc-filesystem.ts`) and the
 * web shim mirrors that, so a transport failure (an unreachable or
 * sleeping cloud machine) is indistinguishable from a real ENOENT at that
 * boundary. A local root has no transport to fail, so its `false` is
 * always trusted; a cloud root's `false` is trusted only once the repo's
 * connection is known "open" — any other status (connecting/closed/
 * error/unknown) means the `false` could just as easily be "couldn't ask."
 */
export function shouldTrustMissing(isCloud: boolean, status: DotStatus): boolean {
  return !isCloud || status === "open";
}

export function FileTreeItem({ paneId, pane, visible }: {
  paneId: string; pane: TreePaneRecord; visible: boolean;
}) {
  const workspaces = useMemo(
    () => [{ path: pane.root, name: pane.name }],
    [pane.root, pane.name],
  );
  const { statuses } = useRepos();
  const isCloud = isCloudPath(pane.root);
  // The virtual `/@cloud/<repoId>/…` path carries the repo id itself,
  // which is more reliable than `pane.repoId` — a persisted/repaired pane
  // can have a null repoId (see `repairTreePanes`) even for a cloud root.
  const repoId = parseCloudPath(pane.root)?.repoId ?? pane.repoId;
  const status = resolveStatus(repoId ?? "", statuses);
  const [missingRoot, setMissingRoot] = useState<string | null>(null);
  const missing = missingRoot === pane.root;
  useEffect(() => {
    let alive = true;
    const checkExists = () => {
      services.files.isDirectory(pane.root).then((ok) => {
        if (!alive) return;
        // A passing check always clears a stale `missing` — this is the
        // reset path: a folder deleted then recreated (e.g. a branch
        // switch) must not stay bricked until the pane is closed/reopened.
        if (ok) { setMissingRoot(null); return; }
        if (shouldTrustMissing(isCloud, status)) setMissingRoot(pane.root);
      });
    };
    checkExists();
    const offDeleted = services.files.onFilesDeleted((paths) => {
      if (paths.some((p) => p === pane.root || isSubpath(p, pane.root))) setMissingRoot(pane.root);
    });
    const parent = parentPath(pane.root);
    const offChanged = services.files.onFsChanged((events) => {
      if (events.some((event) => event.dirPath === parent)) checkExists();
    });
    return () => { alive = false; offDeleted(); offChanged(); };
  }, [pane.root, isCloud, status]);

  return (
    <div className="file-tree-pane">
      <div className="file-tree-toolbar">
        <button type="button" className="file-tree-up" aria-label="Up one folder" title="Up one folder"
          disabled={treePaneParent(pane.root) === null} onClick={() => navigateTreePaneUp(paneId)}>
          <ArrowUp size={14} /><span>Up</span>
        </button>
      </div>
      {missing ? <div className="file-tree-missing">
        <p>This folder no longer exists.</p>
        <button
          type="button"
          className="create-item-modal-button create-item-modal-button-secondary"
          onClick={() => hideItem(paneId)}
        >
          Close
        </button>
      </div> : <FileTreeHost workspaces={workspaces} visible={visible} persistExpansion={false}
        /> }
    </div>
  );
}

export default FileTreeItem;

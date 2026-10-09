// The sequential-send half of dropping OS files onto a sidebar surface,
// shared by both sidebar view modes: the file tree's rows
// (filetree/FileTreeHost.tsx) and
// the default view's checkout rows (ReposSidebar). Sends mirror the
// terminal drop (see packages/components/src/Terminal/file-drop.ts's
// sendDroppedFiles doc); the cap applies per file only when bytes travel —
// a local target's sourcePath copy never crosses the wire, so the limit is
// Infinity here, with the base64 FALLBACK still capped inside
// buildImportPayload.
import { useCallback, useState } from "react";
import { sendDroppedFiles, type TerminalTransfer } from "@builder/components/Terminal/file-drop";
import { MAX_TRANSFER_BYTES } from "@port/shared/cubed-protocol";
import { isCloudPath } from "../items/cloud-placeholder";
import { services } from "../services";
import { buildImportPayload } from "./import-payload";

export interface FileImport {
  /** Progress and refusals for the strip — see TransferStrip. */
  transfer: TerminalTransfer | null;
  dismissTransfer: () => void;
  /** Ships each dropped file into `targetFolder`, one at a time, and
   * reports folder refusals by name. Fire-and-forget: errors land in
   * `transfer`, never throw. */
  importFiles: (files: File[], folderNames: string[], targetFolder: string) => void;
}

export function useFileImport(opts?: {
  /** Called with the written path after a SINGLE-file drop that succeeded —
   * the tree view selects the new row; the default view has no row to
   * select and passes nothing. A multi-file drop never calls it. */
  onSingleImported?: (path: string) => void;
}): FileImport {
  const [transfer, setTransfer] = useState<TerminalTransfer | null>(null);
  const onSingleImported = opts?.onSingleImported;

  const importFiles = useCallback(
    (files: File[], folderNames: string[], targetFolder: string) => {
      void (async () => {
        const targetIsCloud = isCloudPath(targetFolder);
        const { paths, errors } = await sendDroppedFiles(files, {
          maxBytes: targetIsCloud ? MAX_TRANSFER_BYTES : Number.POSITIVE_INFINITY,
          stash: async (file) => {
            const payload = await buildImportPayload(file, {
              targetIsCloud,
              getPathForFile: services.desktop.getPathForFile,
            });
            return services.files.importFile(targetFolder, file.name, payload);
          },
          onProgress: (p) => setTransfer({ kind: "sending", ...p }),
        });
        if (files.length === 1 && paths.length === 1) onSingleImported?.(paths[0]!);
        const messages = [
          ...folderNames.map((name) => `${name} is a folder — only files can be dropped`),
          ...errors,
        ];
        setTransfer(messages.length > 0 ? { kind: "errors", messages } : null);
      })();
    },
    [onSingleImported],
  );

  const dismissTransfer = useCallback(() => setTransfer(null), []);

  return { transfer, dismissTransfer, importFiles };
}

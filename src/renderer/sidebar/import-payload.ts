// Which fs:importfile payload form a dropped File becomes. Local targets
// prefer sourcePath — the daemon copies on its own machine, uncapped, and
// the bytes never cross IPC — falling back to capped base64 when the drag
// carries no native path (a file dragged out of another browser; every
// drop in the web build, where getPathForFile has no answer to give).
import { MAX_TRANSFER_BYTES, MAX_TRANSFER_LABEL, type ImportPayload } from "@port/shared/cubed-protocol";
import { bytesToBase64 } from "@builder/components/Terminal/image-paste";

/** DOM-light, like file-drop.ts's DroppedFile: a real File satisfies it,
 *  and a test can hand in a plain object. */
export interface ImportSource {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export async function buildImportPayload<T extends ImportSource>(
  file: T,
  // Generic so services.desktop.getPathForFile — typed over real Files —
  // slots in unchanged, while tests hand in plain ImportSource objects.
  opts: { targetIsCloud: boolean; getPathForFile: (file: T) => string },
): Promise<ImportPayload> {
  if (!opts.targetIsCloud) {
    try {
      const sourcePath = opts.getPathForFile(file);
      if (sourcePath) return { sourcePath };
    } catch {
      // No native path — fall through to bytes.
    }
  }
  // Size check BEFORE the read: refusing must not cost a cap-sized allocation.
  if (file.size > MAX_TRANSFER_BYTES) {
    throw new Error(
      `${file.name} has no local path to copy from and is over the ${MAX_TRANSFER_LABEL} limit for sending by content`,
    );
  }
  return { contentBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())) };
}

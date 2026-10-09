// src/main/cubed/filter.ts
//
// Daemon-side entry filtering. Policy (which patterns) is injected by the
// caller; execution happens here because deciding whether a file is binary
// means opening it, and only the daemon can see the files.
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isImageFile } from "@port/shared/image";
import { isPdfFile } from "@port/shared/pdf";
import { createIgnoreMatcher, type IgnoreMatcher } from "@port/shared/file-patterns";
import { BINARY_SAMPLE_SIZE, isBinarySample } from "@port/shared/binary-sample";

export interface EntryFilterOptions {
  /** Omitted means no ignore filtering at all. */
  patterns?: readonly string[];
  /** Sniff file contents to exclude non-viewable binaries and label the rest. */
  detectBinary?: boolean;
}

export type EntryVerdict =
  | { include: false }
  | { include: true; isBinary?: boolean };

export interface EntryFilter {
  classify(
    relPath: string,
    absPath: string,
    isDirectory: boolean,
  ): Promise<EntryVerdict>;
}

/**
 * Reads the sample and hands the verdict to the shared heuristic — the same
 * bytes and the same rules the Electron main process applies, which is the
 * point: this filter decides what LOCAL browsing shows too, so a second
 * opinion here is a bug, not an optimisation. A file that cannot be opened is
 * reported as NOT binary: the caller is mid-walk over a live filesystem and a
 * vanished file should not abort it.
 */
async function detectBinaryFile(absPath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(absPath, "r");
    const buffer = Buffer.alloc(BINARY_SAMPLE_SIZE);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SAMPLE_SIZE, 0);
    return isBinarySample(buffer.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Ignore patterns are relative to a root, so with no root there is nothing to
 * apply them to. A caller scoped to the whole filesystem (`root: ""`) hands
 * over the absolute path, which is how that shows up here — and matching an
 * absolute path against the list is worse than useless in two ways. The
 * matcher throws on it outright (RangeError, not `false`); and were the
 * leading separator merely stripped, every ANCESTOR segment would be tested
 * too, so `/home/u/build/src/a.ts` would be ignored for living under a
 * directory that happens to be named `build`, and a listing of that folder
 * would come back silently empty.
 *
 * The main process behaved exactly this way before the filter moved: no
 * workspace for a path meant no ignore filtering at all. Binary detection and
 * counting are unaffected — only pattern matching needs a root.
 *
 * `isAbsolute`, not a leading-slash test: a Windows-hosted daemon in
 * whole-filesystem scope hands over `C:\…`, which a slash test reads as
 * relative — straight into the RangeError above.
 */
function isRootless(relPath: string): boolean {
  return isAbsolute(relPath);
}

export function createEntryFilter(opts: EntryFilterOptions): EntryFilter {
  const matcher: IgnoreMatcher | null =
    opts.patterns === undefined ? null : createIgnoreMatcher(opts.patterns);
  const cache = new Map<string, Promise<boolean>>();

  return {
    async classify(relPath, absPath, isDirectory) {
      if (
        !isRootless(relPath)
        && matcher?.isIgnored(isDirectory ? `${relPath}/` : relPath)
      ) {
        return { include: false };
      }
      if (isDirectory || !opts.detectBinary) {
        return { include: true };
      }
      // Viewable binaries are kept and labelled — they belong in the tree,
      // and the label is what tells a client to fetch them as bytes rather
      // than as text.
      if (isImageFile(absPath) || isPdfFile(absPath)) {
        return { include: true, isBinary: true };
      }
      let pending = cache.get(absPath);
      if (!pending) {
        pending = detectBinaryFile(absPath);
        cache.set(absPath, pending);
      }
      return (await pending) ? { include: false } : { include: true, isBinary: false };
    },
  };
}

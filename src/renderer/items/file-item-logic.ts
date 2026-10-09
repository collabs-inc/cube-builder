/**
 * Pure decision logic extracted from FileItem.tsx so it's testable without
 * mounting a component or a DOM. Two concerns live here:
 *  - fsChangeTouchesPath: does a batch of fs-change events include this
 *    item's own file (the scoped-reload decision — FileItem only re-reads
 *    its own path, not every open item's).
 *  - resolveFileDisplayState: given the item's current path/loaded
 *    path/error, which of FileItem's markdown/code/image/pdf/cloud-binary
 *    views (or loading/error/empty) should render. Mirrors the
 *    hasMarkdownFile/hasCodeFile/hasImageFile/hasPdfFile/showFileLoading
 *    boolean soup the old viewer App.tsx computed inline. cloud-binary
 *    pre-empts image/pdf for a cloud path — see cloud-placeholder.ts.
 */



import type { FsChangeEvent } from "@port/shared/types";
import { isImageFile } from "@port/shared/image";
import { isPdfFile } from "@port/shared/pdf";
import { needsBinaryTransport } from "./cloud-placeholder";

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt"]);

/** True for markdown/plaintext extensions — the ItemDetailView branch. */
export function isMarkdownFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return MARKDOWN_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/**
 * Whether a batch of fs-change events includes a change to `path`. Used to
 * scope FileItem's reload-on-external-edit reaction to its own file only —
 * every other open item's fs-changed subscription runs the same check
 * against its own path and ignores events that don't match.
 */
export function fsChangeTouchesPath(events: FsChangeEvent[], path: string | null): boolean {
  if (!path) return false;
  return events.some((event) => event.changes.some((change) => change.path === path));
}

export type FileDisplayState =
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "markdown" }
  | { kind: "code" }
  | { kind: "image" }
  | { kind: "pdf" }
  | { kind: "cloud-binary"; format: "image" | "pdf" };

/**
 * Resolves which view FileItem should render. `filePath` is the item's
 * current path (from the workspace store); `loadedPath` is the path whose
 * content has actually finished loading (they diverge while a load is in
 * flight, or briefly during a path change). An error takes priority over
 * everything else — mirrors the old viewer's `!fileError` guard on every
 * `hasXFile` boolean.
 */
export function resolveFileDisplayState(params: {
  filePath: string | null;
  loadedPath: string | null;
  fileError: string | null;
}): FileDisplayState {
  const { filePath, loadedPath, fileError } = params;
  if (fileError) return { kind: "error", message: fileError };
  if (filePath && !loadedPath) return { kind: "loading" };
  if (!loadedPath) return { kind: "empty" };
  if (needsBinaryTransport(loadedPath)) {
    return { kind: "cloud-binary", format: isImageFile(loadedPath) ? "image" : "pdf" };
  }
  if (isImageFile(loadedPath)) return { kind: "image" };
  if (isPdfFile(loadedPath)) return { kind: "pdf" };
  if (isMarkdownFile(loadedPath)) return { kind: "markdown" };
  return { kind: "code" };
}

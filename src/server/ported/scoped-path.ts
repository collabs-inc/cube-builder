// src/main/cubed/scoped-path.ts
//
// The one containment check every fs op shares. Its own module because both
// files.ts and tree.ts need it, and files.ts imports tree.ts.
import { isAbsolute, resolve, sep } from "node:path";

/**
 * Resolves `relPath` against `root` and rejects the result if it escapes
 * root. When `root` is `""` — the machine daemon's whole-filesystem scope,
 * gated by auth rather than a repo boundary — `relPath` must already be
 * absolute and no escape check applies.
 */
export function resolveScopedPath(root: string, relPath: string): string {
  if (root === "") {
    if (!isAbsolute(relPath)) {
      throw new Error("path-escape");
    }
    return relPath;
  }
  if (!isAbsolute(root)) {
    throw new Error("root-not-absolute");
  }
  const resolved = resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error("path-escape");
  }
  return resolved;
}

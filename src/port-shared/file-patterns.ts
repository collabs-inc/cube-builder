// packages/shared/src/file-patterns.ts
//
// The ignore list and its matcher, kept free of node:fs so any host can
// import it — the Electron main process, cubed, and a browser client that
// has no filesystem at all. Its counterpart for the other half of the
// decision, "is this file binary?", is ./binary-sample: also pure, for the
// same reason. Only the read that produces the sample lives in cubed.
import ignore from "ignore";

/** Moved verbatim from src/main/file-filter.ts. */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  ".git",
  "node_modules",
  "bower_components",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  ".venv",
  "venv",
  "site-packages",
  "__pycache__",
  ".DS_Store",
  "Thumbs.db",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.lock",
  "package-lock.json",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  // Binary / compiled files
  "*.dylib",
  "*.so",
  "*.dll",
  "*.exe",
  "*.o",
  "*.a",
  "*.lib",
  "*.class",
  "*.pyc",
  "*.pyo",
  "*.node",
  "*.wasm",
  // Images (only non-workspace icon formats)
  "*.svg",
  "*.ico",
  "*.icns",
  // Audio / video
  "*.mp3",
  "*.mp4",
  "*.wav",
  "*.mov",
  "*.webm",
  // Unity / C#
  "*.meta",
  "*.unity",
  "*.prefab",
  "*.mat",
  "*.asset",
  "*.shader",
  "*.cginc",
  "*.asmdef",
  "*.asmref",
  "*.physicMaterial",
  "*.physicsMaterial2D",
  "*.controller",
  "*.overrideController",
  "*.mask",
  "*.lighting",
  "*.terrainlayer",
  "Library",
  "Temp",
  "Obj",
  "Logs",
  "UserSettings",
  "*.pdb",
  // Fonts
  "*.ttf",
  "*.otf",
  "*.woff",
  "*.woff2",
  // Design files
  "*.psd",
  "*.psb",
  // 3D models
  "*.fbx",
  "*.obj",
  "*.blend",
  // Locale / resource packs
  "*.pak",
  // Bundled frameworks (e.g. Vuplex Chromium)
  "*.bundle",
  "*.framework",
  // Archives
  "*.zip",
  "*.tar",
  "*.gz",
  "*.rar",
  "*.7z",
  // Java / Android
  "*.jar",
  "*.aar",
];

export interface IgnoreMatcher {
  isIgnored(relativePath: string): boolean;
}

/**
 * Builds a matcher. `patterns` REPLACES the defaults rather than extending
 * them — a caller that wants both passes [...DEFAULT_IGNORE_PATTERNS, ...own].
 * That keeps the daemon policy-free (D5): what it filters is entirely the
 * caller's choice.
 */
export function createIgnoreMatcher(
  patterns: readonly string[] = DEFAULT_IGNORE_PATTERNS,
): IgnoreMatcher {
  const ig = ignore().add([...patterns]);
  return {
    isIgnored: (relativePath: string) =>
      relativePath.length > 0 && ig.ignores(relativePath),
  };
}

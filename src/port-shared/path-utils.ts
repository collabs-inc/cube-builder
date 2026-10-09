import { CLOUD_PATH_PREFIX } from "./types";

export type PathKind = "posix" | "windows" | "wsl-unc" | "unknown";

function normalizeInput(value: string): string {
  return value.trim();
}

export function pathKind(value: string): PathKind {
  const input = normalizeInput(value);
  if (!input) return "unknown";
  if (/^\\\\wsl(?:\$|\.localhost)\\[^\\]+/i.test(input)) {
    return "wsl-unc";
  }
  if (
    /^[A-Za-z]:[\\/]/.test(input)
    || /^\\\\[^\\]+\\[^\\]+/.test(input)
  ) {
    return "windows";
  }
  if (input.startsWith("/")) {
    return "posix";
  }
  return "unknown";
}

function collapseSeparators(value: string, separator: "/" | "\\"): string {
  if (separator === "/") {
    return value.replace(/[\\/]+/g, "/");
  }
  const hasUncPrefix = /^[\\/]{2}/.test(value);
  const collapsed = value.replace(/[\\/]+/g, "\\");
  return hasUncPrefix
    ? `\\\\${collapsed.replace(/^\\+/, "")}`
    : collapsed;
}

function trimTrailingSeparators(
  value: string,
  separator: "/" | "\\",
): string {
  if (!value) return value;
  if (separator === "/") {
    if (value === "/") return value;
    return value.replace(/\/+$/g, "");
  }
  if (/^[A-Za-z]:\\$/.test(value)) return value;
  if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(value)) {
    return value.replace(/\\+$/g, "");
  }
  return value.replace(/\\+$/g, "");
}

function normalizeForKind(value: string, kind: PathKind): string {
  const input = normalizeInput(value);
  if (!input) return input;
  if (kind === "posix") {
    return trimTrailingSeparators(collapseSeparators(input, "/"), "/");
  }
  if (kind === "windows" || kind === "wsl-unc") {
    const normalized = trimTrailingSeparators(
      collapseSeparators(input, "\\"),
      "\\",
    );
    return normalized.toLowerCase();
  }
  return input;
}

export function normalizePathForComparison(value: string): string {
  return normalizeForKind(value, pathKind(value));
}

export function isSubpath(rootPath: string, candidatePath: string): boolean {
  const kind = pathKind(rootPath);
  if (kind === "unknown") return false;
  const candidateKind = pathKind(candidatePath);
  if (candidateKind !== kind) return false;

  const root = normalizeForKind(rootPath, kind);
  const candidate = normalizeForKind(candidatePath, kind);
  if (!root || !candidate) return false;
  if (root === candidate) return true;

  const separator = kind === "posix" ? "/" : "\\";
  return candidate.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);
}

export function workspaceRootMatch(
  workspacePath: string,
  candidatePath: string,
): boolean {
  return isSubpath(workspacePath, candidatePath);
}

function splitSegments(value: string): string[] {
  return normalizeInput(value)
    .split(/[\\/]+/)
    .filter(Boolean);
}

export function splitDisplayPath(value: string): {
  parent: string;
  name: string;
} {
  const input = normalizeInput(value);
  if (!input) {
    return { parent: "", name: "" };
  }
  const kind = pathKind(input);
  const separator = kind === "windows" || kind === "wsl-unc" ? "\\" : "/";
  const parts = input.split(separator === "/" ? /\// : /[\\/]/);
  const name = parts.pop() || input;
  const parent = parts.length > 0 ? parts.join(separator) + separator : "";
  return { parent, name };
}

export function displayBasename(value: string): string {
  return splitDisplayPath(value).name || value;
}

export function displayCommandName(value: string): string {
  return displayBasename(value).replace(/\.exe$/i, "");
}

export function normalizeCommandName(
  value: string | null | undefined,
): string | null {
  const input = value?.trim();
  if (!input) return null;
  return displayCommandName(input).toLowerCase();
}

export function splitPathSegments(value: string): string[] {
  return splitSegments(value);
}

export function joinPath(basePath: string, child: string): string {
  const kind = pathKind(basePath);
  const separator = kind === "posix" ? "/" : "\\";
  const normalized = trimTrailingSeparators(
    collapseSeparators(basePath, separator),
    separator,
  );
  if (!normalized) return child;
  return `${normalized}${normalized.endsWith(separator) ? "" : separator}${child}`;
}

export function parentPath(value: string): string {
  const input = normalizeInput(value);
  if (!input) return input;
  const kind = pathKind(input);
  const separator = kind === "posix" ? "/" : "\\";
  const normalized = trimTrailingSeparators(
    collapseSeparators(input, separator),
    separator,
  );
  const idx = normalized.lastIndexOf(separator);
  if (idx <= 0) {
    return normalized;
  }
  if (kind === "windows" && /^[A-Za-z]:\\[^\\]+$/.test(normalized)) {
    return normalized.slice(0, idx + 1);
  }
  return normalized.slice(0, idx);
}

export interface ParsedWslUncPath {
  distro: string;
  guestPath: string;
}

export function parseWslUncPath(
  value: string,
): ParsedWslUncPath | null {
  const normalized = normalizeInput(value).replace(/\//g, "\\");
  const match = normalized.match(
    /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)(\\.*)?$/i,
  );
  if (!match) return null;
  const distro = match[1];
  if (distro === undefined) return null;
  const guestPath = match[2]
    ? collapseSeparators(match[2], "/")
    : "/";
  return {
    distro,
    guestPath: guestPath.startsWith("/") ? guestPath : `/${guestPath}`,
  };
}

export function windowsPathToWslPath(value: string): string | null {
  const input = normalizeInput(value);
  const driveMatch = input.match(/^([A-Za-z]):[\\/]*(.*)$/);
  if (!driveMatch) return null;
  const drive = driveMatch[1];
  if (drive === undefined) return null;
  const rest = driveMatch[2]
    ? collapseSeparators(driveMatch[2], "/")
    : "";
  const suffix = rest ? `/${rest}` : "";
  return `/mnt/${drive.toLowerCase()}${suffix}`;
}

export interface ParsedCloudPath {
  repoId: string;
  rel: string;
}

/**
 * Collapses `.`/`..` segments in a virtual cloud path's relative portion,
 * without touching the filesystem or importing `node:path` (this module
 * ships to the renderer too). Returns null if the result would climb above
 * the repo root — cubed already rejects a wire-relative path that
 * escapes its root the same way (see router.ts's `move()`), so a
 * traversal attempt is refused here rather than silently normalized into
 * something that no longer means what the caller wrote.
 */
function normalizeRelPath(rel: string): string | null {
  const out: string[] = [];
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/**
 * Splits a virtual cloud path (`/@cloud/<repoId>/<rel>`) into its
 * repoId and root-relative remainder, or null if `p` isn't one. `rel`
 * is always root-relative and traversal-safe (see `normalizeRelPath`) —
 * callers join it onto the repo's real root without re-checking.
 */
export function parseCloudPath(p: string): ParsedCloudPath | null {
  if (!p.startsWith(CLOUD_PATH_PREFIX)) return null;
  const rest = p.slice(CLOUD_PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  const repoId = slash === -1 ? rest : rest.slice(0, slash);
  if (!repoId) return null;
  const rel = normalizeRelPath(slash === -1 ? "" : rest.slice(slash + 1));
  return rel === null ? null : { repoId, rel };
}

export function hostPathToGuestPath(
  hostPath: string,
  target: string,
): string | null {
  if (!target.startsWith("wsl:")) return null;
  const targetDistro = target.slice(4);
  const unc = parseWslUncPath(hostPath);
  if (unc) {
    if (
      targetDistro &&
      unc.distro.toLowerCase() !== targetDistro.toLowerCase()
    ) {
      return null;
    }
    return unc.guestPath;
  }
  return windowsPathToWslPath(hostPath);
}

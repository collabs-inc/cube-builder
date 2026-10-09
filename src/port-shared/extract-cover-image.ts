import { toCubeFileUrl } from "./cube-file-url";
import { parentPath, pathKind } from "./path-utils";

const PASSTHROUGH_RE = /^(https?:\/\/|data:|cube-file:\/\/)/;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;
const UNC_ABSOLUTE_RE = /^\\\\[^\\]+\\[^\\]+/;

// Does not handle URLs with unescaped parentheses (rare for cover images).
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\((\S+?)(?:\s+"[^"]*")?\)/;
const HTML_IMG_SRC_RE = /<img\s[^>]*?\bsrc=["']([^"']+)["'][^>]*?\/?>/i;

function isAbsoluteLocalPath(path: string): boolean {
  return (
    path.startsWith("/")
    || WINDOWS_ABSOLUTE_RE.test(path)
    || UNC_ABSOLUTE_RE.test(path)
  );
}

function resolveRelativePath(
  notePath: string,
  imageRef: string,
): string {
  const kind = pathKind(notePath);
  const separator = kind === "windows" || kind === "wsl-unc" ? "\\" : "/";
  const baseDir = parentPath(notePath);
  const combined = `${baseDir}${separator}${imageRef}`;
  const segments = combined
    .split(/[\\/]+/)
    .filter(Boolean);

  const resolved: string[] = [];
  let minLength = 0;
  let prefix = "";

  if (kind === "posix") {
    prefix = "/";
  } else if (kind === "windows" || kind === "wsl-unc") {
    if (/^[A-Za-z]:$/.test(segments[0] ?? "")) {
      resolved.push(segments[0]!);
      minLength = 1;
    } else if (combined.startsWith("\\\\")) {
      prefix = "\\\\";
      resolved.push(...segments.slice(0, 2));
      minLength = resolved.length;
    }
  }

  for (const seg of segments.slice(minLength)) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      if (resolved.length > minLength) {
        resolved.pop();
      }
      continue;
    }
    resolved.push(seg);
  }

  return `${prefix}${resolved.join(separator)}`;
}

function resolveImageRef(
  imageRef: string,
  notePath: string | undefined,
): string | null {
  if (PASSTHROUGH_RE.test(imageRef)) return imageRef;
  if (!notePath) return null;

  if (isAbsoluteLocalPath(imageRef)) {
    return toCubeFileUrl(imageRef);
  }

  return toCubeFileUrl(resolveRelativePath(notePath, imageRef));
}

/**
 * Extract a cover image URL from frontmatter or the first image in markdown.
 *
 * Checks frontmatter keys `cover_image` / `coverImage` first, then scans
 * for the first markdown image (`![](url)`) or HTML `<img src="url">`.
 * Remote URLs are returned as-is; local paths are resolved against the
 * note's directory and returned as `cube-file://` URLs.
 */
export function extractCoverImageUrl(
  text: string,
  frontmatter?: Record<string, unknown>,
  notePath?: string,
): string | null {
  if (frontmatter) {
    const candidate = frontmatter.cover_image ?? frontmatter.coverImage;
    if (typeof candidate === "string") {
      const resolved = resolveImageRef(candidate, notePath);
      if (resolved) return resolved;
    }
  }

  const mdMatch = text.match(MARKDOWN_IMAGE_RE);
  if (mdMatch?.[1]) {
    const resolved = resolveImageRef(mdMatch[1], notePath);
    if (resolved) return resolved;
  }

  const htmlMatch = text.match(HTML_IMG_SRC_RE);
  if (htmlMatch?.[1]) {
    const resolved = resolveImageRef(htmlMatch[1], notePath);
    if (resolved) return resolved;
  }

  return null;
}

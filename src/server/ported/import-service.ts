import { join, extname, basename } from "node:path";
import { access } from "node:fs/promises";
import Parser from "@postlight/parser";
import { workspaceRootMatch } from "@port/shared/path-utils";
import { writeFile } from "node:fs/promises";

export function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Only http and https URLs are supported, got: ${parsed.protocol}`,
    );
  }
}

export function validateWorkspaceBoundary(
  targetDir: string,
  workspaceRoot: string,
): void {
  if (!workspaceRootMatch(workspaceRoot, targetDir)) {
    throw new Error("Target directory is outside workspace");
  }
}

export function sanitizeFilename(title: string): string {
  return title
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = basename(name, ext);
  let candidate = join(dir, `${stem}${ext}`);
  let n = 2;
  while (true) {
    try {
      await access(candidate);
      candidate = join(dir, `${stem} ${n}${ext}`);
      n++;
    } catch {
      return candidate;
    }
  }
}

export function fixMalformedLinkedImages(md: string): string {
  return md.replace(
    /\[\s*\n\s*(!\[[^\]]*\]\([^)]+\))\s*\n\s*\]\(([^)]+)\)/g,
    "[$1]($2)",
  );
}

export function buildFrontmatter(
  fields: Record<string, string | undefined>,
): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

export async function importWebArticle(
  url: string,
  targetDir: string,
  workspaceRoot: string,
): Promise<{ path: string }> {
  validateUrl(url);
  validateWorkspaceBoundary(targetDir, workspaceRoot);

  const result = await Parser.parse(url, { contentType: "markdown" });

  if (!result || !result.content) {
    throw new Error(
      `Could not extract content from ${url}. The page may be empty, paywalled, or use JavaScript rendering.`,
    );
  }

  const title = result.title || new URL(url).hostname;
  const content = fixMalformedLinkedImages(result.content);

  const frontmatter = buildFrontmatter({
    type: "article",
    url,
    source_author: result.author ?? undefined,
    date_published: result.date_published ?? undefined,
    domain: result.domain ?? undefined,
    excerpt: result.excerpt ?? undefined,
    lead_image_url: result.lead_image_url ?? undefined,
    imported_at: new Date().toISOString(),
  });

  const filename = sanitizeFilename(title) + ".md";
  const filePath = await uniquePath(targetDir, filename);
  const fileContent = frontmatter + "\n\n" + content + "\n";

  await writeFile(filePath, fileContent, {flag:"wx",mode:0o600});

  return { path: filePath };
}

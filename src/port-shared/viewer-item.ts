// Adapted from packages/shared/src/viewer-item.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { parseDocument } from "yaml";
import type {
  ViewerItem,
  Quote,
  Concept,
  ItemSource,
} from "./types";

interface FrontMatterAttributes {
  title?: string;
  type?: string;
  url?: string;
  summary?: string;
  quotes?: Array<string | { text: string }>;
  quotesTitle?: string;
  concepts?: Array<{
    id: string;
    title: string;
    similarityScore?: string;
    degree?: number;
  }>;
  sources?: ItemSource[];
  cube_reviewed?: boolean;
}

function filenameFromPath(path: string): string {
  const segments = path.split("/");
  const last = segments[segments.length - 1] ?? "";
  return last.replace(/\.[^.]+$/, "");
}

function isSkillPath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/");
  if (p.includes("/.claude/skills/")) return true;
  const idx = p.indexOf("/.claude/plugins/");
  return idx >= 0 && p.includes("/skills/", idx);
}

function typeFromExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "FILE";
  return path.slice(dot + 1).toUpperCase();
}

/** Parse once so rich editing preserves exactly the prefix the viewer removed. */
export function splitFrontmatter(content: string): { attributes: FrontMatterAttributes; body: string; prefix: string } {
  try {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
    if (match) {
      const document = parseDocument(match[1]!, { schema: 'core' });
      if (document.errors.length) throw document.errors[0];
      const parsed = document.toJS({ maxAliasCount: 100 });
      const attributes = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      return { attributes, body: content.slice(match[0].length), prefix: match[0] };
    }
  } catch { /* Malformed metadata stays in the editable body. */ }
  return { attributes: {}, body: content, prefix: '' };
}

export function parseFileToViewerItem(
  path: string,
  content: string,
  stats?: { ctime: string; mtime: string },
): ViewerItem {
  const { attributes, body } = splitFrontmatter(content);

  const quotes: Quote[] | undefined =
    Array.isArray(attributes.quotes) ? attributes.quotes.filter(q => typeof q === "string" || (q && typeof q.text === "string")).map(q => typeof q === "string" ? { text: q } : q) : undefined;

  const concepts: Concept[] | undefined =
    attributes.concepts;

  const item: ViewerItem = {
    id: path,
    title: filenameFromPath(path),
    type: isSkillPath(path)
      ? "skill"
      : (attributes.type ?? typeFromExtension(path)),
    isEditable: true,
    isTitleEditable: true,
    text: body,
    createdAt: stats ? new Date(stats.ctime).getTime() : Date.now(),
    modifiedAt: stats ? new Date(stats.mtime).getTime() : Date.now(),
  };
  if (attributes.url !== undefined) item.url = attributes.url;
  if (attributes.summary !== undefined) item.summary = attributes.summary;
  if (quotes !== undefined) item.quotes = quotes;
  if (attributes.quotesTitle !== undefined) item.quotesTitle = attributes.quotesTitle;
  if (concepts !== undefined) item.relatedConcepts = concepts;
  if (attributes.sources !== undefined) item.sources = attributes.sources;
  if (attributes.cube_reviewed !== undefined) item.cube_reviewed = attributes.cube_reviewed;
  if (Object.keys(attributes).length > 0) {
    item.frontmatter = attributes as Record<string, unknown>;
  }
  return item;
}

/** Fields to strip from front-matter on save. */
const STRIPPED_FIELDS = new Set([
  "createdAt",
  "modifiedAt",
  "author",
]);

export function serializeViewerItem(
  item: ViewerItem,
  body: string,
): string {
  const attrs: Record<string, unknown> = {};
  const hadExplicitType = item.frontmatter?.type != null;
  if (hadExplicitType && item.type !== "skill")
    attrs.type = item.type;
  if (item.url) attrs.url = item.url;
  if (item.summary) attrs.summary = item.summary;
  if (item.quotes?.length) attrs.quotes = item.quotes;
  if (item.quotesTitle) attrs.quotesTitle = item.quotesTitle;
  if (item.relatedConcepts?.length)
    attrs.concepts = item.relatedConcepts;
  if (item.sources?.length) attrs.sources = item.sources;
  if (item.cube_reviewed != null)
    attrs.cube_reviewed = item.cube_reviewed;

  // Strip legacy fields that may have been carried forward
  for (const key of STRIPPED_FIELDS) {
    delete attrs[key];
  }

  const hasAttrs = Object.keys(attrs).length > 0;
  if (!hasAttrs) return body;

  const yaml = Object.entries(attrs)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n${body}`;
}

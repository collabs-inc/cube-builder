/** HTML artifacts are ordinary files in a checkout, independent of repo kind. */
export const ARTIFACT_FOCUS_MESSAGE = "cube:artifact-focus";
/** Posted as `{ type, url }` for a link the artifact wants opened in the user's browser. */
export const ARTIFACT_OPEN_MESSAGE = "cube:artifact-open";

/** The http(s) URL an artifact frame asked to open, or null for any other message. */
export function artifactOpenUrl(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const { type, url } = data as { type?: unknown; url?: unknown };
  if (type !== ARTIFACT_OPEN_MESSAGE || typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function isArtifactName(name: string): boolean {
  return name.length > 5 && !name.startsWith(".") && !/[\\/]/.test(name) && [...name].every(char => char.charCodeAt(0) >= 32) && /\.html$/i.test(name);
}

export function extractHtmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
  return match?.[1]?.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, key: string) => entities[key]!)
    .replace(/\s+/g, " ").trim().slice(0, 240) || null;
}

/**
 * The script appended to every served artifact. The frame is sandboxed
 * without popups and cannot navigate its embedder, so a link off the
 * artifact's own origin would either do nothing (a new-window link) or load
 * inside the pane (a plain one). Both, and `window.open`, go to the embedder
 * instead, which opens the page in the user's browser. The click listener is
 * on window in the bubble phase, so a page that handles its own links and
 * calls `preventDefault` keeps them.
 */
export function withArtifactFocusBridge(html: string): string {
  return html + `\n<script>(() => {
    const notify = () => parent.postMessage("${ARTIFACT_FOCUS_MESSAGE}", "*");
    window.addEventListener("pointerdown", notify, true);
    window.addEventListener("focusin", notify, true);
    const external = (href) => {
      try {
        const url = new URL(href, location.href);
        return /^https?:$/.test(url.protocol) && url.origin !== location.origin ? url.href : null;
      } catch { return null; }
    };
    const openOutside = (url) => parent.postMessage({ type: "${ARTIFACT_OPEN_MESSAGE}", url }, "*");
    window.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      const url = link && external(link.getAttribute("href"));
      if (!url) return;
      event.preventDefault();
      openOutside(url);
    });
    const open = window.open.bind(window);
    window.open = (href, ...rest) => {
      const url = href === undefined ? null : external(String(href));
      if (!url) return open(href, ...rest);
      openOutside(url);
      return null;
    };
  })();</script>`;
}

export interface ArtifactUrlArgs { repoId: string; file: string; theme: "light" | "dark" }
export function artifactUrl(endpoint: string, args: ArtifactUrlArgs & { token: string }): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/artifact";
  url.search = "";
  url.hash = "";
  url.searchParams.set("repo", args.repoId);
  url.searchParams.set("file", args.file);
  url.searchParams.set("token", args.token);
  url.searchParams.set("theme", args.theme);
  return url.toString();
}

/**
 * The one system instruction cubed adds to every agent it launches
 * (src/main/cubed/agent-instructions.ts).
 *
 * It lives here, beside the discovery rules it describes, because the same
 * sentence has to reach a Claude Code tile's argv, a codex config
 * override, an opencode instructions file and a claude-agent-acp
 * `_meta.systemPrompt.append` — four mechanisms, one text. A second copy
 * anywhere would be a second product behaviour the moment either drifted.
 *
 * Every claim in it is a claim about `isArtifactName`/`extractHtmlTitle`
 * above and the preview endpoint's own limits (docs/artifact-panes.md): a
 * root `.html` file, a `<title>` for the label, no adjacent assets
 * served, a `theme` query parameter. Change one and change the other.
 */
export const ARTIFACT_AGENT_INSTRUCTION = `You are running inside Cube. Cube shows every .html file at the root of the current checkout as an artifact in its sidebar, and opens it in a pane next to this session.

When the user asks for an artifact, or for a standalone visual deliverable where a web page is the natural format (a report, diagram, dashboard, mockup, prototype or comparison), create it as a single HTML file at the root of the checkout you are working in:

- Make it self-contained: inline all CSS, JavaScript and data. Cube does not serve files next to it, so linked local assets will not load. Loading libraries from a public CDN is fine.
- Give it a short, descriptive kebab-case name such as auth-flow.html. Never name it index.html.
- Set a <title>; Cube uses it as the artifact's name.
- Match Cube's theme: Cube opens the page with a \`theme\` query parameter set to \`light\` or \`dark\`. Style the page for that value, and fall back to \`prefers-color-scheme\` when the parameter is absent.
- When the user asks for changes, edit the same file rather than creating a new one.
- Commit it the way you would commit any other change.
- Tell the user the artifact's filename; it appears in Cube's sidebar.

This does not apply to changes to the project's own code, or to questions best answered in chat.`;

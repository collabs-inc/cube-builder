// Shared foundations for Cube apps: constants, manifest parser, host-label
// helpers and the page served at /__cube/ready. Imports nothing — the Deno
// functions tree gets a copy of this file, so anything it imported would
// have to be copied too. Spec: docs/superpowers/specs/2026-10-02-cube-apps-design.md.

export const APP_MANIFEST_FILE = "cube.json";
export const APP_HOST_SUFFIX = "cube.site";
export const APP_PATH_PREFIX = "/__cube-app/";
export const APP_RESERVED_PREFIX = "/__cube/";
export const APP_EDGE_SECRET_HEADER = "x-cube-app-edge";
export const APP_EDGE_HOST_HEADER = "x-cube-app-host";
export const APP_AUTH_MARKER_HEADER = "x-cube-app-auth";
/** On the hostname entrance's 404 for a request it cannot place (no or wrong edge secret, unknown label), value
 *  APP_ROUTE_UNKNOWN: tells the edge its remembered route may be stale. The gate strips every `x-cube-app-*` header from
 *  an app's responses, so an app cannot send it, and the edge strips it before answering a browser. */
export const APP_ROUTE_MARKER_HEADER = "x-cube-app-route";
export const APP_ROUTE_UNKNOWN = "unknown";
export const APP_COOKIE_FRAME = "__Host-cube-app-f";
export const APP_COOKIE_TAB = "__Host-cube-app-t";
export const APP_TICKET_KEY_LABEL = "cube.app-ticket.v1";
export const APP_SESSION_KEY_LABEL = "cube.app-session.v1";
export const APP_EDGE_KEY_LABEL = "cube.app-edge.v1";
export const APP_TICKET_AUDIENCE = "cube-app";
export const APP_TICKET_TTL_SECONDS = 120;
/** Clock leeway on a ticket's times; also how long a consumed ticket id is retained past its expiry. */
export const APP_TICKET_LEEWAY_SECONDS = 30;
export const APP_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const APP_READY_MESSAGE = "app-ready";
export const APP_BLOCKED_MESSAGE = "app-blocked";

/** What a client is told for a cloud app the machine holds no `<label>.cube.site` name for yet: there is no web
 *  address to load until a claim succeeds. The router and the daemon both refuse with exactly this sentence. */
export const APP_NO_ADDRESS_MESSAGE = "This app has no address yet.";

/** True for the no-address refusal, including after IPC has wrapped its message (Electron prefixes the channel). */
export function isAppNoAddressError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return message.includes(APP_NO_ADDRESS_MESSAGE);
}

export type AppPlatform = "linux" | "darwin";

export interface AppManifest {
  name: string;
  start?: string;
  install?: string;
  root?: string;
  description?: string;
  icon?: string;
  platforms?: AppPlatform[];
}

export type ManifestResult = { ok: true; manifest: AppManifest } | { ok: false; error: string };

const NAME_MAX = 64;
const DESCRIPTION_MAX = 200;

function fail(error: string): ManifestResult {
  return { ok: false, error };
}

function isRelativeInside(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
  return !path.split("/").includes("..");
}

/** Validates the text of a cube.json. Unknown fields are dropped, so later versions can add to the manifest. */
export function parseAppManifest(text: string): ManifestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("cube.json is not valid JSON.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail("cube.json must be a JSON object.");
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.name !== "string" || o.name.length === 0) return fail('"name" is required and must be a non-empty string.');
  if (o.name.length > NAME_MAX) return fail(`"name" must be at most ${NAME_MAX} characters.`);
  const manifest: AppManifest = { name: o.name };

  if (o.description !== undefined) {
    if (typeof o.description !== "string") return fail('"description" must be a string.');
    if (o.description.length > DESCRIPTION_MAX) return fail(`"description" must be at most ${DESCRIPTION_MAX} characters.`);
    manifest.description = o.description;
  }
  for (const key of ["start", "install"] as const) {
    const v = o[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.trim() === "") return fail(`"${key}" must be a non-empty string.`);
    manifest[key] = v;
  }
  if (o.platforms !== undefined) {
    const p = o.platforms;
    if (!Array.isArray(p) || !p.every((x) => x === "linux" || x === "darwin")) {
      return fail('"platforms" must be a list containing only "linux" and "darwin".');
    }
    manifest.platforms = [...p] as AppPlatform[];
  }
  if (o.root !== undefined) {
    if (manifest.start !== undefined) return fail('"root" cannot be combined with "start": it only applies to an app that serves files.');
    if (typeof o.root !== "string" || !isRelativeInside(o.root)) {
      return fail('"root" must be a relative folder inside the repository, without backslashes or "..".');
    }
    manifest.root = o.root;
  }
  if (o.icon !== undefined) {
    if (typeof o.icon !== "string" || !isRelativeInside(o.icon) || !/\.(svg|png)$/i.test(o.icon)) {
      return fail('"icon" must be a relative path inside the repository to an .svg or .png file.');
    }
    manifest.icon = o.icon;
  }
  return { ok: true, manifest };
}

/** A caller-supplied recipe has the same schema as cube.json, with a transport size limit. Re-parsing also snapshots it. */
export function parseAppManifestOverride(value: unknown): AppManifest {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error("The app manifest must be valid JSON.");
  }
  if (text === undefined) throw new Error("The app manifest must be valid JSON.");
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error("The app manifest must be at most 64 KiB of JSON.");
  const parsed = parseAppManifest(text);
  if (!parsed.ok) throw new Error(`The app manifest was refused: ${parsed.error}`);
  return parsed.manifest;
}

export type AppSource = { gitUrl: string; commit: string; manifest?: AppManifest } | { repoId: string };
export type AppState = "installing" | "starting" | "running" | "stopped" | "failed" | "updating";
/** On-demand app-folder usage; excludes shared caches and data outside that folder. */
export interface AppInfo { installedSizeBytes: number | null }
export type AppUpdatePhase = "installing" | "switching" | "verifying" | "rolling-back";

/** The daemon-written object on a catalog item of type "app". */
export interface AppFields {
  name: string;
  description?: string;
  hasIcon: boolean;
  serves: "server" | "files";
  runsCode: boolean;
  source: AppSource;
  desired: "running" | "stopped";
  state: AppState;
  failure?: string;
  updateAvailable?: boolean;
  update?: { phase: AppUpdatePhase; from: string; to: string };
  gatePort?: number;
  hostname?: string;
  generation: number;
}

/** A patch to AppFields in which a key set to undefined means "delete this field". Needed because the repo compiles with
 *  exactOptionalPropertyTypes, under which Partial<AppFields> rejects an explicit undefined. Use this type for every app patch. */
export type AppPatch = { [K in keyof AppFields]?: AppFields[K] | undefined };

export function isAppItem<T extends { type: string; app?: AppFields }>(item: T): item is T & { type: "app"; app: AppFields } {
  return item.type === "app" && item.app !== undefined;
}

/** Lowercased name, runs of non [a-z0-9] turned to "-", outer hyphens trimmed; "app" when empty. */
export function appHostSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "app" : slug;
}

const SUFFIX_RE = /^[a-z0-9]{8}$/;
const LABEL_MAX = 63;
const STAGING_TAIL = "-stg";

/** `${slug}-${suffix}` (or `-stg` appended when staging), at most 63 chars; suffix must be 8 chars of [a-z0-9]. Throws otherwise. */
export function mintAppHostLabel(name: string, suffix: string, staging: boolean): string {
  if (!SUFFIX_RE.test(suffix)) throw new Error("An app host suffix must be 8 characters of [a-z0-9].");
  const tail = `-${suffix}${staging ? STAGING_TAIL : ""}`;
  const room = LABEL_MAX - tail.length;
  const slug = appHostSlug(name).slice(0, room).replace(/-+$/, "") || "app";
  return `${slug}${tail}`;
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?-[a-z0-9]{8}(-stg)?$/;

export function isAppHostLabel(label: string): boolean {
  return label.length <= LABEL_MAX && LABEL_RE.test(label);
}

export function isStagingAppHostLabel(label: string): boolean {
  return isAppHostLabel(label) && label.endsWith(STAGING_TAIL);
}

/** "panel-ab12cd34.cube.site" -> "panel-ab12cd34"; null for anything else, including nested labels and other suffixes. */
export function appHostLabelOf(hostname: string): string | null {
  const tail = `.${APP_HOST_SUFFIX}`;
  if (!hostname.endsWith(tail)) return null;
  const label = hostname.slice(0, -tail.length);
  return isAppHostLabel(label) ? label : null;
}

/** Resolves `path` against `origin`; returns pathname+search+hash only if the result's origin is exactly `origin`,
 *  the input has no backslash or control character, and the pathname is not under APP_RESERVED_PREFIX. Else null. */
export function validReturnPath(path: string, origin: string): string | null {
  if (path === "" || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return null;
  let url: URL;
  let base: URL;
  try {
    base = new URL(origin);
    url = new URL(path, base);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  if (url.pathname.startsWith(APP_RESERVED_PREFIX) || url.pathname === APP_RESERVED_PREFIX.slice(0, -1)) return null;
  return url.pathname + url.search + url.hash;
}

/** A string safe to place inside an inline script: a JSON literal with every "<" and line separator escaped. */
function scriptLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(new RegExp("[\\u2028\\u2029]", "g"), (c) => "\\u" + c.charCodeAt(0).toString(16));
}

/** The page /__cube/ready returns. `ok` true: posts { cube: APP_READY_MESSAGE } to window.parent when framed, then location.replace(path).
 *  `ok` false: posts { cube: APP_BLOCKED_MESSAGE } and shows one sentence. Pure string, so the daemon and the Worker serve the identical page.
 *  `path` is embedded as a JSON string literal, never concatenated into script text. */
export function appReadyPage(ok: boolean, path: string): string {
  const message = ok ? APP_READY_MESSAGE : APP_BLOCKED_MESSAGE;
  const body = ok ? "" : "<p>This browser blocked the app's sign-in. Open the app in a new tab.</p>";
  const go = ok ? `location.replace(${scriptLiteral(path)});` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Cube</title></head><body>${body}<script>try{if(window.parent!==window)window.parent.postMessage({cube:${scriptLiteral(message)}},"*")}catch(e){}${go}</script></body></html>`;
}

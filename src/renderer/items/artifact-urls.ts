import type { OwnedItem } from "@port/shared/catalog";
import type { ArtifactUrlArgs } from "@port/shared/artifact";
import { isSiteItem, SITE_NEEDS_DESKTOP, SITE_UNREACHABLE, type SiteLocator } from "@port/shared/site";
import { LOCAL_MACHINE_ID } from "@port/shared/types";
import { services } from "../services";
import { artifactFileName } from "./artifact-item-logic";

export interface ArtifactUrlDeps {
  artifactUrl(machineId: string, args: ArtifactUrlArgs): Promise<string>;
  siteUrl(machineId: string, site: SiteLocator): Promise<string>;
  openExternal(url: string): void;
  writeClipboard(text: string): Promise<void>;
  /** A desktop host, where loopback and file URLs mean something. */
  desktop: boolean;
}

function defaultDeps(): ArtifactUrlDeps {
  return {
    artifactUrl: (machineId, args) => services.artifacts.artifactUrl(machineId, args),
    siteUrl: (machineId, site) => services.sites.url(machineId, site),
    openExternal: (url) => services.desktop.openExternal(url),
    writeClipboard: (text) => services.desktop.clipboard.writeText(text),
    desktop: services.desktop.capabilities.localRepos,
  };
}

/**
 * What a failed Open in browser or Copy URL says. A site's own rejection is
 * written for the user (the web shim's SITE_NEEDS_DESKTOP, main's
 * SITE_UNREACHABLE) and is searched for rather than matched whole, because an
 * Error crossing Electron's IPC boundary gains an "Error invoking remote
 * method '…': Error: " wrapper. Any other failure gets the action's own sentence.
 */
export function artifactActionMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return [SITE_NEEDS_DESKTOP, SITE_UNREACHABLE].find((text) => message.includes(text)) ?? fallback;
}

export function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const rooted = /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized;
  return `file://${rooted.split("/").map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment))).join("/")}`;
}

/** Only URLs that keep working: never a two-minute cloud artifact ticket, never loopback on the web. */
export function canCopyArtifactUrl(item: OwnedItem, desktop: boolean): boolean {
  if (!desktop || item.type !== "artifact") return false;
  if (isSiteItem(item)) return true;
  return item.machineId === LOCAL_MACHINE_ID && item.filePath !== undefined;
}

async function lastingUrl(item: OwnedItem, deps: ArtifactUrlDeps): Promise<string> {
  if (isSiteItem(item)) return deps.siteUrl(item.machineId, { port: item.port!, siteAddress: item.siteAddress ?? "127.0.0.1" });
  if (item.machineId === LOCAL_MACHINE_ID && item.filePath) return fileUrl(item.filePath);
  throw new Error("This artifact has no lasting URL.");
}

export async function openArtifactInBrowser(item: OwnedItem, theme: "light" | "dark", deps: ArtifactUrlDeps = defaultDeps()): Promise<void> {
  if (item.type !== "artifact") throw new Error("This artifact is no longer available.");
  if (isSiteItem(item) || item.machineId === LOCAL_MACHINE_ID) {
    deps.openExternal(await lastingUrl(item, deps));
    return;
  }
  if (!item.repoId || !item.filePath) throw new Error("This artifact is no longer available.");
  deps.openExternal(await deps.artifactUrl(item.machineId, { repoId: item.repoId, file: artifactFileName(item.filePath), theme }));
}

export async function copyArtifactUrl(item: OwnedItem, deps: ArtifactUrlDeps = defaultDeps()): Promise<void> {
  if (!canCopyArtifactUrl(item, deps.desktop)) throw new Error("This artifact has no lasting URL.");
  await deps.writeClipboard(await lastingUrl(item, deps));
}

/**
 * Site artifacts: a localhost dev server a terminal announced (or, on a cloud
 * machine, any loopback listener serving HTML), shown as an `artifact` catalog
 * item carrying `port`. See docs/superpowers/specs/2026-09-12-site-artifacts-design.md.
 */
import type { CatalogItem } from "./catalog";

export type SiteAddress = "127.0.0.1" | "::1";

/** What the desktop needs to resolve a site's URL. */
export interface SiteLocator {
  port: number;
  siteAddress: SiteAddress;
}

/** Main → renderer: how one named site frame's navigation ended. */
export interface SiteFrameOutcome {
  frameName: string;
  ok: boolean;
  errorCode?: number;
}

export const SITE_FRAME_PREFIX = "cube-site:";
export const SITE_NEEDS_DESKTOP = "Needs the desktop app";
export const SITE_UNREACHABLE = "Couldn't reach this site";

/** The retired managed preview runtime's catalog target; still filtered and cleaned up. */
export const LEGACY_PREVIEW_TARGET = "web-preview";

export function isSiteItem(item: Pick<CatalogItem, "type" | "port">): boolean {
  return item.type === "artifact" && typeof item.port === "number";
}

export function isSiteAddress(value: unknown): value is SiteAddress {
  return value === "127.0.0.1" || value === "::1";
}

export function siteOrigin(address: SiteAddress, port: number): string {
  return address === "::1" ? `http://[::1]:${port}` : `http://127.0.0.1:${port}`;
}

// Adapted from packages/components/src/Terminal/web-link.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * Scheme guard for terminal link activation — the single funnel both link
 * kinds go through before openExternal: WebLinksAddon's regex-detected
 * http(s) text and OSC 8 hyperlinks, whose URI is whatever the printing
 * program chose (file:, javascript:, custom protocol handlers). main
 * re-checks the scheme in ipc-misc.ts; this is the renderer half of the
 * same fail-closed posture, kept as its own function so it can be tested
 * without an xterm instance.
 */
export function activateWebLink(uri: string, openExternal: (url: string) => void): void {
	if (!/^https?:\/\//i.test(uri)) return;
	openExternal(uri);
}

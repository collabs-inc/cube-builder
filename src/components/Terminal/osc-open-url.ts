// Adapted from packages/components/src/Terminal/osc-open-url.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * Decodes this app's private "open a URL on the user's machine" OSC, or
 * null for anything that must not leave the terminal.
 *
 * The counterpart to osc52.ts, and the same trust posture: a program on
 * a machine with no browser of its own — a CLI's auth flow on a cloud
 * machine, most relevantly — asks the terminal emulator's machine to
 * open a URL, over the one channel that already flows from any pty to
 * the attached client. The emitter is the `cube-open` $BROWSER shim
 * cubed writes on cloud machines (src/main/cubed/shell-wrappers.ts —
 * the OSC code below is duplicated there, in shell).
 *
 * The payload is the raw URL. http(s) only, no whitespace or control
 * characters, bounded length — and the caller must treat a decoded URL
 * as a REQUEST to surface to the user, never something to auto-open: the
 * pty stream is replayed on reattach, and a remote process is not
 * entitled to pop pages on the user's machine unprompted.
 */
export const OSC_OPEN_URL = 5522;

const MAX_URL_LENGTH = 2048;

export function decodeOscOpenUrl(payload: string): string | null {
	if (payload.length === 0 || payload.length > MAX_URL_LENGTH) return null;
	if (!/^https?:\/\//i.test(payload)) return null;
	// Space, C0 controls and DEL: none belong in a URL, and BEL/ESC in
	// particular must never round-trip toward another parser.
	// oxlint-disable-next-line no-control-regex -- matching them IS the point
	if (/[\s\u0000-\u001f\u007f]/.test(payload)) return null;
	return payload;
}

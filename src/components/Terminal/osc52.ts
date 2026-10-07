// Adapted from packages/components/src/Terminal/osc52.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * Decodes an OSC 52 clipboard WRITE into its text, or null for anything
 * that must not touch the clipboard.
 *
 * OSC 52 is how a program with no clipboard of its own — anything running
 * on a remote machine's pty, most relevantly — asks the terminal emulator
 * to set the clipboard on the machine the user is actually sitting at.
 * The payload is `Pc ; Pd`: `Pc` names one or more selections ("c"
 * clipboard, "p" primary, …) which this app collapses into the one system
 * clipboard; `Pd` is the base64-encoded text.
 *
 * Returns null for a read query (`Pd` = "?") — a remote process must
 * never read the user's clipboard — and for anything malformed. An empty
 * `Pd` decodes to "" (the spec's "clear the clipboard").
 */
export function decodeOsc52Write(payload: string): string | null {
	const separator = payload.indexOf(";");
	if (separator === -1) return null;
	const data = payload.slice(separator + 1);
	if (data === "?") return null;
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(atob(data), (ch) => ch.codePointAt(0) ?? 0);
	} catch {
		return null;
	}
	return new TextDecoder().decode(bytes);
}

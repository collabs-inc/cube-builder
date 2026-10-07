// Adapted from packages/components/src/Terminal/sanitizeAgentTitle.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
const AGENT_TITLE_MAX_LEN = 60;

/**
 * Collapses an xterm window-title event into safe, displayable text:
 * strips control characters and Unicode format characters, collapses
 * whitespace runs to a single space, trims, and caps length. Titles
 * originate from the pty — any program running inside it can emit an OSC
 * title sequence — so the sanitized result must still only ever be
 * rendered as plain text, never HTML.
 */
export function sanitizeAgentTitle(raw: string): string {
	return raw
		// eslint-disable-next-line no-control-regex -- deliberately stripping control chars from an attacker-influenced OSC title
		.replace(/[\x00-\x1f\x7f]/g, " ")
		// Unicode "format" characters (category Cf) — bidi overrides
		// (U+202A-U+202E, U+2066-U+2069), zero-width spaces/joiners, etc. —
		// render invisibly but can reorder or hide the surrounding text
		// (Trojan Source-style label spoofing), so strip the whole category.
		.replace(/\p{Cf}/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, AGENT_TITLE_MAX_LEN);
}

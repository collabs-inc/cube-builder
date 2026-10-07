// Adapted from packages/components/src/Terminal/path-links.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * File-path detection for terminal output (issue #25). Deliberately
 * conservative: a token must contain a `/`, and its last segment must
 * look like a file (a dotted name) or carry an explicit `:line[:col]`
 * suffix — a false link on prose is worse than a missed link on an
 * exotic path. URLs never match: their `//` is not a token boundary, so
 * the scan can't start inside one, and http(s) text is the web-links
 * addon's territory (double-linking a region makes hover ambiguous).
 *
 * Pure string → matches, no xterm types: TerminalTab adapts the ranges
 * to xterm's 1-based inclusive buffer coordinates at the registration
 * site, and the app layer resolves the text against the tile's cwd.
 */
export interface PathLink {
	/** The matched token, `:line[:col]` suffix included. */
	text: string;
	/** 0-based string index of the first character. */
	start: number;
	/** 0-based string index one past the last character. */
	end: number;
}

const CANDIDATE = /(?:^|[\s"'`([{<])((?:\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)+(?::\d+(?::\d+)?)?)/g;

export function detectPathLinks(
	line: string,
	opts: { allowAbsolute: boolean },
): PathLink[] {
	const out: PathLink[] = [];
	CANDIDATE.lastIndex = 0;
	for (let m = CANDIDATE.exec(line); m !== null; m = CANDIDATE.exec(line)) {
		// Sentence punctuation glued to the token is not part of the path.
		// A numeric :line[:col] suffix survives (it ends in a digit).
		const token = m[1]!.replace(/[.,;:!?]+$/, "");
		if (!token.includes("/")) continue;
		if (!opts.allowAbsolute && token.startsWith("/")) continue;
		const suffix = /:\d+(?::\d+)?$/.exec(token);
		const base = suffix ? token.slice(0, suffix.index) : token;
		const lastSegment = base.slice(base.lastIndexOf("/") + 1);
		if (lastSegment.length === 0) continue;
		const fileLooking = lastSegment.includes(".") && !/^\.+$/.test(lastSegment);
		if (!fileLooking && suffix === null) continue;
		const start = m.index + (m[0].length - m[1]!.length);
		out.push({ text: token, start, end: start + token.length });
	}
	return out;
}

/**
 * A file-listing failure, in the words the user should see.
 *
 * Everything the tree asks for crosses Electron's IPC boundary, which
 * re-throws the main-process error wrapped in its own channel name:
 * `Error invoking remote method 'workspace:read-tree': Error: <msg>`. The
 * part worth showing is `<msg>` — the router's version-skew sentence, say —
 * so the wrapper and the error class it re-prefixes are peeled off, and only
 * then: a message that genuinely starts "Error: " on its own keeps it.
 */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/;
const ERROR_CLASS = /^[A-Za-z]*Error:\s*/;

/** Shown when the failure carries no message of its own to show. */
const FALLBACK = "Could not list the files here.";

export function treeErrorMessage(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	const unwrapped = raw.replace(IPC_WRAPPER, "");
	const message =
		unwrapped === raw ? raw : unwrapped.replace(ERROR_CLASS, "");
	return message.trim() || FALLBACK;
}

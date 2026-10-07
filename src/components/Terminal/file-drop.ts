// Adapted from packages/components/src/Terminal/file-drop.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * The client-side half of dragging a local file into a terminal whose
 * pty runs on ANOTHER machine. A local session needs none of this — its
 * pty can already open the path the drop carries — but a cloud session
 * cannot see this filesystem at all, so the bytes have to travel and the
 * path typed at the pty has to be the one they landed on over there.
 *
 * Deliberately DOM-light: the two structural interfaces below are what a
 * real `DataTransfer` satisfies, and are also what a test can hand in
 * without a DOM, the same trade `image-paste.ts` makes for clipboards.
 *
 * `dropContents` must be called SYNCHRONOUSLY from the drop handler —
 * a `DataTransfer` is emptied once the event finishes dispatching, so
 * anything read after the first `await` is gone.
 */

const MAX_TRANSFER_BYTES = 8 * 1024 * 1024;

/** What `sendDroppedFiles` needs of a file — a real `File` satisfies it. */
export interface DroppedFile {
	readonly name: string;
	readonly size: number;
}

interface DropItemLike {
	readonly kind: string;
	webkitGetAsEntry?: () => { readonly isDirectory: boolean } | null;
	getAsFile: () => File | null;
}

interface DataTransferLike {
	readonly items?: ArrayLike<DropItemLike> | null;
	readonly files?: ArrayLike<File> | null;
}

/**
 * What the tab tells its host to show while a drop is in flight, and
 * when part of one did not make it. `null` means nothing to show.
 * Errors are terminal, not transient: a user who dropped five files and
 * got three needs to be told which two, and needs it to stay on screen
 * until they dismiss it.
 */
export type TerminalTransfer =
	| { kind: "sending"; name: string; index: number; total: number }
	| { kind: "errors"; messages: string[] };

/** Matches the daemon's own cap (MAX_TRANSFER_BYTES in
 *  the standalone upload service). Checked here too so an oversized file is
 *  refused instantly, having sent nothing — base64ing megabytes only to
 *  be told no is a slow way to fail. */
export const MAX_DROP_BYTES = MAX_TRANSFER_BYTES;

export interface DropContents {
	files: File[];
	/** Folders are refused rather than walked — see `sendDroppedFiles`'s
	 *  caller, which names them so the user is not left wondering why
	 *  the drop did nothing. */
	folderNames: string[];
}

/**
 * Reads a drop into files and refused folders. Directory detection goes
 * through `webkitGetAsEntry`, not a path stat: it is synchronous, and it
 * is the only check that works in a browser tab, where a drop carries no
 * path to stat in the first place.
 */
export function dropContents(data: DataTransferLike | null | undefined): DropContents {
	const files: File[] = [];
	const folderNames: string[] = [];
	const items = data?.items;
	if (items && items.length > 0) {
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (!item || item.kind !== "file") continue;
			const file = item.getAsFile();
			if (item.webkitGetAsEntry?.()?.isDirectory === true) {
				folderNames.push(file?.name ?? "folder");
				continue;
			}
			if (file) files.push(file);
		}
		return { files, folderNames };
	}
	// No `items`: there is no synchronous way to spot a directory, so
	// everything reads as a file. Better than dropping the gesture.
	const list = data?.files;
	if (list) {
		for (let i = 0; i < list.length; i++) {
			const file = list[i];
			if (file) files.push(file);
		}
	}
	return { files, folderNames };
}

function humanSize(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export interface SendResult {
	/** Machine-native paths, in the order the files were dropped. */
	paths: string[];
	/** One human-readable line per file that did not make it. */
	errors: string[];
}

/**
 * Ships each dropped file to the pty's machine, in order, ONE AT A TIME.
 * Sequential on purpose: in parallel the whole drop sits in memory as
 * base64 at once, and there is no honest way to say which file the user
 * is waiting on. A file that fails is reported and the rest still go —
 * a five-file drop should not be lost to one refusal.
 */
export async function sendDroppedFiles<T extends DroppedFile>(
	files: readonly T[],
	opts: {
		stash: (file: T) => Promise<string>;
		maxBytes?: number;
		onProgress?: (progress: { name: string; index: number; total: number }) => void;
	},
): Promise<SendResult> {
	const maxBytes = opts.maxBytes ?? MAX_DROP_BYTES;
	const paths: string[] = [];
	const errors: string[] = [];
	for (let i = 0; i < files.length; i++) {
		const file = files[i]!;
		if (file.size > maxBytes) {
			errors.push(
				`${file.name} is ${humanSize(file.size)} — over the ${humanSize(maxBytes)} limit`,
			);
			continue;
		}
		opts.onProgress?.({ name: file.name, index: i + 1, total: files.length });
		try {
			paths.push(await opts.stash(file));
		} catch (err) {
			errors.push(`${file.name} — ${messageOf(err)}`);
		}
	}
	return { paths, errors };
}

/**
 * Wraps a path so the shell at the pty reads it as a single word. Lives
 * here rather than at either call site because the paste path needs the
 * identical treatment for the identical reason, and a second hand-rolled
 * copy of the `'\''` dance is the kind of thing that is only wrong once.
 */
export function quoteForShell(path: string): string {
	return `'${path.replace(/'/g, "'\\''")}'`;
}

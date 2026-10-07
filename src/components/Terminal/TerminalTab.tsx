import type { TerminalHost } from "./host";
// Adapted from packages/components/src/Terminal/TerminalTab.tsx at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { installTerminalRenderer } from "./renderer-lifecycle";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { installWrappedLinkHighlight } from "./wrapped-link";
import { getTheme, type TerminalTheme } from "./theme";
import { sanitizeAgentTitle } from "./sanitizeAgentTitle";
import { decodeOsc52Write } from "./osc52";
import { activateWebLink } from "./web-link";
import { detectPathLinks } from "./path-links";
import { decodeOscOpenUrl, OSC_OPEN_URL } from "./osc-open-url";
import {
	bytesToBase64,
	imageFileFromClipboard,
	imageFromClipboardItems,
	PASTED_IMAGE_LABEL,
} from "./image-paste";
import { planInsert } from "./dictation-sync";
import {
	dropContents,
	quoteForShell,
	sendDroppedFiles,
	type TerminalTransfer,
} from "./file-drop";
import { byteLengthOf } from "./byte-cursor";
import { attachTouchScroll } from "./touch-scroll";
import { isHistoryTopGesture } from "./history-top";
import "@xterm/xterm/css/xterm.css";
import "./TerminalTab.css";

// Matches VS Code's TerminalDataBufferer throttle interval.
// Coalesces rapid PTY data events into a single term.write()
// call, preventing partial-render artifacts from the renderer
// processing many small sequential writes.
const DATA_BUFFER_FLUSH_MS = 5;

// RIS (ESC c, "Reset to Initial State") — the reset a resetting patch
// carries, as BYTES rather than as a term.reset() call.
//
// term.write() only QUEUES: xterm parses on a later setTimeout, in
// arrival order. A term.reset() call runs immediately, so a reset issued
// from JS lands ahead of every chunk still sitting in that queue — the
// frames it was supposed to wipe parse AFTER it (and, being inside the
// patch's own window, appear a second time), and the viewport arithmetic
// is off by their lines. Prefixing the patch's data with RIS instead puts
// the reset at the patch's own position in the parse stream: xterm routes
// it through fullReset → onRequestReset → Terminal.reset(), the same
// method, at the right moment.
const RIS = "\x1bc";

/** What a term:open/reconnect response contributes to an already-mounted
 * terminal — see terminal-item-logic.ts's `attachScrollback` for how a
 * caller builds this. */
interface ScrollbackPatch {
	data: string;
	reset: boolean;
	/** A live truncated replay needs the application to repaint missing state. */
	redraw?: boolean;
}

interface TerminalTabProps {
	host: TerminalHost;
	fontSize?: number;
	sessionId: string;
	visible: boolean;
	/**
	 * Whether this is the workspace's active item. Becoming active refits
	 * and reasserts this client's grid on the shared pty: another client
	 * may have resized it while our own xterm dimensions stayed unchanged.
	 * DOM focus, window focus and clicks do the same for an already-active
	 * terminal and for surfaces that do not track an active item.
	 */
	focused?: boolean;
	theme: TerminalTheme;
	restored?: boolean;
	/**
	 * A term:open/reconnect response to apply. Written whenever this prop
	 * changes to a new value (not just at mount) — see the `[scrollbackData]`
	 * effect below — so a live tile can re-attach after its host process
	 * restarts without remounting: `reset: true` clears the terminal first,
	 * `reset: false` appends the delta in place.
	 */
	scrollbackData?: ScrollbackPatch | null;
	/**
	 * A backfill reply to apply IN BAND: queued behind the live frames
	 * already received, applied at its FIFO position (spec §3) —
	 * `reset: true` clears first (a window), `reset: false` appends (the
	 * follow-up delta). A new `id` applies a new patch.
	 */
	inbandReset?: { id: number; data: string; reset: boolean } | null;
	/**
	 * Fired once per held window on a user scroll-up gesture at the top of
	 * a normal buffer that has scrollback.
	 */
	onHistoryTop?: () => void;
	/** Fired when an in-band reset patch has finished parsing. */
	onInbandApplied?: (id: number) => void;
	/**
	 * The output byte cursor `sessionId` starts from — from the same
	 * response's `seq`. Seeds the running cursor `onSeqAdvance` reports as
	 * live frames arrive; 0 for a fresh session with no prior cursor.
	 */
	initialSeq?: number;
	/**
	 * Called with the tile's new output cursor every time a live frame
	 * arrives (cumulative, not a delta) — see byte-cursor.ts's
	 * `byteLengthOf` for why this counts raw bytes rather than
	 * `Uint8Array.byteLength`-adjacent JS string length. The caller holds
	 * onto the latest value to pass back as `sinceSeq` on a future
	 * reattach; nothing here needs to.
	 */
	onSeqAdvance?: (seq: number) => void;
	/** Gates window-title capture to agent-harness tiles (Task 9). */
	acceptTitles?: boolean;
	/** Called with the sanitized title whenever the pty's agent reports one. */
	onAgentTitle?: (title: string) => void;
	/**
	 * Called once at unmount with the xterm's serialized rendered state
	 * (screen + scrollback, as replayable escape sequences) and the output
	 * byte cursor that state is complete up to. A successor instance for
	 * the same session restores the snapshot locally and reconnects for
	 * only the delta past that cursor — see TerminalItem's remount branch.
	 * The cursor counts PARSED bytes (advanced by term.write callbacks),
	 * not received ones: xterm parses asynchronously, and pairing the
	 * snapshot with a cursor ahead of what it shows would lose the bytes
	 * in between from both the snapshot and the delta. Not called when the
	 * initial scrollback patch hasn't finished parsing — a snapshot taken
	 * then would claim a cursor it doesn't contain, and no snapshot just
	 * means the successor falls back to a full replay.
	 */
	onSnapshot?: (snapshot: string, seq: number) => void;
	/**
	 * Called with the decoded path whenever the shell reports its cwd via
	 * OSC 7. Optional: the terminal-tile guest this replaces had a
	 * `host.notifyCwdChanged` IPC call here, but that preload method
	 * doesn't exist in the single-renderer app's preload — callers that
	 * care about cwd changes (TerminalItem) pass this prop instead; a
	 * caller that doesn't pass it just drops the notification, same as
	 * before it existed.
	 */
	onCwdChanged?: (cwd: string) => void;
	/**
	 * Called with every chunk of input the USER typed or pasted into this
	 * terminal, as xterm hands it over — the one path human keystrokes
	 * take, so a caller counting user activity (analytics) sees exactly
	 * that and never the app's own programmatic writes to the pty. The
	 * chunk is passed through for the caller to classify; nothing here
	 * inspects it.
	 */
	onUserInput?: (data: string) => void;
	/**
	 * Called with the raw matched token (`:line[:col]` suffix included)
	 * when the user clicks a file-path-looking token in the output — see
	 * path-links.ts. Resolution against the tile's cwd and the actual
	 * open live with the caller, which is what knows the machine and repo.
	 * Absent, no path link provider is registered at all.
	 */
	onOpenPath?: (raw: string) => void;
	/**
	 * Whether absolute paths are clickable. A local shell's absolute paths
	 * are real on this filesystem; a cloud shell's are machine-native and
	 * unresolvable in the renderer, so its caller passes false and only
	 * relative paths (resolved against the virtualized cwd) light up.
	 */
	allowAbsolutePaths?: boolean;
	/**
	 * Whether activating `raw` would actually open something — links that
	 * would be dead on click (a cloud machine-native path outside every
	 * repo, say) are filtered out at detection so nothing underlines that
	 * does not respond. Optional: absent means every detected path links.
	 */
	canOpenPath?: (raw: string) => boolean;
	/**
	 * Called with a validated http(s) URL when a program in the pty emits
	 * this app's private open-a-URL OSC (osc-open-url.ts — the cube-open
	 * $BROWSER shim on a cloud machine is the intended emitter). This is a
	 * REQUEST: the caller surfaces an affordance and lets the user open
	 * it; nothing here or downstream may auto-open, because the pty
	 * stream replays on reattach and a remote process is not entitled to
	 * pop pages on the user's machine unprompted.
	 */
	onOpenUrlRequest?: (url: string) => void;
	/**
	 * True when the pty runs on ANOTHER machine, which changes what a
	 * paste and a drop can mean:
	 *   - pasting an image ships its bytes and types the stashed path
	 *     (issue #13), because a cloud CLI cannot see this machine's
	 *     clipboard — while a local CLI reads the OS clipboard itself
	 *     when the keystroke reaches it, which already works and is
	 *     richer;
	 *   - dropping a file ships its bytes for the same reason, because
	 *     the path the drop carries names nothing over there — while a
	 *     local pty can just open it, so nothing is copied.
	 * One flag rather than two: both forks turn on the same fact, and a
	 * caller that could answer them differently would be describing a
	 * session that does not exist.
	 */
	remote?: boolean;
	/**
	 * Progress and failures for a drop in flight, for the host to render
	 * (see TerminalItem's transfer banner). Called with `null` when
	 * there is nothing left to show. Deliberately not written into the
	 * xterm buffer: that would garble a half-typed prompt line, and the
	 * notice would evaporate on the next reattach replay since it was
	 * never part of the pty stream.
	 */
	onTransferStatus?: (status: TerminalTransfer | null) => void;
	/**
	 * Renders the session's output and never writes to it — not a
	 * keystroke, not a paste, not a drop, and not a RESIZE.
	 *
	 * The last one is the reason this is a mode rather than just xterm's
	 * `disableStdin`. This component owns four separate write paths into
	 * the pty (`term.onData`, the custom key bindings, paste/drop, and
	 * `ptyResize` from both `term.onResize` and `reclaimSize`), and the
	 * resize path needs NO user action at all: merely laying a tool
	 * terminal out in a 180px box fits xterm to it and reshapes the
	 * agent's live 120x40 pty mid-command. So every one of the four is
	 * gated here, not just stdin.
	 *
	 * The one caller today is the agent view's embedded tool terminal — a
	 * command the AGENT ran, shown to the user, on a pty the agent itself
	 * is reading and sizing. Copying out of it still works.
	 *
	 * Read through a ref, like `visible`/`remote`, so a value that changes
	 * after mount is honoured by the listeners already installed.
	 */
	readOnly?: boolean;
}

function TerminalTab({
	host,
	fontSize = 12,
	sessionId,
	visible,
	theme,
	restored,
	scrollbackData,
	inbandReset = null,
	onHistoryTop,
	onInbandApplied,
	initialSeq,
	onSeqAdvance,
	acceptTitles,
	onAgentTitle,
	onCwdChanged,
	onUserInput,
	onSnapshot,
	onOpenPath,
	allowAbsolutePaths,
	canOpenPath,
	onOpenUrlRequest,
	remote,
	onTransferStatus,
	readOnly = false,
	focused = false,
}: TerminalTabProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const fitRef = useRef<{ fit(): void } | null>(null);
	const sizeRef = useRef<((size: number) => void) | null>(null);
	useEffect(() => { sizeRef.current?.(fontSize); }, [fontSize]);
	const writeRef = useRef<Terminal["write"] | null>(null);
	const redrawRef = useRef<(() => void) | null>(null);
	const reclaimSizeRef = useRef<(() => void) | null>(null);
	const visibleRef = useRef(visible);
	visibleRef.current = visible;
	// Read by every write path below (see readOnly's own doc comment).
	const readOnlyRef = useRef(readOnly);
	readOnlyRef.current = readOnly;
	// How many patches (the [scrollbackData] effect's write, or an in-band
	// FIFO chunk's write) are between term.write and their parse callback
	// right now — the window in which a snapshot would be a lie (see
	// onSnapshot's doc comment). A COUNTER, not a boolean: a scrollbackData
	// patch still parsing when another patch's write is queued behind it
	// would otherwise have its callback clear a shared boolean early,
	// double-flushing the deferred OSC below. Every bracketed write
	// increments before term.write and decrements in its callback; a gate
	// tests `> 0`, and completion work (flushDeferredOsc, re-arming
	// onHistoryTop) runs only when a decrement returns this to 0. A ref
	// because it's written by the [scrollbackData] effect and the
	// [sessionId] effect's FIFO alike, and read by the [sessionId] effect's
	// cleanup.
	const pendingParsesRef = useRef(0);
	// A session generation token: bumped once at the top of the
	// [sessionId] effect (a new session starting) and once more in that
	// effect's cleanup (this session ending — whether or not a successor
	// follows). The [scrollbackData] effect's write and an in-band FIFO
	// chunk's write both capture `sessionGenRef.current` right before
	// calling term.write; if the value has moved by the time the callback
	// fires, that write belongs to a terminal that's gone (disposed, or
	// superseded by a newer session sharing this same component instance)
	// and the callback bails without touching pendingParsesRef,
	// historyTopArmedRef, flushDeferredOsc, term, or onInbandApplied — all
	// of which either belong to whatever session is current now, or (for
	// term itself) may already be disposed. A ref, not an effect-local
	// flag, because it has to be visible to the [scrollbackData] effect
	// too, which has no cleanup of its own to mark itself stale.
	const sessionGenRef = useRef(0);
	// Gates onHistoryTop: disarmed the instant a gesture fires, so a rapid
	// double-fire (or a fire against a buffer that hasn't actually grown
	// yet) can't happen, and only re-armed once a patch's write completes
	// AND pendingParsesRef has returned to 0 — never while another patch
	// is still queued behind it. Armed by the [scrollbackData] effect
	// (immediately, if this mount carries no attach reply to wait for;
	// otherwise once that reply's write completes at counter 0) and
	// re-armed by every in-band apply's write completing the same way —
	// and, because a backfill step can fail and never produce a write at
	// all, by a scroll-DOWN gesture at counter 0 (see `gesture` below).
	const historyTopArmedRef = useRef(false);
	// Set inside the [sessionId] effect below so the [inbandReset] effect
	// (declared after it) can push a patch into the same FIFO the live pty
	// frames flow through, without either effect re-running the other's
	// setup.
	const pushInbandRef = useRef<((p: { id: number; data: string; reset: boolean }) => void) | null>(
		null,
	);
	// The latest title/cwd an OSC reported WHILE a patch was parsing —
	// replayed history, thousands of them for one agent session. Each is
	// emitted once, with its last value, when the parse completes; the
	// catalog must not see the past go by (spec §4).
	const deferredTitleRef = useRef<string | null>(null);
	const deferredCwdRef = useRef<string | null>(null);
	const flushDeferredOsc = () => {
		const title = deferredTitleRef.current;
		const cwd = deferredCwdRef.current;
		deferredTitleRef.current = null;
		deferredCwdRef.current = null;
		if (title !== null) onAgentTitleRef.current?.(title);
		if (cwd !== null) onCwdChangedRef.current?.(cwd);
	};
	// Set inside the [sessionId] effect below and read by the separate
	// [scrollbackData] effect, which must be able to apply a later
	// scrollbackData change without re-running the (expensive, term-creating)
	// mount effect.
	const termRef = useRef<Terminal | null>(null);
	// Read inside the component (not at module scope): a module-scope read
	// runs the instant this file is imported, which would crash any
	// non-Electron context (e.g. a test) that merely imports TerminalTab
	// without ever rendering it — same reasoning as TerminalItem's own
	// React.lazy wrapper around this import.
	const IS_MAC = host.getPlatform() === "darwin";
	// A ref, not a captured prop: the mount effect below runs once per
	// sessionId, but the caller's onOpenPath closes over the tile's
	// CURRENT cwd (it resolves relative paths against it), which moves
	// with every OSC 7 report. Capturing the mount-time closure would pin
	// resolution to the cwd the tile was born with.
	const onOpenPathRef = useRef(onOpenPath);
	onOpenPathRef.current = onOpenPath;
	const canOpenPathRef = useRef(canOpenPath);
	canOpenPathRef.current = canOpenPath;
	// Same reasoning: the handler registration below outlives any one
	// render's closure.
	const onOpenUrlRequestRef = useRef(onOpenUrlRequest);
	onOpenUrlRequestRef.current = onOpenUrlRequest;
	const onAgentTitleRef = useRef(onAgentTitle);
	onAgentTitleRef.current = onAgentTitle;
	const onCwdChangedRef = useRef(onCwdChanged);
	onCwdChangedRef.current = onCwdChanged;
	const remoteRef = useRef(remote);
	remoteRef.current = remote;
	const onTransferStatusRef = useRef(onTransferStatus);
	onTransferStatusRef.current = onTransferStatus;
	const onUserInputRef = useRef(onUserInput);
	onUserInputRef.current = onUserInput;
	const onHistoryTopRef = useRef(onHistoryTop);
	onHistoryTopRef.current = onHistoryTop;
	const onInbandAppliedRef = useRef(onInbandApplied);
	onInbandAppliedRef.current = onInbandApplied;

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		// A new session starts unarmed and with nothing pending — nothing
		// about the PREVIOUS session should carry into this one. The
		// [scrollbackData] effect (declared after this one, so it runs
		// right after on mount) arms historyTopArmedRef, immediately if
		// there's no attach reply to wait for. Resetting the counter here
		// matters even though every write that increments it also
		// decrements it: a write queued by the outgoing session (this
		// effect's own FIFO, or the separate [scrollbackData] effect) can
		// still be in flight when its callback eventually fires — bumping
		// sessionGenRef is what makes that callback a no-op instead (see
		// sessionGenRef's own doc comment).
		historyTopArmedRef.current = false;
		pendingParsesRef.current = 0;
		sessionGenRef.current++;

		const term = new Terminal({
			theme: getTheme(theme),
			fontFamily: 'Menlo, Monaco, "Courier New", monospace',
			fontSize,
			fontWeight: "300",
			fontWeightBold: "500",
			cursorBlink: !readOnly,
			// A read-only view of somebody else's pty: xterm still renders
			// and scrolls, it just never writes a keystroke back.
			disableStdin: readOnly,
			scrollback: 200000,
			// One line per wheel notch (xterm's default of 1) reads as sluggish on
			// both input devices, and the fix is one constant because sensitivity is
			// applied to the raw deltaY *before* xterm converts by deltaMode: a mouse
			// wheel (DOM_DELTA_LINE) moves 2 lines per notch, while a trackpad
			// (DOM_DELTA_PIXEL, which xterm already damps by 0.3 for deltas under
			// 50px) lands at ~0.6x of raw finger movement instead of ~0.3x. This
			// started at 3, which read as overshooting in daily use; touch drags
			// (touch-scroll.ts) go through the same multiplier only on the
			// alternate-screen wheel path. fastScrollSensitivity is
			// deliberately left at its default: the two MULTIPLY
			// (_applyScrollModifier does deltaY * fast * normal), so Alt-held fast
			// scroll already went 5x -> 10x here; raising it too would compound.
			scrollSensitivity: 2,
			allowProposedApi: true,
			// Does NOT gate viewport transparency — both themes' alpha-0
			// backgrounds (theme.ts) render transparent regardless. It only
			// controls glyph-atlas rasterization: light mode needs glyphs drawn
			// over an opaque background for crisp dark-on-light text. Read the
			// app theme prop, not prefers-color-scheme: the browser host can
			// apply an explicit saved theme that intentionally differs from it.
			allowTransparency: theme === "dark",
			macOptionIsMeta: false,
			overviewRuler: { width: 8 },
			// Keep the terminal renderer independent of its embedding environment.
			screenReaderMode: false,
			// OSC 8 hyperlinks. Without this, xterm's default handler runs a
			// blocking confirm() and a raw window.open. The URI is whatever
			// the printing program chose, so it goes through the same scheme
			// guard as regex-detected links (web-link.ts). Locality of the
			// pty is irrelevant: the text is already in the local buffer and
			// openExternal runs on the user's machine.
			linkHandler: {
				activate: (_event, text) => activateWebLink(text, host.openExternal),
			},
		});

		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		sizeRef.current = size => { term.options.fontSize = size; fitRef.current?.fit(); };
		const disposeLinkHighlight = installWrappedLinkHighlight(term);
		termRef.current = term;
		// Off-screen cold mounts have no measurable grid yet. Hold replay and
		// live bytes in order until their first visible fit; already-fitted
		// terminals continue parsing normally when subsequently hidden.
		let sized = false;
		let fitDisposed = false;
		let redrawPending = false;
		let redrawTimer: ReturnType<typeof setTimeout> | undefined;
		let redrawSize: { cols: number; rows: number } | undefined;
		const waitingWrites: Array<Parameters<Terminal["write"]>> = [];
		const write: Terminal["write"] = (data, callback) => {
			if (sized) term.write(data, callback);
			else waitingWrites.push([data, callback]);
		};
		const fitAndReplay = () => {
			if (fitDisposed || !visibleRef.current || redrawTimer !== undefined) return;
			const { width, height } = container.getBoundingClientRect();
			if (width <= 0 || height <= 0) return;
			const dimensions = fit.proposeDimensions();
			if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return;
			fit.fit();
			if (!sized) {
				sized = true;
				for (const [data, callback] of waitingWrites.splice(0)) term.write(data, callback);
			}
			if (redrawPending) redraw();
		};
		// Raw tails contain TUI diffs, not a complete screen. Even a
		// correctly sized replay cannot recreate cells outside that tail.
		// An unchanged resize emits no SIGWINCH; briefly change the grid
		// and restore it after the application has had time to observe it.
		const redraw = () => {
			if (readOnlyRef.current || fitDisposed) return;
			redrawPending = true;
			if (!sized || !visibleRef.current || redrawTimer !== undefined) return;
			redrawPending = false;
			redrawSize = { cols: term.cols, rows: term.rows };
			redrawTimer = setTimeout(() => {
				redrawTimer = undefined;
				const size = redrawSize!;
				redrawSize = undefined;
				term.resize(size.cols, size.rows);
				fitAndReplay();
			}, 100);
			term.resize(term.cols > 2 ? term.cols - 1 : term.cols + 1, term.rows);
		};
		fitRef.current = { fit: fitAndReplay };
		writeRef.current = write;
		redrawRef.current = redraw;

		// FitAddon only emits onResize when the LOCAL grid changes. The
		// shared pty can still have a phone's smaller grid, so interaction
		// must send our dimensions even when fit() is a local no-op.
		// A click, DOM focus and active-item change can all arrive together;
		// coalesce them and measure after the layout has settled.
		let interactionRaf = 0;
		const reclaimSize = () => {
			// A read-only view never claims the shared pty's grid: this
			// terminal is a 180px preview of a session the agent is
			// running at its own geometry, and reclaiming would reshape
			// that session mid-command.
			if (readOnlyRef.current) return;
			cancelAnimationFrame(interactionRaf);
			interactionRaf = requestAnimationFrame(() => {
				if (!visibleRef.current || !container.isConnected) return;
				const { width, height } = container.getBoundingClientRect();
				if (width <= 0 || height <= 0) return;
				const { cols, rows } = term;
				fitAndReplay();
				// A changed grid already sent its size through onResize.
				if (term.cols === cols && term.rows === rows) {
					host.ptyResize(sessionId, term.cols, term.rows);
				}
			});
		};
		reclaimSizeRef.current = reclaimSize;
		container.addEventListener("pointerdown", reclaimSize, true);

		// onHistoryTop: a user scroll-up gesture at the top of a normal
		// buffer that actually has scrollback (history-top.ts). Gated on
		// historyTopArmedRef so a gesture during (or before) a patch parse
		// can't fire, and disarmed on fire until the next patch re-arms it
		// — see historyTopArmedRef's own doc comment.
		const probe = () => ({
			viewportY: term.buffer.active.viewportY,
			bufferType: term.buffer.active.type,
			bufferLength: term.buffer.active.length,
			rows: term.rows,
		});
		const gesture = (direction: "up" | "down") => {
			// A scroll DOWN re-arms, provided nothing is mid-parse. Only a
			// completed patch write re-arms otherwise, so a backfill step
			// that FAILS (a timeout, a closed socket — backfill.ts's catch)
			// would leave the gate shut for the rest of the tile's life and
			// the user could never retry by scrolling. Scrolling away and
			// back is exactly the gesture someone makes when nothing
			// happened, and it cannot double-fire: the up-gesture gate
			// below still demands viewportY 0 on a normal buffer.
			if (direction === "down") {
				if (pendingParsesRef.current === 0) historyTopArmedRef.current = true;
				return;
			}
			if (!historyTopArmedRef.current) return;
			if (!isHistoryTopGesture(probe(), direction)) return;
			historyTopArmedRef.current = false;
			onHistoryTopRef.current?.();
		};
		const onWheel = (e: WheelEvent) => gesture(e.deltaY < 0 ? "up" : "down");
		container.addEventListener("wheel", onWheel, { passive: true });

		// Touch-drag scrolling — xterm 6.0 handles wheel but ships its
		// touch gesture machinery unwired, so a real phone/tablet cannot
		// scroll at all without this (see touch-scroll.ts). Listeners on
		// a non-touch device simply never fire. A structural object, not
		// the xterm instance itself (a plain spread would drop its
		// prototype methods): scrollLines is wrapped so a touch drag feeds
		// the same gesture gate a wheel does — its mouse-reporting branch
		// dispatches a synthetic wheel on the container, which the
		// listener above already sees, but the scrollLines branch (normal
		// buffer, no mouse tracking) never touches the DOM at all.
		const detachTouchScroll = attachTouchScroll(container, {
			get rows() {
				return term.rows;
			},
			get buffer() {
				return term.buffer;
			},
			scrollLines: (n: number) => {
				gesture(n < 0 ? "up" : "down");
				term.scrollLines(n);
			},
		});

		const unicode11 = new Unicode11Addon();
		term.loadAddon(unicode11);
		term.unicode.activeVersion = "11";

		// Bare http(s) URLs in output become clickable. The addon
		// only ever matches http(s) text; the handler still funnels through
		// the shared scheme guard so both link kinds have one policy.
		term.loadAddon(
			new WebLinksAddon((_event, uri) => activateWebLink(uri, host.openExternal)),
		);

		// File-path-looking tokens become clickable too (issue #25) — see
		// path-links.ts for what qualifies. Registered only when the caller
		// can actually open a path; disposed with term.dispose().
		if (onOpenPath) {
			const allowAbsolute = allowAbsolutePaths === true;
			term.registerLinkProvider({
				provideLinks: (y, callback) => {
					const bufferLine = term.buffer.active.getLine(y - 1);
					if (!bufferLine) return callback(undefined);
					const text = bufferLine.translateToString(true);
					const links = detectPathLinks(text, { allowAbsolute })
						.filter((l) => canOpenPathRef.current?.(l.text) ?? true)
						.map((l) => ({
							// xterm ranges are 1-based with an inclusive end cell —
							// the same conversion the web-links addon applies.
							range: { start: { x: l.start + 1, y }, end: { x: l.end, y } },
							text: l.text,
							activate: () => onOpenPathRef.current?.(l.text),
						}));
					callback(links.length > 0 ? links : undefined);
				},
			});
		}

		// Serializes the terminal's state for the unmount snapshot — see
		// onSnapshot's doc comment.
		const serialize = new SerializeAddon();
		term.loadAddon(serialize);

		const disposeRenderer = installTerminalRenderer(term, container, () => new WebglAddon());

		// Recheck after layout settles; the synchronous fit below establishes
		// the initial grid before the attach replay can be parsed.
		requestAnimationFrame(() => {
			requestAnimationFrame(fitAndReplay);
		});

		/**
		 * Whether the caret is this terminal's — the question both
		 * window-level handlers below have to answer, since EVERY mounted
		 * terminal hears those events, hidden ones included (a hidden item
		 * stays mounted at display:none).
		 *
		 * Tracked from `focusin`, which fires for every focus move *within*
		 * the document and for none of the app-switching that moves focus
		 * out of it, rather than read off `document.activeElement` when the
		 * window blurs: the caret's owner has to survive the switch away to
		 * be restorable on the way back, and that is exactly the moment
		 * activeElement is least worth trusting.
		 */
		let holdsCaret = false;
		const onDocumentFocusIn = (event: FocusEvent) => {
			const target = event.target;
			holdsCaret = target instanceof Node && container.contains(target);
			if (holdsCaret) reclaimSize();
		};
		document.addEventListener("focusin", onDocumentFocusIn);

		// Auto-focus xterm when the app window already has focus (e.g.
		// an item created via Cmd+N or a sidebar click, where the
		// window was already focused before xterm mounted).
		if (document.hasFocus()) {
			term.focus();
		}

		// Give the caret back on the way in — but only to the terminal that
		// had it on the way out. Unconditionally, this handed the caret to
		// whichever terminal registered its listener last — the last one to
		// have mounted, which on a cold start is the rightmost pane — on
		// every switch back into the app, whatever pane the user had been
		// working in; and when that winner was a hidden terminal, whose
		// textarea cannot take focus at all, the caret landed nowhere and the
		// user had to click a pane before they could type (#150).
		const onWindowFocus = () => {
			if (holdsCaret) {
				term.focus();
				reclaimSize();
			}
		};
		window.addEventListener("focus", onWindowFocus);

		if (!restored) {
			write(
				`\x1b[38;2;100;100;100mStarting...\x1b[0m`,
			);
		}

		// scrollbackData itself is applied by the separate effect below, not
		// here — that effect also fires on this same initial mount (effects
		// run in declaration order, after termRef.current is set above), and
		// keeping the write in exactly one place is what lets a later
		// re-attach (a new scrollbackData value, same sessionId) reuse it
		// without duplicating the reset/append logic.

		// Shift+Enter: inject a CSI u escape sequence so TUI apps like
		// Claude Code can detect the shift modifier. Block both keydown
		// AND keypress to prevent xterm from also sending \r through the
		// normal onData path.
		const copySelectionToClipboard = () => {
			const selection = term.getSelection();
			if (!selection) return false;
			void navigator.clipboard.writeText(selection).catch(() => {});
			return true;
		};

		let suppressPasteEvent = false;

		// In a browser the paste shortcut must NOT be intercepted: reading
		// the clipboard programmatically is permission-gated there — Safari
		// answers navigator.clipboard.readText() with a "Paste" button the
		// user has to click — while letting the keystroke through fires the
		// native ClipboardEvent, which carries the text with no prompt and
		// lands in handlePaste below. On the desktop the interception stays:
		// Electron's readText is ungated, and the shortcut must work even
		// when no Edit-menu accelerator would synthesize a paste. web-host
		// is the class src/windows/web/main.tsx stamps on <html>.
		const nativePasteWorks = () => document.documentElement.classList.contains("web-host");

		const pasteFromShortcut = () => {
			suppressPasteEvent = true;
			void pasteClipboardText();
		};

		const pasteClipboardText = async () => {
			try {
				const text = await navigator.clipboard.readText();
				if (text) {
					host.ptyWrite(sessionId, text);
				}
			} catch {
				// Clipboard access can fail outside a user gesture.
			}
		};

		term.attachCustomKeyEventHandler((e) => {
			// Read-only: the bindings below are all WRITES (Shift+Enter,
			// the Option/Command readline sequences, paste), so none of
			// them may run. Copy still does — reading out of a terminal is
			// not writing to it — and everything else is refused rather
			// than passed to xterm, which has no stdin to give it anyway.
			if (readOnlyRef.current) {
				const modifier = IS_MAC ? e.metaKey : e.ctrlKey;
				if (e.type === "keydown" && modifier && e.key.toLowerCase() === "c") {
					copySelectionToClipboard();
				}
				return false;
			}
			if (e.key === "Enter" && e.shiftKey) {
				if (e.type === "keydown") {
					host.ptyWrite(sessionId, "\x1b[13;2u");
				}
				return false;
			}
			// Option key on macOS: with macOptionIsMeta disabled (so
			// macOS composes special characters like —), we manually
			// send ESC+key for the readline/shell bindings we need.
			if (IS_MAC && e.type === "keydown" && e.altKey && !e.metaKey && !e.ctrlKey) {
				if (e.key === "ArrowLeft") {
					host.ptyWrite(sessionId, "\x1bb");
					return false;
				}
				if (e.key === "ArrowRight") {
					host.ptyWrite(sessionId, "\x1bf");
					return false;
				}
				if (e.key === "b") {
					host.ptyWrite(sessionId, "\x1bb");
					return false;
				}
				if (e.key === "f") {
					host.ptyWrite(sessionId, "\x1bf");
					return false;
				}
				if (e.key === "d") {
					host.ptyWrite(sessionId, "\x1bd");
					return false;
				}
				if (e.key === "Backspace") {
					host.ptyWrite(sessionId, "\x1b\x7f");
					return false;
				}
				if (e.key === ".") {
					host.ptyWrite(sessionId, "\x1b.");
					return false;
				}
			}
			// Command+Arrow on macOS: jump to start/end of line, matching
			// the system terminal. ESC has no metaKey, so send the
			// readline beginning/end-of-line controls (Ctrl-A / Ctrl-E).
			if (IS_MAC && e.type === "keydown" && e.metaKey && !e.altKey && !e.ctrlKey) {
				if (e.key === "ArrowLeft") {
					host.ptyWrite(sessionId, "\x01");
					return false;
				}
				if (e.key === "ArrowRight") {
					host.ptyWrite(sessionId, "\x05");
					return false;
				}
			}
			// macOS only: everywhere else Ctrl+V IS the platform paste, so
			// it already fires a paste event and images already work.
			if (
				IS_MAC &&
				e.type === "keydown" &&
				e.ctrlKey &&
				!e.metaKey &&
				!e.altKey &&
				e.key.toLowerCase() === "v" &&
				remoteRef.current === true
			) {
				void pasteImageOrForwardCtrlV();
				return false;
			}
			const primaryModifier = IS_MAC ? e.metaKey : e.ctrlKey;
			if (e.type === "keydown" && primaryModifier) {
				const key = e.key.toLowerCase();
				if (key === "c" && copySelectionToClipboard()) {
					return false;
				}
				if (key === "v") {
					// false = xterm skips it; the browser default still runs,
					// so the native paste event fires and handlePaste sends it.
					if (!nativePasteWorks()) pasteFromShortcut();
					return false;
				}
				if (!IS_MAC && e.shiftKey) {
					if (key === "c" && copySelectionToClipboard()) {
						return false;
					}
					if (key === "v") {
						if (!nativePasteWorks()) pasteFromShortcut();
						return false;
					}
				}
			}
			if (e.type === "keydown" && e.shiftKey && e.key === "Insert") {
				if (!nativePasteWorks()) pasteFromShortcut();
				return false;
			}
			if (e.type === "keydown" && e.metaKey) {
				if (e.key === "t" || (e.key >= "1" && e.key <= "9")) {
					return false;
				}
			}
			return true;
		});

		// OSC 7: shell reports current working directory
		// Format: file://hostname/path or file:///path
		term.parser.registerOscHandler(7, (data) => {
			try {
				const url = new URL(data);
				if (url.protocol === "file:") {
					const cwd = decodeURIComponent(url.pathname);
					if (cwd) {
						if (pendingParsesRef.current > 0) deferredCwdRef.current = cwd;
						else onCwdChangedRef.current?.(cwd);
					}
				}
			} catch {
				// Malformed URL — ignore
			}
			return true;
		});

		// OSC 52: a program in the pty sets the LOCAL clipboard — the only
		// copy path that works from a session on a remote machine, where
		// there is no clipboard for xclip/pbcopy to reach. Write-only:
		// decodeOsc52Write refuses read queries, so a remote process can
		// never see what the user has copied.
		term.parser.registerOscHandler(52, (data) => {
			if (pendingParsesRef.current > 0) return true;
			const text = decodeOsc52Write(data);
			if (text !== null) void host.writeClipboardText(text);
			return true;
		});

		// The app's private open-a-URL OSC — the cloud cube-open shim's
		// channel to the user's browser. Suppressed while a scrollback
		// patch is parsing: OSC handlers re-fire on replayed bytes, and a
		// request from a past attach must not resurface. (A request that
		// arrives in the post-cursor delta of a reattach still can — it
		// only ever raises the caller's affordance, never a browser.)
		term.parser.registerOscHandler(OSC_OPEN_URL, (data) => {
			if (pendingParsesRef.current > 0) return true;
			const url = decodeOscOpenUrl(data);
			if (url !== null) onOpenUrlRequestRef.current?.(url);
			return true;
		});

		// Agent-harness tiles adopt the CLI's window title (e.g. Claude
		// Code's session summary), surfaced via xterm's title-change event.
		// term.dispose() below tears this listener down with the rest of
		// the terminal's own event plumbing, same as onData/onResize.
		if (acceptTitles) {
			term.onTitleChange((raw) => {
				const title = sanitizeAgentTitle(raw);
				if (title) {
					if (pendingParsesRef.current > 0) deferredTitleRef.current = title;
					else onAgentTitleRef.current?.(title);
				}
			});
		}

		term.onData((data: string) => {
			host.ptyWrite(sessionId, data);
			onUserInputRef.current?.(data);
		});

		// A live pty frame, or an in-band patch (a scroll-up backfill reply,
		// spec §3) queued at its FIFO position among the live frames already
		// received — see pushInbandRef below. `oldLength`/`oldViewportY`
		// are captured when the patch is QUEUED (before whatever live
		// frames sit ahead of it in the FIFO get written), so the
		// post-write scrollToLine restores the user's place relative to
		// the content they were looking at, not to wherever the buffer
		// ends up after those frames land too.
		type Chunk =
			| Uint8Array
			| { replay: true; data: Uint8Array }
			| { inband: true; reset: boolean; data: string; id: number; oldLength: number; oldViewportY: number };
		let dataBuffer: Chunk[] = [];
		let flushTimer: number | undefined;
		let firstData = true;
		// Running output cursor, seeded from the attach response that gave
		// us this sessionId. Advances by raw byte count (never a JS string's
		// UTF-16 .length) so it stays exact against cubed's byte-counted
		// seq once a multi-byte character shows up — see byteLengthOf.
		let seqCursor = initialSeq ?? 0;
		// The PARSED-bytes cursor the unmount snapshot pairs with — trails
		// seqCursor by whatever xterm hasn't finished parsing yet (see
		// onSnapshot's doc comment for why the distinction matters).
		let parsedSeq = initialSeq ?? 0;

		const flushData = () => {
			if (dataBuffer.length === 0) {
				flushTimer = undefined;
				return;
			}
			const chunks = dataBuffer;
			dataBuffer = [];
			flushTimer = undefined;
			if (firstData) {
				firstData = false;
				if (!restored) {
					term.reset();
				}
			}
			for (const chunk of chunks) {
				if (chunk instanceof Uint8Array) {
					const bytes = byteLengthOf(chunk);
					write(chunk, () => {
						parsedSeq += bytes;
					});
					continue;
				}
				if ('replay' in chunk) {
					pendingParsesRef.current++;
					const gen = sessionGenRef.current;
					write(chunk.data, () => { if (gen === sessionGenRef.current) pendingParsesRef.current--; });
					continue;
				}
				// An in-band patch: everything queued before it has been
				// handed to xterm already; a `reset` chunk wipes it when
				// XTERM REACHES IT, and everything after it survives, in
				// order (spec §3, "Apply, in band"). The reset travels as
				// an RIS prefix, never a term.reset() call from here —
				// see RIS's own comment for why a call would wipe the
				// wrong side of the queue. A non-reset chunk (the
				// follow-up delta) appends.
				pendingParsesRef.current++;
				const gen = sessionGenRef.current;
				write(chunk.reset ? `${RIS}${chunk.data}` : chunk.data, () => {
					// A newer generation means the terminal this write was
					// queued against is gone (a new session mounted, or
					// this one's own cleanup already ran) — its session's
					// counter, deferred OSCs and arm state belong to
					// whatever is current now, not to this stale write.
					if (gen !== sessionGenRef.current) return;
					pendingParsesRef.current--;
					if (pendingParsesRef.current === 0) {
						flushDeferredOsc();
						historyTopArmedRef.current = true;
					}
					const newLength = term.buffer.active.length;
					term.scrollToLine(Math.max(0, newLength - (chunk.oldLength - chunk.oldViewportY)));
					onInbandAppliedRef.current?.(chunk.id);
				});
			}
		};

		// Pushes a backfill reply into the same FIFO live frames flow
		// through — see the [inbandReset] effect below, which is what
		// actually calls this on a new prop value. A ref (not a direct
		// call) because that effect is declared separately so a later
		// inbandReset change doesn't have to re-run this (expensive,
		// term-creating) mount effect.
		pushInbandRef.current = (patch) => {
			dataBuffer.push({
				inband: true,
				reset: patch.reset,
				data: patch.data,
				id: patch.id,
				oldLength: term.buffer.active.length,
				oldViewportY: term.buffer.active.viewportY,
			});
			if (flushTimer === undefined) flushTimer = window.setTimeout(flushData, DATA_BUFFER_FLUSH_MS);
		};

		const handleData = (payload: {
			sessionId: string;
			data: Uint8Array;
			replay?: boolean;
		}) => {
			if (payload.sessionId !== sessionId) return;
			seqCursor += byteLengthOf(payload.data);
			onSeqAdvance?.(seqCursor);
			dataBuffer.push(payload.replay ? { replay: true, data: payload.data } : payload.data);
			if (flushTimer === undefined) {
				flushTimer = window.setTimeout(
					flushData,
					DATA_BUFFER_FLUSH_MS,
				);
			}
		};
		host.onPtyData(sessionId, handleData);

		term.onResize(({ cols, rows }) => {
			// Same rule as reclaimSize: a read-only preview never resizes
			// somebody else's pty, however its own box is laid out.
			if (readOnlyRef.current) return;
			host.ptyResize(sessionId, cols, rows);
		});
		// Cursor-addressed TUI replay must not parse into xterm's default
		// 80x24 grid. A later resize cannot recover clipped rows or columns,
		// and an unchanged PTY size may not make the application repaint.
		// Register onResize first so this fit also reaches the shared PTY.
		fitAndReplay();

		const handleCopy = (event: ClipboardEvent) => {
			const selection = term.getSelection();
			if (!selection) return;
			event.clipboardData?.setData("text/plain", selection);
			event.preventDefault();
			event.stopImmediatePropagation();
		};

		/**
		 * Ships bytes to the pty's machine and types the quoted path they
		 * landed on. Shared by both paste routes, and reporting through
		 * the same channel a drop does: an image paste used to be silent
		 * until the path appeared, which reads as nothing happening.
		 */
		const stashAndType = async (
			bytes: Uint8Array,
			mime: string,
			label: string,
		): Promise<void> => {
			const report = onTransferStatusRef.current;
			report?.({ kind: "sending", name: label, index: 1, total: 1 });
			try {
				// No filename: that is what keeps a paste a paste on the
				// daemon side — image mimes only, and a name it picks.
				const { path } = await host.ptyStashFile(
					sessionId,
					bytesToBase64(bytes),
					mime,
				);
				host.ptyWrite(sessionId, quoteForShell(path));
				term.focus();
				report?.(null);
			} catch (err) {
				// An old daemon without term:stash-paste lands here too —
				// the paste fails closed rather than typing a wrong path.
				console.error("[terminal] image paste failed:", err);
				report?.({
					kind: "errors",
					messages: [`${label} — ${err instanceof Error ? err.message : String(err)}`],
				});
			}
		};

		// Ships a pasted image's bytes to the pty's machine and types the
		// stashed file's quoted path — remote sessions only (see the
		// `remote` prop doc). Returns whether it took the event.
		const stashImagePaste = (event: ClipboardEvent): boolean => {
			if (!remoteRef.current) return false;
			const file = imageFileFromClipboard(event.clipboardData);
			if (!file) return false;
			void (async () => {
				const bytes = new Uint8Array(await file.arrayBuffer());
				await stashAndType(bytes, file.type, PASTED_IMAGE_LABEL);
			})();
			return true;
		};

		/**
		 * macOS Ctrl+V on a remote session. Cmd+V arrives as a paste event
		 * carrying the bytes; Ctrl+V fires no paste event at all and goes
		 * to the pty as \x16, where a cloud CLI answers it by reading a
		 * clipboard that is not the user's. So the key is intercepted and
		 * the clipboard asked directly.
		 *
		 * The decision to swallow has to be made before the answer comes
		 * back — `navigator.clipboard.read()` is async and the key handler
		 * is not — so anything that is NOT an image is forwarded as \x16
		 * afterwards. That keeps the change strictly additive: readline's
		 * quoted-insert and a CLI's own Ctrl+V still see the byte, a few
		 * milliseconds later. An unreadable clipboard (no permission, no
		 * user gesture) is indistinguishable from an empty one here, and
		 * takes the same path.
		 */
		const pasteImageOrForwardCtrlV = async (): Promise<void> => {
			let found: { blob: Blob; mime: string } | null = null;
			try {
				found = await imageFromClipboardItems(await navigator.clipboard.read());
			} catch {
				// Unreadable — treated as "no image", same as empty.
			}
			if (!found) {
				host.ptyWrite(sessionId, "\x16");
				return;
			}
			const bytes = new Uint8Array(await found.blob.arrayBuffer());
			await stashAndType(bytes, found.mime, PASTED_IMAGE_LABEL);
		};

		const handlePaste = (event: ClipboardEvent) => {
			if (suppressPasteEvent) {
				suppressPasteEvent = false;
				// Text was already sent via pasteClipboardText — just
				// suppress. An image-only clipboard falls through to the
				// stash below (remote) or propagates so the CLI at the pty
				// can read the OS clipboard itself (local).
				if (event.clipboardData?.getData("text/plain")) {
					event.preventDefault();
					event.stopImmediatePropagation();
					return;
				}
			} else {
				const text = event.clipboardData?.getData("text/plain");
				if (text) {
					host.ptyWrite(sessionId, text);
					event.preventDefault();
					event.stopImmediatePropagation();
					return;
				}
			}
			if (stashImagePaste(event)) {
				event.preventDefault();
				event.stopImmediatePropagation();
			}
		};

		const handleDragOver = (event: DragEvent) => {
			event.preventDefault();
			if (event.dataTransfer) {
				event.dataTransfer.dropEffect = "copy";
			}
		};

		/** Types the paths at the pty as one quoted, space-separated run —
		 *  the shape claude/codex read as a list of file arguments. */
		const typePaths = (paths: string[]): void => {
			if (paths.length === 0) return;
			try {
				host.ptyWrite(sessionId, paths.map(quoteForShell).join(" "));
			} catch {
				/* PTY may have exited */
			}
			term.focus();
		};

		/** A REMOTE pty cannot see this filesystem, so the bytes travel
		 *  and the path typed is the one they landed on over there. */
		const dropRemoteFiles = async (files: File[], folderNames: string[]): Promise<void> => {
			const report = onTransferStatusRef.current;
			const { paths, errors } = await sendDroppedFiles(files, {
				stash: async (file) => {
					const bytes = new Uint8Array(await file.arrayBuffer());
					const { path } = await host.ptyStashFile(
						sessionId,
						bytesToBase64(bytes),
						file.type,
						file.name,
					);
					return path;
				},
				onProgress: (p) => report?.({ kind: "sending", ...p }),
			});
			typePaths(paths);
			// Folders are named rather than silently dropped: a user who
			// drags one and sees nothing happen has no way to tell the
			// refusal from a bug.
			const messages = [
				...folderNames.map((name) => `${name} is a folder — only files can be sent`),
				...errors,
			];
			report?.(messages.length > 0 ? { kind: "errors", messages } : null);
		};

		const handleDrop = (event: DragEvent) => {
			event.preventDefault();
			event.stopPropagation();
			// Synchronous, before any await: a DataTransfer is emptied
			// once the event finishes dispatching.
			const { files, folderNames } = dropContents(event.dataTransfer);
			if (files.length === 0 && folderNames.length === 0) return;
			void dropRemoteFiles(files, folderNames).catch((err: unknown) => {
				console.error("[terminal] drop failed:", err);
				onTransferStatusRef.current?.({
					kind: "errors",
					messages: [err instanceof Error ? err.message : String(err)],
				});
			});
		};

		// iOS dictation (dictation-sync.ts): its `insertText` input events
		// carry the whole utterance so far, which xterm's own input handler
		// would forward verbatim — once per update. Intercepted in the
		// CAPTURE phase on the container, which runs before xterm's own
		// capture listener on the textarea, and stopped there so only the
		// planned delta goes to the pty. The gate mirrors xterm's: a real
		// keystroke (keydown seen, keyup not yet) or an IME composition is
		// somebody else's path, and screen-reader mode (the e2e harness)
		// keeps xterm's bubbling behaviour.
		let keyDownSeen = false;
		let composing = false;
		let dictationSynced = "";
		const onKeyDownCapture = (e: KeyboardEvent) => {
			keyDownSeen = true;
			// xterm empties the textarea on these two (_keyDown), so the
			// synced text is gone with it.
			if (e.key === "Enter" || (e.ctrlKey && e.key === "c")) dictationSynced = "";
		};
		const onKeyUpCapture = () => {
			keyDownSeen = false;
		};
		const onCompositionStart = () => {
			composing = true;
		};
		const onCompositionEnd = () => {
			composing = false;
		};
		// xterm clears the textarea on blur (_handleTextAreaBlur).
		const onFocusOut = () => {
			dictationSynced = "";
		};
		const onInputCapture = (event: Event) => {
			const ev = event as InputEvent;
			const target = ev.target;
			if (!(target instanceof HTMLTextAreaElement)) return;
			if (ev.inputType !== "insertText" || !ev.data) return;
			if (keyDownSeen || composing || ev.isComposing) return;
			if (term.options.screenReaderMode) return;
			const plan = planInsert(dictationSynced, target.value, ev.data);
			dictationSynced = plan.synced;
			if (plan.send) host.ptyWrite(sessionId, plan.send);
			ev.stopImmediatePropagation();
		};
		container.addEventListener("keydown", onKeyDownCapture, true);
		container.addEventListener("keyup", onKeyUpCapture, true);
		container.addEventListener("compositionstart", onCompositionStart, true);
		container.addEventListener("compositionend", onCompositionEnd, true);
		container.addEventListener("focusout", onFocusOut, true);
		container.addEventListener("input", onInputCapture, true);

		container.addEventListener("copy", handleCopy, true);
		// Paste and drop both end in `ptyWrite`, so a read-only terminal
		// never registers them at all — the cleanup's `removeEventListener`
		// is a no-op for a listener that was never added.
		if (!readOnly) {
			container.addEventListener("paste", handlePaste, true);
			container.addEventListener("dragover", handleDragOver);
			container.addEventListener("drop", handleDrop);
		}

		// The window's own blur (that is all shell-blur is — see the preload's
		// onShellBlur), heard by every mounted terminal at once, which is why
		// it now blurs nothing but the terminal the caret is actually in.
		// It used to blur `document.activeElement` outright: leaving the app
		// with the caret in ANY surface — another pane, the sidebar's search
		// field — threw that focus away on every other terminal's behalf, so
		// Chromium had nothing of its own to restore on the way back in
		// either (#150). That is a leftover from the multi-webview shell,
		// where a guest had to be told to give up focus; FileItem dropped its
		// own copy for the same reason when it was ported (see its header).
		// Our own term.blur() stays: it is what stops the cursor blinking in
		// a backgrounded app.
		const offShellBlur = host.onShellBlur(() => {
			if (holdsCaret) term.blur();
		});

		// Debounce resize via rAF to coalesce rapid events
		let rafId = 0;
		const resizeObserver = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			const { width, height } = entry.contentRect;
			if (width > 0 && height > 0) {
				cancelAnimationFrame(rafId);
				rafId = requestAnimationFrame(fitAndReplay);
			}
		});
		resizeObserver.observe(container);

		return () => {
			if (redrawTimer !== undefined) clearTimeout(redrawTimer);
			// Never leave a shared PTY at the temporary width if this tile
			// is closed or hot-reloaded during the redraw.
			if (redrawSize) host.ptyResize(sessionId, redrawSize.cols, redrawSize.rows);
			redrawRef.current = null;
			// Snapshot before the final flush below: bytes flushed during
			// teardown never get their parse callbacks serviced, so they sit
			// past parsedSeq either way — serializing first keeps the snapshot
			// and its cursor consistent, and the successor's delta re-delivers
			// them. Skipped while the initial patch is still parsing (the
			// successor then just does a full replay).
			// A redraw in flight still has an incomplete screen (and may
			// have the temporary width). Do not cache it as a complete
			// snapshot that would bypass recovery on the next mount.
			if (onSnapshot && pendingParsesRef.current === 0 && redrawTimer === undefined && !redrawPending) {
				try {
					onSnapshot(serialize.serialize(), parsedSeq);
				} catch (err) {
					console.warn("[terminal] snapshot at unmount failed:", err);
				}
			}
			if (flushTimer !== undefined) {
				clearTimeout(flushTimer);
				flushData();
			}
			// Bumped AFTER the final flush above, not before: a chunk that
			// flush just wrote captured today's sessionGenRef.current as
			// its `gen`, same as every other write this session issued: a
			// bump here — whether or not a successor session ever mounts
			// to bump it further — is what makes every one of those
			// writes' callbacks a no-op once it fires, since none of them
			// can ever see this value again (see sessionGenRef's own doc
			// comment).
			sessionGenRef.current++;
			cancelAnimationFrame(rafId);
			cancelAnimationFrame(interactionRaf);
			reclaimSizeRef.current = null;
			container.removeEventListener("pointerdown", reclaimSize, true);
			window.removeEventListener("focus", onWindowFocus);
			document.removeEventListener("focusin", onDocumentFocusIn);
			resizeObserver.disconnect();
			container.removeEventListener("keydown", onKeyDownCapture, true);
			container.removeEventListener("keyup", onKeyUpCapture, true);
			container.removeEventListener("compositionstart", onCompositionStart, true);
			container.removeEventListener("compositionend", onCompositionEnd, true);
			container.removeEventListener("focusout", onFocusOut, true);
			container.removeEventListener("input", onInputCapture, true);
			container.removeEventListener("copy", handleCopy, true);
			container.removeEventListener("paste", handlePaste, true);
			container.removeEventListener("dragover", handleDragOver);
			container.removeEventListener("drop", handleDrop);
			container.removeEventListener("wheel", onWheel);
			detachTouchScroll();
			host.offPtyData(sessionId, handleData);
			sizeRef.current = null;
			pushInbandRef.current = null;
			offShellBlur();
			disposeRenderer();
			disposeLinkHighlight();
			term.dispose();
			fitRef.current = null;
			fitDisposed = true;
			waitingWrites.length = 0;
			writeRef.current = null;
			termRef.current = null;
		};
	}, [sessionId]);

	// The app's root `.dark` class is the appearance source of truth. The
	// parent observes that class and passes its current value here, so an
	// explicit Light/Dark selection or an Auto-mode change rethemes a live
	// xterm without recreating it and losing its buffer.
	useEffect(() => {
		const term = termRef.current;
		if (!term) return;
		term.options.allowTransparency = theme === "dark";
		term.options.theme = getTheme(theme);
	}, [theme]);

	// Applies a term:open/reconnect response to an already-created terminal —
	// separate from the [sessionId] effect above so a later scrollbackData
	// change (a re-attach into a live tile) doesn't have to re-run term
	// creation to take effect. Declared after that effect, so on the initial
	// mount termRef.current is already set by the time this runs (effects
	// commit in declaration order): a fresh mount and a later re-attach both
	// go through this one application path.
	useEffect(() => {
		const term = termRef.current;
		if (!term) return;
		if (!scrollbackData) {
			// Nothing NEW to wait for — a mount (or reconnect) with no
			// attach reply to apply has nothing that could make
			// onHistoryTop fire against a buffer that hasn't actually
			// loaded yet, so it's ready for a scroll-up gesture
			// immediately. Still gated on the counter, not unconditional:
			// scrollbackData flipping back to null while an earlier patch
			// (this one, or an in-band chunk) is still mid-parse must not
			// re-arm out from under it.
			historyTopArmedRef.current = pendingParsesRef.current === 0;
			return;
		}
		historyTopArmedRef.current = false;
		// The reset rides in as an RIS prefix rather than a term.reset()
		// call, for the same reason the in-band FIFO's does: this tile's
		// own dataBuffer can hold up to DATA_BUFFER_FLUSH_MS of live
		// frames, and anything already handed to xterm is queued, not
		// parsed. See RIS.
		// The pending count brackets the parse, not just the write call:
		// xterm parses asynchronously, and an unmount snapshot taken in
		// between would show less than the cursor it claims (see
		// onSnapshot's doc comment). A counter, not a boolean — see
		// pendingParsesRef's own doc comment for why an in-band patch's
		// write overlapping this one needs that.
		pendingParsesRef.current++;
		// This effect has no cleanup of its own to mark a pending write
		// stale on a session change or unmount — sessionGenRef is what
		// the [sessionId] effect bumps for exactly that, so this callback
		// checks it the same way the in-band FIFO's write does (see
		// sessionGenRef's own doc comment).
		const gen = sessionGenRef.current;
		writeRef.current?.(scrollbackData.reset ? `${RIS}${scrollbackData.data}` : scrollbackData.data, () => {
			if (gen !== sessionGenRef.current) return;
			if (scrollbackData.redraw) redrawRef.current?.();
			pendingParsesRef.current--;
			if (pendingParsesRef.current === 0) {
				flushDeferredOsc();
				historyTopArmedRef.current = true;
			}
		});
	}, [scrollbackData]);

	// Pushes a scroll-up backfill reply into the same FIFO live pty frames
	// flow through, at its position among frames already received —
	// pushInbandRef.current does the actual queueing (see the [sessionId]
	// effect above). Keyed on the patch's own id, not the object identity,
	// so a caller that hands back an equal-but-new object on every render
	// doesn't requeue it.
	useEffect(() => {
		if (!inbandReset) return;
		pushInbandRef.current?.(inbandReset);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on id, not object identity
	}, [inbandReset?.id]);

	useEffect(() => {
		if (visible && fitRef.current) {
			requestAnimationFrame(() => fitRef.current?.fit());
		}
	}, [visible]);

	// Becoming active also claims the shared pty's size (see the prop).
	useEffect(() => {
		if (focused && visible) {
			reclaimSizeRef.current?.();
		}
	}, [focused, visible, sessionId]);

	return (
		<div
			ref={containerRef}
			className="terminal-tab"
			style={{ display: visible ? "block" : "none" }}
		/>
	);
}

export default TerminalTab;

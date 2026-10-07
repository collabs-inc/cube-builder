// Adapted from packages/components/src/Terminal/touch-scroll.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * Touch scrolling for xterm — the piece xterm 6.0 ships but never wires.
 * The library bundles VS Code's `Gesture` class, yet `Gesture.addTarget`
 * has no caller anywhere in the build, so a finger drag on the terminal
 * produces no scroll at all on a real touch device. (Desktop Chrome's
 * device emulation hides this: the mouse wheel still emits real `wheel`
 * events, which xterm handles fine — the gap only shows on hardware.)
 *
 * The translation layer is deliberately ours and tiny: drags become
 * `term.scrollLines()` in whole-line steps, and a release with velocity
 * becomes a decaying fling. Split into a pure model (`TouchScroller`,
 * testable with plain numbers — happy-dom has no TouchEvent constructor)
 * and a thin DOM adapter (`attachTouchScroll`).
 *
 * Alternate-screen apps (vim, less, a fullscreen TUI) get a different
 * sink: `scrollLines` is a no-op there (no scrollback), so the drag is
 * forwarded as synthetic pixel `wheel` events dispatched from the touch
 * target instead — they bubble into xterm's own wheel pipeline, which
 * already answers the alt screen correctly (arrow keys, or mouse-wheel
 * reports when the app negotiated mouse tracking). That path is exactly
 * what a desktop wheel exercises, so touch inherits its behavior rather
 * than re-implementing the protocol. `preventDefault` on touchmove is
 * what keeps the drag from rubber-banding the page instead — taps are
 * not prevented, so focus (and iOS's synthesized mouse events) still
 * land.
 */

/** Velocity below which a release is a stop, not a fling (px/ms). */
const FLING_MIN_VELOCITY = 0.15;
/** Per-16ms decay factor for fling velocity. */
const FLING_DECAY = 0.94;
/** Fling velocity below which the animation ends (px/ms). */
const FLING_STOP = 0.01;
/** Smoothing for the velocity estimate: new sample's weight. */
const VELOCITY_BLEND = 0.3;

/**
 * The pure drag→lines model. Feed it touch positions (pixels) and
 * timestamps (ms); it returns whole lines to scroll, carrying the
 * fractional remainder so slow drags still add up. Positive lines scroll
 * toward the bottom of the buffer (finger moving up), matching
 * `Terminal.scrollLines`.
 */
export class TouchScroller {
	private lastY = 0;
	private lastT = 0;
	private acc = 0;
	private velocity = 0;

	constructor(private readonly cellHeight: number) {}

	start(y: number, t: number): void {
		this.lastY = y;
		this.lastT = t;
		this.acc = 0;
		this.velocity = 0;
	}

	/** Returns the integer lines to scroll for this move (may be 0). */
	move(y: number, t: number): number {
		const dy = this.lastY - y;
		const dt = t - this.lastT;
		this.lastY = y;
		this.lastT = t;
		if (dt > 0) {
			// Exponentially smoothed so one jittery sample can't fake a fling.
			this.velocity = this.velocity * (1 - VELOCITY_BLEND) + (dy / dt) * VELOCITY_BLEND;
		}
		this.acc += dy / this.cellHeight;
		const lines = Math.trunc(this.acc);
		this.acc -= lines;
		return lines;
	}

	/** Ends the drag: primes the fling if fast enough, returns whether it did. */
	end(): boolean {
		if (Math.abs(this.velocity) < FLING_MIN_VELOCITY) {
			this.velocity = 0;
			return false;
		}
		this.acc = 0;
		return true;
	}

	/**
	 * One animation frame of fling: decays velocity and returns the integer
	 * lines for `dtMs` elapsed. Returns 0 forever once the fling has died —
	 * callers stop their loop on `done()`.
	 */
	flingStep(dtMs: number): number {
		if (this.velocity === 0) return 0;
		this.velocity *= Math.pow(FLING_DECAY, dtMs / 16);
		if (Math.abs(this.velocity) < FLING_STOP) {
			this.velocity = 0;
			return 0;
		}
		this.acc += (this.velocity * dtMs) / this.cellHeight;
		const lines = Math.trunc(this.acc);
		this.acc -= lines;
		return lines;
	}

	done(): boolean {
		return this.velocity === 0;
	}
}

/** The slice of Terminal the adapter needs — structural, so tests can fake it. */
export interface ScrollableTerm {
	readonly rows: number;
	readonly buffer: { readonly active: { readonly type: "normal" | "alternate" } };
	scrollLines(amount: number): void;
}

/**
 * Wires single-finger vertical drags on `container` to `term.scrollLines`
 * (normal buffer) or synthetic wheel events (alternate buffer — see the
 * module comment). Returns a disposer. Cell height is measured per
 * gesture from the rendered screen (rows and font can both change
 * between gestures); the 17px fallback only matters before the first
 * render. The buffer choice is per-gesture too: a TUI exiting mid-drag
 * just means finishing that drag in the old mode.
 */
export function attachTouchScroll(container: HTMLElement, term: ScrollableTerm): () => void {
	let scroller: TouchScroller | null = null;
	let sink: (amount: number) => void = () => {};
	let raf = 0;
	let lastFrameT = 0;

	const cellHeight = (): number => {
		const screen = container.querySelector(".xterm-screen");
		const h = screen instanceof HTMLElement ? screen.clientHeight : 0;
		return h > 0 && term.rows > 0 ? h / term.rows : 17;
	};

	const stopFling = (): void => {
		if (raf !== 0) {
			cancelAnimationFrame(raf);
			raf = 0;
		}
	};

	const flingFrame = (t: number): void => {
		raf = 0;
		if (!scroller || scroller.done()) return;
		const amount = scroller.flingStep(Math.min(t - lastFrameT, 100));
		lastFrameT = t;
		if (amount !== 0) sink(amount);
		if (!scroller.done()) raf = requestAnimationFrame(flingFrame);
	};

	const onTouchStart = (e: TouchEvent): void => {
		stopFling();
		const touch = e.touches.length === 1 ? e.touches[0] : undefined;
		if (!touch) {
			scroller = null;
			return;
		}
		if (term.buffer.active.type === "alternate") {
			// Whole pixels through the wheel pipeline (cell height 1 makes
			// the model's integers pixels). Dispatched from the touch's own
			// target so the event bubbles up through whichever element xterm
			// listens on, exactly as a real wheel would arrive.
			const target = e.target instanceof Element ? e.target : container;
			scroller = new TouchScroller(1);
			sink = (deltaY) => {
				target.dispatchEvent(
					new WheelEvent("wheel", { deltaY, deltaMode: 0, bubbles: true, cancelable: true }),
				);
			};
		} else {
			scroller = new TouchScroller(cellHeight());
			sink = (lines) => term.scrollLines(lines);
		}
		scroller.start(touch.clientY, e.timeStamp);
	};

	const onTouchMove = (e: TouchEvent): void => {
		const touch = e.touches.length === 1 ? e.touches[0] : undefined;
		if (!scroller || !touch) return;
		// The drag is ours: without this iOS rubber-bands the page instead.
		e.preventDefault();
		const amount = scroller.move(touch.clientY, e.timeStamp);
		if (amount !== 0) sink(amount);
	};

	const onTouchEnd = (e: TouchEvent): void => {
		if (!scroller || e.touches.length !== 0) return;
		if (scroller.end()) {
			lastFrameT = e.timeStamp;
			raf = requestAnimationFrame(flingFrame);
		} else {
			scroller = null;
		}
	};

	container.addEventListener("touchstart", onTouchStart, { passive: true });
	container.addEventListener("touchmove", onTouchMove, { passive: false });
	container.addEventListener("touchend", onTouchEnd, { passive: true });
	container.addEventListener("touchcancel", onTouchEnd, { passive: true });
	return () => {
		stopFling();
		container.removeEventListener("touchstart", onTouchStart);
		container.removeEventListener("touchmove", onTouchMove);
		container.removeEventListener("touchend", onTouchEnd);
		container.removeEventListener("touchcancel", onTouchEnd);
	};
}

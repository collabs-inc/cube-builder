// Adapted from packages/components/src/Terminal/history-top.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * Whether a scroll gesture means "show me older history than you hold".
 * Only a USER gesture counts, and only at the top of a normal buffer that
 * actually has scrollback: xterm's own onScroll fires for writes while
 * pinned and for programmatic scrolls, and the alternate screen (vim,
 * htop, an agent's TUI) and any buffer shorter than the viewport sit at
 * viewportY 0 forever — a passive trigger there would fetch the whole
 * ring for every visible TUI with nobody asking (spec §3).
 */
export interface HistoryTopProbe {
	viewportY: number;
	bufferType: "normal" | "alternate";
	bufferLength: number;
	rows: number;
}

export function isHistoryTopGesture(probe: HistoryTopProbe, direction: "up" | "down"): boolean {
	if (direction !== "up") return false;
	if (probe.viewportY !== 0) return false;
	if (probe.bufferType !== "normal") return false;
	return probe.bufferLength > probe.rows;
}

// Adapted from packages/components/src/Terminal/theme.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { afterAll, describe, expect, test } from "vitest";


import { darkTheme, getTheme, lightTheme } from "../../src/components/Terminal/theme";

const nativeMatchMedia = window.matchMedia.bind(window);

function setBrowserPrefersDark(matches: boolean): void {
	const result = nativeMatchMedia("(prefers-color-scheme: dark)");
	Object.defineProperty(result, "matches", { configurable: true, value: matches });
	window.matchMedia = (() => result) as typeof window.matchMedia;
}

describe("getTheme", () => {
	test("uses the app's dark theme when the browser prefers light", () => {
		setBrowserPrefersDark(false);

		expect(getTheme("dark")).toBe(darkTheme);
	});

	test("uses the app's light theme when the browser prefers dark", () => {
		setBrowserPrefersDark(true);

		expect(getTheme("light")).toBe(lightTheme);
	});
});

/**
 * The light theme's `background` is transparent (alpha 0) — the terminal is
 * painted over the app surface — so contrast has to be measured against the
 * opaque colour those same rgb components name: --background, rgb(248,248,248).
 */
function lightSurface(): [number, number, number] {
	const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(lightTheme.background));
	if (!match) throw new Error(`lightTheme.background is not rgb/rgba: ${lightTheme.background}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function channels(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
	const linearise = (v: number): number => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
	const [first, second] = [relativeLuminance(a), relativeLuminance(b)];
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

type AnsiKey = keyof typeof lightTheme;

const ANSI_KEYS: AnsiKey[] = [
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
	"brightBlack",
	"brightRed",
	"brightGreen",
	"brightYellow",
	"brightBlue",
	"brightMagenta",
	"brightCyan",
	"brightWhite",
];

const ANSI_PAIRS: [AnsiKey, AnsiKey][] = [
	["black", "brightBlack"],
	["red", "brightRed"],
	["green", "brightGreen"],
	["yellow", "brightYellow"],
	["blue", "brightBlue"],
	["magenta", "brightMagenta"],
	["cyan", "brightCyan"],
	["white", "brightWhite"],
];

function colourOf(key: AnsiKey): [number, number, number] {
	const colour = lightTheme[key];
	if (typeof colour !== "string") throw new Error(`lightTheme.${key} is unset`);
	return channels(colour);
}

describe("lightTheme legibility", () => {
	/**
	 * A third-party program picks an ANSI index, not a colour — a statusline
	 * that prints \033[37m has no idea what our palette maps 7 to. So every
	 * index has to be readable on our surface, or someone else's script is
	 * silently invisible. This caught `white: #fafafa` at 1.02:1.
	 */
	for (const key of ANSI_KEYS) {
		test(`${key} clears WCAG AA against the app surface`, () => {
			const ratio = contrastRatio(colourOf(key), lightSurface());

			expect({ key, readable: ratio >= 4.5, ratio: Number(ratio.toFixed(2)) }).toEqual({
				key,
				readable: true,
				ratio: Number(ratio.toFixed(2)),
			});
		});
	}

	for (const [normal, bright] of ANSI_PAIRS) {
		test(`${normal} and ${bright} stay tellable apart`, () => {
			const ratio = contrastRatio(colourOf(normal), colourOf(bright));

			expect(ratio).toBeGreaterThanOrEqual(1.25);
		});
	}
});

afterAll(() => {
});

// Adapted from packages/components/src/Terminal/theme.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import type { ITheme } from "@xterm/xterm";

export type TerminalTheme = "light" | "dark";

export const darkTheme: ITheme = {
  background: "rgba(8, 8, 8, 0)",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

export const lightTheme: ITheme = {
  background: "rgba(248, 248, 248, 0)",
  foreground: "#383a42",
  cursor: "#383a42",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  // Every entry below clears 4.5:1 against the app's light surface
  // (--background, rgb(248, 248, 248)) — see theme.test.ts, which fails the
  // build if one stops doing so. The palette this replaced was a port of One
  // Half Light, whose bright set is One Dark's pastels: fine on a dark
  // background, 1.6–2.8:1 on ours, so any program printing bright colors
  // washed out. `white` was #fafafa — 1.02:1, invisible.
  //
  // Note the direction of "bright": for the six hues it is DARKER and more
  // saturated than its normal counterpart, because on a light background
  // emphasis reads as more ink, not less. Only the greys go lighter. Do not
  // "correct" this back to a dark-theme palette's lighter brights.
  black: "#383a42",
  red: "#d1382a",
  green: "#3f7e3e",
  yellow: "#976701",
  blue: "#396bd9",
  magenta: "#a626a4",
  cyan: "#01749f",
  white: "#575a67",
  brightBlack: "#4f525e",
  brightRed: "#a3251a",
  brightGreen: "#2a6029",
  brightYellow: "#7d5602",
  brightBlue: "#2551b0",
  brightMagenta: "#7d1c7b",
  brightCyan: "#015877",
  brightWhite: "#6c707e",
};

export function getTheme(theme: TerminalTheme): ITheme {
  return theme === "dark" ? darkTheme : lightTheme;
}

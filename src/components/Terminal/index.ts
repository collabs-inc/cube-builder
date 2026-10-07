// Adapted from packages/components/src/Terminal/index.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
export { default as TerminalTab } from "./TerminalTab";
export { getTheme, darkTheme, lightTheme } from "./theme";
export type { TerminalTheme } from "./theme";
export type { TerminalTransfer } from "./file-drop";
// This barrel is also TerminalTab's lazy chunk boundary
// (`lazy(() => import("@builder/components/Terminal"))` in TerminalItem.tsx):
// a static value import from anywhere in the eager render graph un-splits
// xterm back into the entry bundle. Deep-import the sibling modules
// (`./file-drop`, `./image-paste`) for value exports instead of widening
// this barrel — types are fine, they vanish at build time.

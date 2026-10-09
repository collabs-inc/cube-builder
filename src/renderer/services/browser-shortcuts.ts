import { GO_TO_SCREEN_DIGITS, goToScreenAction } from "@port/shared/shortcuts";
export type Platform = "darwin" | "win32" | "linux";
export function platformFor(raw: string): Platform {
  if (/mac/i.test(raw)) return "darwin";
  if (/win/i.test(raw)) return "win32";
  return "linux";
}

/**
 * This page's platform. Exported because the ROUTER needs the same answer
 * (`RouterDeps.platform`, for path handling) and two independent detections
 * that could ever disagree is one too many — index.ts resolves it once and
 * hands it to both.
 */
export function detectPlatform(): Platform {
  const nav = globalThis.navigator as
    | (Navigator & { userAgentData?: { platform?: string } })
    | undefined;
  return platformFor(nav?.userAgentData?.platform ?? nav?.platform ?? "");
}

/** `theme:set`'s mode → whether the `dark` class should be on. Main coerces
 *  anything that is not "light"/"dark" to "system". */
export function isDarkMode(mode: string, prefersDark: boolean): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return prefersDark;
}

// ── the shortcut table (src/main/index.ts's TOGGLE_SHORTCUTS) ────────

interface Modifiers {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

type ModifierTest = (m: Modifiers, platform: Platform) => boolean;

const cmdOrCtrl: ModifierTest = (m, platform) =>
  platform === "darwin" ? m.meta && !m.ctrl : m.ctrl && !m.meta;
// The EXACT-match variants (deviation 2 in this module's header): main's
// `cmdOrCtrl` ignores the modifiers it does not name, so Cmd+Shift+N fires
// `new-tile` there. Every one of those accidental combinations is a reserved
// browser binding — Cmd+Shift+N is an incognito window, Cmd+Alt+K opens
// devtools — so matching them would swallow a key
// the page cannot honour anyway, and would fire an app action on the way out.
const plainCmdOrCtrl: ModifierTest = (m, p) => cmdOrCtrl(m, p) && !m.alt && !m.shift;
const shiftCmdOrCtrl: ModifierTest = (m, p) => cmdOrCtrl(m, p) && m.shift && !m.alt;
const cmdAlt: ModifierTest = (m, p) => cmdOrCtrl(m, p) && m.alt && !m.shift;
const cmdAltShift: ModifierTest = (m, p) => cmdOrCtrl(m, p) && m.alt && m.shift;

interface ShortcutEntry {
  modifier: ModifierTest;
  action: string;
}

const TOGGLE_SHORTCUTS: Record<string, ShortcutEntry[]> = {
  KeyB: [{ modifier: plainCmdOrCtrl, action: "studio-sidebar" }],
  Backslash: [{ modifier: plainCmdOrCtrl, action: "sidebar-files" }],
  Comma: [{ modifier: plainCmdOrCtrl, action: "toggle-settings" }],
  KeyO: [{ modifier: shiftCmdOrCtrl, action: "add-repo" }],
  KeyN: [{ modifier: plainCmdOrCtrl, action: "new-tile" }],
  KeyW: [
    { modifier: shiftCmdOrCtrl, action: "close-screen" },
    { modifier: plainCmdOrCtrl, action: "close-tile" },
  ],
  ArrowLeft: [
    { modifier: cmdAltShift, action: "move-pane-left" },
    { modifier: cmdAlt, action: "focus-pane-left" },
  ],
  ArrowRight: [
    { modifier: cmdAltShift, action: "move-pane-right" },
    { modifier: cmdAlt, action: "focus-pane-right" },
  ],
  ArrowUp: [
    { modifier: cmdAltShift, action: "move-pane-up" },
    { modifier: cmdAlt, action: "focus-pane-up" },
  ],
  ArrowDown: [
    { modifier: cmdAltShift, action: "move-pane-down" },
    { modifier: cmdAlt, action: "focus-pane-down" },
  ],
  Enter: [{ modifier: shiftCmdOrCtrl, action: "zoom-pane" }],
  ...Object.fromEntries(GO_TO_SCREEN_DIGITS.map((n) => [
    `Digit${n}`, [{ modifier: plainCmdOrCtrl, action: goToScreenAction(n) }],
  ])),
};

/** Main's `TOGGLE_SHORTCUT_KEYS`: the same entries, reached by `key` when a
 *  layout gives no usable `code`. */
const TOGGLE_SHORTCUT_KEYS: Record<string, ShortcutEntry[]> = {
  ",": TOGGLE_SHORTCUTS.Comma!,
  o: TOGGLE_SHORTCUTS.KeyO!,
  b: TOGGLE_SHORTCUTS.KeyB!,
  "\\": TOGGLE_SHORTCUTS.Backslash!,
  n: TOGGLE_SHORTCUTS.KeyN!,
  w: TOGGLE_SHORTCUTS.KeyW!,
  ArrowLeft: TOGGLE_SHORTCUTS.ArrowLeft!,
  ArrowRight: TOGGLE_SHORTCUTS.ArrowRight!,
  ArrowUp: TOGGLE_SHORTCUTS.ArrowUp!,
  ArrowDown: TOGGLE_SHORTCUTS.ArrowDown!,
  Enter: TOGGLE_SHORTCUTS.Enter!,
  ...Object.fromEntries(GO_TO_SCREEN_DIGITS.map((n) => [String(n), TOGGLE_SHORTCUTS[`Digit${n}`]!])),
};

function normalizeShortcutKey(key: string | undefined): string | null {
  if (!key) return null;
  return key.length === 1 ? key.toLowerCase() : key;
}

/** The shortcut action this keydown means, or null. Pure. */
export function resolveShortcut(event: KeyboardEvent, platform: Platform): string | null {
  const normalized = normalizeShortcutKey(event.key);
  const candidates =
    TOGGLE_SHORTCUTS[event.code] ?? (normalized ? TOGGLE_SHORTCUT_KEYS[normalized] : undefined);
  if (!candidates) return null;
  const modifiers: Modifiers = {
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
  return candidates.find((entry) => entry.modifier(modifiers, platform))?.action ?? null;
}


/** Canonical accelerators shared by the native menu and hover hints. */
export const SHORTCUT_ACCELERATORS = {
  "toggle-settings": "CommandOrControl+,",
  "sidebar-files": "CommandOrControl+\\",
  "studio-sidebar": "CommandOrControl+B",
  "new-tile": "CommandOrControl+N",
  "close-tile": "CommandOrControl+W",
  "close-screen": "CommandOrControl+Shift+W",
  // Cmd+1 … Cmd+9 — one entry stands for the whole run; the digit is the
  // screen's 1-based position in the sequence (goToScreenAction, below).
  "go-to-screen": "CommandOrControl+1",
  "add-repo": "CommandOrControl+Shift+O",
  "zoom-pane": "CommandOrControl+Shift+Return",
  "focus-pane-left": "CommandOrControl+Alt+Left",
  "focus-pane-right": "CommandOrControl+Alt+Right",
  "focus-pane-up": "CommandOrControl+Alt+Up",
  "focus-pane-down": "CommandOrControl+Alt+Down",
  "move-pane-left": "CommandOrControl+Alt+Shift+Left",
  "move-pane-right": "CommandOrControl+Alt+Shift+Right",
  "move-pane-up": "CommandOrControl+Alt+Shift+Up",
  "move-pane-down": "CommandOrControl+Alt+Shift+Down",
} as const;

/** Digits Cmd/Ctrl+1 … +9 bind to — the 1-based screen position each selects. */
export const GO_TO_SCREEN_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/** The shortcut action that selects the screen at 1-based position `n`. */
export function goToScreenAction(n: number): string {
  return `go-to-screen-${n}`;
}

/** The 1-based screen position a `go-to-screen-N` action names, or null. */
export function goToScreenPosition(action: string): number | null {
  const match = /^go-to-screen-([1-9])$/.exec(action);
  return match ? Number(match[1]) : null;
}

/** Electron accelerator spelling in; platform-appropriate keycaps out. */
export function formatShortcut(accelerator: string, platform: string): string {
  const mac = platform === "darwin";
  const keys: Record<string, string> = {
    CommandOrControl: mac ? "⌘" : "Ctrl",
    Cmd: mac ? "⌘" : "Ctrl",
    Shift: mac ? "⇧" : "Shift",
    Alt: mac ? "⌥" : "Alt",
    Return: mac ? "↵" : "Enter",
    Enter: mac ? "↵" : "Enter",
    Escape: "Esc",
    Left: "←", Right: "→", Up: "↑", Down: "↓",
  };
  return accelerator.split("+").map(key => keys[key] ?? key).join(mac ? "" : "+");
}

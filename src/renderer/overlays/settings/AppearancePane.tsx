/**
 * Theme, and the one thing the browser build has to explain about it.
 * Moved out of SettingsModal.tsx and onto the row vocabulary (#69).
 */



import { useEffect, useState } from "react";
import { Sun } from '@phosphor-icons/react/dist/csr/Sun';
import { Moon } from '@phosphor-icons/react/dist/csr/Moon';
import { Monitor } from '@phosphor-icons/react/dist/csr/Monitor';
import { services } from "../../services";
import { SettingGroup, SettingNote, SettingRow } from "./rows";

type ThemeMode = "light" | "dark" | "system";

const THEME_MODES: ThemeMode[] = ["light", "dark", "system"];

const THEME_ICONS: Record<ThemeMode, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

/**
 * Which theme is on, as a segmented control.
 *
 * The pill was painted `var(--accent)`, a token nothing in the repo declared
 * (#69) — so it computed to no colour and the only thing distinguishing the
 * selected mode was the icon's fill weight. `--accent` is now declared in
 * App.css, but the pill deliberately does NOT use it: at 4% against its own
 * 10% track it is a step too small to read, and this control is answering
 * "which one is on", which is the same question the rail answers. So it uses
 * the same selection tint the rail does, and the two agree.
 *
 * The styles moved to CSS with everything else in this pane; they were the
 * last inline colour expressions left in a converted pane.
 */
function ThemeToggle({ value, onChange }: { value: ThemeMode; onChange: (mode: ThemeMode) => void }) {
  const idx = THEME_MODES.indexOf(value);

  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      <div className="theme-toggle-pill" style={{ transform: `translateX(${idx * 36}px)` }} />
      {THEME_MODES.map((mode) => {
        const Icon = THEME_ICONS[mode];
        const active = mode === value;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={mode}
            onClick={() => onChange(mode)}
            className={`theme-toggle-option${active ? " is-active" : ""}`}
          >
            <Icon className="h-4 w-4" weight={active ? "fill" : "regular"} />
          </button>
        );
      })}
    </div>
  );
}

export default function AppearancePane() {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const isWebHost = document.documentElement.classList.contains("web-host");

  useEffect(() => {
    services.prefs
      .get("theme")
      .then((v) => {
        // Mirrors main's startup fallback: never-chosen -> dark; an explicit
        // persisted "system" stays system.
        if (v === "light" || v === "dark" || v === "system") setTheme(v);
        else setTheme("dark");
      })
      .catch(() => {});
  }, []);

  async function handleThemeChange(mode: ThemeMode) {
    setTheme(mode);
    await services.desktop.setTheme(mode);
  }

  return (
    <div className="settings-content">
      <SettingGroup>
        <SettingRow label="Theme">
          <ThemeToggle
            value={theme}
            onChange={(m) => {
              void handleThemeChange(m);
            }}
          />
        </SettingRow>
        {isWebHost && theme === "system" && (
          <SettingNote>
            Follows your browser's appearance. In Chrome, choose Device to follow macOS.
          </SettingNote>
        )}
      </SettingGroup>
    </div>
  );
}

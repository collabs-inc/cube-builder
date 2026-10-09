/**
 * Derives the app's current light/dark theme from `documentElement`'s
 * `dark` class — the one source of truth `@port/shared/dark-mode`'s
 * `initDarkMode` maintains (it toggles the class in response to
 * `prefers-color-scheme`, which Electron's `nativeTheme.themeSource`
 * itself drives once main applies a theme change — see
 * src/main/index.ts's "theme:set" handler and packages/shared/src/
 * dark-mode.ts). FileItem.tsx previously tracked theme via its own
 * `matchMedia` listener, independent of that class; this hook replaces
 * it so a settings-driven theme change (SettingsModal's ThemeToggle ->
 * services.desktop.setTheme -> main flips nativeTheme.themeSource ->
 * initDarkMode's matchMedia listener flips the class) rethemes every
 * mounted consumer live, from the same class dark-mode.ts already
 * maintains — not a second, parallel read of the OS media query.
 */



import { useEffect, useState } from "react";

export type AppTheme = "light" | "dark";

/** Pure: derives the theme from whether `dark` is present in a class list. */
export function deriveTheme(hasDarkClass: boolean): AppTheme {
  return hasDarkClass ? "dark" : "light";
}

function readDocumentTheme(): AppTheme {
  return deriveTheme(document.documentElement.classList.contains("dark"));
}

/**
 * Subscribes to `documentElement`'s `class` attribute via a
 * MutationObserver (dark-mode.ts only toggles the class; it doesn't expose
 * a subscribable current-theme value) and returns the current theme,
 * updating on every change.
 */
export function useAppTheme(): AppTheme {
  const [theme, setTheme] = useState<AppTheme>(readDocumentTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(readDocumentTheme());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    // The class may have changed between this effect's initial state
    // (computed at render time) and the observer actually attaching.
    setTheme(readDocumentTheme());
    return () => observer.disconnect();
  }, []);

  return theme;
}

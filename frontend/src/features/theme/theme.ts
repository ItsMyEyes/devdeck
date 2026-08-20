/**
 * Appearance: dark only.
 *
 * DevDeck previously let a preference (light / dark / system) resolve to a
 * palette. Light mode is disabled — every function below now always
 * resolves to `dark`, regardless of what is stored or what the OS prefers.
 * The types stay unions of the original three/two values, and the plumbing
 * (monaco's global theme registry, the live xterm instances, the pre-paint
 * script in `index.html`) stays wired through this module, so re-enabling
 * light mode later is a change to this file only.
 */

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

/** Also read by the inline script in `index.html`, which applies the stored
 *  theme before first paint. `theme.guard.test.ts` pins the two together. */
export const THEME_STORAGE_KEY = 'devdeck.appearance.theme'

export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

/** Light mode is disabled: whatever is stored, the resolved preference is
 *  always `dark`. */
export function readThemePreference(): ThemePreference {
  return 'dark'
}

/** No-op: the preference cannot change while light mode is disabled. */
export function setThemePreference(_next: ThemePreference) {}

export function subscribeThemePreference(_listener: (preference: ThemePreference) => void) {
  return () => {}
}

/** Light mode is disabled: always `dark`, regardless of preference or OS. */
export function resolveTheme(_preference: ThemePreference, _systemPrefersDark: boolean): ResolvedTheme {
  return 'dark'
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(SYSTEM_DARK_QUERY).matches
  } catch {
    // Ancient/headless environments without matchMedia keep the historical look.
    return true
  }
}

/** The theme in force right now: always `dark` while light mode is disabled. */
export function currentResolvedTheme(): ResolvedTheme {
  return resolveTheme(readThemePreference(), systemPrefersDark())
}

/**
 * Fires whenever the *resolved* theme changes. While light mode is disabled
 * the resolved theme can never change, so this is a no-op subscription kept
 * for the non-React consumers (`sshTerminalRegistry`) that call it.
 */
export function subscribeResolvedTheme(_listener: (resolved: ResolvedTheme) => void): () => void {
  return () => {}
}

/**
 * Writes the resolved theme onto `<html>`. Forces `dark` regardless of the
 * `resolved` argument — defense in depth while light mode is disabled.
 *
 * Both classes are managed, not just `.dark`: tailwind's `dark:` variant keys
 * off `.dark` (see `@custom-variant dark` in globals.css) while the palette
 * override keys off `.light`, so the two have to move together or the vendored
 * shadcn layer ends up with dark component styles on a light page.
 *
 * `color-scheme` is what makes the browser's own chrome — scrollbars, form
 * controls, the canvas behind an overscroll — follow along.
 */
export function applyTheme(_resolved: ResolvedTheme = 'dark', root: HTMLElement = document.documentElement) {
  root.classList.add('dark')
  root.classList.remove('light')
  root.style.colorScheme = 'dark'
}

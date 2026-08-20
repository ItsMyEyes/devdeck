import { useCallback, useEffect, useState } from 'react'
import {
  applyTheme,
  currentResolvedTheme,
  readThemePreference,
  setThemePreference,
  subscribeResolvedTheme,
  subscribeThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from './theme'

/** The theme actually in force, for surfaces that cannot read CSS variables
 *  (monaco, xterm, mermaid, the toaster). */
export function useResolvedTheme(): ResolvedTheme {
  const [resolved, setResolved] = useState<ResolvedTheme>(currentResolvedTheme)
  useEffect(() => subscribeResolvedTheme(setResolved), [])
  return resolved
}

/**
 * Keeps `<html>` in sync with the stored preference for the life of the app.
 *
 * Mounted once, from `GlobalOverlays` — the one component that is always
 * rendered. `subscribeResolvedTheme` owns the OS listener, so `system`
 * re-resolves the moment the OS flips rather than at the next reload.
 */
export function useThemeSync(): ResolvedTheme {
  const resolved = useResolvedTheme()
  useEffect(() => {
    applyTheme(resolved)
  }, [resolved])
  useEffect(() => {
    // Imported lazily: monaco is a large chunk, and the app shell must not pull
    // it in just to render the overlays. `setupMonaco()` has already run by the
    // time any editor exists, and calling `setTheme` before that is a no-op the
    // seed in `setupMonaco` corrects.
    void import('@/features/editor/monacoSetup').then((m) => m.setMonacoTheme(resolved))
  }, [resolved])
  useEffect(() => {
    // The title bar and the strip around the app are a native
    // NSVisualEffectView behind the webview, and it takes light/dark from the
    // window's appearance rather than from any CSS — see `setNativeWindowTheme`.
    if (!('__TAURI_INTERNALS__' in window)) return
    void import('@/features/desktop/desktopBridge')
      .then((m) => m.setNativeWindowTheme(resolved))
      .catch(() => {
        // An older tauri build without setTheme: the chrome keeps the OS
        // appearance, which is cosmetic and must not break the web-side switch.
      })
  }, [resolved])
  return resolved
}

/** For the settings control: the current choice, and a setter that writes it
 *  through to every subscriber. */
export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference)
  useEffect(() => subscribeThemePreference(setPreference), [])
  return [preference, useCallback((next: ThemePreference) => setThemePreference(next), [])]
}

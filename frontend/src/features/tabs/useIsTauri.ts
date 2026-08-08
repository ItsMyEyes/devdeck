/** True only inside the Tauri desktop shell — `__TAURI_INTERNALS__` is a
 *  global injected by Tauri v2's webview at load time. Always false on the
 *  web, where no tab bar should render. */
export function useIsTauri(): boolean {
  return '__TAURI_INTERNALS__' in window
}

/** True only inside Tauri on macOS — the only platform with native window
 *  vibrancy configured (`transparent` + `windowEffects: sidebar` live in
 *  tauri.macos.conf.json, a platform-specific override that Windows/Linux
 *  builds never see). Gates the CSS that skips the opaque/glass-approximation
 *  background in favour of the native material; using plain `useIsTauri()`
 *  there would leave Windows/Linux windows transparent with nothing behind
 *  them to composite against. */
export function useHasMacVibrancy(): boolean {
  return useIsTauri() && typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}

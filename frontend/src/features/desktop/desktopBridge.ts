// Thin wrapper around this app's hub-mode/diagnostics Tauri commands
// (frontend/src-tauri/src/lib.rs). Desktop-only — every export here assumes
// useIsTauri() is already true; callers gate on that themselves, matching
// how browserTilesBridge.ts reaches into Tauri-only APIs.

import { invoke } from '@tauri-apps/api/core'

/** Clears the saved hub mode and restarts the app — it comes back up on the
 *  first-run hub-mode picker. See Rust's `change_hub` in `lib.rs`. */
export function changeHub(): Promise<void> {
  return invoke('change_hub')
}

/** Opens this device's sidecar.log with the OS's default handler. See
 *  Rust's `open_log_file` in `lib.rs`. */
export function openLogFile(): Promise<void> {
  return invoke('open_log_file')
}

/**
 * Points the native window at the light or dark system appearance.
 *
 * The CSS palette cannot reach this. The window is `transparent: true` with
 * `windowEffects: ['sidebar']` (tauri.macos.conf.json), which is a real
 * `NSVisualEffectView` composited *behind* the webview — the title bar and the
 * strip around the app are that material, not our markup. It picks light or
 * dark from the window's `NSAppearance`, so with the app in light mode and the
 * OS in dark the chrome stayed dark around a light page.
 *
 * Web builds have no window to set; callers guard on `useIsTauri()`.
 */
export async function setNativeWindowTheme(theme: 'light' | 'dark'): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().setTheme(theme)
}

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

/** One dialable IPv4 address on this device. */
export interface BindInterface {
  name: string
  ip: string
}

export interface BindConfig {
  /** The address this device's sidecars bind, e.g. `127.0.0.1` or `0.0.0.0`. */
  host: string
  /** This device's up, non-loopback IPv4 addresses, for the picker. */
  interfaces: BindInterface[]
  /** The address to actually show for `host` — `0.0.0.0` resolved to a
   *  concrete interface. Null while bound to loopback, where there is
   *  nothing to hand another device. */
  displayHost: string | null
  /** The port the hub is listening on right now — not the one it prefers.
   *  They differ whenever 8989 was already taken and the OS assigned one. */
  hubPort: number
  /** False when `hubPort` is an OS-assigned fallback, so the address is not
   *  stable across restarts. */
  portIsPreferred: boolean
}

/** Reads the saved bind address plus this device's interfaces. See Rust's
 *  `get_bind_config` in `lib.rs`. */
export function getBindConfig(): Promise<BindConfig> {
  return invoke('get_bind_config')
}

/** Saves a new bind address and restarts the app so the sidecars respawn
 *  against it — the app goes away as this resolves. Rejects without writing
 *  anything when `host` is not an IP address. See Rust's `set_bind_config`. */
export function setBindConfig(host: string): Promise<void> {
  return invoke('set_bind_config', { host })
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

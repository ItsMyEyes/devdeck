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

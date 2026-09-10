// "Open with a local app" — hands a file's bytes to the Tauri shell, which
// writes them to a private temp file and opens it with the OS's default
// handler for that extension, deleting the temp copy again once that app
// closes. See frontend/src-tauri/src/open_with.rs for the actual lifecycle
// (and exactly what "closes" means per platform).
//
// Desktop-only, like saveFile.ts's Tauri tier and desktopBridge.ts: opening a
// local OS app and writing a filesystem path both need the Tauri shell.
// Callers gate on canOpenWithExternalApp()/useIsTauri() themselves.

/** Mirrors `hasTauriIpc` in saveFile.ts — kept local rather than imported so
 *  this module stays plain TS with no React, unit-testable against a stub
 *  window that has neither key. */
function hasTauriIpc(win: Pick<Window, never> = window): boolean {
  return '__TAURI_INTERNALS__' in win
}

export function canOpenWithExternalApp(win: Pick<Window, never> = window): boolean {
  return hasTauriIpc(win)
}

/**
 * Opens `bytes` (named `name`) in the OS's default app for its extension.
 *
 * `bytes` crosses IPC as the invoke's raw request body rather than a
 * JSON-wrapped argument — a JSON number array would inflate a multi-megabyte
 * document 3-4x and cost a slow parse on both ends. `name` rides a header
 * instead, since a raw-body invoke carries no other named arguments;
 * percent-encoded so it survives as a valid header value no matter what
 * characters the filename has.
 */
export async function openWithExternalApp(name: string, bytes: Uint8Array): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('open_with_external', bytes, {
    headers: { 'x-devdeck-filename': encodeURIComponent(name) },
  })
}

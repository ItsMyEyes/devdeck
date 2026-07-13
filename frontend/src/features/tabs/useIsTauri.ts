/** True only inside the Tauri desktop shell — `__TAURI_INTERNALS__` is a
 *  global injected by Tauri v2's webview at load time. Always false on the
 *  web, where no tab bar should render. */
export function useIsTauri(): boolean {
  return '__TAURI_INTERNALS__' in window
}

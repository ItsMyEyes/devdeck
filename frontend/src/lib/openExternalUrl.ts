import { invoke } from '@tauri-apps/api/core'

/** Opens an http(s) terminal link in the system browser. */
export function openExternalUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  if ('__TAURI_INTERNALS__' in window) {
    void invoke('open_external_url', { url: url.href }).catch(() => window.open(url.href, '_blank', 'noopener,noreferrer'))
    return
  }
  window.open(url.href, '_blank', 'noopener,noreferrer')
}

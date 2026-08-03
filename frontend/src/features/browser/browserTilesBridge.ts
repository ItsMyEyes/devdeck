// Thin wrapper around the Tauri commands in
// frontend/src-tauri/src/browser_tiles.rs. Desktop-only — every export here
// assumes useIsTauri() is already true; callers gate on that themselves,
// matching how the rest of the tabs feature reaches into Tauri-only APIs.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface BrowserTileBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Tracks which (tabId, docId) pair a given native webview label belongs
 *  to, so `onBrowserTilePageLoad` doesn't need to parse ids back out of a
 *  concatenated label string (unsafe in general, since both ids can contain
 *  hyphens themselves — e.g. generated UUIDs). */
const labelRegistry = new Map<string, { tabId: string; docId: string }>()

export function browserTileLabel(tabId: string, docId: string): string {
  return `browser-${tabId}-${docId}`
}

export function openBrowserTile(tabId: string, docId: string, proxyUrl: string, initialUrl: string): Promise<void> {
  const key = browserTileLabel(tabId, docId)
  labelRegistry.set(key, { tabId, docId })
  hiddenLabels.delete(key)
  return invoke('browser_tile_open', { tabId, docId, proxyUrl, initialUrl })
}

export function navigateBrowserTile(tabId: string, docId: string, url: string): Promise<void> {
  return invoke('browser_tile_navigate', { tabId, docId, url })
}

export function reloadBrowserTile(tabId: string, docId: string): Promise<void> {
  return invoke('browser_tile_reload', { tabId, docId })
}

/** Steps the webview's own session history, so the engine restores scroll
 *  position and form state. Re-navigating to a remembered URL — what the
 *  toolbar used to do — reloads the page from scratch and pushes a fresh
 *  entry instead. */
export function goBackBrowserTile(tabId: string, docId: string): Promise<void> {
  return invoke('browser_tile_back', { tabId, docId })
}

export function goForwardBrowserTile(tabId: string, docId: string): Promise<void> {
  return invoke('browser_tile_forward', { tabId, docId })
}

export function setZoomBrowserTile(tabId: string, docId: string, scale: number): Promise<void> {
  return invoke('browser_tile_set_zoom', { tabId, docId, scale })
}

/** Bounds in flight to Rust, and the latest bounds superseding it, keyed by
 *  webview label. `BrowserTile`'s `ResizeObserver` calls this on every tick
 *  of an interactive panel drag — dozens of unawaited invokes in quick
 *  succession. `browser_tile_set_bounds` is a sync Tauri command, so nothing
 *  guarantees those IPC calls apply in the order they were sent; the native
 *  webview (an OS surface Tauri paints on top of the DOM, unclipped by any
 *  CSS) can end up glued to a stale, larger, mid-drag rect that visibly
 *  overflows the placeholder div once the drag settles. Serializing sends
 *  per label — always the latest queued rect, never more than one in flight
 *  — guarantees the final applied bounds match the final on-screen rect. */
const pendingBounds = new Map<string, BrowserTileBounds>()
const sendingBounds = new Set<string>()

export function setBrowserTileBounds(tabId: string, docId: string, bounds: BrowserTileBounds): Promise<void> {
  const key = browserTileLabel(tabId, docId)
  pendingBounds.set(key, bounds)
  if (sendingBounds.has(key)) return Promise.resolve()
  sendingBounds.add(key)
  return (async () => {
    let next: BrowserTileBounds | undefined
    while ((next = pendingBounds.get(key))) {
      pendingBounds.delete(key)
      await invoke('browser_tile_set_bounds', { tabId, docId, ...next }).catch(() => {})
    }
    sendingBounds.delete(key)
  })()
}

/** Labels currently known to be hidden, so a redundant hide never reaches
 *  Rust. `BrowserTile`'s occlusion effect re-runs on every change to
 *  `nativeOverlayBlockers`, and a blocker using `useNativeOverlayBlocker`'s
 *  `live` mode (the tab-drag ghost, whose rect moves by CSS transform and so
 *  has to be re-measured per animation frame) republishes its rect ~60x a
 *  second. Without this, a ghost dragged across an open Browser tile fires a
 *  `browser_tile_hide` IPC round trip every frame, each one taking the global
 *  `BrowserTiles` mutex — the exact IPC storm the `scheduleShow` coalescing
 *  on the other side of the effect exists to avoid.
 *
 *  Only `hide` is safe to skip this way: it carries no arguments, so a second
 *  identical call is a genuine no-op. `show` carries bounds that may have
 *  changed since the last one, so it always goes through. */
const hiddenLabels = new Set<string>()

export function hideBrowserTile(tabId: string, docId: string): Promise<void> {
  const key = browserTileLabel(tabId, docId)
  if (hiddenLabels.has(key)) return Promise.resolve()
  hiddenLabels.add(key)
  return invoke('browser_tile_hide', { tabId, docId })
}

export function showBrowserTile(tabId: string, docId: string, bounds: BrowserTileBounds): Promise<void> {
  hiddenLabels.delete(browserTileLabel(tabId, docId))
  return invoke('browser_tile_show', { tabId, docId, ...bounds })
}

export function closeBrowserTile(tabId: string, docId: string): Promise<void> {
  const key = browserTileLabel(tabId, docId)
  labelRegistry.delete(key)
  // A recreated webview (machine switch rebuilds one under the same label —
  // see `BrowserTile`'s `selectMachine`) starts visible, so a stale hidden
  // flag here would suppress the next legitimate hide.
  hiddenLabels.delete(key)
  return invoke('browser_tile_close', { tabId, docId })
}

export interface BrowserTileFindResult {
  active: number
  total: number
}

export function findInBrowserTile(
  tabId: string,
  docId: string,
  query: string,
  direction: 'next' | 'prev',
): Promise<BrowserTileFindResult> {
  return invoke('browser_tile_find', { tabId, docId, query, direction })
}

export function clearBrowserTileFind(tabId: string, docId: string): Promise<void> {
  return invoke('browser_tile_find_clear', { tabId, docId })
}

/** Subscribes to page-load events for every browser-tile webview (Rust's
 *  global `on_page_load` hook, filtered there to `browser-*` labels). Looks
 *  the label back up in `labelRegistry` rather than parsing it, since a
 *  regex split would be ambiguous when either id contains a hyphen. */
export function onBrowserTilePageLoad(
  callback: (info: { tabId: string; docId: string; url: string; loading: boolean }) => void,
): Promise<() => void> {
  return listen<{ label: string; url: string; loading: boolean }>('browser-tile-page-load', (event) => {
    const ids = labelRegistry.get(event.payload.label)
    if (ids) callback({ ...ids, url: event.payload.url, loading: event.payload.loading })
  })
}

/** Subscribes to the loaded page's own `<title>` changing (Rust's per-webview
 *  `on_document_title_changed` hook set up in `browser_tile_open`), so the
 *  Browser tile's tab strip and doc title follow the real page title instead
 *  of a URL-derived guess. */
export function onBrowserTileTitleChange(
  callback: (info: { tabId: string; docId: string; title: string }) => void,
): Promise<() => void> {
  return listen<{ label: string; title: string }>('browser-tile-title-changed', (event) => {
    const ids = labelRegistry.get(event.payload.label)
    if (ids) callback({ ...ids, title: event.payload.title })
  })
}

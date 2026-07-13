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
  labelRegistry.set(browserTileLabel(tabId, docId), { tabId, docId })
  return invoke('browser_tile_open', { tabId, docId, proxyUrl, initialUrl })
}

export function navigateBrowserTile(tabId: string, docId: string, url: string): Promise<void> {
  return invoke('browser_tile_navigate', { tabId, docId, url })
}

export function reloadBrowserTile(tabId: string, docId: string): Promise<void> {
  return invoke('browser_tile_reload', { tabId, docId })
}

export function setBrowserTileBounds(tabId: string, docId: string, bounds: BrowserTileBounds): Promise<void> {
  return invoke('browser_tile_set_bounds', { tabId, docId, ...bounds })
}

export function hideBrowserTile(tabId: string, docId: string): Promise<void> {
  return invoke('browser_tile_hide', { tabId, docId })
}

export function showBrowserTile(tabId: string, docId: string, bounds: BrowserTileBounds): Promise<void> {
  return invoke('browser_tile_show', { tabId, docId, ...bounds })
}

export function closeBrowserTile(tabId: string, docId: string): Promise<void> {
  labelRegistry.delete(browserTileLabel(tabId, docId))
  return invoke('browser_tile_close', { tabId, docId })
}

/** Subscribes to page-load events for every browser-tile webview (Rust's
 *  global `on_page_load` hook, filtered there to `browser-*` labels). Looks
 *  the label back up in `labelRegistry` rather than parsing it, since a
 *  regex split would be ambiguous when either id contains a hyphen. */
export function onBrowserTilePageLoad(
  callback: (info: { tabId: string; docId: string; url: string }) => void,
): Promise<() => void> {
  return listen<{ label: string; url: string }>('browser-tile-page-load', (event) => {
    const ids = labelRegistry.get(event.payload.label)
    if (ids) callback({ ...ids, url: event.payload.url })
  })
}

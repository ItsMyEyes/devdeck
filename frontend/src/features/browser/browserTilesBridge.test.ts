import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }))

import { closeBrowserTile, hideBrowserTile, showBrowserTile } from '@/features/browser/browserTilesBridge'

afterEach(() => {
  invoke.mockReset()
})

const BOUNDS = { x: 0, y: 0, width: 100, height: 100 }

// Closing a Browser tab destroys the native webviews first and unmounts the
// tile second, so the tile's own teardown always addresses a webview Rust has
// already forgotten. That surfaced as "Unhandled Promise Rejection: no browser
// tile webview for browser-…" every time a tab was closed.
describe('browserTilesBridge missing-webview tolerance', () => {
  it('treats hiding an already-destroyed webview as done', async () => {
    invoke.mockRejectedValueOnce('no browser tile webview for browser-tab-a-doc-a')

    await expect(hideBrowserTile('tab-a', 'doc-a')).resolves.toBeUndefined()
  })

  it('treats showing an already-destroyed webview as done', async () => {
    invoke.mockRejectedValueOnce('no browser tile webview for browser-tab-b-doc-b')

    await expect(showBrowserTile('tab-b', 'doc-b', BOUNDS)).resolves.toBeUndefined()
  })

  it('treats closing an already-destroyed webview as done', async () => {
    invoke.mockRejectedValueOnce('no browser tile webview for browser-tab-c-doc-c')

    await expect(closeBrowserTile('tab-c', 'doc-c')).resolves.toBeUndefined()
  })

  // Only the "it is already gone" case is absorbed — a genuine IPC failure has
  // to stay visible rather than being silently treated as success.
  it('still rejects on an unrelated failure', async () => {
    invoke.mockRejectedValueOnce(new Error('ipc channel closed'))

    await expect(hideBrowserTile('tab-d', 'doc-d')).rejects.toThrow('ipc channel closed')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { useDevDeckStore } from '@/store/useDevDeckStore'

// Regression test for the "native webview stays put while the page scrolls
// around it" bug: `ResizeObserver` only fires when the placeholder's own box
// size changes, not when an ancestor's scroll moves it on screen. See the
// scroll listener added alongside the `ResizeObserver` in BrowserTile.tsx.
const bridge = vi.hoisted(() => ({
  openBrowserTile: vi.fn(() => Promise.resolve()),
  hideBrowserTile: vi.fn(() => Promise.resolve()),
  showBrowserTile: vi.fn(() => Promise.resolve()),
  setBrowserTileBounds: vi.fn(() => Promise.resolve()),
  closeBrowserTile: vi.fn(() => Promise.resolve()),
  navigateBrowserTile: vi.fn(() => Promise.resolve()),
  reloadBrowserTile: vi.fn(() => Promise.resolve()),
  goBackBrowserTile: vi.fn(() => Promise.resolve()),
  goForwardBrowserTile: vi.fn(() => Promise.resolve()),
  setZoomBrowserTile: vi.fn(() => Promise.resolve()),
  findInBrowserTile: vi.fn(() => Promise.resolve({ active: 0, total: 0 })),
  clearBrowserTileFind: vi.fn(() => Promise.resolve()),
  onBrowserTilePageLoad: vi.fn(() => Promise.resolve(() => undefined)),
  onBrowserTileTitleChange: vi.fn(() => Promise.resolve(() => undefined)),
}))

vi.mock('@/features/browser/browserTilesBridge', () => bridge)

vi.mock('@/features/data/queries', () => ({
  useMachines: () => ({ data: [] }),
  useMachinesHealth: () => new Map(),
  useBookmarks: () => ({ data: [] }),
  useCreateBookmark: () => ({ mutate: vi.fn() }),
  useDeleteBookmark: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/lib/machineApi', () => ({ startProxy: vi.fn(() => Promise.resolve(null)) }))

import { BrowserTile } from '@/features/browser/BrowserTile'

const TAB_ID = 'tab-1'
const DOC_ID = 'doc-1'

function stubResizeObserver() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
}

/** jsdom measures every element as 0x0, which `visibleTileRect` reads as "not
 *  visible at all" — so without this the tile would look occluded for reasons
 *  unrelated to what this test is about. Returns a distinct rect per call so a
 *  post-scroll re-measure is distinguishable from the mount-time bounds. */
function stubLayout(rect: Partial<DOMRect>) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    left: 0,
    right: 1200,
    width: 1200,
    height: 760,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect)
}

function seedOpenTile() {
  useDevDeckStore.setState({
    browserTiles: {
      [TAB_ID]: {
        fullscreen: false,
        activeDocId: DOC_ID,
        docs: [
          {
            id: DOC_ID,
            machineId: 'machine-1',
            proxy: { socks5Addr: '127.0.0.1:1080', httpProxyAddr: '127.0.0.1:8080' },
            url: 'https://google.com',
            title: 'Google',
            loading: false,
            loadError: null,
            history: ['https://google.com'],
            historyIndex: 0,
          },
        ],
      },
    },
    nativeOverlayBlockers: {},
    tileDragActive: false,
  })
}

beforeEach(() => {
  seedOpenTile()
  stubResizeObserver()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const fn of Object.values(bridge)) fn.mockClear()
})

describe('BrowserTile native webview follows ancestor scroll', () => {
  it('re-reports bounds on a window scroll event, not just resize', async () => {
    stubLayout({ y: 40, top: 40, bottom: 800 })
    render(<BrowserTile tabId={TAB_ID} isActive />)
    await waitFor(() => expect(bridge.openBrowserTile).toHaveBeenCalled())
    bridge.setBrowserTileBounds.mockClear()

    // Scrolling an ancestor moves the placeholder without resizing it —
    // simulate that by changing only what getBoundingClientRect reports,
    // then firing the same capture-phase 'scroll' event a nested scrollable
    // container would dispatch.
    stubLayout({ y: -160, top: -160, bottom: 600 })
    window.dispatchEvent(new Event('scroll'))

    await waitFor(() =>
      expect(bridge.setBrowserTileBounds).toHaveBeenCalledWith(TAB_ID, DOC_ID, {
        x: 0,
        y: -160,
        width: 1200,
        height: 760,
      }),
    )
  })
})

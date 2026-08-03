import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { useDevDeckStore } from '@/store/useDevDeckStore'

// The native webview bridge is the whole subject here: a Browser tile whose
// tab is no longer the selected one in its leaf must tell Rust to hide, since
// the tile itself stays *mounted* (WorkspaceTileCanvas only toggles a
// `hidden` class on inactive tabs) and a native webview paints above the DOM
// regardless of any CSS applied to its placeholder.
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

/** Every `ResizeObserver` constructed while a test runs, so the tile's own
 *  bounds-reporting callback can be fired on demand — vitest.setup.ts's global
 *  stub is inert, and jsdom has no real one. */
const observerCallbacks: ResizeObserverCallback[] = []

function stubResizeObserver() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        observerCallbacks.push(callback)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
}

function fireResize() {
  for (const callback of observerCallbacks) callback([], {} as ResizeObserver)
}

/** jsdom measures every element as 0x0, which `visibleTileRect` reads as "not
 *  visible at all" — so without this the tile would look occluded for reasons
 *  unrelated to what this test is about. */
function stubLayout() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 40,
    left: 0,
    top: 40,
    right: 1200,
    bottom: 800,
    width: 1200,
    height: 760,
    toJSON: () => ({}),
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
  stubLayout()
  stubResizeObserver()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  observerCallbacks.length = 0
  for (const fn of Object.values(bridge)) fn.mockClear()
})

describe('BrowserTile native webview follows its tab selection', () => {
  it('hides the webview when its tab stops being the leaf’s active tab', async () => {
    const view = render(<BrowserTile tabId={TAB_ID} isActive />)
    await waitFor(() => expect(bridge.openBrowserTile).toHaveBeenCalled())
    bridge.hideBrowserTile.mockClear()

    view.rerender(<BrowserTile tabId={TAB_ID} isActive={false} />)

    await waitFor(() => expect(bridge.hideBrowserTile).toHaveBeenCalledWith(TAB_ID, DOC_ID))
  })

  it('shows it again when its tab is reselected', async () => {
    const view = render(<BrowserTile tabId={TAB_ID} isActive />)
    await waitFor(() => expect(bridge.openBrowserTile).toHaveBeenCalled())

    view.rerender(<BrowserTile tabId={TAB_ID} isActive={false} />)
    await waitFor(() => expect(bridge.hideBrowserTile).toHaveBeenCalledWith(TAB_ID, DOC_ID))
    bridge.showBrowserTile.mockClear()

    view.rerender(<BrowserTile tabId={TAB_ID} isActive />)

    await waitFor(() =>
      expect(bridge.showBrowserTile).toHaveBeenCalledWith(TAB_ID, DOC_ID, {
        x: 0,
        y: 40,
        width: 1200,
        height: 760,
      }),
    )
  })

  it('stops reasserting bounds while inactive, so a resize never revives it', async () => {
    const view = render(<BrowserTile tabId={TAB_ID} isActive />)
    await waitFor(() => expect(bridge.openBrowserTile).toHaveBeenCalled())

    view.rerender(<BrowserTile tabId={TAB_ID} isActive={false} />)
    await waitFor(() => expect(bridge.hideBrowserTile).toHaveBeenCalledWith(TAB_ID, DOC_ID))
    bridge.setBrowserTileBounds.mockClear()

    fireResize()
    await Promise.resolve()

    expect(bridge.setBrowserTileBounds).not.toHaveBeenCalled()
  })
})

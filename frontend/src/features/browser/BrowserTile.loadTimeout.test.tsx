import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { BROWSER_LOAD_TIMEOUT_MS } from '@/features/browser/browserLoadError'

// Nothing native reports a load that never lands — `on_page_load` only fires on
// a commit — so before the timer the toolbar spun forever with the tile stuck on
// whatever the previous page left behind.
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

function seedLoadingTile() {
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
            url: 'https://example.com',
            title: 'Example',
            loading: true,
            loadError: null,
            history: ['https://example.com'],
            historyIndex: 0,
          },
        ],
      },
    },
    nativeOverlayBlockers: {},
    tileDragActive: false,
  })
}

function currentDoc() {
  return useDevDeckStore.getState().browserTiles[TAB_ID]?.docs.find((d) => d.id === DOC_ID)
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  seedLoadingTile()
  stubLayout()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const fn of Object.values(bridge)) fn.mockClear()
})

describe('BrowserTile load timeout', () => {
  it('gives up on a load that never commits and offers a retry', async () => {
    render(<BrowserTile tabId={TAB_ID} isActive />)
    await waitFor(() => expect(bridge.openBrowserTile).toHaveBeenCalled())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BROWSER_LOAD_TIMEOUT_MS + 1)
    })

    expect(currentDoc()?.loading).toBe(false)
    expect(currentDoc()?.loadError?.kind).toBe('timeout')
    expect(screen.getByRole('alert')).toHaveTextContent('took too long')
  })

  // A native child webview composites above the app's DOM, so the panel is only
  // actually visible once Rust has been told to hide the webview.
  it('hides the native webview so the panel is not painted over', async () => {
    render(<BrowserTile tabId={TAB_ID} isActive />)
    await waitFor(() => expect(bridge.openBrowserTile).toHaveBeenCalled())
    bridge.hideBrowserTile.mockClear()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BROWSER_LOAD_TIMEOUT_MS + 1)
    })

    await waitFor(() => expect(bridge.hideBrowserTile).toHaveBeenCalledWith(TAB_ID, DOC_ID))
  })

  it('clears the timer when the load commits in time', async () => {
    render(<BrowserTile tabId={TAB_ID} isActive />)
    await waitFor(() => expect(bridge.openBrowserTile).toHaveBeenCalled())

    act(() => {
      useDevDeckStore.getState().setBrowserDocState(TAB_ID, DOC_ID, { loading: false })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BROWSER_LOAD_TIMEOUT_MS + 1)
    })

    expect(currentDoc()?.loadError).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retry reloads the webview and drops the panel', async () => {
    render(<BrowserTile tabId={TAB_ID} isActive />)
    await waitFor(() => expect(bridge.openBrowserTile).toHaveBeenCalled())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BROWSER_LOAD_TIMEOUT_MS + 1)
    })

    await act(async () => {
      screen.getByRole('button', { name: /retry/i }).click()
    })

    expect(bridge.reloadBrowserTile).toHaveBeenCalledWith(TAB_ID, DOC_ID)
    expect(currentDoc()?.loadError).toBeNull()
    expect(currentDoc()?.loading).toBe(true)
  })
})

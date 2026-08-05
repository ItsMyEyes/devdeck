import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { BROWSER_LOAD_TIMEOUT_MS } from '@/features/browser/browserLoadError'

// The module renders /api/browser/proxy in a sandboxed iframe, which can read
// neither its own response status nor its own headers. Everything it knows
// about a failed load arrives as a postMessage from the injected script, or not
// at all — in which case the timer is the only thing that ends the wait.
vi.mock('@/lib/api', () => ({
  fetchBrowserProxySession: vi.fn(() => Promise.resolve({ token: 'proxy-token' })),
  browserProxyUrl: (url: string, token?: string) => `/api/browser/proxy?url=${encodeURIComponent(url)}&token=${token ?? ''}`,
}))

import { BrowserModule } from '@/features/modules/BrowserModule'

function frame() {
  return document.querySelector('iframe')
}

/** Speaks as the proxied page does: same source window the module's listener
 *  checks, so the message is not discarded as coming from somewhere else. */
function postFromFrame(data: Record<string, unknown>) {
  const source = frame()?.contentWindow ?? null
  window.dispatchEvent(new MessageEvent('message', { data, source: source as MessageEventSource }))
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('BrowserModule failed loads', () => {
  it('shows the site s error status instead of silently rendering its page', async () => {
    render(<BrowserModule />)
    await waitFor(() => expect(frame()).not.toBeNull())

    act(() => {
      postFromFrame({ type: 'devdeck-browser:loaded', url: 'https://example.com', status: 404 })
    })

    const panel = await screen.findByRole('alert')
    expect(panel).toHaveTextContent('404 Not Found')
    expect(frame()).toBeNull()
  })

  // A DevDeck-side failure used to render as the raw `{"error":…}` envelope
  // inside the frame; it now arrives as a page carrying its own message.
  it('names the proxy as the cause when the proxy is what failed', async () => {
    render(<BrowserModule />)
    await waitFor(() => expect(frame()).not.toBeNull())

    act(() => {
      postFromFrame({
        type: 'devdeck-browser:loaded',
        url: 'https://example.com',
        status: 502,
        error: 'the site could not be reached',
      })
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('The site could not be reached. (502 Bad Gateway)')
  })

  it('clears the spinner on a good load without showing a panel', async () => {
    render(<BrowserModule />)
    await waitFor(() => expect(frame()).not.toBeNull())

    act(() => {
      postFromFrame({ type: 'devdeck-browser:loaded', url: 'https://example.com', status: 200 })
    })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(frame()).not.toBeNull()
  })

  it('gives up on a load that never reports back', async () => {
    render(<BrowserModule />)
    await waitFor(() => expect(frame()).not.toBeNull())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BROWSER_LOAD_TIMEOUT_MS + 1)
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('took too long')
  })

  it('retry puts the frame back', async () => {
    render(<BrowserModule />)
    await waitFor(() => expect(frame()).not.toBeNull())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BROWSER_LOAD_TIMEOUT_MS + 1)
    })
    await screen.findByRole('alert')

    await act(async () => {
      screen.getByRole('button', { name: /retry/i }).click()
    })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(frame()).not.toBeNull()
  })
})

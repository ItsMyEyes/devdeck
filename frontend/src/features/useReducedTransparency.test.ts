import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useReducedTransparency } from './useReducedTransparency'

type Listener = () => void
let listeners: Listener[] = []

function mockMatchMedia(matches: boolean) {
  listeners = []
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: (_: string, fn: Listener) => listeners.push(fn),
      removeEventListener: (_: string, fn: Listener) => {
        listeners = listeners.filter((l) => l !== fn)
      },
    })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useReducedTransparency', () => {
  it('reports false when the user has not asked to reduce transparency', () => {
    mockMatchMedia(false)
    const { result } = renderHook(() => useReducedTransparency())
    expect(result.current).toBe(false)
  })

  it('reports true when the media query matches', () => {
    mockMatchMedia(true)
    const { result } = renderHook(() => useReducedTransparency())
    expect(result.current).toBe(true)
  })

  it('reacts when the preference changes while mounted', () => {
    // Deviation from the plan: the plan's version of this test restubs
    // matchMedia mid-test, which orphans the listener the hook already
    // stored on mount (the new stub's `matches` value is never observed by
    // the mounted hook, since nothing calls the OLD listener). That made the
    // test pass without exercising the change path at all. Instead: keep one
    // stub for the whole test, capture the listener the hook registers, flip
    // `mql.matches` on that same object, and invoke the stored listener
    // directly, then assert the hook re-read `mql.matches` and re-rendered.
    let currentMatches = false
    let storedListener: Listener | undefined
    const mql = {
      get matches() {
        return currentMatches
      },
      media: '(prefers-reduced-transparency: reduce)',
      addEventListener: (_: string, fn: Listener) => {
        storedListener = fn
      },
      removeEventListener: (_: string, fn: Listener) => {
        if (storedListener === fn) storedListener = undefined
      },
    }
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation(() => mql),
    )

    const { result } = renderHook(() => useReducedTransparency())
    expect(result.current).toBe(false)

    act(() => {
      currentMatches = true
      storedListener?.()
    })

    expect(result.current).toBe(true)
  })

  it('removes its listener on unmount', () => {
    mockMatchMedia(false)
    const { unmount } = renderHook(() => useReducedTransparency())
    expect(listeners).toHaveLength(1)
    unmount()
    expect(listeners).toHaveLength(0)
  })
})

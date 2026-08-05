import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { AUTO_EXPAND_DELAY_MS, useDragAutoExpand, type DragAutoExpand } from './useDragAutoExpand'

function harness(onExpand: (path: string) => void) {
  let api!: DragAutoExpand
  function Probe() {
    api = useDragAutoExpand(onExpand)
    return null
  }
  const view = render(<Probe />)
  return { get api() { return api }, view }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('useDragAutoExpand', () => {
  it('expands a hovered folder once the delay elapses', () => {
    const onExpand = vi.fn()
    const h = harness(onExpand)
    act(() => h.api.hover('src'))
    act(() => void vi.advanceTimersByTime(AUTO_EXPAND_DELAY_MS - 1))
    expect(onExpand).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(1))
    expect(onExpand).toHaveBeenCalledWith('src')
  })

  // Repeated dragover on a stationary cursor must not keep restarting the
  // clock, or a folder hovered steadily would never open.
  it('does not restart the timer while the same folder stays hovered', () => {
    const onExpand = vi.fn()
    const h = harness(onExpand)
    act(() => h.api.hover('src'))
    act(() => void vi.advanceTimersByTime(400))
    act(() => h.api.hover('src'))
    act(() => h.api.hover('src'))
    act(() => void vi.advanceTimersByTime(200))
    expect(onExpand).toHaveBeenCalledTimes(1)
  })

  it('restarts for a different folder and only expands the last one', () => {
    const onExpand = vi.fn()
    const h = harness(onExpand)
    act(() => h.api.hover('src'))
    act(() => void vi.advanceTimersByTime(400))
    act(() => h.api.hover('docs'))
    act(() => void vi.advanceTimersByTime(AUTO_EXPAND_DELAY_MS))
    expect(onExpand).toHaveBeenCalledTimes(1)
    expect(onExpand).toHaveBeenCalledWith('docs')
  })

  it('cancels on leave', () => {
    const onExpand = vi.fn()
    const h = harness(onExpand)
    act(() => h.api.hover('src'))
    act(() => h.api.cancel())
    act(() => void vi.advanceTimersByTime(AUTO_EXPAND_DELAY_MS * 2))
    expect(onExpand).not.toHaveBeenCalled()
  })

  it('never fires after unmount', () => {
    const onExpand = vi.fn()
    const h = harness(onExpand)
    act(() => h.api.hover('src'))
    h.view.unmount()
    act(() => void vi.advanceTimersByTime(AUTO_EXPAND_DELAY_MS * 2))
    expect(onExpand).not.toHaveBeenCalled()
  })
})

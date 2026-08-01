import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ProgressLine } from '@/components/ui/progress-line'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('ProgressLine', () => {
  it('renders nothing while inactive', () => {
    render(<ProgressLine active={false} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('waits out the delay before showing', () => {
    vi.useFakeTimers()
    render(<ProgressLine active delayMs={150} />)
    expect(screen.queryByRole('progressbar')).toBeNull()

    advance(149)
    expect(screen.queryByRole('progressbar')).toBeNull()

    advance(1)
    expect(screen.getByRole('progressbar')).toBeTruthy()
  })

  it('never shows when loading finishes inside the delay window', () => {
    vi.useFakeTimers()
    const { rerender } = render(<ProgressLine active delayMs={150} />)

    advance(100)
    rerender(<ProgressLine active={false} delayMs={150} />)
    advance(500)

    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('fades out rather than unmounting instantly', () => {
    vi.useFakeTimers()
    const { rerender } = render(<ProgressLine active delayMs={150} />)
    advance(150)
    expect(screen.getByRole('progressbar')).toBeTruthy()

    rerender(<ProgressLine active={false} delayMs={150} />)
    // Still mounted, now transparent — this is the 180ms fade.
    expect(screen.getByRole('progressbar').className).toContain('opacity-0')

    advance(180)
    expect(screen.queryByRole('progressbar')).toBeNull()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ComposerBannerStack } from '@/features/agent-chat/ComposerBannerStack'
import type { ComposerBannerStackItem } from '@/features/agent-chat/ComposerBannerStack'

afterEach(() => cleanup())

function banner(id: string, overrides: Partial<ComposerBannerStackItem> = {}): ComposerBannerStackItem {
  return {
    id,
    tone: 'warning',
    icon: <span aria-hidden="true">!</span>,
    title: `${id} title`,
    ...overrides,
  }
}

describe('ComposerBannerStack', () => {
  it('renders no expanded region and no collapsed cap for a single banner', () => {
    const { container } = render(<ComposerBannerStack items={[banner('front')]} />)

    expect(container.querySelector('[data-composer-banner-stack-expanded-items]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-composer-banner-stack-cap]')).not.toBeInTheDocument()
  })

  it('keeps the front banner first in DOM order and the expanded region in layout flow, never absolute', () => {
    const { container } = render(<ComposerBannerStack items={[banner('front'), banner('stacked')]} />)

    const frontTitle = screen.getByText('front title')
    const stackedTitle = screen.getByText('stacked title')
    // DOM order is priority order (visual order is reversed by
    // `flex-col-reverse`), so the front item's node must precede the
    // stacked item's node in the tree.
    expect(frontTitle.compareDocumentPosition(stackedTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const expanded = container.querySelector('[data-composer-banner-stack-expanded-items="true"]')
    expect(expanded).not.toBeNull()
    expect(expanded?.className).toContain('grid-rows-[0fr]')
    expect(expanded?.className).toContain('group-hover/banner-stack:grid-rows-[1fr]')
    expect(expanded?.className).not.toContain('absolute')
  })

  it('renders a resting item with no starting offset, with the exit transition already attached', () => {
    const { container } = render(<ComposerBannerStack items={[banner('front')]} />)
    const wrapper = container.querySelector('[data-banner-id="front"]') as HTMLElement

    expect(wrapper.style.transform).toBe('none')
    expect(wrapper.style.opacity).toBe('1')
    expect(wrapper.style.transition).toContain('transform 220ms ease-in')
    expect(wrapper.style.transition).toContain('opacity 220ms ease-in')
  })

  it('calls onDismiss 220ms after the click, never synchronously, disabling the X in between', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(<ComposerBannerStack items={[banner('front', { onDismiss })]} />)
    const dismissButton = screen.getByRole('button', { name: 'Dismiss' })

    fireEvent.click(dismissButton)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(dismissButton).toBeDisabled()

    vi.advanceTimersByTime(219)
    expect(onDismiss).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('ignores a second click on the same X during its own exit window', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(<ComposerBannerStack items={[banner('front', { onDismiss })]} />)
    const dismissButton = screen.getByRole('button', { name: 'Dismiss' })

    fireEvent.click(dismissButton)
    fireEvent.click(dismissButton)
    vi.advanceTimersByTime(220)

    expect(onDismiss).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('becomes interactive again immediately when the parent removes the exiting item mid-exit', () => {
    vi.useFakeTimers()
    const onDismissFront = vi.fn()
    const onDismissStacked = vi.fn()
    const { rerender, container } = render(
      <ComposerBannerStack
        items={[banner('front', { onDismiss: onDismissFront }), banner('stacked', { onDismiss: onDismissStacked })]}
      />,
    )
    const frontWrapper = container.querySelector('[data-banner-id="front"]') as HTMLElement
    fireEvent.click(within(frontWrapper).getByRole('button', { name: 'Dismiss' }))

    // The underlying condition cleared on its own — the parent stops
    // rendering "front" mid-exit, independent of the dismiss animation.
    rerender(<ComposerBannerStack items={[banner('stacked', { onDismiss: onDismissStacked })]} />)

    const stackedWrapper = container.querySelector('[data-banner-id="stacked"]') as HTMLElement
    expect(stackedWrapper.className).not.toContain('pointer-events-none')

    // A fresh dismiss on the now-sole item succeeds immediately, proving
    // `exitingItemId` healed back to null instead of staying locked to the
    // id the parent already removed.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    vi.advanceTimersByTime(220)
    expect(onDismissStacked).toHaveBeenCalledTimes(1)
    expect(onDismissFront).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('does not fire the pending onDismiss or warn when unmounted mid-exit', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onDismiss = vi.fn()
    const { unmount } = render(<ComposerBannerStack items={[banner('front', { onDismiss })]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    unmount()
    vi.advanceTimersByTime(500)

    expect(onDismiss).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    vi.useRealTimers()
  })

  it('is focusable and labelled with the count once more than one banner is present, not otherwise', () => {
    const { container: twoContainer } = render(<ComposerBannerStack items={[banner('a'), banner('b')]} />)
    const twoRoot = twoContainer.firstElementChild as HTMLElement
    expect(twoRoot.tabIndex).toBe(0)
    expect(twoRoot.getAttribute('aria-label')).toMatch(/2/)
    cleanup()

    const { container: oneContainer } = render(<ComposerBannerStack items={[banner('solo')]} />)
    const oneRoot = oneContainer.firstElementChild as HTMLElement
    expect(oneRoot.tabIndex).toBe(-1)
  })

  it('gives an error-tone banner role="alert" and every other tone role="status"', () => {
    const { unmount } = render(<ComposerBannerStack items={[banner('err', { tone: 'error' })]} />)
    expect(screen.getByRole('alert')).toHaveTextContent('err title')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    unmount()

    render(<ComposerBannerStack items={[banner('warn', { tone: 'warning' })]} />)
    expect(screen.getByRole('status')).toHaveTextContent('warn title')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

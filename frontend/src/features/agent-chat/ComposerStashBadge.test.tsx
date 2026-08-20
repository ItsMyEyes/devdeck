import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ComposerStashBadge } from '@/features/agent-chat/ComposerStashBadge'

afterEach(() => cleanup())

describe('ComposerStashBadge', () => {
  it('renders nothing when count is 0', () => {
    const { container } = render(<ComposerStashBadge count={0} onClick={() => {}} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders the count when count is greater than 0', () => {
    render(<ComposerStashBadge count={3} onClick={() => {}} />)

    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('prevents default on pointerdown so opening it does not steal focus from the editor', () => {
    render(<ComposerStashBadge count={2} onClick={() => {}} />)

    const badge = screen.getByRole('button')
    const event = new Event('pointerdown', { bubbles: true, cancelable: true })
    fireEvent(badge, event)

    expect(event.defaultPrevented).toBe(true)
  })

  it('calls onClick when clicked', () => {
    const onClick = vi.fn()
    render(<ComposerStashBadge count={1} onClick={onClick} />)

    fireEvent.click(screen.getByRole('button'))

    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

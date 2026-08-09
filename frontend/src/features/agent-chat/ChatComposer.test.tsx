/**
 * t3code layout parity for the composer (plan Task 6, step 1): a circular
 * icon send button (never a labelled one), the control row on a single
 * line that structurally cannot wrap, and that same row collapsing behind
 * a "More controls" overflow menu at narrow widths instead. Enter/
 * Shift+Enter behaviour carries over unchanged from spec 1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatComposer } from '@/features/agent-chat/ChatComposer'
import type { ChatComposerProps } from '@/features/agent-chat/ChatComposer'

afterEach(() => {
  cleanup()
})

/** The pills' own behaviour is covered by ComposerControls.test.tsx; these
 *  tests only care that the row is present, unwrappable, and collapsible, so
 *  the control wiring is a static fixture. */
const controls: ChatComposerProps['controls'] = {
  model: 'claude-sonnet-5',
  onModelChange: () => {},
  effort: 'high:normal',
  onEffortChange: () => {},
  interactionMode: 'default',
  setInteractionMode: () => {},
  runtimeMode: 'full-access',
  setRuntimeMode: () => {},
  error: null,
}

describe('ChatComposer — t3code layout', () => {
  it('sends on Enter and inserts a newline on Shift+Enter', async () => {
    const onSend = vi.fn()
    render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={controls} />)

    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'add rate limiting{Shift>}{Enter}{/Shift}second line')
    expect(onSend).not.toHaveBeenCalled()

    await userEvent.type(box, '{Enter}')
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toContain('add rate limiting')
    expect(onSend.mock.calls[0][0]).toContain('second line')
  })

  it('clears the box after a send', async () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'hello{Enter}')
    expect(box).toHaveValue('')
  })

  it('does not send an empty or whitespace-only message', async () => {
    const onSend = vi.fn()
    render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={controls} />)

    await userEvent.type(screen.getByRole('textbox'), '   {Enter}')
    expect(onSend).not.toHaveBeenCalled()
  })

  // The backend decider explicitly allows a follow-up message to steer an
  // in-flight turn, so Enter must keep working while running. Only the BUTTON
  // becomes an interrupt.
  it('still steers an in-flight turn from the keyboard', async () => {
    const onSend = vi.fn()
    const onAbort = vi.fn()
    render(<ChatComposer status="running" onSend={onSend} onAbort={onAbort} controls={controls} />)

    await userEvent.type(screen.getByRole('textbox'), 'also add tests{Enter}')
    expect(onSend).toHaveBeenCalledWith('also add tests')
    expect(onAbort).not.toHaveBeenCalled()
  })

  it('turns the action button into an interrupt while running', async () => {
    const onSend = vi.fn()
    const onAbort = vi.fn()
    render(<ChatComposer status="running" onSend={onSend} onAbort={onAbort} controls={controls} />)

    await userEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps the status strip below the input', () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} worktree="auth" branch="feat/auth" />)

    expect(screen.getByText('auth')).toBeInTheDocument()
    expect(screen.getByText('feat/auth')).toBeInTheDocument()
  })

  it('renders the control row on one line that cannot wrap', () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    const row = screen.getByTestId('composer-controls-inline')
    expect(row.className).toContain('flex-nowrap')
    expect(row.className).not.toContain(' flex-wrap')
    for (const label of ['Sonnet 5', 'High · Normal', 'Build', 'Full access']) {
      expect(screen.getAllByRole('button', { name: label }).length).toBeGreaterThanOrEqual(1)
    }
  })

  it('collapses the control row into a "More controls" menu instead of wrapping', async () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    expect(screen.getAllByRole('button', { name: 'Sonnet 5' })).toHaveLength(1)

    const overflow = screen.getByRole('button', { name: 'More controls' })
    await userEvent.click(overflow)

    // The overflow popup mounts a second copy of the same pills — the
    // structural escape hatch that makes wrapping impossible instead of
    // merely unlikely (design spec: "structurally impossible, not merely
    // unlikely").
    expect(await screen.findAllByRole('button', { name: 'Sonnet 5' })).toHaveLength(2)
    for (const label of ['High · Normal', 'Build', 'Full access']) {
      expect(screen.getAllByRole('button', { name: label }).length).toBeGreaterThanOrEqual(2)
    }
  })

  it('renders the status strip below the composer', () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} worktree="devdeck" branch="main" />)

    expect(screen.getByText('devdeck')).toBeInTheDocument()
    expect(screen.getByText('main')).toBeInTheDocument()
  })
})

// Regression: the plan split the control row across two tasks — one owned
// ChatComposer.tsx, the other owned ComposerControls.tsx — with no seam
// between them, so the real dispatching component was built, unit-tested,
// and never mounted. The composer shipped rendering disabled placeholder
// pills: exactly the "controls silently lie about what the agent is doing"
// defect the whole spec exists to remove. Every other test passed.
describe('ChatComposer mounts the real controls', () => {
  it('dispatches through the wired control, not a placeholder', async () => {
    const setRuntimeMode = vi.fn()
    render(
      <ChatComposer
        status="idle"
        onSend={vi.fn()}
        onAbort={vi.fn()}
        controls={{ ...controls, setRuntimeMode }}
      />,
    )

    // The placeholder row rendered every pill `disabled`. A live pill is the
    // difference between the wired component and the dead one.
    const pill = screen.getAllByRole('button', { name: 'Full access' })[0]
    expect(pill).not.toBeDisabled()

    await userEvent.click(pill)
    await userEvent.click(await screen.findByRole('button', { name: 'Auto-accept edits' }))

    expect(setRuntimeMode).toHaveBeenCalledWith('auto-accept-edits')
  })
})

/**
 * Plan Task 7, step 1: each pill dispatches its real command with the right
 * payload, and a command the decider rejects reverts the pill to the
 * thread's actual mode instead of continuing to show a value the agent
 * isn't in (design spec's error-handling table: "Mode command rejected by
 * the decider -> Pill reverts to the thread's actual mode").
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComposerControls } from '@/features/agent-chat/ComposerControls'
import type { ComposerControlsProps } from '@/features/agent-chat/ComposerControls'

afterEach(() => {
  cleanup()
})

function baseProps(overrides: Partial<ComposerControlsProps> = {}): ComposerControlsProps {
  return {
    model: 'claude-sonnet-5',
    onModelChange: vi.fn(),
    effort: 'high:normal',
    onEffortChange: vi.fn(),
    interactionMode: 'default',
    setInteractionMode: vi.fn(),
    runtimeMode: 'full-access',
    setRuntimeMode: vi.fn(),
    error: null,
    ...overrides,
  }
}

describe('ComposerControls — wired to real commands', () => {
  it('renders the four pills with their current labels', () => {
    render(<ComposerControls {...baseProps()} />)
    expect(screen.getByRole('button', { name: 'Sonnet 5' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'High · Normal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Build' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Full access' })).toBeInTheDocument()
  })

  it('dispatches thread.interaction-mode.set with the picked mode', async () => {
    const setInteractionMode = vi.fn()
    render(<ComposerControls {...baseProps({ setInteractionMode })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Build' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Plan' }))

    expect(setInteractionMode).toHaveBeenCalledTimes(1)
    expect(setInteractionMode).toHaveBeenCalledWith('plan')
  })

  it('dispatches thread.runtime-mode.set with the picked mode', async () => {
    const setRuntimeMode = vi.fn()
    render(<ComposerControls {...baseProps({ setRuntimeMode })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Full access' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Approval required' }))

    expect(setRuntimeMode).toHaveBeenCalledTimes(1)
    expect(setRuntimeMode).toHaveBeenCalledWith('approval-required')
  })

  it('updates model and effort locally, without dispatching a socket command', async () => {
    const onModelChange = vi.fn()
    const onEffortChange = vi.fn()
    render(<ComposerControls {...baseProps({ onModelChange, onEffortChange })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Sonnet 5' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Opus 4.8' }))
    expect(onModelChange).toHaveBeenCalledWith('claude-opus-4-8')

    await userEvent.click(screen.getByRole('button', { name: 'High · Normal' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Low · Normal' }))
    expect(onEffortChange).toHaveBeenCalledWith('low:normal')
  })

  it('shows the picked runtime mode optimistically before the engine confirms it', async () => {
    render(<ComposerControls {...baseProps()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Full access' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Approval required' }))

    expect(screen.getByRole('button', { name: 'Approval required' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Full access' })).not.toBeInTheDocument()
  })

  it("reverts the runtime-mode pill to the thread's actual mode when the command is rejected", async () => {
    const setRuntimeMode = vi.fn()
    const props = baseProps({ setRuntimeMode })
    const { rerender } = render(<ComposerControls {...props} />)

    await userEvent.click(screen.getByRole('button', { name: 'Full access' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Approval required' }))
    expect(screen.getByRole('button', { name: 'Approval required' })).toBeInTheDocument()

    // The decider rejected the command — the socket surfaces a fresh error.
    // runtimeMode itself never changed (the parent never applied the
    // optimistic value), so reverting means falling back to it.
    rerender(<ComposerControls {...props} error="thread w-abc: runtime mode rejected" />)

    expect(screen.getByRole('button', { name: 'Full access' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approval required' })).not.toBeInTheDocument()
  })

  it("reverts the interaction-mode pill to the thread's actual mode when the command is rejected", async () => {
    const setInteractionMode = vi.fn()
    const props = baseProps({ setInteractionMode })
    const { rerender } = render(<ComposerControls {...props} />)

    await userEvent.click(screen.getByRole('button', { name: 'Build' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Plan' }))
    expect(screen.getByRole('button', { name: 'Plan' })).toBeInTheDocument()

    rerender(<ComposerControls {...props} error="thread w-abc: interaction mode rejected" />)

    expect(screen.getByRole('button', { name: 'Build' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Plan' })).not.toBeInTheDocument()
  })

  it('does not revert a pill that has no change pending when an unrelated error arrives', () => {
    const { rerender } = render(<ComposerControls {...baseProps()} />)
    rerender(<ComposerControls {...baseProps()} error="some other error" />)

    expect(screen.getByRole('button', { name: 'Full access' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Build' })).toBeInTheDocument()
  })
})

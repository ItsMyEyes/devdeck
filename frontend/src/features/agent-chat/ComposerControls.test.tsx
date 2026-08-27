/**
 * Plan Task 7, step 1: each pill dispatches its real command with the right
 * payload, and a command the decider rejects reverts the pill to the
 * thread's actual mode instead of continuing to show a value the agent
 * isn't in (design spec's error-handling table: "Mode command rejected by
 * the decider -> Pill reverts to the thread's actual mode"). The
 * interaction-mode (Build/Plan) pill has since been removed from the row;
 * the `/plan` and `/build` slash commands (`composerSlashTrigger.ts`) are
 * how the mode is switched now.
 *
 * The permission picker's rows now carry a description alongside their
 * label (`PermissionPicker`), so a row's accessible NAME is the label and
 * description concatenated — tests below match those rows with a regex
 * anchored on the label rather than an exact string. The picker's TRIGGER
 * button (closed state, before a row exists to click) is unaffected and
 * still matches its label exactly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
vi.mock('@/features/data/queries', () => ({
  useAgents: () => ({ data: [{ id: 'claude', name: 'Claude', installed: true }], isLoading: false, error: null }),
  useAgentModels: () => ({
    data: [
      { id: 'claude-sonnet-5', name: 'Sonnet 5', contextWindow: 200000 },
      { id: 'claude-opus-5', name: 'Opus 5', contextWindow: 1000000 },
    ],
    isLoading: false,
    error: null,
  }),
}))

import { ComposerControls } from '@/features/agent-chat/ComposerControls'
import type { ComposerControlsProps } from '@/features/agent-chat/ComposerControls'

afterEach(() => {
  cleanup()
})

function baseProps(overrides: Partial<ComposerControlsProps> = {}): ComposerControlsProps {
  return {
    model: { agentId: 'claude', modelId: 'claude-sonnet-5', modelName: 'Sonnet 5' },
    onModelChange: vi.fn(),
    machine: { id: 'm1', name: 'dev', url: '', key: '', isLocal: false, signingPublicKey: '' },
    worktreeAgentId: 'claude',
    effort: 'high',
    onEffortChange: vi.fn(),
    contextWindow: '200k',
    onContextWindowChange: vi.fn(),
    contextTokens: 0,
    interactionMode: 'default',
    setInteractionMode: vi.fn(),
    runtimeMode: 'full-access',
    setRuntimeMode: vi.fn(),
    error: null,
    ...overrides,
  }
}

describe('ComposerControls — wired to real commands', () => {
  it('renders every control with its current label', () => {
    render(<ComposerControls {...baseProps()} />)
    expect(screen.getByRole('button', { name: 'Sonnet 5' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'High · 200k' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Full access' })).toBeInTheDocument()
    // The context-window ring carries no visible text in the inline row — its
    // accessible name is the usage summary.
    expect(screen.getByRole('button', { name: /Context window: 0\.0% used/ })).toBeInTheDocument()
  })

  // The Build/Plan pill was removed from the row: interaction mode is still
  // thread state and still switchable (`/plan` and `/build` in the editor),
  // but it no longer spends width here. The prop stays on the interface for
  // `ChatComposer`'s plan follow-up, so this pins that the ROW ignores it.
  it('renders no Build/Plan pill, whichever interaction mode the thread is in', () => {
    const { rerender } = render(<ComposerControls {...baseProps({ interactionMode: 'default' })} />)
    expect(screen.queryByRole('button', { name: 'Build' })).not.toBeInTheDocument()
    rerender(<ComposerControls {...baseProps({ interactionMode: 'plan' })} />)
    expect(screen.queryByRole('button', { name: 'Plan' })).not.toBeInTheDocument()
  })

  it('dispatches thread.runtime-mode.set with the picked mode', async () => {
    const setRuntimeMode = vi.fn()
    render(<ComposerControls {...baseProps({ setRuntimeMode })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Full access' }))
    await userEvent.click(await screen.findByRole('button', { name: /^Approval required/ }))

    expect(setRuntimeMode).toHaveBeenCalledTimes(1)
    expect(setRuntimeMode).toHaveBeenCalledWith('approval-required')
  })

  // Every permission row shows what it actually does, not just its name —
  // the restyle this test guards against regressing back to a flat list.
  it('shows an icon and a description on every permission row', async () => {
    render(<ComposerControls {...baseProps()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Full access' }))

    expect(await screen.findByText('Ask before commands and file changes.')).toBeInTheDocument()
    expect(screen.getByText('Auto-approve edits, ask before other actions.')).toBeInTheDocument()
    expect(screen.getByText('Supported providers approve routine actions; others still ask.')).toBeInTheDocument()
    expect(screen.getByText('Allow commands and edits without prompts.')).toBeInTheDocument()
  })

  it('updates effort locally, without dispatching a socket command', async () => {
    const onEffortChange = vi.fn()
    render(<ComposerControls {...baseProps({ onEffortChange })} />)

    await userEvent.click(screen.getByRole('button', { name: 'High · 200k' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Low' }))
    expect(onEffortChange).toHaveBeenCalledWith('low')
  })

  // The picker's whole reason for existing: Reasoning and Context Window in
  // one popover, with the trigger reading "level · window".
  it('updates the context window from the same popover as effort', async () => {
    const onContextWindowChange = vi.fn()
    render(<ComposerControls {...baseProps({ onContextWindowChange })} />)

    await userEvent.click(screen.getByRole('button', { name: 'High · 200k' }))
    await userEvent.click(await screen.findByRole('button', { name: '1M' }))
    expect(onContextWindowChange).toHaveBeenCalledWith('1M')
  })

  it('clamps a custom context window to the range --autocompact accepts', async () => {
    const onContextWindowChange = vi.fn()
    render(<ComposerControls {...baseProps({ onContextWindowChange })} />)

    await userEvent.click(screen.getByRole('button', { name: 'High · 200k' }))
    const customField = await screen.findByLabelText('Custom context window, in thousands of tokens')
    await userEvent.clear(customField)
    await userEvent.type(customField, '2500')
    await userEvent.tab()

    // 2500k is above the CLI's 1M ceiling — buildArgs sends this straight to
    // --autocompact, which HARD-FAILS the session outside 100k-1M, so this
    // must never leave the client uncapped.
    expect(onContextWindowChange).toHaveBeenCalledWith('1000k')
  })

  it('offers ultrathink as its own reasoning row', async () => {
    // It rides `--effort max` once a turn is actually sent (no CLI flag of
    // its own — see AgentChatPane.test.tsx's coverage of `turnModel`); this
    // only guards that the row is reachable and reports the pick verbatim,
    // the way every other reasoning row does.
    const onEffortChange = vi.fn()
    render(<ComposerControls {...baseProps({ onEffortChange })} />)

    await userEvent.click(screen.getByRole('button', { name: 'High · 200k' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Ultrathink' }))
    expect(onEffortChange).toHaveBeenCalledWith('ultrathink')
  })

  // The model pill used to be a ghost pill over four hardcoded ids that never
  // reached the backend. It is now the real picker over the machine's catalog,
  // and it reports the agent alongside the model — running a model IS running
  // its agent.
  it('picks a model from the machine catalog, carrying its agent', async () => {
    const onModelChange = vi.fn()
    render(<ComposerControls {...baseProps({ onModelChange })} />)

    await userEvent.click(screen.getByRole('button', { name: /Sonnet 5/ }))
    await userEvent.click(await screen.findByRole('button', { name: /^Opus 5/ }))

    expect(onModelChange).toHaveBeenCalledWith({
      agentId: 'claude',
      modelId: 'claude-opus-5',
      modelName: 'Opus 5',
    })
  })

  it('shows the picked runtime mode optimistically before the engine confirms it', async () => {
    render(<ComposerControls {...baseProps()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Full access' }))
    await userEvent.click(await screen.findByRole('button', { name: /^Approval required/ }))

    expect(screen.getByRole('button', { name: 'Approval required' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Full access' })).not.toBeInTheDocument()
  })

  it("reverts the runtime-mode pill to the thread's actual mode when the command is rejected", async () => {
    const setRuntimeMode = vi.fn()
    const props = baseProps({ setRuntimeMode })
    const { rerender } = render(<ComposerControls {...props} />)

    await userEvent.click(screen.getByRole('button', { name: 'Full access' }))
    await userEvent.click(await screen.findByRole('button', { name: /^Approval required/ }))
    expect(screen.getByRole('button', { name: 'Approval required' })).toBeInTheDocument()

    // The decider rejected the command — the socket surfaces a fresh error.
    // runtimeMode itself never changed (the parent never applied the
    // optimistic value), so reverting means falling back to it.
    rerender(<ComposerControls {...props} error="thread w-abc: runtime mode rejected" />)

    expect(screen.getByRole('button', { name: 'Full access' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approval required' })).not.toBeInTheDocument()
  })

  it('does not revert a pill that has no change pending when an unrelated error arrives', () => {
    const { rerender } = render(<ComposerControls {...baseProps()} />)
    rerender(<ComposerControls {...baseProps()} error="some other error" />)

    expect(screen.getByRole('button', { name: 'Full access' })).toBeInTheDocument()
  })

  // The optimistic pick must SETTLE, not stick. `runtimeMode` is the thread's
  // actual mode off the event log; the engine echoes an accepted command
  // back as a `thread.runtime-mode-set`, so `runtimeMode` catches up with the
  // pick — and from then on the pill has to follow the thread, or a change
  // made anywhere else (another pane, the approval card's mode buttons,
  // Telegram) would stay hidden behind a pick confirmed long ago.
  it('settles the optimistic pick once the thread confirms it, then tracks later changes from elsewhere', async () => {
    const props = baseProps({ runtimeMode: 'full-access' })
    const { rerender } = render(<ComposerControls {...props} />)

    await userEvent.click(screen.getByRole('button', { name: 'Full access' }))
    await userEvent.click(await screen.findByRole('button', { name: /^Approval required/ }))
    expect(screen.getByRole('button', { name: 'Approval required' })).toBeInTheDocument()

    // The engine's echo lands: the thread really is in approval-required now.
    rerender(<ComposerControls {...baseProps({ runtimeMode: 'approval-required' })} />)
    expect(screen.getByRole('button', { name: 'Approval required' })).toBeInTheDocument()

    // Someone else moves the thread to Auto. No pick is pending here, so the
    // pill must show the thread's mode, not the one this pane last chose.
    rerender(<ComposerControls {...baseProps({ runtimeMode: 'auto' })} />)
    expect(screen.getByRole('button', { name: 'Auto' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approval required' })).not.toBeInTheDocument()
  })
})

describe('ComposerControls — context window usage indicator', () => {
  it('reports the real percentage against the selected window', async () => {
    // 47_000 / 200_000 = 23.5%, which Math.round takes to 24 — the indicator
    // rounds to a whole percent once it clears single digits (see
    // ContextWindowIndicator's percentLabel, and the 1M case below for the
    // single-digit branch that keeps one decimal instead).
    render(<ComposerControls {...baseProps({ contextTokens: 47_000, contextWindow: '200k' })} />)

    await userEvent.click(screen.getByRole('button', { name: /Context window: 24% used/ }))
    expect(await screen.findByText('24% · 47k/200k')).toBeInTheDocument()
    expect(screen.getByText('Total processed')).toBeInTheDocument()
    expect(screen.getByText('47k')).toBeInTheDocument()
    expect(screen.getByText(/automatically compacts/)).toBeInTheDocument()
  })

  it('divides by the 1M preset once that is what is selected', async () => {
    render(<ComposerControls {...baseProps({ contextTokens: 47_000, contextWindow: '1M' })} />)
    expect(screen.getByRole('button', { name: /4\.7% used, 47k of 1M tokens/ })).toBeInTheDocument()
  })
})

// Regression, from a screenshot at a real chat-pane width: the row is
// `flex-nowrap overflow-hidden`, and every pill was `flex-none`. A long model
// id (`ollama/deepseek-v4-flash:cloud`) therefore did not truncate — it clipped
// its neighbours, cutting the effort pill mid-character ("High · 200(") and
// pushing both mode pills out of the row entirely.
//
// Exactly one pill may absorb that overflow, and it has to be the model one:
// it is the only pill whose width varies with the data.
describe('ComposerControls — the row absorbs a long model name', () => {
  function pillWrappers(container: HTMLElement): HTMLElement[] {
    // Each pill sits in its own wrapper span; the model pill is the first.
    return Array.from(container.querySelectorAll<HTMLElement>(':scope > span'))
  }

  it('lets the model pill shrink and keeps every other pill intact', () => {
    const { container } = render(
      <ComposerControls
        {...baseProps({ model: { agentId: 'claude', modelId: 'ollama/deepseek-v4-flash:cloud', modelName: 'ollama/deepseek-v4-flash:cloud' } })}
        variant="inline"
      />,
    )

    const wrappers = pillWrappers(container)
    expect(wrappers.length).toBeGreaterThan(1)

    const [modelWrap, ...rest] = wrappers
    expect(modelWrap.className).toContain('shrink')
    expect(modelWrap.className).not.toContain('flex-none')

    // Everything after it must refuse to shrink, or the clipping just moves.
    for (const wrap of rest) {
      expect(wrap.className).toContain('flex-none')
    }
  })

  it('truncates the model label instead of letting it set the pill width', () => {
    const { container } = render(
      <ComposerControls
        {...baseProps({ model: { agentId: 'claude', modelId: 'ollama/deepseek-v4-flash:cloud', modelName: 'ollama/deepseek-v4-flash:cloud' } })}
        variant="inline"
      />,
    )

    // The innermost span — `textContent` also matches every ancestor.
    const label = Array.from(container.querySelectorAll('span')).find(
      (el) => el.textContent === 'deepseek-v4-flash:cloud' && el.childElementCount === 0,
    )
    expect(label, 'the provider prefix should be dropped from the pill').toBeTruthy()
    expect(label!.className).toContain('truncate')
    expect(label!.className).toContain('min-w-0')
  })
})

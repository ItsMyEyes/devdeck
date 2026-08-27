/**
 * t3code layout parity for the composer (plan Task 6, step 1): a circular
 * icon send button (never a labelled one), the control row on a single
 * line that structurally cannot wrap, and that same row collapsing behind
 * a "More controls" overflow menu at narrow widths instead. Enter/
 * Shift+Enter behaviour carries over unchanged from spec 1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
// The model pill is now a real picker over the machine's agent/model catalog,
// so the composer transitively needs react-query. These tests are about the
// composer's own behaviour, not the catalog — stub it, as
// ComposerControls.test.tsx does.
vi.mock('@/features/data/queries', () => ({
  useAgents: () => ({ data: [{ id: 'claude', name: 'Claude', installed: true }], isLoading: false, error: null }),
  useAgentModels: () => ({ data: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', contextWindow: 200000 }], isLoading: false, error: null }),
  useAgentSkills: vi.fn(() => ({ data: [], isLoading: false, error: null })),
}))

// T11 (composer-context-attachments, C2): only `uploadAgentAttachment` is
// stubbed — every other export (including `searchWorktreeFiles`, which
// `ComposerPromptEditor`'s `@` mention feature reaches, unmocked, the same
// way this file already left it before this task) keeps its real
// implementation, matching `ComposerPromptEditor.test.tsx`'s narrower
// `vi.mock` precedent for the same module.
const uploadAgentAttachmentMock = vi.fn()
vi.mock('@/lib/machineApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/machineApi')>()
  return { ...actual, uploadAgentAttachment: (...args: unknown[]) => uploadAgentAttachmentMock(...args) }
})

// jsdom has no `createImageBitmap` — the real downscale ladder is T9's to
// test; this file only needs the identity pass-through.
vi.mock('@/features/agent-chat/imageCompression', () => ({
  downscaleImage: async (file: File) => file,
}))

import { useAgentSkills } from '@/features/data/queries'
import { ChatComposer, insertTerminalContext } from '@/features/agent-chat/ChatComposer'
import type { ChatComposerProps } from '@/features/agent-chat/ChatComposer'
import { composerTerminalContextChip, serializeComposerDoc } from '@/features/agent-chat/composerSerialize'
import { buildPlanImplementationPrompt } from '@/features/agent-chat/planMarkdown'
import { STASH_STORAGE_KEY } from '@/features/agent-chat/promptStash'
import { buildTerminalContextBlock } from '@/features/agent-chat/terminalContext'
import type { ChatItem } from '@/features/agent-chat/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const useAgentSkillsMock = vi.mocked(useAgentSkills)

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  // The store is real in this file (no `vi.mock` of it anywhere) — drafts
  // and the stash both ride shared/global state, so a leftover entry from
  // one test would otherwise leak into the next (plan T9).
  useDevDeckStore.setState({ composerDrafts: {}, promptStash: [] })
  localStorage.removeItem(STASH_STORAGE_KEY)
})

/** The pills' own behaviour is covered by ComposerControls.test.tsx; these
 *  tests only care that the row is present, unwrappable, and collapsible, so
 *  the control wiring is a static fixture. */
const controls: ChatComposerProps['controls'] = {
  model: { agentId: 'claude', modelId: 'claude-sonnet-5', modelName: 'Sonnet 5' },
  onModelChange: () => {},
  machine: { id: 'm1', name: 'dev', url: '', key: '', isLocal: false, signingPublicKey: '' },
  worktreeAgentId: 'claude',
  effort: 'high',
  onEffortChange: () => {},
  contextWindow: '200k',
  onContextWindowChange: () => {},
  contextTokens: 0,
  interactionMode: 'default',
  setInteractionMode: () => {},
  runtimeMode: 'full-access',
  setRuntimeMode: () => {},
  error: null,
}

/**
 * The input is a ProseMirror `contenteditable`, not a `<textarea>`, and
 * `userEvent.type` cannot drive one in jsdom: it simulates typing by reading
 * the node and writing the next character back, while ProseMirror rebuilds
 * that same DOM on every transaction and React re-renders around it. The
 * reference it captured goes stale mid-word and characters are silently
 * dropped — `'add rate limiting'` arrives as `'ad rt iiig'`, and the more work
 * a keystroke triggers, the more it loses.
 *
 * `paste` and `keyDown` are the two paths ProseMirror handles explicitly
 * (`editHandlers.paste` reads `clipboardData` synchronously and dispatches a
 * transaction; `prosemirror-keymap` binds a real `keydown` listener on
 * `view.dom`), so both survive re-renders. Verified against this repo's
 * actual @tiptap/prosemirror-view versions — the controlled round-trip through
 * these helpers delivers text intact, including `Shift+Enter` newlines.
 * `ComposerPromptEditor.test.tsx` documents the same two techniques.
 */
function type(box: HTMLElement, text: string) {
  fireEvent.paste(box, { clipboardData: { getData: () => text } })
}

function pressEnter(box: HTMLElement, options: { shift?: boolean } = {}) {
  fireEvent.keyDown(box, { key: 'Enter', shiftKey: options.shift === true })
}

describe('ChatComposer — t3code layout', () => {
  it('sends on Enter and inserts a newline on Shift+Enter', async () => {
    const onSend = vi.fn()
    render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={controls} />)

    const box = screen.getByRole('textbox')
    type(box, 'add rate limiting')
    pressEnter(box, { shift: true })
    type(box, 'second line')
    expect(onSend).not.toHaveBeenCalled()

    pressEnter(box)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toContain('add rate limiting')
    expect(onSend.mock.calls[0][0]).toContain('second line')
    // Shift+Enter must produce a real line break, not merely "not send".
    expect(onSend.mock.calls[0][0]).toBe('add rate limiting\nsecond line')
    // onSend's arity widened to (text, attachments) — nothing was attached,
    // so the second argument is an empty array, never omitted.
    expect(onSend.mock.calls[0][1]).toEqual([])
  })

  it('clears the box after a send', async () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    const box = screen.getByRole('textbox')
    type(box, 'hello')
    expect(box).toHaveTextContent('hello')

    pressEnter(box)
    // `toHaveValue` does not apply to a contenteditable — it has no `value`
    // property at all, so it reads `undefined` and would pass against a box
    // that never cleared. Assert the text the user can actually still see.
    expect(box.textContent).toBe('')
  })

  it('does not send an empty or whitespace-only message', async () => {
    const onSend = vi.fn()
    render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={controls} />)

    const box = screen.getByRole('textbox')
    type(box, '   ')
    pressEnter(box)
    expect(onSend).not.toHaveBeenCalled()
  })

  // The backend decider explicitly allows a follow-up message to steer an
  // in-flight turn, so Enter must keep working while running. Only the BUTTON
  // becomes an interrupt.
  it('still steers an in-flight turn from the keyboard', async () => {
    const onSend = vi.fn()
    const onAbort = vi.fn()
    render(<ChatComposer status="running" onSend={onSend} onAbort={onAbort} controls={controls} />)

    const box = screen.getByRole('textbox')
    type(box, 'also add tests')
    pressEnter(box)
    expect(onSend).toHaveBeenCalledWith('also add tests', [])
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

  // Regression: the single vendored action button became a Stop for BOTH
  // generating states, so in `waiting` — the one state where the agent is
  // asking the user for something — clicking it destroyed the turn instead of
  // sending. Submit must stay reachable, with the interrupt beside it.
  it('sends from the action button while the agent waits on the user', async () => {
    const onSend = vi.fn()
    const onAbort = vi.fn()
    render(<ChatComposer status="waiting" onSend={onSend} onAbort={onAbort} controls={controls} />)

    type(screen.getByRole('textbox'), 'use the second option')
    await userEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(onSend).toHaveBeenCalledWith('use the second option', [])
    expect(onAbort).not.toHaveBeenCalled()
  })

  it('steers an in-flight turn from the action button too, not only from Enter', async () => {
    const onSend = vi.fn()
    const onAbort = vi.fn()
    render(<ChatComposer status="running" onSend={onSend} onAbort={onAbort} controls={controls} />)

    type(screen.getByRole('textbox'), 'also add tests')
    await userEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(onSend).toHaveBeenCalledWith('also add tests', [])
    expect(onAbort).not.toHaveBeenCalled()
  })

  it('keeps the interrupt reachable while the agent waits on the user', async () => {
    const onAbort = vi.fn()
    render(<ChatComposer status="waiting" onSend={vi.fn()} onAbort={onAbort} controls={controls} />)

    await userEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(onAbort).toHaveBeenCalledTimes(1)
  })

  // ── One button ──
  // Two live circular buttons 8px apart, one red one teal, was a coin flip at
  // a glance. The draft decides which one it is.
  it('shows exactly one action button in every state', () => {
    for (const status of ['idle', 'running', 'waiting', 'stopped'] as const) {
      const { unmount } = render(<ChatComposer status={status} onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)
      const actions = screen.queryAllByRole('button', { name: /stop|submit/i })
      expect(actions, `status=${status}`).toHaveLength(1)
      unmount()
    }
  })

  it('is a Stop while the agent runs and the box is empty', () => {
    render(<ChatComposer status="running" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull()
  })

  // Typing turns the interrupt back into a send, which is what keeps steering
  // an in-flight turn (and answering a `waiting` prompt) reachable at all.
  it('becomes a Send as soon as something is typed, mid-turn', async () => {
    const onSend = vi.fn()
    const onAbort = vi.fn()
    render(<ChatComposer status="running" onSend={onSend} onAbort={onAbort} controls={controls} />)

    type(screen.getByRole('textbox'), 'also add tests')

    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /submit/i }))
    expect(onSend).toHaveBeenCalledWith('also add tests', [])
    expect(onAbort).not.toHaveBeenCalled()
  })

  // ...and clearing it back to empty hands the interrupt back.
  it('returns to Stop when the draft is cleared again', async () => {
    render(<ChatComposer status="running" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    const box = screen.getByRole('textbox')
    type(box, 'x')
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull()

    // `clear` selects the whole editable and deletes — a selection path
    // ProseMirror handles, unlike per-character typing.
    await userEvent.clear(box)
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument()
  })

  // Whitespace is not a draft — it cannot send, so it must not steal the
  // interrupt either.
  it('treats a whitespace-only draft as empty', async () => {
    render(<ChatComposer status="running" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    type(screen.getByRole('textbox'), '   ')
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument()
  })

  it('offers no interrupt while the thread is idle', () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument()
  })

  // Regression, restated for the ported shell. Originally: `PromptInput`
  // hardcoded its `InputGroup`'s className, so our border/bg landed on the
  // <form> and the vendored box painted a SECOND, hard 3:1 grey border plus a
  // `bg-input/30` wash inside it. That box no longer exists — the shell owns
  // its own DOM (design spec §1) — so the old assertions checked for the very
  // element the port removes.
  //
  // The invariant they protected has not changed and is what this asserts now:
  // exactly ONE element paints the composer box, and the <form> is not it.
  it('paints one composer box, and the vendored input-group is gone', () => {
    const { container } = render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    const form = container.querySelector('form')
    expect(form).not.toBeNull()

    // The vendored box is what the port deleted. Its return would mean the
    // descendant-selector fight (and the double border) came back with it.
    expect(container.querySelector('[data-slot="input-group"]')).toBeNull()

    // The form still paints no box of its own.
    expect(form?.className).not.toMatch(/(^|\s)border(\s|$)/)
    expect(form?.className).not.toMatch(/(^|\s)bg-devdeck-raised/)

    // …and exactly one descendant does, with both halves on the same element
    // — a border on one node and the fill on another is how two boxes start.
    const painted = Array.from(container.querySelectorAll('div')).filter(
      (el) =>
        el.className.includes('border-devdeck-hairline') && el.className.includes('bg-devdeck-raised'),
    )
    expect(painted).toHaveLength(1)

    // The panel slot A mounts into must survive, directly inside that box.
    const panels = container.querySelector('[data-slot="composer-panels"]')
    expect(panels).not.toBeNull()
    expect(painted[0].contains(panels)).toBe(true)
  })

  // Was "keeps the status strip below the input". The strip is gone: it
  // restated the pane header and the tab, on the line closest to the box the
  // user types into. The guard is inverted rather than deleted so nothing
  // quietly reintroduces a worktree/branch line under the composer.
  it('renders nothing below the input', () => {
    const { container } = render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    const form = container.querySelector('form')
    expect(form).not.toBeNull()
    expect(form!.nextElementSibling).toBeNull()
  })

  it('renders the control row on one line that cannot wrap', () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    const row = screen.getByTestId('composer-controls-inline')
    expect(row.className).toContain('flex-nowrap')
    expect(row.className).not.toContain(' flex-wrap')
    for (const label of ['Sonnet 5', 'High · 200k', 'Full access']) {
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
    for (const label of ['High · 200k', 'Full access']) {
      expect(screen.getAllByRole('button', { name: label }).length).toBeGreaterThanOrEqual(2)
    }
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
    await userEvent.click(await screen.findByRole('button', { name: /^Auto-accept edits/ }))

    expect(setRuntimeMode).toHaveBeenCalledWith('auto-accept-edits')
  })
})

// T9: the composer's `data-slot="composer-panels"` slot, built empty by the
// shell spec, is where `ComposerPendingUserInputPanel` actually mounts.
describe('ChatComposer — pending user-input panel', () => {
  // `id` is the full question text, not a synthetic `q1` — per the plan's
  // Global Constraints, T1 normalizes the answer id to the question text
  // (or `q-<idx>` for an empty one) once, in Go, before this ever reaches the
  // client. `buildPendingUserInputAnswers` (T4) keys its result by `id`, so a
  // fixture using a placeholder id here would desync from the assertion below
  // in a way no real payload ever would.
  const onePendingQuestion: ChatComposerProps['pendingUserInputs'] = [
    {
      requestId: 'req-1',
      createdAt: 1,
      questions: [
        {
          id: 'Tabs or spaces?',
          header: 'Style',
          question: 'Tabs or spaces?',
          multiSelect: false,
          options: [
            { label: 'Tabs', description: '' },
            { label: 'Spaces', description: '' },
          ],
        },
      ],
    },
  ]

  it('renders the pending user-input panel above the editor and submits on advance', () => {
    const onRespondToUserInput = vi.fn()
    // Fake timers must be in place before the click: the panel's auto-advance
    // is a real `window.setTimeout(…, 200)` (ComposerPendingUserInputPanel),
    // so the clock has to be fake at the moment it's scheduled, not only when
    // it's advanced afterward — a real timer already in flight ignores a
    // later-installed fake clock. Same ordering ComposerPendingUserInputPanel.test.tsx
    // already uses for its own auto-advance assertion.
    vi.useFakeTimers()
    render(
      <ChatComposer
        status="waiting"
        onSend={vi.fn()}
        onAbort={vi.fn()}
        controls={controls}
        pendingUserInputs={onePendingQuestion}
        onRespondToUserInput={onRespondToUserInput}
      />,
    )
    fireEvent.click(screen.getByText('Tabs'))
    // Single-select auto-advances; this prompt has one question, so advancing
    // past it submits immediately.
    vi.advanceTimersByTime(200)
    expect(onRespondToUserInput).toHaveBeenCalledWith('req-1', { 'Tabs or spaces?': 'Tabs' })
  })

  it('renders nothing extra when there are no pending user-input requests', () => {
    render(
      <ChatComposer
        status="idle"
        onSend={vi.fn()}
        onAbort={vi.fn()}
        controls={controls}
        pendingUserInputs={[]}
        onRespondToUserInput={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /Tabs/ })).not.toBeInTheDocument()
  })
})

// T18: the approval panel (deliverable A2) joins the pending user-input panel
// in the same composer-panels slot. Precedence rule (decided in T18, not
// specified verbatim upstream): the user-input panel wins whenever both are
// simultaneously pending — a question is rarer and typically gates what the
// agent does next, and an approval can wait one extra render.
describe('ChatComposer — pending approval panel', () => {
  const onePendingApproval: ChatComposerProps['pendingApprovals'] = [
    {
      requestId: 'req-2',
      createdAt: 1,
      requestType: 'command_execution_approval',
      detail: 'rm -rf /tmp/x',
      options: ['accept', 'decline', 'cancel'],
    },
  ]

  it('renders the approval panel and forwards a decision', () => {
    const onRespondToApproval = vi.fn()
    render(
      <ChatComposer
        status="waiting"
        onSend={vi.fn()}
        onAbort={vi.fn()}
        controls={controls}
        pendingUserInputs={[]}
        onRespondToUserInput={vi.fn()}
        pendingApprovals={onePendingApproval}
        onRespondToApproval={onRespondToApproval}
      />,
    )
    fireEvent.click(screen.getByText('Approve once'))
    expect(onRespondToApproval).toHaveBeenCalledWith('req-2', 'accept')
  })

  it('the user-input panel takes precedence when both are pending', () => {
    const onePendingQuestion: ChatComposerProps['pendingUserInputs'] = [
      {
        requestId: 'req-1',
        createdAt: 1,
        questions: [
          {
            id: 'Tabs or spaces?',
            header: 'Style',
            question: 'Tabs or spaces?',
            multiSelect: false,
            options: [
              { label: 'Tabs', description: '' },
              { label: 'Spaces', description: '' },
            ],
          },
        ],
      },
    ]
    render(
      <ChatComposer
        status="waiting"
        onSend={vi.fn()}
        onAbort={vi.fn()}
        controls={controls}
        pendingUserInputs={onePendingQuestion}
        onRespondToUserInput={vi.fn()}
        pendingApprovals={onePendingApproval}
        onRespondToApproval={vi.fn()}
      />,
    )
    expect(screen.getByText('Tabs')).toBeInTheDocument()
    expect(screen.queryByText('Approve once')).not.toBeInTheDocument()
  })

  it('renders nothing extra when there are no pending approvals', () => {
    render(
      <ChatComposer
        status="idle"
        onSend={vi.fn()}
        onAbort={vi.fn()}
        controls={controls}
        pendingApprovals={[]}
        onRespondToApproval={vi.fn()}
      />,
    )
    expect(screen.queryByText('Approve once')).not.toBeInTheDocument()
  })
})

// Plan T9 — draft threads (design spec §2) and the prompt stash (§5/§6). The
// store is real here too — no `vi.mock('@/store/useDevDeckStore', ...)`
// anywhere in this file, matching the file's existing convention.
describe('ChatComposer — draft mirror', () => {
  it('rehydrates the same text after unmount and remount with the same threadKey', () => {
    const { unmount } = render(
      <ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} threadKey="thread-1" />,
    )
    type(screen.getByRole('textbox'), 'half-written idea')
    // No timers advanced: this only passes if unmounting flushes the
    // pending debounce straight to the store, not merely "eventually".
    unmount()

    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} threadKey="thread-1" />)
    expect(screen.getByRole('textbox').textContent).toBe('half-written idea')
  })

  it('does not rehydrate a draft belonging to a different threadKey', () => {
    const { unmount } = render(
      <ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} threadKey="thread-1" />,
    )
    type(screen.getByRole('textbox'), 'thread one only')
    unmount()

    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} threadKey="thread-2" />)
    expect(screen.getByRole('textbox').textContent).toBe('')
  })

  it('a successful send clears the persisted draft, even one the debounce already committed', () => {
    vi.useFakeTimers()
    const onSend = vi.fn()
    render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={controls} threadKey="thread-1" />)

    const box = screen.getByRole('textbox')
    type(box, 'ship it')
    // Let the debounce actually fire and commit 'ship it' to the store
    // BEFORE sending — this is what makes the assertion below meaningful:
    // once the write has already landed, there is no "pending" tick left
    // for `setText('')`'s own re-render to naturally race and cancel.
    // Only an explicit clear on submit removes it at this point.
    vi.advanceTimersByTime(300)
    expect(useDevDeckStore.getState().composerDrafts['thread-1']?.text).toBe('ship it')

    pressEnter(box)
    expect(onSend).toHaveBeenCalledWith('ship it', [])
    expect(useDevDeckStore.getState().composerDrafts['thread-1']).toBeUndefined()

    // ...and nothing resurrects it afterward either.
    vi.advanceTimersByTime(1000)
    expect(useDevDeckStore.getState().composerDrafts['thread-1']).toBeUndefined()
  })

  it('mirrors typed text to the store only after the 300ms debounce, not per keystroke', () => {
    vi.useFakeTimers()
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} threadKey="thread-9" />)
    type(screen.getByRole('textbox'), 'still typing')

    // Nothing written yet — the write is trailing-debounced, not immediate.
    expect(useDevDeckStore.getState().composerDrafts['thread-9']).toBeUndefined()

    vi.advanceTimersByTime(300)
    expect(useDevDeckStore.getState().composerDrafts['thread-9']?.text).toBe('still typing')
  })
})

describe('ChatComposer — ⌘S prompt stash', () => {
  // The stash is global, not per-thread (design spec §5) — unlike drafts,
  // this wiring must not go dormant just because the caller has no
  // `threadKey` to hydrate a draft against.
  it('⌘S still stashes with no threadKey prop at all', () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)
    const box = screen.getByRole('textbox')
    type(box, 'no thread yet')
    box.focus()
    fireEvent.keyDown(box, { key: 's', metaKey: true })

    expect(box.textContent).toBe('')
    expect(useDevDeckStore.getState().promptStash.map((e) => e.text)).toContain('no thread yet')
  })

  it('stashes non-empty text and empties the composer', () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} threadKey="thread-1" />)
    const box = screen.getByRole('textbox')
    type(box, 'stash me')
    box.focus()
    fireEvent.keyDown(box, { key: 's', metaKey: true })

    expect(box.textContent).toBe('')
    expect(useDevDeckStore.getState().promptStash.map((e) => e.text)).toContain('stash me')
  })

  it('does nothing on ⌘S when the editor does not have focus', () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} threadKey="thread-1" />)
    const box = screen.getByRole('textbox')
    type(box, 'not focused right now')
    ;(document.activeElement as HTMLElement | null)?.blur?.()

    fireEvent.keyDown(window, { key: 's', metaKey: true })

    expect(box.textContent).toBe('not focused right now')
    expect(useDevDeckStore.getState().promptStash).toHaveLength(0)
  })

  it('opens the stash menu on ⌘S with an empty composer', () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} threadKey="thread-1" />)
    const box = screen.getByRole('textbox')
    box.focus()
    fireEvent.keyDown(box, { key: 's', ctrlKey: true })

    expect(screen.getByRole('listbox', { name: 'Stashed prompts' })).toBeInTheDocument()
  })

  it('Escape closes the open stash menu', () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} threadKey="thread-1" />)
    const box = screen.getByRole('textbox')
    box.focus()
    fireEvent.keyDown(box, { key: 's', metaKey: true })
    expect(screen.getByRole('listbox', { name: 'Stashed prompts' })).toBeInTheDocument()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Stashed prompts' })).not.toBeInTheDocument()
  })

  it('Enter restores the highlighted stash entry into the composer', () => {
    useDevDeckStore.setState({
      promptStash: [{ id: 'stash-1', createdAt: new Date().toISOString(), text: 'restored idea' }],
    })
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} threadKey="thread-1" />)
    const box = screen.getByRole('textbox')
    box.focus()
    fireEvent.keyDown(box, { key: 's', metaKey: true }) // empty composer → open the menu
    expect(screen.getByRole('listbox', { name: 'Stashed prompts' })).toBeInTheDocument()

    fireEvent.keyDown(document.body, { key: 'Enter' })

    expect(box.textContent).toBe('restored idea')
    expect(screen.queryByRole('listbox', { name: 'Stashed prompts' })).not.toBeInTheDocument()
  })

  it('restoring into a non-empty composer stashes the current text first, then swaps — nothing is lost', () => {
    useDevDeckStore.setState({
      promptStash: [{ id: 'stash-1', createdAt: new Date().toISOString(), text: 'older idea' }],
    })
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} threadKey="thread-1" />)
    const box = screen.getByRole('textbox')
    type(box, 'currently typing this')

    // The badge (not ⌘S — text is non-empty, so ⌘S would stash-and-clear
    // instead) opens the menu while the composer still holds a draft.
    fireEvent.click(screen.getByRole('button', { name: /Stashed prompts: 1/i }))
    fireEvent.keyDown(document.body, { key: 'Enter' })

    expect(box.textContent).toBe('older idea')
    const stash = useDevDeckStore.getState().promptStash
    expect(stash.some((e) => e.text === 'currently typing this')).toBe(true)
    expect(stash.some((e) => e.text === 'older idea')).toBe(false)
  })

  // The split-pane collision (design spec §6): three file editors each
  // register a window-level, bubble-phase Cmd/Ctrl+S listener gated only on
  // their own tab being active — not on focus. A stray ⌘S meant for this
  // composer must never reach them.
  it('stops a window-level bubble-phase Cmd+S listener (à la FileEditor) from firing', () => {
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    try {
      render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} threadKey="thread-1" />)
      const box = screen.getByRole('textbox')
      type(box, 'do not let this leak')
      box.focus()
      fireEvent.keyDown(box, { key: 's', metaKey: true })

      expect(spy).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })
})

// Plan T12: the composer-panels slot renders `ComposerPlanFollowUpBanner`
// (T10) and the action button gains a third state, both gated on the same
// follow-up condition (interactionMode 'plan', status idle, a plan on the
// table) that the banner already owns internally. `plan`/`onPlanFollowUp`
// default to `null`/a no-op so every pre-existing render above (none of
// which know about plans) needs no change.
describe('ChatComposer — plan follow-up', () => {
  const PLAN: ChatItem = { id: 'plan-1', kind: 'plan', text: '# Ship it\n\n- step one', lastSequence: 0 }
  const planControls: ChatComposerProps['controls'] = { ...controls, interactionMode: 'plan' }

  it('shows the banner only when all three follow-up conditions hold', () => {
    const { rerender } = render(
      <ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={planControls} plan={PLAN} />,
    )
    expect(screen.getByText('Plan Ready')).toBeInTheDocument()

    // interactionMode flips away from 'plan'
    rerender(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} plan={PLAN} />)
    expect(screen.queryByText('Plan Ready')).not.toBeInTheDocument()

    // status flips away from 'idle'
    rerender(<ChatComposer status="running" onSend={vi.fn()} onAbort={vi.fn()} controls={planControls} plan={PLAN} />)
    expect(screen.queryByText('Plan Ready')).not.toBeInTheDocument()

    // no plan on the table
    rerender(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={planControls} plan={null} />)
    expect(screen.queryByText('Plan Ready')).not.toBeInTheDocument()
  })

  it('empty draft + follow-up state: the button reads Implement and dispatches via onPlanFollowUp, not onSend', async () => {
    const onSend = vi.fn()
    const onPlanFollowUp = vi.fn()
    render(
      <ChatComposer
        status="idle"
        onSend={onSend}
        onAbort={vi.fn()}
        controls={planControls}
        plan={PLAN}
        onPlanFollowUp={onPlanFollowUp}
      />,
    )

    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /implement/i }))

    expect(onPlanFollowUp).toHaveBeenCalledWith({
      action: 'implement',
      text: buildPlanImplementationPrompt(PLAN.text),
      mode: 'default',
    })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('non-empty draft + follow-up state: the button reads Refine and dispatches the typed draft via onPlanFollowUp', async () => {
    const onSend = vi.fn()
    const onPlanFollowUp = vi.fn()
    render(
      <ChatComposer
        status="idle"
        onSend={onSend}
        onAbort={vi.fn()}
        controls={planControls}
        plan={PLAN}
        onPlanFollowUp={onPlanFollowUp}
      />,
    )

    type(screen.getByRole('textbox'), 'make it shorter')
    expect(screen.queryByRole('button', { name: /implement/i })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /refine/i }))

    expect(onPlanFollowUp).toHaveBeenCalledWith({ action: 'refine', text: 'make it shorter', mode: 'plan' })
    expect(onSend).not.toHaveBeenCalled()
    // Empties the box the same way a normal send does.
    expect(screen.getByRole('textbox').textContent).toBe('')
  })

  it('is exactly one action button in the follow-up state too', () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={planControls} plan={PLAN} />)

    expect(screen.getAllByRole('button', { name: /implement/i })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument()
  })

  // Outside the follow-up state (no `plan` prop at all — every test above
  // this describe block), the ordinary Send/Stop branch must be completely
  // unaffected. Not a new assertion so much as documentation: the tests
  // above this one in the file are that proof, run unmodified.
  it('a plan on the table with interactionMode still default renders the ordinary Send button', () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} plan={PLAN} />)

    expect(screen.getByRole('button', { name: /submit/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /implement/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /refine/i })).not.toBeInTheDocument()
  })
})

// D6: ChatComposer derives the effective agent id (for the $ skill catalog)
// from the model picker, not the worktree's static default, and threads
// controls.setInteractionMode through so /plan and /build reach the socket.
describe('ChatComposer — skill catalog agent id and slash commands', () => {
  it('derives the skill catalog agent id from the picked model, not the worktree default', () => {
    render(
      <ChatComposer
        status="idle"
        onSend={vi.fn()}
        onAbort={vi.fn()}
        controls={{ ...controls, worktreeAgentId: 'claude', model: { agentId: 'codex', modelId: 'x', modelName: 'X' } }}
        machine={{ id: 'm1', name: 'dev', url: '', key: '', isLocal: false, signingPublicKey: '' }}
        worktreeId="worktree-1"
      />,
    )
    expect(useAgentSkillsMock).toHaveBeenLastCalledWith(expect.anything(), 'codex')
  })

  it('falls back to the worktree default agent id when no model is picked', () => {
    render(
      <ChatComposer
        status="idle"
        onSend={vi.fn()}
        onAbort={vi.fn()}
        controls={{ ...controls, worktreeAgentId: 'claude', model: null }}
        machine={{ id: 'm1', name: 'dev', url: '', key: '', isLocal: false, signingPublicKey: '' }}
        worktreeId="worktree-1"
      />,
    )
    expect(useAgentSkillsMock).toHaveBeenLastCalledWith(expect.anything(), 'claude')
  })

  it('typing /plan and pressing Enter dispatches setInteractionMode("plan") and sends nothing', async () => {
    const onSend = vi.fn()
    const setInteractionMode = vi.fn()
    render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={{ ...controls, setInteractionMode }} />)
    const box = screen.getByRole('textbox')
    type(box, '/plan')
    // The `/` command menu (ComposerSuggestionMenu) mounts asynchronously
    // through a ReactRenderer portal — ComposerPromptEditor.test.tsx's own
    // equivalent `/pl` test waits for the same `data-command-item` marker
    // before pressing Enter, for the same reason.
    await waitFor(() => expect(document.querySelector('[data-command-item="plan"]')).not.toBeNull())
    pressEnter(box)
    expect(setInteractionMode).toHaveBeenCalledWith('plan')
    expect(onSend).not.toHaveBeenCalled()
    expect(box.textContent).toBe('')
  })
})

// Composer-context-attachments plan, T11 (C2): the attachment slot, the
// paperclip's file picker, and onSend's widened arity.
describe('ChatComposer — image attachments', () => {
  function pngFile(name = 'shot.png') {
    return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
  }

  function uploadedAttachment(name = 'shot.png') {
    return { id: 'att-1', threadId: '', name, mimeType: 'image/png', sizeBytes: 3, createdAt: '2026-08-15T00:00:00Z' }
  }

  function stubObjectUrls() {
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn((f: File) => `blob:${f.name}`), revokeObjectURL: vi.fn() })
  }

  function fileInput(): HTMLInputElement {
    return document.querySelector('input[type="file"]') as HTMLInputElement
  }

  afterEach(() => {
    uploadAgentAttachmentMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('renders the attachments row as a sibling of composer-panels, never nested inside it', () => {
    const { container } = render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    const panels = container.querySelector('[data-slot="composer-panels"]')
    const attachments = container.querySelector('[data-slot="composer-attachments"]')
    expect(panels).not.toBeNull()
    expect(attachments).not.toBeNull()
    expect(panels?.contains(attachments)).toBe(false)
    expect(attachments?.contains(panels)).toBe(false)
  })

  it('the paperclip button opens the hidden file picker', async () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)
    const clickSpy = vi.spyOn(fileInput(), 'click')

    await userEvent.click(screen.getByRole('button', { name: /attach image/i }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('selecting a file through the picker feeds the same addFiles path paste/drop use', async () => {
    stubObjectUrls()
    uploadAgentAttachmentMock.mockResolvedValue(uploadedAttachment())
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    await userEvent.upload(fileInput(), pngFile())

    expect(await screen.findByAltText('shot.png')).toBeInTheDocument()
  })

  it('pasting an image onto the composer surface feeds the same addFiles path as the picker', async () => {
    stubObjectUrls()
    uploadAgentAttachmentMock.mockImplementation(() => new Promise(() => {}))
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [pngFile('pasted.png')], getData: () => '' } })

    expect(await screen.findByAltText('pasted.png')).toBeInTheDocument()
  })

  it('disables the paperclip (with a tooltip) when the effective agent is pi', () => {
    render(
      <ChatComposer
        status="idle"
        onSend={vi.fn()}
        onAbort={vi.fn()}
        controls={{ ...controls, worktreeAgentId: 'claude', model: { agentId: 'pi', modelId: 'x', modelName: 'X' } }}
      />,
    )

    const button = screen.getByRole('button', { name: /attach image/i })
    expect(button).toBeDisabled()
    expect(button.getAttribute('title')).toMatch(/pi/i)
  })

  it('leaves the paperclip enabled for a non-pi agent', () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    expect(screen.getByRole('button', { name: /attach image/i })).toBeEnabled()
  })

  it('sends the completed attachment mapped to its wire shape alongside the trimmed text', async () => {
    stubObjectUrls()
    uploadAgentAttachmentMock.mockResolvedValue(uploadedAttachment())
    const onSend = vi.fn()
    render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={controls} />)

    await userEvent.upload(fileInput(), pngFile())
    await screen.findByAltText('shot.png')
    type(screen.getByRole('textbox'), 'look at this')
    pressEnter(screen.getByRole('textbox'))

    expect(onSend).toHaveBeenCalledWith('look at this', [{ id: 'att-1', kind: 'image', mime: 'image/png', name: 'shot.png' }])
  })

  // An image with no caption is still a real send — the empty-draft guard
  // above must not require text once an upload has actually finished.
  it('sends with only an attached image and no text', async () => {
    stubObjectUrls()
    uploadAgentAttachmentMock.mockResolvedValue(uploadedAttachment())
    const onSend = vi.fn()
    render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={controls} />)

    await userEvent.upload(fileInput(), pngFile())
    await screen.findByAltText('shot.png')
    pressEnter(screen.getByRole('textbox'))

    expect(onSend).toHaveBeenCalledWith('', [{ id: 'att-1', kind: 'image', mime: 'image/png', name: 'shot.png' }])
  })

  it('clears the attachment strip after a successful send', async () => {
    stubObjectUrls()
    uploadAgentAttachmentMock.mockResolvedValue(uploadedAttachment())
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    await userEvent.upload(fileInput(), pngFile())
    await screen.findByAltText('shot.png')
    pressEnter(screen.getByRole('textbox'))

    expect(screen.queryByAltText('shot.png')).not.toBeInTheDocument()
  })

  // Regression guard on the widened empty-draft guard above: a draft with
  // no text and no completed attachment must still be blocked, exactly like
  // the pre-attachment "does not send an empty or whitespace-only message"
  // case elsewhere in this file.
  it('still refuses to send when nothing was typed and nothing finished uploading', () => {
    const onSend = vi.fn()
    render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={controls} />)

    pressEnter(screen.getByRole('textbox'))

    expect(onSend).not.toHaveBeenCalled()
  })
})

// Composer-context-attachments plan, T15 (C3): the second edit's bridge.
// `insertTerminalContext` is exactly what `ExpandedTerminal.tsx`'s "Send to
// chat" affordance calls (see that file's own suite for the routing side of
// this) — this file drives it directly against a mounted `ChatComposer`,
// the same way `ComposerPromptEditor.test.tsx` drives `insertChip` itself
// rather than the whole terminal→chat pipeline.
describe('ChatComposer — terminal context (C3 bridge)', () => {
  /** The string T1's serialization gives a terminal-context chip with this
   *  value/label — derived from `composerSerialize.ts` itself, not
   *  hardcoded, mirroring `ComposerPromptEditor.test.tsx`'s own
   *  `serializedTerminalContextChip` helper. */
  function serializedTerminalContextChip(value: string, label?: string): string {
    return serializeComposerDoc({ type: 'doc', content: [composerTerminalContextChip(value, label)] })
  }

  function chipMarker(): Element | null {
    return document.querySelector('[data-composer-chip-kind="terminal-context"]')
  }

  it('appends a <terminal_context> block for a chip inserted through the bridge', async () => {
    const onSend = vi.fn()
    render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={controls} threadKey="thread-1" />)

    act(() => {
      insertTerminalContext('thread-1', 'sess-1/L3-L5', 'Terminal lines 3-5', 'echo hi\necho bye')
    })
    await waitFor(() => expect(chipMarker()).not.toBeNull())

    pressEnter(screen.getByRole('textbox'))

    const chip = serializedTerminalContextChip('sess-1/L3-L5', 'Terminal lines 3-5')
    const expected = buildTerminalContextBlock(chip, [
      { destination: 'terminal:sess-1/L3-L5', text: 'echo hi\necho bye' },
    ])
    expect(onSend).toHaveBeenCalledWith(expected, [])
  })

  // The bridge's queueing half: `ExpandedTerminal` may open a brand-new chat
  // pane in the same click that captured the selection, so the target
  // `ChatComposer` cannot possibly be mounted yet when `insertTerminalContext`
  // is called — this is what keeps that capture from being silently dropped.
  it('applies a capture that arrived before this threadKey had a mounted ChatComposer', async () => {
    insertTerminalContext('thread-queued', 'sess-9/L1-L1', 'Terminal', 'queued output')

    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} threadKey="thread-queued" />)

    await waitFor(() => expect(chipMarker()).not.toBeNull())
    expect(screen.getByText('Terminal')).toBeInTheDocument()
  })

  it('removing the chip before submit removes its entry from the appended block', async () => {
    const onSend = vi.fn()
    render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={controls} threadKey="thread-2" />)

    act(() => {
      insertTerminalContext('thread-2', 'sess-1/L3-L5', 'Terminal lines 3-5', 'echo hi')
    })
    await waitFor(() => expect(chipMarker()).not.toBeNull())

    await userEvent.click(screen.getByRole('button', { name: 'Remove Terminal lines 3-5' }))
    await waitFor(() => expect(chipMarker()).toBeNull())

    type(screen.getByRole('textbox'), 'just text now')
    pressEnter(screen.getByRole('textbox'))

    expect(onSend).toHaveBeenCalledWith('just text now', [])
  })

  it('keeps two chips in document order in the appended block', async () => {
    const onSend = vi.fn()
    render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={controls} threadKey="thread-3" />)

    act(() => {
      insertTerminalContext('thread-3', 'sess-1/L1-L2', 'Terminal lines 1-2', 'out-1')
    })
    await waitFor(() => expect(document.querySelectorAll('[data-composer-chip-kind="terminal-context"]')).toHaveLength(1))

    act(() => {
      insertTerminalContext('thread-3', 'sess-2/L4-L4', 'Terminal 2 lines 4-4', 'out-2')
    })
    await waitFor(() => expect(document.querySelectorAll('[data-composer-chip-kind="terminal-context"]')).toHaveLength(2))

    pressEnter(screen.getByRole('textbox'))

    const sent = onSend.mock.calls[0]?.[0] as string
    expect(sent.indexOf('terminal:sess-1/L1-L2')).toBeLessThan(sent.indexOf('terminal:sess-2/L4-L4'))
    expect(sent).toContain('out-1')
    expect(sent).toContain('out-2')
  })
})

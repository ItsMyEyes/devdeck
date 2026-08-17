import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentChatPane } from '@/features/agent-chat/AgentChatPane'
import { emptyThreadView } from '@/features/agent-chat/eventReducer'
import type { UseAgentChatSocketOptions } from '@/features/agent-chat/useAgentChatSocket'
import { STASH_STORAGE_KEY } from '@/features/agent-chat/promptStash'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const mockSocket = vi.fn()
// Captures the options the pane actually passes to the hook on its most
// recent render — plan Task 10's connect-gate tests assert on `connect`,
// which the old `() => mockSocket()` form threw away.
let capturedSocketOpts: UseAgentChatSocketOptions | undefined
vi.mock('@/features/agent-chat/useAgentChatSocket', () => ({
  useAgentChatSocket: (opts: UseAgentChatSocketOptions) => {
    capturedSocketOpts = opts
    return mockSocket()
  },
}))

// Shiki compiles a real grammar and (depending on the engine) reaches for
// WASM, which is slow-to-impossible under jsdom. ToolInput renders a
// CodeBlock, so stub the vendored module: these tests are about which rows
// appear and what they say, not about highlighting.
vi.mock('@/components/ai-elements/code-block', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
  CodeBlockCopyButton: () => null,
}))

afterEach(() => {
  cleanup()
  // Restores real timers even if a fake-timer test throws before reaching
  // its own `vi.useRealTimers()` — a no-op when timers are already real, so
  // this is safe for every other test in the file too.
  vi.useRealTimers()
  // Task 10 threads `threadKey` into the composer, so it now hydrates from
  // and writes to the real (non-mocked) store — reset both slices between
  // tests, same discipline `ChatComposer.test.tsx` already applies, so a
  // draft left behind by one connect-gate test (several share the same
  // `threadKey="w-abc"`) can't rehydrate into the next.
  useDevDeckStore.setState({ composerDrafts: {}, promptStash: [] })
  localStorage.removeItem(STASH_STORAGE_KEY)
})

// `AgentChatPane` reaches `MessagesTimeline` through `React.lazy` (it drags in
// Streamdown/Shiki/katex/mermaid, which must not sit in the eagerly loaded
// workspace-route chunk). Resolving that module here, once, keeps the assertions
// about the REAL timeline while taking vitest's transform of that whole graph
// out of a `findBy*` timeout.
beforeAll(async () => {
  await import('@/features/agent-chat/MessagesTimeline')
})

// ChatHeader's agent/model pickers consume useAgents()/useAgentModels() (the
// per-machine CLI-agent catalog) — stub both so these pane-state tests don't
// need a real QueryClientProvider or a live machine to hit. See
// AgentChatPane.tsx / ChatHeader.tsx doc comments for why this is a
// deviation from the plan's verbatim test: Task 11 (the per-machine `Probe`
// snapshot this header was meant to read) isn't implemented in this repo
// snapshot, so the mock stands in for both the network and the missing
// fields.
//
// `useAgentThreads` backs Task 10's connect gate (plan
// `2026-08-15-composer-drafts-and-stash.md`) — the pane now calls it to
// decide whether a draft thread should open its socket. A `vi.fn()`, not a
// static stub, so each connect-gate test can configure its own
// data/isLoading/isError shape.
const mockAgentThreads = vi.fn()
vi.mock('@/features/data/queries', () => ({
  useAgents: () => ({ data: [], isLoading: false, error: null }),
  useAgentModels: () => ({ data: [], isLoading: false, error: null }),
  useAgentThreads: () => mockAgentThreads(),
  useAgentSkills: () => ({ data: [], isLoading: false, error: null }),
}))

// T11 (composer-context-attachments, C2): only `uploadAgentAttachment` is
// stubbed — everything else in the module (including `fetchAgentAttachmentBlob`,
// which `MessagesTimeline` would reach for a real thumbnail, never exercised
// here since no test in this file renders a message with `.attachments`)
// keeps its real implementation.
const uploadAgentAttachmentMock = vi.fn()
vi.mock('@/lib/machineApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/machineApi')>()
  return { ...actual, uploadAgentAttachment: (...args: unknown[]) => uploadAgentAttachmentMock(...args) }
})

vi.mock('@/features/agent-chat/imageCompression', () => ({
  downscaleImage: async (file: File) => file,
}))

beforeEach(() => {
  // Default: no thread yet, query settled, no error — every pre-existing
  // test in this file (which predates the connect gate) never inspects
  // `capturedSocketOpts.connect`, so this default only needs to not throw.
  mockAgentThreads.mockReturnValue({ data: [], isLoading: false, isError: false })
})

const machine = { id: 'm-1', name: 'dev', url: 'http://localhost:8989', key: 'k' } as never

describe('AgentChatPane', () => {
  it('shows a connecting state before the socket opens', () => {
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'connecting',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)
    expect(screen.getByText(/connecting/i)).toBeInTheDocument()
  })

  // An empty thread is the hero layout — the question plus the composer,
  // centred — not a placeholder card sitting above a docked input.
  it('shows the hero prompt once connected with no messages', () => {
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'open',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)
    expect(screen.getByRole('heading', { name: /what should we build/i })).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('names the worktree in the hero prompt when it knows it', () => {
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'open',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} worktreeLabel="auth" />)
    // textContent, not the accessible name: the worktree is its own <span>
    // (it carries the underline), and the name algorithm space-separates
    // element children, which would put a gap before the question mark.
    expect(screen.getByRole('heading').textContent).toBe('What should we build in auth?')
  })

  // The hero composer and the docked one are the same component in two
  // placements — the status strip is the tell, since it belongs to the docked
  // one only.
  it('drops the status strip from the hero composer and keeps it on the docked one', () => {
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'open',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    const { rerender } = render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} worktreeLabel="auth" branch="main" />)
    expect(screen.queryByText('main')).not.toBeInTheDocument()

    mockSocket.mockReturnValue({
      view: {
        ...emptyThreadView(),
        items: [{ id: 'u1', kind: 'user', text: 'go', lastSequence: 0, createdAt: 1_700_000_000_000 }],
      },
      status: 'open',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    rerender(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} worktreeLabel="auth" branch="main" />)
    expect(screen.getByText('main')).toBeInTheDocument()
  })

  it('surfaces a thread error instead of rendering an empty timeline', () => {
    mockSocket.mockReturnValue({
      view: { ...emptyThreadView(), error: 'claude CLI not found on PATH' },
      status: 'open', sendTurn: vi.fn(), abortTurn: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)
    expect(screen.getByText(/claude CLI not found on PATH/i)).toBeInTheDocument()
  })

  // Regression: `PaneMessage` centred itself with `flex-1`, which had real
  // height back when the scroll container was the flex child. Inside
  // `ConversationContent` (an auto-height block from use-stick-to-bottom) it
  // collapses to one line pinned to the top of the pane. The empty state was
  // given an explicit height for exactly this reason; these two were not.
  it('gives the connecting state a height to centre itself in', () => {
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'connecting',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    const message = screen.getByText(/connecting/i)
    expect(message.className).toContain('min-h-[220px]')
    expect(message.className).toContain('items-center')
  })

  // The defect this whole subsystem exists to fix: a mid-thread reconnect
  // used to be invisible. The transcript must stay on screen — not be
  // replaced — with a connection banner surfacing the drop.
  it('keeps the timeline on screen and shows a connection banner when the socket drops mid-thread', async () => {
    mockSocket.mockReturnValue({
      view: {
        ...emptyThreadView(),
        items: [{ id: 'a1', kind: 'assistant', text: 'earlier reply', lastSequence: 0, createdAt: 1_700_000_000_000 }],
      },
      status: 'closed',
      sendTurn: vi.fn(),
      abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(),
      setInteractionMode: vi.fn(),
      clearError: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    expect(await screen.findByText(/earlier reply/)).toBeInTheDocument()
    // `machine.name` is 'dev' — F1's reconnect copy names it, since a
    // transcript already exists (hasTranscript: true).
    expect(screen.getByText(/reconnecting to dev/i)).toBeInTheDocument()
  })

  // Today `view.error` replaces the whole pane with `PaneMessage
  // tone="error"`. This proves it no longer does: the transcript stays, the
  // error moves into a banner.
  it('keeps the timeline on screen and shows an error banner instead of replacing it', async () => {
    mockSocket.mockReturnValue({
      view: {
        ...emptyThreadView(),
        items: [{ id: 'a1', kind: 'assistant', text: 'earlier reply', lastSequence: 0, createdAt: 1_700_000_000_000 }],
        error: 'claude CLI not found on PATH',
      },
      status: 'open',
      sendTurn: vi.fn(),
      abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(),
      setInteractionMode: vi.fn(),
      clearError: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    expect(await screen.findByText(/earlier reply/)).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/claude CLI not found on PATH/i)
  })

  // `isEmpty` drops its `view.error === null` clause: a brand-new thread that
  // cannot reach its socket must still get the hero layout (heading +
  // centred composer), with the banner above it — not lose its framing.
  it('keeps the hero layout for a brand-new thread that cannot connect, with a banner above it', () => {
    mockSocket.mockReturnValue({
      view: { ...emptyThreadView(), error: 'claude CLI not found on PATH' },
      status: 'open',
      sendTurn: vi.fn(),
      abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(),
      setInteractionMode: vi.fn(),
      clearError: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    expect(screen.getByRole('heading', { name: /what should we build/i })).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/claude CLI not found on PATH/i)
  })

  // Proves the wiring only: dismissing the error banner calls the mocked
  // socket's clearError(), under the stack's real 220ms dismiss animation.
  // The hook's own behaviour (setTransportError(null)) is T3's to test.
  it('calls clearError when the error banner is dismissed', () => {
    vi.useFakeTimers()
    const clearError = vi.fn()
    mockSocket.mockReturnValue({
      view: { ...emptyThreadView(), error: 'claude CLI not found on PATH' },
      status: 'open',
      sendTurn: vi.fn(),
      abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(),
      setInteractionMode: vi.fn(),
      clearError,
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(clearError).not.toHaveBeenCalled()

    vi.advanceTimersByTime(220)
    expect(clearError).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it('renders the timeline once messages exist', async () => {
    mockSocket.mockReturnValue({
      view: {
        ...emptyThreadView(),
        items: [{ id: 'a1', kind: 'assistant', text: 'the limiter is in place', lastSequence: 0, createdAt: 1_700_000_000_000 }],
      },
      status: 'open',
      sendTurn: vi.fn(),
      abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(),
      setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    // `MessagesTimeline` is behind a lazy boundary (it drags in Streamdown,
    // Shiki, katex and mermaid), so the transcript arrives on a microtask.
    expect(await screen.findByText(/the limiter is in place/)).toBeInTheDocument()
    expect(screen.queryByText(/no messages yet/i)).not.toBeInTheDocument()
  })

  it('keeps the existing timeline on screen while reconnecting mid-thread', async () => {
    mockSocket.mockReturnValue({
      view: {
        ...emptyThreadView(),
        items: [{ id: 'a1', kind: 'assistant', text: 'earlier reply', lastSequence: 0, createdAt: 1_700_000_000_000 }],
      },
      status: 'connecting',
      sendTurn: vi.fn(),
      abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(),
      setInteractionMode: vi.fn(),
      clearError: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    expect(await screen.findByText(/earlier reply/)).toBeInTheDocument()
    // Narrowed from a bare `/connecting/i` (pre-dates this subsystem): that
    // regex also matches the new, intended F1 banner text below
    // ("Reconnecting to dev"), which this exact scenario — mid-thread,
    // socket not open — is supposed to show. The regression this guards
    // against is specifically the old *blocking* overlay, which must still
    // never appear once a transcript exists.
    expect(screen.queryByText('Connecting to the agent…')).not.toBeInTheDocument()
    expect(screen.getByText(/reconnecting to dev/i)).toBeInTheDocument()
  })

  // T9: proves the prop/callback actually reach ChatComposer through the real
  // pane, not just that both files compile against each other.
  // Plan T12: the pane derives `latestProposedPlan(view.items)` (T7) and
  // threads it into the composer, plus a handler that turns a resolved
  // `PlanFollowUpSubmission` (T8) into the two calls the design spec says
  // already exist — `setInteractionMode` then `sendTurn` — end-to-end
  // through the real composer (not a mock), starting from clicking the
  // Build pill to Plan the same way `ComposerControls.test.tsx` does.
  describe('AgentChatPane — plan follow-up', () => {
    function planThreadView() {
      return {
        ...emptyThreadView(),
        items: [{ id: 'plan-1', kind: 'plan', text: '# Ship it\n\n- step one', lastSequence: 0, createdAt: 1_700_000_000_000 }],
        status: 'idle',
      }
    }

    it('Implement switches interaction mode to default and sends the plan implementation prompt', async () => {
      const sendTurn = vi.fn()
      const setInteractionMode = vi.fn()
      mockSocket.mockReturnValue({
        view: planThreadView(),
        status: 'open',
        sendTurn,
        abortTurn: vi.fn(),
        setRuntimeMode: vi.fn(),
        setInteractionMode,
        respondToUserInput: vi.fn(),
        respondToApproval: vi.fn(),
        clearError: vi.fn(),
      })
      render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

      await userEvent.click(screen.getByRole('button', { name: 'Build' }))
      await userEvent.click(await screen.findByRole('button', { name: 'Plan' }))

      await userEvent.click(await screen.findByRole('button', { name: /implement/i }))

      expect(setInteractionMode).toHaveBeenCalledWith('default')
      expect(sendTurn).toHaveBeenCalledWith(
        'PLEASE IMPLEMENT THIS PLAN:\n# Ship it\n\n- step one',
        { options: { effort: 'high', contextWindow: '200k' } },
        [],
      )
    })

    it('Refine submits the typed draft and leaves interaction mode at plan', async () => {
      const sendTurn = vi.fn()
      const setInteractionMode = vi.fn()
      mockSocket.mockReturnValue({
        view: planThreadView(),
        status: 'open',
        sendTurn,
        abortTurn: vi.fn(),
        setRuntimeMode: vi.fn(),
        setInteractionMode,
        respondToUserInput: vi.fn(),
        respondToApproval: vi.fn(),
        clearError: vi.fn(),
      })
      render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

      await userEvent.click(screen.getByRole('button', { name: 'Build' }))
      await userEvent.click(await screen.findByRole('button', { name: 'Plan' }))
      // The toggle above is the one legitimate call — entering plan mode in
      // the first place. Cleared so the assertion below is only about what
      // Refine itself does.
      expect(setInteractionMode).toHaveBeenCalledTimes(1)
      setInteractionMode.mockClear()

      fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { getData: () => 'make it shorter' } })
      await userEvent.click(await screen.findByRole('button', { name: /refine/i }))

      expect(sendTurn).toHaveBeenCalledWith('make it shorter', { options: { effort: 'high', contextWindow: '200k' } }, [])
      // Mode was already 'plan' — a "leave it alone" follow-up must not
      // dispatch a redundant thread.interaction-mode.set.
      expect(setInteractionMode).not.toHaveBeenCalled()
    })

    it('shows the Plan Ready banner once a plan is on the table and the composer is in plan mode', async () => {
      mockSocket.mockReturnValue({
        view: planThreadView(),
        status: 'open',
        sendTurn: vi.fn(),
        abortTurn: vi.fn(),
        setRuntimeMode: vi.fn(),
        setInteractionMode: vi.fn(),
        respondToUserInput: vi.fn(),
        respondToApproval: vi.fn(),
        clearError: vi.fn(),
      })
      render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

      expect(screen.queryByText('Plan Ready')).not.toBeInTheDocument()

      await userEvent.click(screen.getByRole('button', { name: 'Build' }))
      await userEvent.click(await screen.findByRole('button', { name: 'Plan' }))

      expect(await screen.findByText('Plan Ready')).toBeInTheDocument()
    })
  })

  it('threads pendingUserInputs and the responder from the socket into the composer', () => {
    const respondToUserInput = vi.fn()
    mockSocket.mockReturnValue({
      view: {
        ...emptyThreadView(),
        pendingUserInputs: [
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
        ],
      },
      status: 'open',
      sendTurn: vi.fn(),
      abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(),
      setInteractionMode: vi.fn(),
      respondToUserInput,
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    expect(screen.getByText('Tabs')).toBeInTheDocument()
  })
})

// `turnModel` (this file's private helper that builds the turn's
// ModelSelection) has no export to unit-test directly — these exercise it the
// way it is actually reached, by sending a turn through the real composer.
describe('AgentChatPane — turnModel', () => {
  it("sends the picker's defaults on an untouched composer", async () => {
    const sendTurn = vi.fn()
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'open',
      sendTurn, abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    await userEvent.type(screen.getByRole('textbox'), 'hi{Enter}')

    expect(sendTurn).toHaveBeenCalledWith('hi', { options: { effort: 'high', contextWindow: '200k' } }, [])
  })

  // Ultrathink has no --effort value of its own (verified against `claude
  // --help`: low/medium/high/xhigh/max only) — it must ride on 'max', the
  // closest real level, never leak the client-only label onto the wire.
  it('sends ultrathink as effort=max, not the picker label', async () => {
    const sendTurn = vi.fn()
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'open',
      sendTurn, abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    await userEvent.click(screen.getByRole('button', { name: 'High · 200k' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Ultrathink' }))
    await userEvent.type(screen.getByRole('textbox'), 'go{Enter}')

    expect(sendTurn).toHaveBeenCalledWith('go', { options: { effort: 'max', contextWindow: '200k' } }, [])
  })

  it('carries a picked context window onto the turn', async () => {
    const sendTurn = vi.fn()
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'open',
      sendTurn, abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    await userEvent.click(screen.getByRole('button', { name: 'High · 200k' }))
    await userEvent.click(await screen.findByRole('button', { name: '1M' }))
    await userEvent.type(screen.getByRole('textbox'), 'go{Enter}')

    expect(sendTurn).toHaveBeenCalledWith('go', { options: { effort: 'high', contextWindow: '1M' } }, [])
  })
})

// Plan Task 10 (`2026-08-15-composer-drafts-and-stash.md`): the pane decides
// whether a draft thread's socket should actually connect, and threads
// `threadKey` into the composer so a hero↔docked remount survives.
describe('AgentChatPane — connect gate', () => {
  it('passes connect:false when no thread in useAgentThreads matches this threadKey', () => {
    mockAgentThreads.mockReturnValue({ data: [{ id: 'some-other-thread' }], isLoading: false, isError: false })
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'draft',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    expect(capturedSocketOpts?.connect).toBe(false)
  })

  it('passes connect:true when a matching thread exists', () => {
    mockAgentThreads.mockReturnValue({ data: [{ id: 'w-abc' }], isLoading: false, isError: false })
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'connecting',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    expect(capturedSocketOpts?.connect).toBe(true)
  })

  // Fail open: a stray empty row is cheaper than a real thread that never
  // connects because its existence check hasn't resolved yet.
  it('passes connect:true (fail-open) while the threads query is still loading', () => {
    mockAgentThreads.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'connecting',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    expect(capturedSocketOpts?.connect).toBe(true)
  })

  it('passes connect:true (fail-open) when the threads query errors', () => {
    mockAgentThreads.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'connecting',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    expect(capturedSocketOpts?.connect).toBe(true)
  })

  // The first send flips a local flag that keeps connect:true even if
  // useAgentThreads' cache hasn't caught up with the just-created row yet —
  // otherwise a stale query result could flap the gate back to false
  // mid-turn.
  it('keeps connect:true after the first send even when useAgentThreads has not caught up', async () => {
    mockAgentThreads.mockReturnValue({ data: [], isLoading: false, isError: false })
    const sendTurn = vi.fn()
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'draft',
      sendTurn, abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)
    expect(capturedSocketOpts?.connect).toBe(false)

    await userEvent.type(screen.getByRole('textbox'), 'hi{Enter}')

    // Still no matching row in the (unchanged) mocked query result — only the
    // "has sent this session" flag can be keeping the gate open now.
    expect(mockAgentThreads).toHaveBeenCalled()
    expect(capturedSocketOpts?.connect).toBe(true)
  })

  // Problem 2, verbatim: connecting mid-type used to remount ChatComposer
  // (different branch, different element type at the same position) and
  // wipe whatever was typed. Task 9's draft mirror makes it survivable
  // without touching the hero/docked branching itself — this proves the two
  // halves (T5's status plumbing, T9's draft mirror) actually connect
  // through this pane once `threadKey` is threaded into the composer.
  //
  // Timers advance past the 300ms debounce between typing and the status
  // flip: React's branch swap here is a same-commit unmount-then-mount (a
  // different element type at that position, not two separate `unmount()` /
  // `render()` calls), so the new ChatComposer instance's lazy `useState`
  // initializer runs during the *render* phase — strictly before the old
  // instance's unmount-cleanup effect (the debounce flush) runs during
  // *commit*. Verified empirically with an instrumented React tree: the new
  // instance's initial read always observes the store as it stood before
  // that same render started. So this is lossless because the debounce has
  // already committed the draft by the time the swap happens — the design
  // spec's own honestly-stated tradeoff ("a hard reload within 300ms of the
  // last keystroke loses those characters") is exactly this same window, and
  // a real WebSocket connect+hello round trip taking longer than 300ms is
  // what makes the swap safe in practice, not the unmount flush alone.
  it('keeps typed text through the hero↔docked remount once the debounce has committed it', () => {
    vi.useFakeTimers()
    mockAgentThreads.mockReturnValue({ data: [{ id: 'w-abc' }], isLoading: false, isError: false })
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'connecting',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    const { rerender } = render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    const box = screen.getByRole('textbox')
    fireEvent.paste(box, { clipboardData: { getData: () => 'half-typed idea' } })
    expect(box.textContent).toBe('half-typed idea')
    vi.advanceTimersByTime(300)

    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'open',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    rerender(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    expect(screen.getByRole('textbox').textContent).toBe('half-typed idea')
  })
})

// Composer-context-attachments plan, T11 (C2): exercised through the REAL
// composer + attachment upload pipeline (mocked only at the network
// boundary), not a stub — proves the wiring, not merely that both files
// compile against each other.
describe('AgentChatPane — attachments', () => {
  beforeEach(() => {
    uploadAgentAttachmentMock.mockReset()
    uploadAgentAttachmentMock.mockResolvedValue({
      id: 'att-1',
      threadId: 'w-abc',
      name: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      createdAt: '2026-08-15T00:00:00Z',
    })
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn((f: File) => `blob:${f.name}`), revokeObjectURL: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("forwards ChatComposer's onSend attachments straight into sendTurn's third argument", async () => {
    const sendTurn = vi.fn()
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'open',
      sendTurn, abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane target={{ kind: 'machine', machine }} worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }))
    await screen.findByAltText('shot.png')

    await userEvent.type(screen.getByRole('textbox'), 'go{Enter}')

    expect(sendTurn).toHaveBeenCalledWith(
      'go',
      { options: { effort: 'high', contextWindow: '200k' } },
      [{ id: 'att-1', kind: 'image', mime: 'image/png', name: 'shot.png' }],
    )
  })
})

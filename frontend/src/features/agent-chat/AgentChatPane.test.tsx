import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AgentChatPane } from '@/features/agent-chat/AgentChatPane'
import { emptyThreadView } from '@/features/agent-chat/eventReducer'

const mockSocket = vi.fn()
vi.mock('@/features/agent-chat/useAgentChatSocket', () => ({
  useAgentChatSocket: () => mockSocket(),
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
vi.mock('@/features/data/queries', () => ({
  useAgents: () => ({ data: [], isLoading: false, error: null }),
  useAgentModels: () => ({ data: [], isLoading: false, error: null }),
}))

const machine = { id: 'm-1', name: 'dev', url: 'http://localhost:8989', key: 'k' } as never

describe('AgentChatPane', () => {
  it('shows a connecting state before the socket opens', () => {
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'connecting',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
    })
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} />)
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
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} />)
    expect(screen.getByRole('heading', { name: /what should we build/i })).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('names the worktree in the hero prompt when it knows it', () => {
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'open',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(), setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} worktreeLabel="auth" />)
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
    const { rerender } = render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} worktreeLabel="auth" branch="main" />)
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
    rerender(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} worktreeLabel="auth" branch="main" />)
    expect(screen.getByText('main')).toBeInTheDocument()
  })

  it('surfaces a thread error instead of rendering an empty timeline', () => {
    mockSocket.mockReturnValue({
      view: { ...emptyThreadView(), error: 'claude CLI not found on PATH' },
      status: 'open', sendTurn: vi.fn(), abortTurn: vi.fn(),
    })
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} />)
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
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    const message = screen.getByText(/connecting/i)
    expect(message.className).toContain('min-h-[220px]')
    expect(message.className).toContain('items-center')
  })

  it('gives the thread-error state the same height', () => {
    mockSocket.mockReturnValue({
      view: { ...emptyThreadView(), error: 'claude CLI not found on PATH' },
      status: 'open', sendTurn: vi.fn(), abortTurn: vi.fn(),
    })
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    expect(screen.getByText(/claude CLI not found on PATH/i).className).toContain('min-h-[220px]')
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
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

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
    })
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    expect(await screen.findByText(/earlier reply/)).toBeInTheDocument()
    expect(screen.queryByText(/connecting/i)).not.toBeInTheDocument()
  })
})

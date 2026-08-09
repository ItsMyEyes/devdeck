import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('shows an empty state once connected with no messages', () => {
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'open',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
    })
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} />)
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument()
  })

  it('surfaces a thread error instead of rendering an empty timeline', () => {
    mockSocket.mockReturnValue({
      view: { ...emptyThreadView(), error: 'claude CLI not found on PATH' },
      status: 'open', sendTurn: vi.fn(), abortTurn: vi.fn(),
    })
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} />)
    expect(screen.getByText(/claude CLI not found on PATH/i)).toBeInTheDocument()
  })

  it('renders the timeline once messages exist', () => {
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

    expect(screen.getByText(/the limiter is in place/)).toBeInTheDocument()
    expect(screen.queryByText(/no messages yet/i)).not.toBeInTheDocument()
  })

  it('keeps the existing timeline on screen while reconnecting mid-thread', () => {
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

    expect(screen.getByText(/earlier reply/)).toBeInTheDocument()
    expect(screen.queryByText(/connecting/i)).not.toBeInTheDocument()
  })
})

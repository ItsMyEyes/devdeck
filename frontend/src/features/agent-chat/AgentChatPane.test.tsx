import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentChatPane } from '@/features/agent-chat/AgentChatPane'
import { emptyThreadView } from '@/features/agent-chat/eventReducer'

const mockSocket = vi.fn()
vi.mock('@/features/agent-chat/useAgentChatSocket', () => ({
  useAgentChatSocket: () => mockSocket(),
}))

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
})

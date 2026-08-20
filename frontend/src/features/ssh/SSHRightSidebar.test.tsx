import { useEffect } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { SSHRightSidebar } from './SSHRightSidebar'

let forwardsMounts = 0
vi.mock('./SSHForwardsPanel', () => ({
  SSHForwardsPanel: (props: { connectionId: string; visible: boolean }) => {
    useEffect(() => {
      forwardsMounts += 1
    }, [])
    return (
      <div data-testid="mock-forwards" data-visible={String(props.visible)}>
        forwards:{props.connectionId}
      </div>
    )
  },
}))

vi.mock('@/features/stats/StatsPane', () => ({
  StatsPane: (props: { target: { kind: string; connectionId?: string }; visible: boolean }) => (
    <div data-testid="mock-stats" data-visible={String(props.visible)}>
      stats:{props.target.kind === 'ssh' ? props.target.connectionId : ''}
    </div>
  ),
}))

// Task 12: the DevOps Chat panel wraps AgentChatPane, which owns a real
// WebSocket (useAgentChatSocket) — mocked here so mounting it in a test never
// opens one. useSSHConnections is mocked alongside it: SSHAgentChatPanel
// (real, unmocked) calls it to resolve the connection's name for ChatHeader's
// subject label, and this test file has no QueryClientProvider for a real
// react-query call to attach to.
vi.mock('@/features/agent-chat/AgentChatPane', () => ({
  AgentChatPane: (props: { threadKey: string }) => <div data-testid="mock-agent-chat-pane">{props.threadKey}</div>,
}))

const mockUseAgentThreads = vi.fn((_machine: unknown, _worktreeId: unknown) => ({
  data: [] as unknown[],
  isLoading: false,
  error: null,
  refetch: vi.fn(),
}))

vi.mock('@/features/data/queries', () => ({
  // Deliberately empty, as before: these tests are about rail behaviour
  // (which panel is open, what stays mounted), not about the chat itself. With
  // no connection to resolve, SSHAgentChatPanel sits in its `loading` state —
  // mounted, with its socket gated off — which is exactly what "keeps the chat
  // panel mounted" asserts.
  useSSHConnections: () => ({ data: [] }),
  // Both are read by SSHAgentChatPanel to resolve the connection's executor
  // runtime (sshChatAvailability.ts). Present and empty rather than absent: a
  // missing export throws on render, which is not the state under test.
  useMachines: () => ({ data: [] }),
  useMachineCapabilities: () => ({ data: undefined, isError: false }),
  // SessionsPanel fetches its own data; the sidebar mounts it for the SSH
  // connection's own thread namespace.
  useAgentThreads: (machine: unknown, worktreeId: unknown) => mockUseAgentThreads(machine, worktreeId),
  useDeleteAgentThread: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}))

if (typeof window.PointerEvent === 'undefined') {
  class FakePointerEvent extends MouseEvent {
    pointerId: number
    constructor(type: string, params: MouseEventInit & { pointerId?: number } = {}) {
      super(type, params)
      this.pointerId = params.pointerId ?? 0
    }
  }
  // @ts-expect-error jsdom doesn't implement PointerEvent
  window.PointerEvent = FakePointerEvent
}
Element.prototype.setPointerCapture = vi.fn()
Element.prototype.releasePointerCapture = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)

afterEach(() => {
  cleanup()
  forwardsMounts = 0
  useDevDeckStore.setState({ sshRightSidebars: {} })
  // A couple of "session history" tests below override this per-test — reset
  // to the empty-history default so a later test never inherits their data.
  mockUseAgentThreads.mockReturnValue({ data: [], isLoading: false, error: null, refetch: vi.fn() })
})

beforeEach(() => {
  useDevDeckStore.setState({ sshRightSidebars: {} })
})

const shellKey = 'ssh:conn-1'

describe('SSHRightSidebar', () => {
  it('starts closed with only the collapsed rail visible', () => {
    render(<SSHRightSidebar shellKey={shellKey} connectionId="conn-1" />)
    expect(screen.getByRole('button', { name: /port forwarding/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^stats$/i })).toBeTruthy()
    expect(screen.getByTestId('mock-stats').getAttribute('data-visible')).toBe('false')
  })

  it('clicking Port Forwarding opens the sidebar to that panel', () => {
    render(<SSHRightSidebar shellKey={shellKey} connectionId="conn-1" />)
    fireEvent.click(screen.getByRole('button', { name: /port forwarding/i }))

    expect(screen.getByTestId('mock-forwards').getAttribute('data-visible')).toBe('true')
    expect(useDevDeckStore.getState().sshRightSidebars[shellKey]?.open).toBe(true)
    expect(useDevDeckStore.getState().sshRightSidebars[shellKey]?.panel).toBe('forwards')
  })

  it("clicking the active panel's icon again closes the sidebar", () => {
    useDevDeckStore.setState({ sshRightSidebars: { [shellKey]: { open: true, panel: 'stats', width: 300 } } })
    render(<SSHRightSidebar shellKey={shellKey} connectionId="conn-1" />)
    fireEvent.click(screen.getByRole('button', { name: /^stats$/i }))

    expect(useDevDeckStore.getState().sshRightSidebars[shellKey]?.open).toBe(false)
    // Panel choice survives the close, so reopening returns to the same tab.
    expect(useDevDeckStore.getState().sshRightSidebars[shellKey]?.panel).toBe('stats')
  })

  it('switches panels without closing when the sidebar is already open', () => {
    useDevDeckStore.setState({ sshRightSidebars: { [shellKey]: { open: true, panel: 'stats', width: 300 } } })
    render(<SSHRightSidebar shellKey={shellKey} connectionId="conn-1" />)
    fireEvent.click(screen.getByRole('button', { name: /port forwarding/i }))

    expect(useDevDeckStore.getState().sshRightSidebars[shellKey]?.open).toBe(true)
    expect(useDevDeckStore.getState().sshRightSidebars[shellKey]?.panel).toBe('forwards')
  })

  it('does not remount the hidden panel when toggling closed then open again', () => {
    render(<SSHRightSidebar shellKey={shellKey} connectionId="conn-1" />)
    fireEvent.click(screen.getByRole('button', { name: /port forwarding/i }))
    fireEvent.click(screen.getByRole('button', { name: /port forwarding/i })) // closes
    fireEvent.click(screen.getByRole('button', { name: /port forwarding/i })) // reopens

    expect(forwardsMounts).toBe(1)
  })

  it('opens the chat panel when the DevOps Chat rail button is pressed', async () => {
    render(<SSHRightSidebar shellKey={shellKey} connectionId="conn-1" />)
    const button = screen.getByRole('button', { name: 'DevOps Chat' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps the chat panel mounted when switching to Stats', async () => {
    render(<SSHRightSidebar shellKey={shellKey} connectionId="conn-1" />)
    await userEvent.click(screen.getByRole('button', { name: 'DevOps Chat' }))
    const panel = screen.getByTestId('ssh-chat-panel')
    await userEvent.click(screen.getByRole('button', { name: 'Stats' }))
    expect(screen.getByTestId('ssh-chat-panel')).toBe(panel)
  })
})

// An SSH host accumulates chat sessions the same way a worktree does, but the
// panel was hardcoded to one thread (`ssh:<id>`) with no way to see or reach
// the others — even though the backend already grouped them: the store derives
// a thread's worktree_id by cutting at `::`, so `ssh:<id>` and
// `ssh:<id>::chat-N` have always listed together.
describe('SSHRightSidebar — session history', () => {
  // The rail's Sessions button opened a full-height list in place of the
  // conversation. The chat header's own history popover
  // (`SSHAgentChatPanel.test.tsx`) reaches the same `SessionsPanel` without
  // replacing what you were reading, so the rail entry is gone.
  it('no longer offers a Sessions button in the rail', () => {
    render(<SSHRightSidebar shellKey="s1" connectionId="conn-1" />)

    expect(screen.queryByRole('button', { name: 'Sessions' })).toBeNull()
    expect(screen.queryByTestId('ssh-sessions-panel')).toBeNull()
  })

  it("still scopes the thread list to this connection's own namespace", () => {
    // Now read by the chat panel itself rather than by a rail tab — the
    // worktree id is the contract that matters, not which component asks.
    render(<SSHRightSidebar shellKey="s1" connectionId="conn-1" />)

    expect(mockUseAgentThreads).toHaveBeenCalled()
    const worktreeIds = mockUseAgentThreads.mock.calls.map((call) => call[1])
    expect(worktreeIds).toContain('ssh:conn-1')
  })

  it('reopens on Chat for an operator whose rail was last left on Sessions', () => {
    // The slice is persisted, so this value survives the release that removed
    // the panel. Without the migration in `sshRightSidebarState` the rail would
    // open with no button lit over an empty body.
    useDevDeckStore.setState({ sshRightSidebars: { s1: { open: true, panel: 'sessions', width: 300 } } })
    render(<SSHRightSidebar shellKey="s1" connectionId="conn-1" />)

    expect(screen.getByRole('button', { name: 'DevOps Chat' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('ssh-chat-panel').className).toContain('flex')
  })

  // The reported bug: closing and reopening this SSH tab (a fresh
  // `SSHRightSidebar` mount) always landed the chat panel back on the very
  // first conversation ever had with this host (`ssh:conn-1`), no matter how
  // many newer sessions existed since. `AgentThreads` orders newest-touched
  // first, so absent an explicit pick this mount should default to
  // `sessions.data[0]`, not the primary/first-ever thread.
  it('defaults the chat panel to the most recently touched session, not the primary thread', () => {
    mockUseAgentThreads.mockReturnValue({
      data: [
        { id: 'ssh:conn-1::chat-2', worktreeId: 'ssh:conn-1', title: 'newest', status: 'idle', createdAt: 1, updatedAt: 300 },
        { id: 'ssh:conn-1::chat-1', worktreeId: 'ssh:conn-1', title: 'middle', status: 'idle', createdAt: 1, updatedAt: 200 },
        { id: 'ssh:conn-1', worktreeId: 'ssh:conn-1', title: 'oldest', status: 'idle', createdAt: 1, updatedAt: 100 },
      ],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    })
    render(<SSHRightSidebar shellKey="s1" connectionId="conn-1" />)

    expect(screen.getByTestId('mock-agent-chat-pane').textContent).toBe('ssh:conn-1::chat-2')
  })

  it('falls back to the primary thread while there is no session history yet', () => {
    mockUseAgentThreads.mockReturnValue({ data: [], isLoading: false, error: null, refetch: vi.fn() })
    render(<SSHRightSidebar shellKey="s1" connectionId="conn-1" />)

    expect(screen.getByTestId('mock-agent-chat-pane').textContent).toBe('ssh:conn-1')
  })
})

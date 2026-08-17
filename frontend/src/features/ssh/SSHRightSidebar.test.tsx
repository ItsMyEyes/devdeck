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

vi.mock('@/features/data/queries', () => ({
  useSSHConnections: () => ({ data: [] }),
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

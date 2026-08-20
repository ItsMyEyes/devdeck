/**
 * The SSH chat panel's own contribution to the chat header: a session-history
 * popover and a new-session button (`SSHAgentChatPanel.tsx`'s `headerActions`).
 *
 * `AgentChatPane` is mocked down to just its `headerActions` slot — the real
 * one owns a WebSocket (`useAgentChatSocket`) that nothing here wants opened,
 * and the slot's contents are the whole subject of this file. Rendering the
 * mock's `headerActions` (rather than dropping the prop, as
 * `SSHRightSidebar.test.tsx`'s own mock of the same module does) is what makes
 * these buttons reachable at all.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SSHAgentChatPanel } from './SSHAgentChatPanel'

vi.mock('@/features/agent-chat/AgentChatPane', () => ({
  AgentChatPane: (props: { threadKey: string; headerActions?: ReactNode }) => (
    <div data-testid="mock-agent-chat-pane">
      <span data-testid="thread-key">{props.threadKey}</span>
      <div data-testid="header-actions">{props.headerActions}</div>
    </div>
  ),
}))

const threads = vi.fn(() => ({
  data: [
    { id: 'ssh:conn-1', title: 'Restart nginx', status: 'idle', updatedAt: Date.now(), planReady: false },
    { id: 'ssh:conn-1::chat-1', title: 'Disk usage', status: 'running', updatedAt: Date.now(), planReady: false },
  ] as unknown[],
  isLoading: false,
  error: null,
  refetch: vi.fn(),
}))

// DevOps chat runs on the connection's executor runtime, so the panel only
// renders a chat at all once that machine is resolved AND advertises the
// capability (see sshChatAvailability.ts). These header-action tests are about
// the chat chrome, so the fixture below is the fully-ready case; the gating
// itself is covered by sshChatAvailability.test.ts.
vi.mock('@/features/data/queries', () => ({
  useSSHConnections: () => ({ data: [{ id: 'conn-1', name: 'Superapps Dev 02', executorMachineId: 'm-1' }] }),
  useMachines: () => ({ data: [{ id: 'm-1', name: 'superapps-dev-02', url: 'http://m-1:7777', key: 'k', isLocal: false, signingPublicKey: '' }] }),
  useMachineCapabilities: () => ({ data: ['ssh-chat'], isError: false }),
  useAgentThreads: () => threads(),
  useDeleteAgentThread: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}))

afterEach(cleanup)

describe('SSHAgentChatPanel header actions', () => {
  let onSelectThread: (threadKey: string) => void

  beforeEach(() => {
    onSelectThread = vi.fn()
  })

  function renderPanel(props: { onSelectThread?: (key: string) => void; threadKey?: string } = {}) {
    return render(
      <SSHAgentChatPanel
        connectionId="conn-1"
        visible
        threadKey={props.threadKey ?? 'ssh:conn-1'}
        onSelectThread={'onSelectThread' in props ? props.onSelectThread : onSelectThread}
      />,
    )
  }

  it('puts a session-history and a new-session button in the chat header', () => {
    renderPanel()

    const actions = screen.getByTestId('header-actions')
    expect(actions).toContainElement(screen.getByRole('button', { name: 'Session history' }))
    expect(actions).toContainElement(screen.getByRole('button', { name: 'New session' }))
  })

  it('renders neither button when there is no way to switch sessions', () => {
    // A caller that pins one thread has nothing for these to do, so they are
    // absent rather than present-and-inert.
    renderPanel({ onSelectThread: undefined })

    expect(screen.queryByRole('button', { name: 'Session history' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull()
  })

  it('opens this connection’s existing sessions from the history button', async () => {
    renderPanel()

    await userEvent.click(screen.getByRole('button', { name: 'Session history' }))

    expect(await screen.findByText('Restart nginx')).toBeInTheDocument()
    expect(screen.getByText('Disk usage')).toBeInTheDocument()

    await userEvent.click(screen.getByText('Disk usage'))
    expect(onSelectThread).toHaveBeenCalledWith('ssh:conn-1::chat-1')
  })

  it('starts the next unused session key from the new-session button', async () => {
    // `ssh:conn-1` and `::chat-1` are taken above, so the first free one is
    // `::chat-2` — no create request goes out, the key alone is the session
    // (the thread is written by its socket's hello).
    renderPanel()

    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onSelectThread).toHaveBeenCalledWith('ssh:conn-1::chat-2')
  })

  it('shows the requested session, not always the primary thread', () => {
    renderPanel({ threadKey: 'ssh:conn-1::chat-1' })

    expect(screen.getByTestId('thread-key').textContent).toBe('ssh:conn-1::chat-1')
  })
})

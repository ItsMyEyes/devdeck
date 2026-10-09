import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import type { Workspace } from '@/store/types'
import { AgentWorkspace } from '@/features/agent-workspace/AgentWorkspace'
vi.mock('@/features/browser/useNativeOverlayBlocker', () => ({
  useNativeOverlayBlocker: () => {},
}))
const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  ssh: false,
  failScene: false,
  spawn: vi.fn(),
  navigate: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))
vi.mock('@/store/useDevDeckStore', () => ({
  useDevDeckStore: (select: (s: unknown) => unknown) =>
    select({ openSpawn: mocks.spawn, openWorktreeTab: vi.fn() }),
}))
vi.mock('@/features/agent-workspace/OfficeScene', () => ({
  default: () => {
    if (mocks.failScene) throw new Error('WebGL unavailable')
    return <div>Office canvas</div>
  },
}))
vi.mock('@/features/agent-chat/AgentChatPane', () => ({
  AgentChatPane: (props: unknown) => {
    mocks.chat(props)
    return <div>Existing chat</div>
  },
}))
vi.mock('@/features/ssh/SSHAgentChatPanel', () => ({
  SSHAgentChatPanel: () => <div>SSH chat</div>,
  HUB_MACHINE: { id: '', name: 'This server' },
}))
vi.mock('@/features/agent-workspace/useOfficeOverview', () => ({
  useOfficeOverview: () => ({
    visible: true,
    loading: false,
    catalogError: false,
    refresh: vi.fn(),
    sources: [{ id: 'hub', name: 'Local', sampledAt: 1 }],
    members: [
      {
        key: 'member',
        sourceId: 'hub',
        sourceName: 'Local',
        id: 'thread',
        connectionId: mocks.ssh ? 'connection' : undefined,
        projectId: 'p',
        worktreeId: 'w',
        title: 'Inspect tests',
        agent: 'codex',
        model: 'test',
        status: 'waiting',
        turnInFlight: true,
        approvals: 1,
        questions: 0,
        planReady: false,
        activity: 'Approval needed',
        updatedAt: 1,
        subagents: [],
        recent: [],
        stale: false,
        limited: false,
      },
    ],
  }),
}))
const workspace = {
  id: 'ws',
  name: 'Studio',
  projects: [
    {
      id: 'p',
      name: 'Project',
      worktrees: [{ id: 'w', branch: 'feature', agent: 'codex' }],
      issues: [],
    },
  ],
  todos: [],
  news: [],
  invoices: [],
} as unknown as Workspace
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.ssh = false
  mocks.failScene = false
})
describe('Agent Workspace', () => {
  it('does not mount chat until a session is selected, then uses its actual thread', async () => {
    render(<AgentWorkspace workspace={workspace} />)
    expect(mocks.chat).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: /Inspect tests.*Approval needed/i }),
    )
    expect(await screen.findByText('Existing chat')).toBeInTheDocument()
    expect(mocks.chat.mock.calls.at(-1)?.[0]).toMatchObject({
      threadKey: 'thread',
      worktreeId: 'w',
    })
  })
  it('opens the existing spawn flow without sending any agent command', () => {
    render(<AgentWorkspace workspace={workspace} />)
    fireEvent.click(screen.getByRole('button', { name: /New agent/i }))
    expect(mocks.spawn).toHaveBeenCalled()
    expect(mocks.chat).not.toHaveBeenCalled()
  })
})

it('opens runtime-local SSH chat without requiring the hub machine registry', async () => {
  mocks.ssh = true
  render(<AgentWorkspace workspace={workspace} />)
  fireEvent.click(
    screen.getByRole('button', { name: /Inspect tests.*Approval needed/i }),
  )
  expect(await screen.findByText('Existing chat')).toBeInTheDocument()
  expect(mocks.chat.mock.calls.at(-1)?.[0]).toMatchObject({
    threadKey: 'thread',
    target: { kind: 'hub' },
    mentionSource: expect.anything(),
  })
})

it('keeps the keyboard-operable session roster when the renderer fails', async () => {
  mocks.failScene = true
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  render(<AgentWorkspace workspace={workspace} />)
  expect(await screen.findByText('3D view unavailable')).toBeInTheDocument()
  const session = screen.getByRole('button', {
    name: /Inspect tests.*Approval needed/i,
  })
  session.focus()
  expect(session).toHaveFocus()
  fireEvent.click(session)
  expect(await screen.findByText('Existing chat')).toBeInTheDocument()
  errors.mockRestore()
})

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
  scene: vi.fn(),
  status: 'waiting',
  count: 1,
  otherProject: false,
  child: false,
  loading: false,
  archived: false,
  name: undefined as string | undefined,
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))
vi.mock('@/store/useDevDeckStore', () => ({
  useDevDeckStore: (select: (s: unknown) => unknown) =>
    select({ openSpawn: mocks.spawn, openWorktreeTab: vi.fn() }),
}))
vi.mock('@/features/agent-workspace/OfficeScene', () => ({
  default: (props: { view: string }) => {
    mocks.scene(props)
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
    loading: mocks.loading,
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
        characterName: mocks.name,
        archivedAt: mocks.archived ? 100 : 0,
        agent: 'codex',
        model: 'test',
        status: mocks.status,
        turnInFlight: true,
        approvals: mocks.status === 'waiting' ? 1 : 0,
        questions: 0,
        planReady: false,
        activity: 'Approval needed',
        updatedAt: 1,
        subagents: mocks.child
          ? [
              {
                id: 'child',
                title: 'Check deployment',
                role: 'Inspect',
                status: 'running',
                activity: 'Reading',
                updatedAt: 1,
              },
            ]
          : [],
        recent: [{ id: 'event', text: 'Fixture activity', createdAt: 1 }],
        stale: false,
        limited: false,
      },
    ].flatMap((m) =>
      Array.from({ length: mocks.count }, (_, i) => ({
        ...m,
        key: i ? `member${i}` : m.key,
        id: mocks.otherProject
          ? i < 25
            ? `a${i}`
            : `z${i}`
          : i
            ? `thread${i}`
            : m.id,
        projectId: mocks.otherProject && i < 25 ? 'other' : m.projectId,
      })),
    ),
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
  localStorage.clear()
  vi.clearAllMocks()
  mocks.loading = false
  mocks.archived = false
  mocks.name = undefined
  mocks.child = false
  mocks.otherProject = false
  mocks.status = 'waiting'
  mocks.count = 1
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

it('opens a selected SSH session on DevOps, and preserves chat when changing floors manually', async () => {
  mocks.ssh = true
  render(<AgentWorkspace workspace={workspace} />)
  expect(await screen.findByText('Office canvas')).toBeInTheDocument()
  expect(mocks.scene.mock.calls.at(-1)?.[0].view).toBe('building')
  fireEvent.click(
    screen.getByRole('button', { name: /Inspect tests.*Approval needed/i }),
  )
  expect(await screen.findByText('Existing chat')).toBeInTheDocument()
  expect(mocks.scene.mock.calls.at(-1)?.[0].view).toBe('devops')
  fireEvent.click(screen.getByRole('button', { name: /^1 · Developer/ }))
  expect(mocks.scene.mock.calls.at(-1)?.[0].view).toBe('developer')
  expect(screen.getByText('Existing chat')).toBeInTheDocument()
  expect(mocks.chat.mock.calls.at(-1)?.[0].threadKey).toBe('thread')
  expect(localStorage.getItem('devdeck.office-view.ws')).toBe('developer')
})
it('changes floor from project/SSH filters and restores per-workspace view', async () => {
  localStorage.setItem('devdeck.office-view.ws', 'devops')
  const { rerender } = render(<AgentWorkspace workspace={workspace} />)
  await screen.findByText('Office canvas')
  expect(mocks.scene.mock.calls.at(-1)?.[0].view).toBe('devops')
  fireEvent.change(screen.getByLabelText('View'), { target: { value: 'p' } })
  expect(mocks.scene.mock.calls.at(-1)?.[0].view).toBe('developer')
  fireEvent.change(screen.getByLabelText('View'), {
    target: { value: 'shared-ssh' },
  })
  expect(mocks.scene.mock.calls.at(-1)?.[0].view).toBe('devops')
  rerender(<AgentWorkspace workspace={{ ...workspace, id: 'other' }} />)
  expect(mocks.scene.mock.calls.at(-1)?.[0].view).toBe('building')
})

it('resets the active saved camera even while the HTML fallback list is open', async () => {
  localStorage.setItem('devdeck.office-camera.ws.building', '{}')
  localStorage.setItem('devdeck.office-camera.ws.devops', '{}')
  render(<AgentWorkspace workspace={workspace} />)
  await screen.findByText('Office canvas')
  fireEvent.click(screen.getByRole('button', { name: 'Show session list' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reset camera' }))
  expect(localStorage.getItem('devdeck.office-camera.ws.building')).toBeNull()
  expect(localStorage.getItem('devdeck.office-camera.ws.devops')).toBe('{}')
})

it('removes idle scene previews when the division history is collapsed', async () => {
  mocks.status = 'idle'
  render(<AgentWorkspace workspace={workspace} />)
  await screen.findByText('Office canvas')
  const history = screen
    .getByRole('region', { name: '1 · Developer sessions' })
    .querySelector('details')!
  history.open = true
  fireEvent(history, new Event('toggle'))
  expect(mocks.scene.mock.calls.at(-1)?.[0].members).toHaveLength(1)
  history.open = false
  fireEvent(history, new Event('toggle'))
  expect(mocks.scene.mock.calls.at(-1)?.[0].members).toHaveLength(0)
})
it('keeps every busy session in the roster but pins selection within twenty scene slots', async () => {
  mocks.count = 35
  render(<AgentWorkspace workspace={workspace} />)
  await screen.findByText('Office canvas')
  const sessions = screen.getAllByRole('button', {
    name: /Inspect tests.*Approval needed/i,
  })
  expect(sessions).toHaveLength(35)
  fireEvent.click(sessions[34])
  await screen.findByText('Existing chat')
  const props = mocks.scene.mock.calls.at(-1)?.[0]
  expect(props.members).toHaveLength(20)
  expect(props.allMembers).toHaveLength(20)
  expect(props.members.some((s: { id: string }) => s.id === 'thread34')).toBe(
    true,
  )
  expect(
    props.allMembers.some((s: { id: string }) => s.id === 'thread34'),
  ).toBe(true)
})

it('gives every filtered visible session a desk even outside the global twenty most recent slots', async () => {
  mocks.count = 35
  mocks.otherProject = true
  render(<AgentWorkspace workspace={workspace} />)
  await screen.findByText('Office canvas')
  fireEvent.change(screen.getByLabelText('View'), { target: { value: 'p' } })
  const props = mocks.scene.mock.calls.at(-1)?.[0]
  expect(props.members).toHaveLength(10)
  expect(
    props.members.every((m: { key: string }) =>
      props.allMembers.some((d: { key: string }) => d.key === m.key),
    ),
  ).toBe(true)
})
it('filters the activity feed by floor and opens a SSH subagent in its parent chat', async () => {
  mocks.ssh = true
  mocks.child = true
  render(<AgentWorkspace workspace={workspace} />)
  await screen.findByText('Office canvas')
  expect(screen.getByText('Fixture activity')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /^1 · Developer/ }))
  expect(screen.queryByText('Fixture activity')).not.toBeInTheDocument()
  const details = screen
    .getByRole('region', { name: '2 · DevOps sessions' })
    .querySelector<HTMLDetailsElement>('details.office-subagents')!
  details.open = true
  fireEvent.click(screen.getByRole('button', { name: /Check deployment/ }))
  await screen.findByText('Existing chat')
  expect(mocks.scene.mock.calls.at(-1)?.[0].view).toBe('devops')
  expect(mocks.chat.mock.calls.at(-1)?.[0].threadKey).toBe('thread')
  expect(
    screen.getByText('Continue in the parent conversation below.'),
  ).toBeInTheDocument()
})
it('waits for the initial overview before mounting the camera with its workspace footprint', async () => {
  mocks.loading = true
  const { rerender } = render(<AgentWorkspace workspace={workspace} />)
  expect(screen.getByText('Connecting to your office…')).toBeInTheDocument()
  expect(mocks.scene).not.toHaveBeenCalled()
  mocks.loading = false
  rerender(<AgentWorkspace workspace={workspace} />)
  expect(await screen.findByText('Office canvas')).toBeInTheDocument()
})

it('moves focus and selects floors with arrow keys', async () => {
  render(<AgentWorkspace workspace={workspace} />)
  await screen.findByText('Office canvas')
  const developer = screen.getByRole('button', { name: /^1 · Developer/ })
  developer.focus()
  fireEvent.keyDown(developer, { key: 'ArrowRight' })
  expect(mocks.scene.mock.calls.at(-1)?.[0].view).toBe('devops')
  expect(screen.getByRole('button', { name: /^2 · DevOps/ })).toHaveFocus()
})

it('focuses the chosen floor for WebKit keyboard navigation after clicking', async () => {
  render(<AgentWorkspace workspace={workspace} />)
  await screen.findByText('Office canvas')
  const developer = screen.getByRole('button', { name: /^1 · Developer/ })
  fireEvent.click(developer)
  expect(developer).toHaveFocus()
})

it('keeps an ended session out of the office and opens retained history without adding an avatar', async () => {
  mocks.archived = true
  mocks.name = 'Arka Wijaya'
  render(<AgentWorkspace workspace={workspace} />)
  expect(
    screen.queryByRole('button', { name: /Inspect tests.*Approval needed/i }),
  ).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Riwayat sesi' }))
  fireEvent.click(
    await screen.findByRole('button', { name: /Arka Wijaya.*Inspect tests/i }),
  )
  expect(await screen.findByText('Existing chat')).toBeInTheDocument()
  expect(mocks.chat.mock.calls.at(-1)?.[0]).toMatchObject({
    threadKey: 'thread',
    archived: true,
  })
  expect(mocks.scene.mock.calls.at(-1)?.[0].members).toHaveLength(0)
})
it('shows persistent character name together with the unchanged chat title', () => {
  mocks.name = 'Arka Wijaya'
  render(<AgentWorkspace workspace={workspace} />)
  expect(screen.getByText('Arka Wijaya')).toBeInTheDocument()
  expect(screen.getAllByText('Inspect tests').length).toBeGreaterThan(0)
})

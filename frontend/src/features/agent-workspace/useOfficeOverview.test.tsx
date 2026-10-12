import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor, cleanup, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { Machine, Workspace, SSHConnection } from '@/store/types'
import { useOfficeOverview } from '@/features/agent-workspace/useOfficeOverview'
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  role: 'hub' as string,
  machineId: '',
  machines: [] as Machine[],
  connections: [] as SSHConnection[],
}))
vi.mock('@/lib/api', () => ({
  request: (...args: unknown[]) => mocks.request(...args),
}))
vi.mock('@/lib/machineClient', () => ({
  resolveMachineRest: async () => ({ base: '/runtime/api' }),
}))
vi.mock('@/features/data/queries', () => ({
  useWhoami: () => ({
    data: { role: mocks.role, machineId: mocks.machineId },
    refetch: vi.fn(),
  }),
  useMachines: () => ({ data: mocks.machines, refetch: vi.fn() }),
  useSSHConnections: () => ({ data: mocks.connections, refetch: vi.fn() }),
}))
const workspace = {
  id: 'ws',
  projects: [],
  todos: [],
  news: [],
  invoices: [],
} as unknown as Workspace
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.role = 'hub'
  mocks.machineId = ''
  mocks.machines = []
  mocks.connections = []
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  })
})
describe('office overview lifecycle', () => {
  it('only reads metadata and does not connect any agent socket', async () => {
    const socket = vi.spyOn(globalThis, 'WebSocket')
    mocks.request.mockImplementation(async (_method, path) =>
      path === '/whoami'
        ? { capabilities: ['agent-workspace-overview'] }
        : { workspaceId: 'ws', sampledAt: Date.now(), sessions: [] },
    )
    const { result } = renderHook(() => useOfficeOverview(workspace), {
      wrapper,
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(socket).not.toHaveBeenCalled()
    expect(mocks.request.mock.calls.every((call) => call[0] === 'GET')).toBe(
      true,
    )
    socket.mockRestore()
  })
  it('does not poll while the page is hidden', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    renderHook(() => useOfficeOverview(workspace), { wrapper })
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('marks an unreachable source as an error instead of an empty live office', async () => {
    mocks.request.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useOfficeOverview(workspace), {
      wrapper,
    })
    await waitFor(() => expect(result.current.sources[0].error).toBe(true))
  })
})

it('uses receipt time rather than a remote clock to decide staleness', async () => {
  const scoped = {
    ...workspace,
    projects: [{ id: 'p', machineId: '', worktrees: [{ id: 'w' }] }],
  } as unknown as Workspace
  mocks.request.mockImplementation(async (_method, path) =>
    path === '/whoami'
      ? { capabilities: ['agent-workspace-overview'] }
      : {
          workspaceId: 'ws',
          sampledAt: 1,
          sessions: [
            {
              id: 'w',
              worktreeId: 'w',
              status: 'idle',
              subagents: [],
              recent: [],
            },
          ],
        },
  )
  const { result } = renderHook(() => useOfficeOverview(scoped), { wrapper })
  await waitFor(() => expect(result.current.members).toHaveLength(1))
  expect(result.current.members[0].stale).toBe(false)
})

it('owns local projects on a combined hub/runtime even when whoami has a runtime ID', async () => {
  mocks.role = 'both'
  mocks.machineId = 'local-runtime'
  const scoped = {
    ...workspace,
    projects: [{ id: 'p', machineId: '', worktrees: [{ id: 'w' }] }],
  } as unknown as Workspace
  mocks.request.mockImplementation(async (_method, path) =>
    path === '/whoami'
      ? { capabilities: ['agent-workspace-overview'] }
      : {
          workspaceId: 'ws',
          sampledAt: Date.now(),
          sessions: [
            {
              id: 'w',
              worktreeId: 'w',
              status: 'idle',
              subagents: [],
              recent: [],
            },
          ],
        },
  )
  const { result } = renderHook(() => useOfficeOverview(scoped), { wrapper })
  await waitFor(() => expect(result.current.members).toHaveLength(1))
  expect(result.current.members[0].sourceId).toBe('hub')
})

it('keeps only the owning runtime copy of a duplicated catalog thread', async () => {
  mocks.machines = [{ id: 'runtime', name: 'Remote' } as Machine]
  const scoped = {
    ...workspace,
    projects: [{ id: 'p', machineId: 'runtime', worktrees: [{ id: 'w' }] }],
  } as unknown as Workspace
  mocks.request.mockImplementation(async (_method, path) =>
    path === '/whoami'
      ? { capabilities: ['agent-workspace-overview'] }
      : {
          workspaceId: 'ws',
          sampledAt: Date.now(),
          sessions: [
            {
              id: 'same',
              worktreeId: 'w',
              status: 'running',
              subagents: [],
              recent: [],
            },
          ],
        },
  )
  const { result } = renderHook(() => useOfficeOverview(scoped), { wrapper })
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.members).toHaveLength(1)
  expect(result.current.members[0].sourceId).toBe('runtime')
})
it('uses limited metadata on an older runtime without inventing running AI activity', async () => {
  const scoped = {
    ...workspace,
    projects: [{ id: 'p', worktrees: [{ id: 'w' }] }],
  } as unknown as Workspace
  mocks.request.mockImplementation(async (_method, path) =>
    path === '/whoami'
      ? { capabilities: [] }
      : [
          {
            id: 'w',
            title: 'Legacy',
            status: 'running',
            agentId: 'claude',
            updatedAt: 1,
          },
        ],
  )
  const { result } = renderHook(() => useOfficeOverview(scoped), { wrapper })
  await waitFor(() => expect(result.current.members).toHaveLength(1))
  expect(result.current.members[0]).toMatchObject({
    limited: true,
    status: 'unknown',
    turnInFlight: false,
  })
  expect(
    mocks.request.mock.calls.some((c) => c[1].includes('workspace-overview')),
  ).toBe(false)
})
it('retains stale sessions while offline and unlocks them after reconnection', async () => {
  const scoped = {
    ...workspace,
    projects: [{ id: 'p', worktrees: [{ id: 'w' }] }],
  } as unknown as Workspace
  const healthy = async (_method: unknown, path: string) =>
    path === '/whoami'
      ? { capabilities: ['agent-workspace-overview'] }
      : {
          workspaceId: 'ws',
          sampledAt: Date.now(),
          sessions: [
            {
              id: 'w',
              worktreeId: 'w',
              status: 'idle',
              subagents: [],
              recent: [],
            },
          ],
        }
  mocks.request.mockImplementation(healthy)
  const { result } = renderHook(() => useOfficeOverview(scoped), { wrapper })
  await waitFor(() => expect(result.current.members).toHaveLength(1))
  mocks.request.mockRejectedValue(new Error('offline'))
  act(() => result.current.refresh())
  await waitFor(() => expect(result.current.members[0].stale).toBe(true))
  mocks.request.mockImplementation(healthy)
  act(() => result.current.refresh())
  await waitFor(() => expect(result.current.members[0].stale).toBe(false))
})

it('enriches archived SSH metadata from its saved host without inventing a local override', async () => {
  mocks.connections = [
    {
      id: 'vm',
      name: 'Production VM',
      parentProject: 'AIGN',
      executorMachineId: null,
    } as SSHConnection,
  ]
  mocks.request.mockImplementation(async (_method, path) =>
    path === '/whoami'
      ? {
          capabilities: ['agent-workspace-overview', 'agent-session-lifecycle'],
        }
      : {
          workspaceId: 'ws',
          sampledAt: Date.now(),
          sessions: [
            {
              id: 'ssh:vm',
              connectionId: 'vm',
              characterName: 'Arka Wijaya',
              archivedAt: 100,
              status: 'stopped',
              subagents: [],
              recent: [],
            },
          ],
        },
  )
  const { result } = renderHook(() => useOfficeOverview(workspace), { wrapper })
  await waitFor(() => expect(result.current.members).toHaveLength(1))
  expect(result.current.members[0]).toMatchObject({
    characterName: 'Arka Wijaya',
    archivedAt: 100,
    parentProject: 'AIGN',
    hostName: 'Production VM',
    sourceId: 'hub',
    lifecycle: true,
  })
})

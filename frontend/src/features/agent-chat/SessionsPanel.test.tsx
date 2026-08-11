/**
 * Plan Task 8, step 1: "SessionsPanel: renders loading, error, and empty
 * states, highlights the active thread, and folds older entries behind
 * `Show more`." `useAgentThreads` is mocked (SessionsPanel owns its own
 * data fetching, mirroring `GitPanel`'s pattern — see this task's
 * `deviationsFromPlan` for why that shape was chosen over presentational
 * props: `ShellSidebar.test.tsx` renders this component unconditionally
 * whenever a `git` prop is given, with no `QueryClientProvider` in its
 * tree, the same reason `GitPanel` is mocked there today).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Machine } from '@/store/types'
import type { AgentThread } from '@/features/data/queries'

const mockUseAgentThreads = vi.fn()
const mockDeleteMutate = vi.fn()

vi.mock('@/features/data/queries', () => ({
  useAgentThreads: (machine: unknown, worktreeId: unknown) => mockUseAgentThreads(machine, worktreeId),
  useDeleteAgentThread: () => ({ mutate: mockDeleteMutate, isPending: false, variables: undefined }),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const { SessionsPanel, nextFreeThreadKey } = await import('./SessionsPanel')

const machine: Machine = {
  id: 'm1',
  name: 'Machine One',
  url: 'https://m1.example',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

function thread(overrides: Partial<AgentThread> = {}): AgentThread {
  return {
    id: 'wt-1',
    worktreeId: 'wt-1',
    instanceId: 'claude:default',
    title: '',
    agentId: 'claude',
    model: '',
    status: 'idle',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

const idleQuery = { data: undefined, isLoading: false, error: null, refetch: vi.fn() }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SessionsPanel', () => {
  it('renders a loading state', () => {
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, isLoading: true })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('renders an error state with a retry action', () => {
    const refetch = vi.fn()
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, error: new Error('offline'), refetch })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)

    expect(screen.getByText('offline')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('renders an empty state when there are no threads', () => {
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: [] })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)
    expect(screen.getByText(/no sessions/i)).toBeInTheDocument()
  })

  it('highlights the active thread', () => {
    mockUseAgentThreads.mockReturnValue({
      ...idleQuery,
      data: [thread({ id: 'wt-1', title: 'Fix the redirect' }), thread({ id: 'wt-1::chat-2', title: 'Second thread' })],
    })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} activeThreadKey="wt-1::chat-2" />)

    expect(screen.getByRole('button', { name: /^Second thread/ })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: /^Fix the redirect/ })).not.toHaveAttribute('aria-current')
  })

  it('calls onSelectThread with the thread id when a row is clicked', () => {
    const onSelectThread = vi.fn()
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: [thread({ id: 'wt-1', title: 'Fix the redirect' })] })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} onSelectThread={onSelectThread} />)

    fireEvent.click(screen.getByRole('button', { name: /^Fix the redirect/ }))
    expect(onSelectThread).toHaveBeenCalledWith('wt-1')
  })

  it('falls back to a placeholder title for an untitled thread', () => {
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: [thread({ id: 'wt-1', title: '' })] })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)
    expect(screen.getByText(/untitled/i)).toBeInTheDocument()
  })

  it('folds older entries behind Show more', () => {
    const threads = Array.from({ length: 7 }, (_, i) => thread({ id: `wt-1::chat-${i}`, title: `Session ${i}` }))
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: threads })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)

    expect(screen.getAllByRole('button', { name: /^Session \d/ })).toHaveLength(5)
    expect(screen.getByRole('button', { name: /show \d+ more/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /show \d+ more/i }))

    expect(screen.getAllByRole('button', { name: /^Session \d/ })).toHaveLength(7)
    expect(screen.queryByRole('button', { name: /show \d+ more/i })).toBeNull()
  })

  // The three verbs the panel shipped without: you could not start a session,
  // delete one, or (with only ever one row) switch between them.
  it('starts a new session on the first unused thread key', () => {
    const onSelectThread = vi.fn()
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: [thread({ id: 'wt-1' }), thread({ id: 'wt-1::chat-1' })] })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} onSelectThread={onSelectThread} />)

    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onSelectThread).toHaveBeenCalledWith('wt-1::chat-2')
  })

  // The empty state is exactly when a user most wants "new", and it used to be
  // a dead end.
  it('offers a new session from the empty state', () => {
    const onSelectThread = vi.fn()
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: [] })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} onSelectThread={onSelectThread} />)

    fireEvent.click(screen.getByRole('button', { name: /start a session/i }))
    expect(onSelectThread).toHaveBeenCalledWith('wt-1')
  })

  it('deletes a session once the confirm is accepted', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: [thread({ id: 'wt-1', title: 'Fix the redirect' })] })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)

    fireEvent.click(screen.getByRole('button', { name: /delete session/i }))
    expect(confirmSpy).toHaveBeenCalled()
    expect(mockDeleteMutate).toHaveBeenCalledWith('wt-1', expect.anything())
    confirmSpy.mockRestore()
  })

  // Erasing a transcript is irreversible, so declining must be a true no-op.
  it('does not delete when the confirm is declined', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: [thread({ id: 'wt-1', title: 'Fix the redirect' })] })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)

    fireEvent.click(screen.getByRole('button', { name: /delete session/i }))
    expect(mockDeleteMutate).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('renders no disclosure with five or fewer threads', () => {
    const threads = Array.from({ length: 5 }, (_, i) => thread({ id: `wt-1::chat-${i}`, title: `Session ${i}` }))
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: threads })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)

    expect(screen.getAllByRole('button', { name: /^Session \d/ })).toHaveLength(5)
    expect(screen.queryByRole('button', { name: /show \d+ more/i })).toBeNull()
  })
})

// The key space is fixed by paneTree.ts: the primary pane IS the bare
// worktree id, extras are `<worktreeId>::chat-N` starting at 1 (seq 0 would
// render a second tab also labelled "Chat 1").
describe('nextFreeThreadKey', () => {
  it('uses the bare worktree id first', () => {
    expect(nextFreeThreadKey('wt-1', [])).toBe('wt-1')
  })

  it('numbers extras from 1', () => {
    expect(nextFreeThreadKey('wt-1', ['wt-1'])).toBe('wt-1::chat-1')
    expect(nextFreeThreadKey('wt-1', ['wt-1', 'wt-1::chat-1'])).toBe('wt-1::chat-2')
  })

  // A deleted thread's events and receipts are erased with it, so its id
  // carries nothing forward and is safe to hand out again.
  it('reuses a number freed by a delete', () => {
    expect(nextFreeThreadKey('wt-1', ['wt-1', 'wt-1::chat-2'])).toBe('wt-1::chat-1')
  })
})

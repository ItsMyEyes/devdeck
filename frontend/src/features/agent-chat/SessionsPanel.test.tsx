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

const { SessionsPanel, nextFreeThreadKey, filterSessions } = await import('./SessionsPanel')

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
    planReady: false,
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

  // These two used to stub `window.confirm` — which is exactly why the suite
  // stayed green while deleting was impossible in the shipped desktop app.
  // Tauri's WKWebView implements no `runJavaScriptConfirmPanelWithMessage`
  // delegate, so the real `confirm()` returns false with no dialog, and the
  // guard returned early every time. Stubbing it to `true` tested a browser
  // that DevDeck does not run in. The confirmation is an in-app dialog now,
  // and these drive it the way a user does.
  it('deletes a session once the confirmation is accepted', async () => {
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: [thread({ id: 'wt-1', title: 'Fix the redirect' })] })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)

    fireEvent.click(screen.getByRole('button', { name: /delete session/i }))
    // Nothing may happen on the strength of the row button alone.
    expect(mockDeleteMutate).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByRole('button', { name: 'Delete session' }))
    expect(mockDeleteMutate).toHaveBeenCalledWith('wt-1', expect.anything())
  })

  // Erasing a transcript is irreversible, so declining must be a true no-op.
  it('does not delete when the confirmation is dismissed', async () => {
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: [thread({ id: 'wt-1', title: 'Fix the redirect' })] })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)

    fireEvent.click(screen.getByRole('button', { name: /delete session/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(mockDeleteMutate).not.toHaveBeenCalled()
  })

  // The regression guard proper: no code path here may depend on the native
  // dialog, because in the desktop build it silently answers "no".
  it('never calls window.confirm', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: [thread({ id: 'wt-1', title: 'Fix the redirect' })] })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)

    fireEvent.click(screen.getByRole('button', { name: /delete session/i }))
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  // Plan `2026-08-15-composer-plan-surface.md` T6: a "Plan" pill beside the
  // status dot when the thread has a plan on the table.
  it('renders a Plan pill for a thread with planReady true', () => {
    mockUseAgentThreads.mockReturnValue({
      ...idleQuery,
      data: [thread({ id: 'wt-1', title: 'Fix the redirect', planReady: true })],
    })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)
    expect(screen.getByText('Plan')).toBeInTheDocument()
  })

  it('renders no Plan pill for a thread with planReady false', () => {
    mockUseAgentThreads.mockReturnValue({
      ...idleQuery,
      data: [thread({ id: 'wt-1', title: 'Fix the redirect', planReady: false })],
    })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)
    expect(screen.queryByText('Plan')).toBeNull()
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

// Session history is only useful if you can find things in it — a worktree or
// an SSH host accumulates threads faster than a 5-row list can show.
describe('SessionsPanel — search', () => {
  // The search box is the only way to reach a session that has scrolled past
  // "Show more", so it must filter the WHOLE list, not just the visible slice.
  it('searches beyond the folded rows', () => {
    const threads = Array.from({ length: 7 }, (_, i) => thread({ id: `wt-1::chat-${i}`, title: `Session ${i}` }))
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: threads })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)

    // Session 6 is folded away behind "Show more" to begin with.
    expect(screen.queryByRole('button', { name: /^Session 6/ })).toBeNull()

    fireEvent.change(screen.getByRole('searchbox', { name: /search sessions/i }), { target: { value: 'Session 6' } })

    expect(screen.getByRole('button', { name: /^Session 6/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Session 1/ })).toBeNull()
  })

  it('says so when nothing matches, rather than showing an empty list', () => {
    const threads = Array.from({ length: 3 }, (_, i) => thread({ id: `wt-1::chat-${i}`, title: `Session ${i}` }))
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: threads })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)

    fireEvent.change(screen.getByRole('searchbox', { name: /search sessions/i }), { target: { value: 'zzz' } })
    expect(screen.getByText(/no sessions match/i)).toBeInTheDocument()
  })

  // A search box over one or two rows is furniture.
  it('does not offer search for a list short enough to read at a glance', () => {
    mockUseAgentThreads.mockReturnValue({ ...idleQuery, data: [thread({ id: 'wt-1', title: 'Only one' })] })
    render(<SessionsPanel worktreeId="wt-1" machine={machine} />)
    expect(screen.queryByRole('searchbox', { name: /search sessions/i })).toBeNull()
  })
})

describe('filterSessions', () => {
  const rows = [
    thread({ id: 't1', title: 'Fix the auth redirect' }),
    thread({ id: 't2', title: 'Add rate limiting' }),
    thread({ id: 't3', title: '' }),
  ]

  it('returns everything for an empty or whitespace query', () => {
    expect(filterSessions(rows, '')).toHaveLength(3)
    expect(filterSessions(rows, '   ')).toHaveLength(3)
  })

  it('matches titles case-insensitively on a substring', () => {
    expect(filterSessions(rows, 'AUTH').map((t) => t.id)).toEqual(['t1'])
    expect(filterSessions(rows, 'rate').map((t) => t.id)).toEqual(['t2'])
  })

  // Every term has to match, so a second word narrows instead of widening —
  // otherwise typing more makes the list grow, which reads as broken.
  it('narrows on each additional term rather than widening', () => {
    expect(filterSessions(rows, 'fix redirect').map((t) => t.id)).toEqual(['t1'])
    expect(filterSessions(rows, 'fix limiting')).toHaveLength(0)
  })

  // An untitled thread is still a real session someone may be looking for, and
  // it renders as "Untitled session" — so that is what it must match on.
  it('finds an untitled session by the label it actually shows', () => {
    expect(filterSessions(rows, 'untitled').map((t) => t.id)).toEqual(['t3'])
  })

  it('returns nothing when no session matches', () => {
    expect(filterSessions(rows, 'nonexistent')).toHaveLength(0)
  })
})

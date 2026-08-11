import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Machine, TerminalSession } from '@/store/types'

const mockUseTerminalSessions = vi.fn()
const mockUseKillTerminalSession = vi.fn()
const mockMutate = vi.fn()

vi.mock('@/features/data/queries', () => ({
  useTerminalSessions: (machine: Machine, enabled: boolean) => mockUseTerminalSessions(machine, enabled),
  useKillTerminalSession: (machine: Machine) => mockUseKillTerminalSession(machine),
}))

const { TerminalSessionsDialog } = await import('./TerminalSessionsDialog')

const machine: Machine = {
  id: 'm1',
  name: 'prod-runtime',
  url: 'http://runtime:9199',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

function session(over: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 'w-abc123',
    pid: 4242,
    command: 'claude',
    worktreeId: 'w-abc123',
    primary: true,
    attached: true,
    startedAt: new Date().toISOString(),
    lastOutputAt: new Date().toISOString(),
    bufferBytes: 2048,
    ...over,
  }
}

beforeEach(() => {
  mockUseKillTerminalSession.mockReturnValue({ mutate: mockMutate, isPending: false })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TerminalSessionsDialog', () => {
  it('renders a loading state while sessions are loading', () => {
    mockUseTerminalSessions.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null })

    render(<TerminalSessionsDialog machine={machine} open onOpenChange={() => {}} />)

    expect(screen.getByText(/loading sessions/i)).toBeTruthy()
  })

  it('renders an error state when the fetch fails', () => {
    mockUseTerminalSessions.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('machine unreachable'),
    })

    render(<TerminalSessionsDialog machine={machine} open onOpenChange={() => {}} />)

    expect(screen.getByText(/machine unreachable/i)).toBeTruthy()
  })

  it('renders a calm empty state when no sessions are running', () => {
    mockUseTerminalSessions.mockReturnValue({ data: [], isLoading: false, isError: false, error: null })

    render(<TerminalSessionsDialog machine={machine} open onOpenChange={() => {}} />)

    expect(screen.getByText(/no terminal sessions running on this machine/i)).toBeTruthy()
  })

  it('gates the query on the open prop, matching the maintenance-poll convention', () => {
    mockUseTerminalSessions.mockReturnValue({ data: [], isLoading: false, isError: false, error: null })

    render(<TerminalSessionsDialog machine={machine} open={false} onOpenChange={() => {}} />)

    expect(mockUseTerminalSessions).toHaveBeenCalledWith(machine, false)
  })

  it('shows primary vs pane and attached vs detached per row', () => {
    mockUseTerminalSessions.mockReturnValue({
      data: [
        session({ id: 'w-primary', primary: true, attached: true }),
        session({ id: 'w-primary::term-1', primary: false, attached: false, lastOutputAt: null }),
      ],
      isLoading: false,
      isError: false,
      error: null,
    })

    render(<TerminalSessionsDialog machine={machine} open onOpenChange={() => {}} />)

    expect(screen.getByText('w-primary')).toBeTruthy()
    expect(screen.getByText('w-primary::term-1')).toBeTruthy()
    expect(screen.getAllByText('primary')).toHaveLength(1)
    expect(screen.getAllByText('pane')).toHaveLength(1)
    expect(screen.getByText('attached')).toBeTruthy()
    expect(screen.getByText('detached')).toBeTruthy()
    expect(screen.getByText(/no output yet/i)).toBeTruthy()
  })

  it('kills a spawned pane session immediately, without a confirmation step', () => {
    mockUseTerminalSessions.mockReturnValue({
      data: [session({ id: 'w-abc::term-2', primary: false })],
      isLoading: false,
      isError: false,
      error: null,
    })

    render(<TerminalSessionsDialog machine={machine} open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /kill session w-abc::term-2/i }))

    expect(mockMutate).toHaveBeenCalledWith('w-abc::term-2', expect.anything())
  })

  it('requires an inline confirmation before killing a primary session', () => {
    mockUseTerminalSessions.mockReturnValue({
      data: [session({ id: 'w-abc', primary: true })],
      isLoading: false,
      isError: false,
      error: null,
    })

    render(<TerminalSessionsDialog machine={machine} open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /kill session w-abc/i }))

    // First click only reveals the confirmation - nothing is killed yet.
    expect(mockMutate).not.toHaveBeenCalled()
    expect(screen.getByText(/agent process/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /kill primary/i }))
    expect(mockMutate).toHaveBeenCalledWith('w-abc', expect.anything())
  })

  it('cancelling a primary-session confirmation does not kill it', () => {
    mockUseTerminalSessions.mockReturnValue({
      data: [session({ id: 'w-abc', primary: true })],
      isLoading: false,
      isError: false,
      error: null,
    })

    render(<TerminalSessionsDialog machine={machine} open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /kill session w-abc/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(mockMutate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /kill session w-abc/i })).toBeTruthy()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SSHForward, SSHForwardState } from '@/store/types'

// jsdom has no PointerEvent — @base-ui/react's Switch.Root dispatches one
// from its onClick handler unconditionally. Stub it so `fireEvent.click` on
// the switch doesn't throw (same pattern as SocksPublishSection.test.tsx and
// ShellSidebar.test.tsx).
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

const mockUseSSHForwards = vi.fn()
const mockUseSSHForwardStates = vi.fn()
const mockStart = vi.fn()
const mockStop = vi.fn()
const mockUpdate = vi.fn()
const mockCreate = vi.fn()
const mockDelete = vi.fn()

vi.mock('@/features/data/queries', () => ({
  useSSHForwards: (id: string) => mockUseSSHForwards(id),
  useSSHForwardStates: (enabled: boolean) => mockUseSSHForwardStates(enabled),
  useCreateSSHForward: () => ({ mutate: mockCreate, isPending: false }),
  useUpdateSSHForward: () => ({ mutate: mockUpdate, isPending: false }),
  useDeleteSSHForward: () => ({ mutate: mockDelete, isPending: false }),
  useStartSSHForward: () => ({ mutate: mockStart, isPending: false }),
  useStopSSHForward: () => ({ mutate: mockStop, isPending: false }),
}))

const { SSHForwardsPanel } = await import('./SSHForwardsPanel')

const localRule: SSHForward = {
  id: 'f1',
  connectionId: 'c1',
  mode: 'local',
  bindHost: '127.0.0.1',
  bindPort: 5432,
  targetHost: 'db.internal',
  targetPort: 5432,
  label: '',
}

function state(over: Partial<SSHForwardState> = {}): SSHForwardState {
  return { forwardId: 'f1', status: 'off', attempts: 0, ...over }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SSHForwardsPanel', () => {
  it('renders a loading state', () => {
    mockUseSSHForwards.mockReturnValue({ data: undefined, isLoading: true, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [] })

    render(<SSHForwardsPanel connectionId="c1" visible />)

    expect(screen.getByText(/loading/i)).toBeTruthy()
  })

  it('renders an empty state when there are no rules', () => {
    mockUseSSHForwards.mockReturnValue({ data: [], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [] })

    render(<SSHForwardsPanel connectionId="c1" visible />)

    expect(screen.getByText(/no forwarding rules/i)).toBeTruthy()
  })

  it('renders an error state', () => {
    mockUseSSHForwards.mockReturnValue({ data: undefined, isLoading: false, error: new Error('nope') })
    mockUseSSHForwardStates.mockReturnValue({ data: [] })

    render(<SSHForwardsPanel connectionId="c1" visible />)

    expect(screen.getByText(/nope/i)).toBeTruthy()
  })

  it('shows the rule with its bind and target', () => {
    mockUseSSHForwards.mockReturnValue({ data: [localRule], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [state()] })

    render(<SSHForwardsPanel connectionId="c1" visible />)

    expect(screen.getByText(/127\.0\.0\.1:5432/)).toBeTruthy()
    expect(screen.getByText(/db\.internal:5432/)).toBeTruthy()
  })

  it('editing a rule pre-fills the form and calls update, not create', () => {
    mockUseSSHForwards.mockReturnValue({ data: [localRule], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [state()] })

    render(<SSHForwardsPanel connectionId="c1" visible />)
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    const bindPortInput = screen.getByLabelText(/bind port/i)
    fireEvent.change(bindPortInput, { target: { value: '6543' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f1', body: expect.objectContaining({ bindPort: 6543 }) }),
    )
  })

  it('warns that saving restarts a rule that is currently running, but not one that is off', () => {
    mockUseSSHForwards.mockReturnValue({ data: [localRule], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [state({ status: 'running', boundAddr: '127.0.0.1:5432' })] })

    render(<SSHForwardsPanel connectionId="c1" visible />)
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))

    expect(screen.getByText(/saving restarts it/i)).toBeTruthy()
  })

  it('toggling an off rule starts it with the full rule body', () => {
    mockUseSSHForwards.mockReturnValue({ data: [localRule], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [state()] })

    render(<SSHForwardsPanel connectionId="c1" visible />)
    fireEvent.click(screen.getByRole('switch', { name: /toggle forward/i }))

    expect(mockStart).toHaveBeenCalledWith(localRule)
  })

  it('toggling a running rule stops it by id', () => {
    mockUseSSHForwards.mockReturnValue({ data: [localRule], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [state({ status: 'running', boundAddr: '127.0.0.1:5432' })] })

    render(<SSHForwardsPanel connectionId="c1" visible />)
    fireEvent.click(screen.getByRole('switch', { name: /toggle forward/i }))

    expect(mockStop).toHaveBeenCalledWith('f1')
  })

  it('surfaces a failed rule error', () => {
    mockUseSSHForwards.mockReturnValue({ data: [localRule], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({
      data: [state({ status: 'failed', error: 'port 5432 unavailable' })],
    })

    render(<SSHForwardsPanel connectionId="c1" visible />)

    expect(screen.getByText(/port 5432 unavailable/)).toBeTruthy()
  })

  it('warns when a rule binds a non-loopback address', () => {
    mockUseSSHForwards.mockReturnValue({
      data: [{ ...localRule, bindHost: '0.0.0.0' }],
      isLoading: false,
      error: null,
    })
    mockUseSSHForwardStates.mockReturnValue({ data: [state()] })

    render(<SSHForwardsPanel connectionId="c1" visible />)

    expect(screen.getByText(/reachable by anything/i)).toBeTruthy()
  })

  it('warns about the remote host, not the hub, for a non-loopback remote forward', () => {
    mockUseSSHForwards.mockReturnValue({
      data: [{ ...localRule, mode: 'remote' as const, bindHost: '0.0.0.0' }],
      isLoading: false,
      error: null,
    })
    mockUseSSHForwardStates.mockReturnValue({ data: [state()] })

    render(<SSHForwardsPanel connectionId="c1" visible />)

    expect(screen.getByText(/reachable by anything that can route to the remote host/i)).toBeTruthy()
    expect(screen.queryByText(/route to the hub/i)).toBeNull()
  })

  it('adds the GatewayPorts note for a non-loopback remote forward', () => {
    mockUseSSHForwards.mockReturnValue({
      data: [{ ...localRule, mode: 'remote' as const, bindHost: '0.0.0.0' }],
      isLoading: false,
      error: null,
    })
    mockUseSSHForwardStates.mockReturnValue({ data: [state()] })

    render(<SSHForwardsPanel connectionId="c1" visible />)

    expect(screen.getByText(/GatewayPorts/)).toBeTruthy()
  })

  it('shows a rule label as its primary line, with the address kept as a secondary line', () => {
    mockUseSSHForwards.mockReturnValue({ data: [{ ...localRule, label: 'Postgres' }], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [state()] })

    render(<SSHForwardsPanel connectionId="c1" visible />)

    expect(screen.getByText('Postgres')).toBeTruthy()
    expect(screen.getByText(/127\.0\.0\.1:5432/)).toBeTruthy()
  })

  it('opens the add dialog from the empty state and creates a rule from the form', () => {
    mockUseSSHForwards.mockReturnValue({ data: [], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [] })

    render(<SSHForwardsPanel connectionId="c1" visible />)
    fireEvent.click(screen.getByRole('button', { name: /add rule/i }))

    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/bind port/i), { target: { value: '8080' } })
    fireEvent.change(within(dialog).getByLabelText(/target host/i), { target: { value: 'app.internal' } })
    fireEvent.change(within(dialog).getByLabelText(/target port/i), { target: { value: '80' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /add rule/i }))

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'local', bindPort: 8080, targetHost: 'app.internal', targetPort: 80 }),
    )
  })

  it('rejects an out-of-range bind port instead of submitting', () => {
    mockUseSSHForwards.mockReturnValue({ data: [], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [] })

    render(<SSHForwardsPanel connectionId="c1" visible />)
    fireEvent.click(screen.getByRole('button', { name: /add rule/i }))

    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/bind port/i), { target: { value: '99999' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /add rule/i }))

    expect(mockCreate).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/bind port/i)
  })

  it('asks for confirmation before deleting a rule', () => {
    mockUseSSHForwards.mockReturnValue({ data: [localRule], isLoading: false, error: null })
    mockUseSSHForwardStates.mockReturnValue({ data: [state()] })

    render(<SSHForwardsPanel connectionId="c1" visible />)
    fireEvent.click(screen.getByRole('button', { name: /delete forward/i }))

    expect(mockDelete).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /delete forward/i }))

    expect(mockDelete).toHaveBeenCalledWith('f1')
  })
})

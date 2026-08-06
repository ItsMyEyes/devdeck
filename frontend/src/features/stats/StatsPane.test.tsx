import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { HostStats } from '@/store/types'

const mockUseMachineStats = vi.fn()
const mockUseSSHStats = vi.fn()

// StatsPane also imports useMachines to resolve a machineId to a Machine, so
// the mock factory must supply it too — a partial factory makes the import
// itself fail, not just the call.
vi.mock('@/features/data/queries', () => ({
  useMachines: () => ({
    data: [{ id: 'm1', name: 'local', url: '', key: '', isLocal: true, signingPublicKey: '' }],
    isLoading: false,
    error: null,
  }),
  useMachineStats: (...args: unknown[]) => mockUseMachineStats(...args),
  useSSHStats: (...args: unknown[]) => mockUseSSHStats(...args),
}))

// recharts needs layout the jsdom environment does not provide; the assertions
// here are about states and readouts, not SVG geometry.
vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}))

const { StatsPane } = await import('./StatsPane')

function stats(over: Partial<HostStats> = {}): HostStats {
  return {
    supported: true,
    cpuPct: 47,
    mem: { used: 6_200_000_000, total: 16_000_000_000 },
    disk: { used: 412_000_000_000, total: 932_000_000_000 },
    sampledAt: '2026-08-06T00:00:00Z',
    ...over,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('StatsPane', () => {
  it('renders a loading state before the first sample', () => {
    mockUseMachineStats.mockReturnValue({ data: undefined, isLoading: true, error: null })
    mockUseSSHStats.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<StatsPane target={{ kind: 'machine', machineId: 'm1' }} visible />)

    expect(screen.getByText(/loading/i)).toBeTruthy()
  })

  it('renders an error state', () => {
    mockUseMachineStats.mockReturnValue({ data: undefined, isLoading: false, error: new Error('offline') })
    mockUseSSHStats.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<StatsPane target={{ kind: 'machine', machineId: 'm1' }} visible />)

    expect(screen.getByText(/offline/i)).toBeTruthy()
  })

  it('renders the unsupported state with its reason', () => {
    mockUseSSHStats.mockReturnValue({
      data: stats({ supported: false, reason: 'this host has no readable /proc/stat — Linux only' }),
      isLoading: false,
      error: null,
    })
    mockUseMachineStats.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<StatsPane target={{ kind: 'ssh', connectionId: 'c1' }} visible />)

    expect(screen.getByText(/Linux only/i)).toBeTruthy()
  })

  it('shows CPU, memory and disk readouts when supported', () => {
    mockUseMachineStats.mockReturnValue({ data: stats(), isLoading: false, error: null })
    mockUseSSHStats.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<StatsPane target={{ kind: 'machine', machineId: 'm1' }} visible />)

    expect(screen.getByText('47%')).toBeTruthy()
    expect(screen.getByText(/CPU/i)).toBeTruthy()
    expect(screen.getByText(/MEM/i)).toBeTruthy()
    expect(screen.getByText(/DISK/i)).toBeTruthy()
  })

  it('shows a dash for CPU while the first delta is pending', () => {
    mockUseMachineStats.mockReturnValue({ data: stats({ cpuPct: null }), isLoading: false, error: null })
    mockUseSSHStats.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<StatsPane target={{ kind: 'machine', machineId: 'm1' }} visible />)

    expect(screen.getByText('—')).toBeTruthy()
  })

  it('polls only the query matching the target kind', () => {
    mockUseMachineStats.mockReturnValue({ data: stats(), isLoading: false, error: null })
    mockUseSSHStats.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<StatsPane target={{ kind: 'machine', machineId: 'm1' }} visible />)

    expect(mockUseMachineStats).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), true)
    expect(mockUseSSHStats).toHaveBeenCalledWith(undefined, false)
  })
})

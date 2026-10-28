import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const state = vi.hoisted(() => ({ offline: false, fail: false, used: 66 }))

vi.mock('@/features/data/queries', () => ({
  useWhoami: () => ({ data: { role: 'hub' } }),
  useMachines: () => ({ data: [{ id: 'm1', name: 'Laptop' }] }),
  useMachinesHealth: () => new Map([['m1', { status: state.offline ? 'offline' : 'online' }]]),
}))
vi.mock('@/lib/machineApi', () => ({ fetchAgentUsage: async (_machine: unknown, provider: string) => { if (state.fail) throw new Error('offline'); return ({ provider, status: 'available', fetchedAt: '2026-10-27T09:00:00Z', windows: [{ name: provider === 'antigravity' ? 'Gemini Models' : 'Codex', usedPercent: state.used, durationMinutes: 300, resetDescription: 'resets Oct 27 at 8:30pm (Asia/Jakarta)' }] }) } }))
import { AgentUsage } from '@/features/sidebar/AgentUsage'

describe('Agent usage', () => {
  beforeEach(() => { state.offline = false; state.fail = false; state.used = 66; localStorage.clear() })
  it('shows a provider usage window when opened', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><AgentUsage /></QueryClientProvider>)
    await userEvent.click(screen.getByLabelText('Codex usage'))
    expect(await screen.findByText('66% used')).toBeTruthy()
    expect(screen.getByText(/5 hours/)).toBeTruthy()
    expect(screen.getByText('resets Oct 27 at 8:30pm (Asia/Jakarta)')).toBeTruthy()
  })

  it.each([[0, 100], [66, 34], [100, 0]])('shows remaining quota for %i%% used', async (used, remaining) => {
    state.used = used
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><AgentUsage /></QueryClientProvider>)
    await userEvent.click(screen.getByLabelText('Codex usage'))
    const bar = await screen.findByRole('progressbar', { name: /remaining/i })
    expect(bar.getAttribute('aria-valuenow')).toBe(String(remaining))
    expect((bar.firstElementChild as HTMLElement).style.width).toBe(`${remaining}%`)
    expect(screen.getByText(`${used}% used`)).toBeTruthy()
  })

  it('opens Codex on hover after Claude was opened with a click', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    render(<QueryClientProvider client={client}><AgentUsage /></QueryClientProvider>)
    await user.click(screen.getByLabelText('Claude usage'))
    await screen.findByText('66% used')
    await user.hover(screen.getByLabelText('Codex usage'))
    await vi.waitFor(() => expect(screen.getByLabelText('Codex usage').getAttribute('aria-expanded')).toBe('true'))
  })

  it('opens Codex usage when it is the first icon hovered', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    render(<QueryClientProvider client={client}><AgentUsage /></QueryClientProvider>)
    await user.hover(screen.getByLabelText('Codex usage'))
    expect(await screen.findByText('66% used')).toBeTruthy()
  })

  it('opens usage on hover and keeps it open while moving to the popover', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    render(<QueryClientProvider client={client}><AgentUsage /></QueryClientProvider>)
    const trigger = screen.getByLabelText('Claude usage')
    await user.hover(trigger)
    expect(await screen.findByText('66% used')).toBeTruthy()
    await user.hover(screen.getByLabelText('Refresh usage'))
    expect(screen.getByText('66% used')).toBeTruthy()
    await user.unhover(screen.getByLabelText('Refresh usage'))
    await vi.waitFor(() => expect(screen.queryByText('66% used')).toBeNull())
  })

  it('switches between provider popovers when moving across their icons', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    render(<QueryClientProvider client={client}><AgentUsage /></QueryClientProvider>)
    await user.hover(screen.getByLabelText('Claude usage'))
    await screen.findByText('66% used')
    await user.hover(screen.getByLabelText('Codex usage'))
    await vi.waitFor(() => expect(screen.getByLabelText('Codex usage').getAttribute('aria-expanded')).toBe('true'))
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(screen.getByLabelText('Codex usage').getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the popover open while selecting a runtime after hovering', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    render(<QueryClientProvider client={client}><AgentUsage /></QueryClientProvider>)
    await user.hover(screen.getByLabelText('Claude usage'))
    await screen.findByText('66% used')
    await user.click(screen.getByLabelText('Usage runtime'))
    await user.hover(await screen.findByRole('option', { name: 'Laptop' }))
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(screen.getByRole('option', { name: 'Laptop' })).toBeTruthy()
  })

  it('opens Antigravity usage from its own icon on hover', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    render(<QueryClientProvider client={client}><AgentUsage /></QueryClientProvider>)
    await user.hover(screen.getByLabelText('Antigravity usage'))
    expect(await screen.findByText(/Gemini Models · 5 hours/)).toBeTruthy()
    expect(screen.getByText('66% used')).toBeTruthy()
  })

  it('shows an offline runtime without fetching', async () => {
    state.offline = true
    localStorage.setItem('devdeck-usage-machine', 'm1')
    const client = new QueryClient()
    render(<QueryClientProvider client={client}><AgentUsage /></QueryClientProvider>)
    await userEvent.click(screen.getByLabelText('Codex usage'))
    expect(screen.getByText('Runtime is offline.')).toBeTruthy()
  })

  it('keeps cached data visible when refresh fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><AgentUsage /></QueryClientProvider>)
    await userEvent.click(screen.getByLabelText('Codex usage'))
    expect(await screen.findByText('66% used')).toBeTruthy()
    state.fail = true
    await userEvent.click(screen.getByLabelText('Refresh usage'))
    expect(await screen.findByText('Refresh failed; showing last available data.')).toBeTruthy()
    expect(screen.getByText('66% used')).toBeTruthy()
  })
})

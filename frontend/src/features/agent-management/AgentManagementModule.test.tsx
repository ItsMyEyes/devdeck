import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { AgentSummary, Machine } from '@/store/types'
import type { MachineHealth } from '@/lib/api'

const mockUseMachines = vi.fn()
const mockUseMachinesHealth = vi.fn()
const mockUseAgents = vi.fn()

vi.mock('@/features/data/queries', () => ({
  useMachines: () => mockUseMachines(),
  useMachinesHealth: (machines: Machine[]) => mockUseMachinesHealth(machines),
  useAgents: (machine: Machine | undefined) => mockUseAgents(machine),
}))

vi.mock('@/lib/machineApi', () => ({
  fetchAgentSkills: vi.fn(async () => []),
  fetchAgentMCPServers: vi.fn(async () => []),
  fetchAgentModels: vi.fn(async () => []),
  fetchAgentEnvProfiles: vi.fn(async () => []),
}))

// The three panels each pull their own mutations off the query layer; this
// suite is about which machine the module picks and what it lets you do, so
// they're stubbed down to markers.
vi.mock('./SkillsManagement', () => ({ SkillsManagement: () => <div data-testid="skills-panel" /> }))
vi.mock('./MCPManagement', () => ({ MCPManagement: () => <div data-testid="mcp-panel" /> }))
// The settings panel is a marker too, but it reports back which agents it was
// handed: which of them the Settings tab covers is this module's decision, and
// the panel itself pulls in Monaco, which jsdom can't render.
vi.mock('./EnvProfileManagement', () => ({
  EnvProfileManagement: ({
    agentId,
    allSettingsAgents,
  }: {
    agentId: string
    allSettingsAgents: AgentSummary[]
  }) => (
    <div data-testid="env-panel" data-agent={agentId} data-agents={allSettingsAgents.map((a) => a.id).join(',')} />
  ),
}))

const { fetchAgentEnvProfiles } = await import('@/lib/machineApi')
const { AgentManagementModule } = await import('./AgentManagementModule')

function machine(id: string, name: string): Machine {
  return { id, name, url: `http://${name}:9199`, key: 'k', isLocal: false, signingPublicKey: '' }
}

function agent(id: string, name: string): AgentSummary {
  return { id, name, description: '', icon: '', installed: true, modelCount: 2, skillCount: 3 }
}

const offline: MachineHealth = { status: 'offline' }
const online: MachineHealth = { status: 'online' }

function setup(
  machines: Machine[],
  health: Record<string, MachineHealth | undefined>,
  agents: AgentSummary[] = [],
) {
  mockUseMachines.mockReturnValue({ data: machines, isPending: false, isError: false, error: null, refetch: vi.fn() })
  mockUseMachinesHealth.mockImplementation(() => new Map(machines.map((m) => [m.id, health[m.id]])))
  mockUseAgents.mockReturnValue({
    data: agents,
    isPending: false,
    isError: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(async () => {}),
  })
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AgentManagementModule machine selection', () => {
  it('skips an offline runtime and defaults to the first online one', async () => {
    setup([machine('m1', 'down-runtime'), machine('m2', 'live-runtime')], { m1: offline, m2: online })
    render(<AgentManagementModule />, { wrapper: Wrapper })

    await waitFor(() => {
      expect(screen.getByLabelText('Machine')).toHaveTextContent('live-runtime')
    })
    expect(screen.queryByText(/is offline/)).not.toBeInTheDocument()
  })

  it('skips to the online runtime once health resolves after the first paint', async () => {
    // Health is still polling on mount, so `m1` is not yet KNOWN to be down and
    // must not be skipped on a guess; the switch happens when it reports.
    const health: Record<string, MachineHealth | undefined> = { m1: undefined, m2: undefined }
    setup([machine('m1', 'down-runtime'), machine('m2', 'live-runtime')], health)
    const { rerender } = render(<AgentManagementModule />, { wrapper: Wrapper })
    expect(screen.getByLabelText('Machine')).toHaveTextContent('down-runtime')

    health.m1 = offline
    health.m2 = online
    rerender(<AgentManagementModule />)

    await waitFor(() => {
      expect(screen.getByLabelText('Machine')).toHaveTextContent('live-runtime')
    })
  })

  it('reports the runtime as offline instead of managing it when nothing is online', async () => {
    setup([machine('m1', 'down-runtime')], { m1: offline }, [agent('claude', 'Claude Code')])
    render(<AgentManagementModule />, { wrapper: Wrapper })

    expect(await screen.findByText('down-runtime is offline')).toBeInTheDocument()
    expect(screen.getByText('runtime offline')).toBeInTheDocument()
    // No tabs, no panels: skills/MCP/settings all live on the runtime's disk.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skills-panel')).not.toBeInTheDocument()
    // The picker survives so another machine is one click away.
    expect(screen.getByLabelText('Machine')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /refresh/i })).toBeDisabled()
  })
})

describe('AgentManagementModule settings tab', () => {
  it('marks the settings tab with a gear', async () => {
    setup([machine('m1', 'live-runtime')], { m1: online }, [agent('claude', 'Claude Code')])
    render(<AgentManagementModule />, { wrapper: Wrapper })

    const tab = await screen.findByRole('tab', { name: /settings/i })
    expect(tab.querySelector('.lucide-settings')).not.toBeNull()
    expect(tab.querySelector('.lucide-sliders-horizontal')).toBeNull()
  })

  // Every installed agent keeps a config file DevDeck can edit, so the tab
  // covers all of them. It used to be filtered down to the two that also
  // support LLM env profiles, which left pi/opencode/gemini with no way in.
  it('offers the settings panel for every installed agent, not just claude and codex', async () => {
    const agents = [
      agent('claude', 'Claude Code'),
      agent('codex', 'Codex'),
      agent('pi', 'Pi'),
      agent('opencode', 'OpenCode'),
      agent('gemini', 'Gemini CLI'),
    ]
    setup([machine('m1', 'live-runtime')], { m1: online }, agents)
    render(<AgentManagementModule />, { wrapper: Wrapper })

    await userEvent.click(await screen.findByRole('tab', { name: /settings/i }))

    const panel = await screen.findByTestId('env-panel')
    expect(panel.dataset.agents).toBe('claude,codex,pi,opencode,gemini')
    expect(panel.dataset.agent).toBe('claude')
  })

  // Env profiles are Claude/Codex-only, so the count next to the tab label is
  // meaningless for the others — a bare "0" would read as "nothing loaded".
  it('drops the profile count when the selected agent has no env profiles', async () => {
    setup([machine('m1', 'live-runtime')], { m1: online }, [agent('pi', 'Pi')])
    render(<AgentManagementModule />, { wrapper: Wrapper })

    const tab = await screen.findByRole('tab', { name: /settings/i })
    expect(tab).toHaveTextContent(/^Settings$/)
    expect(fetchAgentEnvProfiles).not.toHaveBeenCalled()
  })
})

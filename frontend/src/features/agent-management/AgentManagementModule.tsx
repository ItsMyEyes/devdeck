import { useEffect, useMemo, useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { Blocks, RefreshCw, ServerCog, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { qk } from '@/features/data/keys'
import { useAgents, useMachines, useMachinesHealth } from '@/features/data/queries'
import { ModuleHeader } from '@/features/modules/ModuleHeader'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import { EmptyState } from '@/features/screens/EmptyState'
import { fetchAgentEnvProfiles, fetchAgentMCPServers, fetchAgentSkills } from '@/lib/machineApi'
import { cn } from '@/lib/utils'
import { EnvProfileManagement } from './EnvProfileManagement'
import { MCPManagement } from './MCPManagement'
import { SkillsManagement } from './SkillsManagement'
import type { EnvProfileSummary } from '@/store/types'
import type { AgentMCPInventory, AgentSkillInventory } from './types'

type ManagementTab = 'skills' | 'mcp' | 'settings'

export function AgentManagementModule() {
  const [tab, setTab] = useState<ManagementTab>('skills')
  const machinesQuery = useMachines()
  const machines = machinesQuery.data ?? []
  const machineHealth = useMachinesHealth(machines)
  const [machineId, setMachineId] = useState<string | null>(null)
  // Installed CLI agents/skills/MCP servers/env profiles all live on a
  // specific machine. Keep a valid selection, otherwise use the first machine
  // returned by the registry.
  useEffect(() => {
    if (machines.length === 0) {
      if (machineId !== null) setMachineId(null)
      return
    }
    if (machineId && machines.some((m) => m.id === machineId)) return
    setMachineId(machines[0].id)
  }, [machineId, machines])
  const machine = machines.find((m) => m.id === machineId)

  const agentsQuery = useAgents(machine)
  const queryClient = useQueryClient()
  const installedAgents = useMemo(
    () => (agentsQuery.data ?? []).filter((agent) => agent.installed),
    [agentsQuery.data],
  )
  const mcpAgents = useMemo(
    () => installedAgents.filter((agent) => agent.id === 'claude' || agent.id === 'codex'),
    [installedAgents],
  )
  const settingsAgents = useMemo(
    () => installedAgents.filter((agent) => agent.id === 'claude' || agent.id === 'codex'),
    [installedAgents],
  )
  const [activeSettingsAgentId, setActiveSettingsAgentId] = useState<string | null>(null)

  const skillQueries = useQueries({
    queries: installedAgents.map((agent) => ({
      queryKey: qk.agentSkills(machine?.id ?? '', agent.id),
      queryFn: () => fetchAgentSkills(machine!, agent.id),
      enabled: !!machine,
      staleTime: 30_000,
    })),
  })
  const mcpQueries = useQueries({
    queries: mcpAgents.map((agent) => ({
      queryKey: qk.agentMCPServers(machine?.id ?? '', agent.id),
      queryFn: () => fetchAgentMCPServers(machine!, agent.id),
      enabled: !!machine,
      staleTime: 30_000,
      retry: false,
    })),
  })
  // Default to claude when settings agents load; keep current selection if already set.
  useEffect(() => {
    if (!activeSettingsAgentId && settingsAgents.length > 0) {
      const preferred = settingsAgents.find((a) => a.id === 'claude') ?? settingsAgents[0]
      setActiveSettingsAgentId(preferred.id)
    }
  }, [activeSettingsAgentId, settingsAgents])

  const envProfileQueries = useQueries({
    queries: [
      {
        queryKey: qk.agentEnvProfiles(machine?.id ?? '', activeSettingsAgentId ?? 'claude'),
        queryFn: () => fetchAgentEnvProfiles(machine!, activeSettingsAgentId!),
        enabled: !!machine && !!activeSettingsAgentId,
        staleTime: 30_000,
        retry: false,
      },
    ],
  })

  const skillInventory: AgentSkillInventory[] = installedAgents.map((agent, index) => ({
    agent,
    skills: skillQueries[index]?.data ?? [],
    error: skillQueries[index]?.error instanceof Error ? skillQueries[index].error : undefined,
  }))
  const mcpInventory: AgentMCPInventory[] = mcpAgents.map((agent, index) => ({
    agent,
    servers: mcpQueries[index]?.data ?? [],
    error: mcpQueries[index]?.error instanceof Error ? mcpQueries[index].error : undefined,
  }))
  const skillCount = new Set(skillInventory.flatMap((item) => item.skills.map((skill) => skill.name))).size
  const mcpCount = mcpInventory.reduce((total, item) => total + item.servers.length, 0)
  const envProfiles: EnvProfileSummary[] = envProfileQueries[0]?.data ?? []
  const envProfileCount = envProfiles.length
  const envProfilesLoading = envProfileQueries.some((query) => query.isPending)
  const refreshing =
    agentsQuery.isFetching ||
    skillQueries.some((query) => query.isFetching) ||
    mcpQueries.some((query) => query.isFetching) ||
    envProfileQueries.some((query) => query.isFetching)

  async function refresh() {
    if (!machine) return
    await Promise.all([
      agentsQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: ['machines', machine.id, 'agents'] }),
    ])
  }

  if (machinesQuery.isPending) return <DataLoading label="loading machines…" />
  if (machinesQuery.isError) {
    return <DataError error={machinesQuery.error} onRetry={() => machinesQuery.refetch()} />
  }
  if (!machine) {
    return (
      <EmptyState
        icon={<ServerCog size={26} />}
        title="No machine is registered yet"
        hint="Register this device or a runtime machine to manage its installed agents."
      />
    )
  }
  if (agentsQuery.isPending) return <DataLoading label="loading agent integrations..." />
  if (agentsQuery.isError) {
    return <DataError error={agentsQuery.error} onRetry={() => agentsQuery.refetch()} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
      <ModuleHeader
        title="Agent management"
        meta={`${installedAgents.length} installed`}
        actions={
          <>
            <div className="w-44">
              <Select
                value={machine.id}
                onValueChange={setMachineId}
                aria-label="Machine"
                options={machines.map((m) => ({
                  value: m.id,
                  label: m.isLocal ? `${m.name} (this device)` : m.name,
                  disabled: machineHealth.get(m.id)?.status === 'offline',
                }))}
                triggerClassName="h-8"
              />
            </div>
            <Button variant="secondary" size="sm" onClick={refresh} disabled={refreshing}>
              <RefreshCw size={13} className={cn(refreshing && 'animate-spin')} />
              Refresh
            </Button>
          </>
        }
      />

      {installedAgents.length === 0 ? (
        <EmptyState
          icon={<Blocks size={26} />}
          title="No supported agents are installed"
          hint="Install Claude Code, Codex, Pi, OpenCode, or Gemini CLI, then refresh."
        />
      ) : (
        <>
          {/* <section className="flex-none border-b border-devdeck-border bg-devdeck-pane/35 px-3 py-3 sm:px-4 sm:py-4">
            <div className="mx-auto grid w-full max-w-[1180px] gap-3 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
              <div className="min-w-0 py-0.5">
                <h2 className="text-[13px] font-semibold text-devdeck-fg-2">Connected agents</h2>
                <p className="mt-1 max-w-[32ch] text-[11px] leading-relaxed text-devdeck-fg-2">
                  Skills and MCP servers stay visible in one workspace.
                </p>
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {installedAgents.map((agent) => (
                  <article
                    key={agent.id}
                    className="flex min-w-0 items-center gap-3 rounded-xl border border-devdeck-border-card bg-devdeck-glass-solid px-3 py-2.5"
                  >
                    <AgentMark id={agent.id} name={agent.name} active />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-semibold text-devdeck-fg-2">
                        {agent.name}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 font-mono text-[9.5px] text-devdeck-fg-2">
                        <span>{agent.skillCount} skills</span>
                        <span aria-hidden="true">/</span>
                        <span>{agent.modelCount} models</span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section> */}

          <div
            className="grid flex-none grid-cols-2 gap-1 border-b border-devdeck-border bg-devdeck-pane px-3 py-2 sm:flex sm:px-4"
            role="tablist"
            aria-label="Agent management views"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'skills'}
              onClick={() => setTab('skills')}
              className={cn(
                'flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg px-3 text-[12px] font-medium transition-colors sm:h-8',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                tab === 'skills'
                  ? 'bg-devdeck-on text-devdeck-fg'
                  : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
              )}
            >
              <Blocks size={14} />
              Skills
              <span className="font-mono text-[10px] text-devdeck-fg-2">{skillCount}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'mcp'}
              onClick={() => setTab('mcp')}
              className={cn(
                'flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg px-3 text-[12px] font-medium transition-colors sm:h-8',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                tab === 'mcp'
                  ? 'bg-devdeck-on text-devdeck-fg'
                  : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
              )}
            >
              <ServerCog size={14} />
              <span>MCP<span className="hidden sm:inline"> management</span></span>
              <span className="font-mono text-[10px] text-devdeck-fg-2">{mcpCount}</span>
            </button>
            {settingsAgents.length > 0 ? (
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'settings'}
                onClick={() => setTab('settings')}
                className={cn(
                  'flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg px-3 text-[12px] font-medium transition-colors sm:h-8',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  tab === 'settings'
                    ? 'bg-devdeck-on text-devdeck-fg'
                    : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
                )}
              >
                <SlidersHorizontal size={14} />
                <span>Settings</span>
                <span className="font-mono text-[10px] text-devdeck-fg-2">{envProfileCount}</span>
              </button>
            ) : null}
          </div>

          {tab === 'skills' ? (
            <SkillsManagement
              machine={machine}
              agents={installedAgents}
              inventory={skillInventory}
              loading={skillQueries.some((query) => query.isPending)}
            />
          ) : tab === 'mcp' ? (
            <MCPManagement
              machine={machine}
              agents={mcpAgents}
              inventory={mcpInventory}
              loading={mcpQueries.some((query) => query.isPending)}
            />
          ) : activeSettingsAgentId ? (
            <EnvProfileManagement
              machine={machine}
              agentId={activeSettingsAgentId}
              allSettingsAgents={settingsAgents}
              profiles={envProfiles}
              loading={envProfilesLoading}
              onSelectAgent={setActiveSettingsAgentId}
            />
          ) : (
            <MCPManagement
              machine={machine}
              agents={mcpAgents}
              inventory={mcpInventory}
              loading={mcpQueries.some((query) => query.isPending)}
            />
          )}
        </>
      )}
    </div>
  )
}

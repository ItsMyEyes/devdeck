import { useEffect, useMemo, useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { Blocks, RefreshCw, ServerCog, ServerOff, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { qk } from '@/features/data/keys'
import { useAgents, useMachines, useMachinesHealth } from '@/features/data/queries'
import { ModuleHeader } from '@/features/modules/ModuleHeader'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import { EmptyState } from '@/features/screens/EmptyState'
import { fetchAgentEnvProfiles, fetchAgentMCPServers, fetchAgentModels, fetchAgentSkills } from '@/lib/machineApi'
import { cn } from '@/lib/utils'
import { AgentMark } from './AgentMark'
import { EnvProfileManagement } from './EnvProfileManagement'
import { MCPManagement } from './MCPManagement'
import { SkillsManagement } from './SkillsManagement'
import type { EnvProfileSummary } from '@/store/types'
import type { AgentMCPInventory, AgentModelInventory, AgentSkillInventory } from './types'

type ManagementTab = 'skills' | 'mcp' | 'settings'

/** Agents whose LLM env profiles DevDeck can write — mirrors the backend's
 *  `validateEnvProfileAgent`. The Settings tab itself is not limited to these:
 *  its other half, the raw config-file editor, works for every installed agent,
 *  so only the Profiles panel is gated on membership here. */
const ENV_PROFILE_AGENTS = new Set(['claude', 'codex'])

export function AgentManagementModule() {
  const [tab, setTab] = useState<ManagementTab>('skills')
  const machinesQuery = useMachines()
  const machines = machinesQuery.data ?? []
  const machineHealth = useMachinesHealth(machines)
  const [machineId, setMachineId] = useState<string | null>(null)
  // An offline runtime can only ever render an error here, so the default
  // selection has to respect health — see the effect below. Once the operator
  // picks a machine themselves we stop moving it under them: the offline
  // notice is the honest answer for a machine they asked for.
  const [pickedByOperator, setPickedByOperator] = useState(false)
  function selectMachine(id: string) {
    setPickedByOperator(true)
    setMachineId(id)
  }
  // Installed CLI agents/skills/MCP servers/env profiles all live on a
  // specific machine, and every one of them is read from that machine's own
  // process. Keep a valid selection, and skip past offline machines to the
  // first online one — the registry order alone would land the whole module
  // on an error screen whenever machine #1 happens to be down.
  useEffect(() => {
    if (machines.length === 0) {
      if (machineId !== null) setMachineId(null)
      return
    }
    const selected = machineId ? machines.find((m) => m.id === machineId) : undefined
    // Health starts out `undefined` (still polling), which is not yet a reason
    // to move: only a machine KNOWN to be offline gets skipped.
    const selectedOffline = !!selected && machineHealth.get(selected.id)?.status === 'offline'
    if (selected && (pickedByOperator || !selectedOffline)) return
    const online = machines.find((m) => machineHealth.get(m.id)?.status === 'online')
    if (!online) {
      // Nothing online to skip to — keep (or seed) a selection so the picker
      // and the offline notice still have a subject.
      if (!selected) setMachineId(machines[0].id)
      return
    }
    if (online.id !== machineId) setMachineId(online.id)
  }, [machineId, machines, machineHealth, pickedByOperator])
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
  // Every installed agent has a config file of its own to edit, so all of them
  // get a pill in the Settings tab — not just the two that support env profiles.
  const settingsAgents = installedAgents
  const [activeSettingsAgentId, setActiveSettingsAgentId] = useState<string | null>(null)
  const settingsAgentHasProfiles = !!activeSettingsAgentId && ENV_PROFILE_AGENTS.has(activeSettingsAgentId)

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
  const modelQueries = useQueries({
    queries: installedAgents.map((agent) => ({
      queryKey: qk.agentModels(machine?.id ?? '', agent.id),
      queryFn: () => fetchAgentModels(machine!, agent.id),
      enabled: !!machine,
      staleTime: 30_000,
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
        // Asking for pi/opencode/gemini profiles is a 400 by design — that
        // agent's settings tab is the file editor alone.
        enabled: !!machine && settingsAgentHasProfiles,
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
  const modelInventory: AgentModelInventory[] = installedAgents.map((agent, index) => ({
    agent,
    models: modelQueries[index]?.data ?? [],
    error: modelQueries[index]?.error instanceof Error ? modelQueries[index].error : undefined,
  }))
  const skillCount = new Set(skillInventory.flatMap((item) => item.skills.map((skill) => skill.name))).size
  const mcpCount = mcpInventory.reduce((total, item) => total + item.servers.length, 0)
  const envProfiles: EnvProfileSummary[] = envProfileQueries[0]?.data ?? []
  const envProfileCount = envProfiles.length
  // A disabled query reports `isPending` forever, so the skeleton would never
  // clear for an agent that has no profiles to load in the first place.
  const envProfilesLoading = settingsAgentHasProfiles && envProfileQueries.some((query) => query.isPending)
  const refreshing =
    agentsQuery.isFetching ||
    skillQueries.some((query) => query.isFetching) ||
    mcpQueries.some((query) => query.isFetching) ||
    modelQueries.some((query) => query.isFetching) ||
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
  const machineOffline = machineHealth.get(machine.id)?.status === 'offline'
  // The picker stays mounted for every state below (including the offline
  // notice) so switching runtimes is always one click away.
  const header = (
    <ModuleHeader
      title="Agent management"
      meta={machineOffline ? 'runtime offline' : `${installedAgents.length} installed`}
      actions={
        <>
          <div className="w-44">
            <Select
              value={machine.id}
              onValueChange={selectMachine}
              aria-label="Machine"
              options={machines.map((m) => {
                const offline = machineHealth.get(m.id)?.status === 'offline'
                const name = m.isLocal ? `${m.name} (this device)` : m.name
                return {
                  value: m.id,
                  label: offline ? `${name} — offline` : name,
                  disabled: offline,
                }
              })}
              triggerClassName="h-8"
            />
          </div>
          <Button variant="secondary" size="sm" onClick={refresh} disabled={refreshing || machineOffline}>
            <RefreshCw size={13} className={cn(refreshing && 'animate-spin')} />
            Refresh
          </Button>
        </>
      }
    />
  )

  // Skills, MCP servers and LLM environments are all read from — and written
  // to — the runtime's own filesystem, so nothing here can be inspected or
  // configured while it is down. Say that instead of failing every panel.
  if (machineOffline) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {header}
        <EmptyState
          icon={<ServerOff size={26} />}
          title={`${machine.name} is offline`}
          hint="Agents, skills, MCP servers, and settings live on the runtime itself and can't be managed until it reconnects. Pick an online machine, or bring this one back up."
        />
      </div>
    )
  }
  if (agentsQuery.isPending || agentsQuery.isError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {header}
        {agentsQuery.isError ? (
          <DataError error={agentsQuery.error} onRetry={() => agentsQuery.refetch()} />
        ) : (
          <DataLoading label="loading agent integrations..." />
        )}
      </div>
    )
  }

  // The page itself always scrolls. It used to be `md:overflow-hidden`, on the
  // assumption that at `md` and up the tab panel below is tall enough to take
  // the overflow itself — but the chrome above it (header + the connected-agents
  // grid + the tab bar) is all `flex-none`, so on any short-but-wide viewport (a
  // phone in landscape, a half-height window) that chrome alone outgrows the
  // container: the panel got squeezed to a ~32px sliver and the clipped rest of
  // the page had nothing that could scroll to it. The `md:min-h-[18rem]` floor on
  // each panel is the other half of the fix — it stops the squeeze, which is what
  // pushes the overflow up to here where it can actually be scrolled.
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {header}

      {installedAgents.length === 0 ? (
        <EmptyState
          icon={<Blocks size={26} />}
          title="No supported agents are installed"
          hint="Install Claude Code, Codex, Pi, OpenCode, or Gemini CLI, then refresh."
        />
      ) : (
        <>
          <section className="flex-none border-b border-devdeck-border bg-devdeck-pane/35 px-3 py-3 sm:px-4 sm:py-4">
            <div className="mx-auto grid w-full max-w-[1180px] gap-3 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
              <div className="min-w-0 py-0.5">
                <h2 className="text-[13px] font-semibold text-devdeck-fg-2">Connected agents</h2>
                <p className="mt-1 max-w-[32ch] text-[11px] leading-relaxed text-devdeck-fg-2">
                  Skills, MCP servers, and models stay visible in one workspace.
                </p>
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {modelInventory.map(({ agent, models }) => (
                  <article
                    key={agent.id}
                    className="flex min-w-0 flex-col gap-2 rounded-xl border border-devdeck-border-card bg-devdeck-glass-solid px-3 py-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <AgentMark id={agent.id} name={agent.name} active />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-semibold text-devdeck-fg-2">
                          {agent.name}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 font-mono text-[9.5px] text-devdeck-fg-2">
                          <span>{agent.skillCount} skills</span>
                          <span aria-hidden="true">/</span>
                          <span>{models.length || agent.modelCount} models</span>
                        </div>
                      </div>
                    </div>
                    {models.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {models.slice(0, 4).map((model) => (
                          <span
                            key={model.id}
                            title={model.id}
                            className="max-w-full truncate rounded-md border border-devdeck-border-card bg-devdeck-card-wash px-1.5 py-0.5 font-mono text-[9.5px] text-devdeck-fg-2"
                          >
                            {model.name}
                          </span>
                        ))}
                        {models.length > 4 ? (
                          <span className="rounded-md border border-devdeck-border-card bg-devdeck-card-wash px-1.5 py-0.5 font-mono text-[9.5px] text-devdeck-fg-2">
                            +{models.length - 4} more
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            </div>
          </section>

          {/* Sticky because the page scrolls as one column now: without it the
              tabs scroll away behind the connected-agents grid on a phone and
              switching panel means scrolling all the way back up.
              `bg-devdeck-pane` is opaque — a `*-wash` token here would let the
              rows ghost through as they pass under. */}
          <div
            className="sticky top-0 z-10 grid flex-none grid-cols-2 gap-1 border-b border-devdeck-border bg-devdeck-pane px-3 py-2 sm:flex sm:px-4"
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
              <Settings size={14} />
              <span>Settings</span>
              {/* The count is the selected agent's env profiles; for an agent
                  that has none as a concept, a bare "0" reads as a failure. */}
              {settingsAgentHasProfiles ? (
                <span className="font-mono text-[10px] text-devdeck-fg-2">{envProfileCount}</span>
              ) : null}
            </button>
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

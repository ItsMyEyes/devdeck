import { useMemo, useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { Blocks, RefreshCw, ServerCog } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { qk } from '@/features/data/keys'
import { useAgents } from '@/features/data/queries'
import { ModuleHeader } from '@/features/modules/ModuleHeader'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import { EmptyState } from '@/features/screens/EmptyState'
import { fetchAgentMCPServers, fetchAgentSkills } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AgentMark } from './AgentMark'
import { MCPManagement } from './MCPManagement'
import { SkillsManagement } from './SkillsManagement'
import type { AgentMCPInventory, AgentSkillInventory } from './types'

type ManagementTab = 'skills' | 'mcp'

export function AgentManagementModule() {
  const [tab, setTab] = useState<ManagementTab>('skills')
  const agentsQuery = useAgents()
  const queryClient = useQueryClient()
  const installedAgents = useMemo(
    () => (agentsQuery.data ?? []).filter((agent) => agent.installed),
    [agentsQuery.data],
  )
  const mcpAgents = useMemo(
    () => installedAgents.filter((agent) => agent.id === 'claude' || agent.id === 'codex'),
    [installedAgents],
  )

  const skillQueries = useQueries({
    queries: installedAgents.map((agent) => ({
      queryKey: qk.agentSkills(agent.id),
      queryFn: () => fetchAgentSkills(agent.id),
      staleTime: 30_000,
    })),
  })
  const mcpQueries = useQueries({
    queries: mcpAgents.map((agent) => ({
      queryKey: qk.agentMCPServers(agent.id),
      queryFn: () => fetchAgentMCPServers(agent.id),
      staleTime: 30_000,
      retry: false,
    })),
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
  const refreshing =
    agentsQuery.isFetching ||
    skillQueries.some((query) => query.isFetching) ||
    mcpQueries.some((query) => query.isFetching)

  async function refresh() {
    await Promise.all([
      agentsQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: ['agents'] }),
    ])
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
          <Button variant="secondary" size="sm" onClick={refresh} disabled={refreshing}>
            <RefreshCw size={13} className={cn(refreshing && 'animate-spin')} />
            Refresh
          </Button>
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
          <section className="flex-none border-b border-loom-border bg-loom-surface/35 px-3 py-3 sm:px-4 sm:py-4">
            <div className="mx-auto grid w-full max-w-[1180px] gap-3 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
              <div className="min-w-0 py-0.5">
                <h2 className="text-[13px] font-semibold text-loom-fg-2">Connected agents</h2>
                <p className="mt-1 max-w-[32ch] text-[11px] leading-relaxed text-loom-dim">
                  Skills and MCP servers stay visible in one workspace.
                </p>
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {installedAgents.map((agent) => (
                  <article
                    key={agent.id}
                    className="flex min-w-0 items-center gap-3 rounded-xl border border-loom-border-card bg-loom-card px-3 py-2.5"
                  >
                    <AgentMark id={agent.id} name={agent.name} active />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-semibold text-loom-fg-2">
                        {agent.name}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 font-mono text-[9.5px] text-loom-dim">
                        <span>{agent.skillCount} skills</span>
                        <span aria-hidden="true">/</span>
                        <span>{agent.modelCount} models</span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>

          <div
            className="grid flex-none grid-cols-2 gap-1 border-b border-loom-border bg-loom-bg px-3 py-2 sm:flex sm:px-4"
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
                  ? 'border border-loom-border-accent bg-loom-accent-tint text-loom-fg'
                  : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
              )}
            >
              <Blocks size={14} />
              Skills
              <span className="font-mono text-[10px] text-loom-dim">{skillCount}</span>
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
                  ? 'border border-loom-border-accent bg-loom-accent-tint text-loom-fg'
                  : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
              )}
            >
              <ServerCog size={14} />
              <span>MCP<span className="hidden sm:inline"> management</span></span>
              <span className="font-mono text-[10px] text-loom-dim">{mcpCount}</span>
            </button>
          </div>

          {tab === 'skills' ? (
            <SkillsManagement
              agents={installedAgents}
              inventory={skillInventory}
              loading={skillQueries.some((query) => query.isPending)}
            />
          ) : (
            <MCPManagement
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

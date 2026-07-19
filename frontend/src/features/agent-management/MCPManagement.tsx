import { useMemo, useState } from 'react'
import {
  CircleAlert,
  KeyRound,
  Plus,
  Search,
  Server,
  ServerCog,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRemoveAgentMCPServer } from '@/features/data/queries'
import { cn } from '@/lib/utils'
import type { AgentSummary, MCPServer, Machine } from '@/store/types'
import { AddMCPDialog } from './AddMCPDialog'
import { AgentMark } from './AgentMark'
import { RemoveMCPDialog } from './RemoveMCPDialog'
import type { AgentMCPInventory } from './types'

interface PendingRemoval {
  server: MCPServer
  agentName: string
}

export function MCPManagement({
  machine,
  agents,
  inventory,
  loading,
}: {
  machine: Machine
  agents: AgentSummary[]
  inventory: AgentMCPInventory[]
  loading: boolean
}) {
  const [query, setQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null)
  const removeServer = useRemoveAgentMCPServer()
  const servers = useMemo(
    () =>
      inventory
        .flatMap((item) => item.servers)
        .sort((left, right) => left.name.localeCompare(right.name) || left.agentId.localeCompare(right.agentId)),
    [inventory],
  )
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase()
    if (!search) return servers
    return servers.filter(
      (server) =>
        server.name.toLowerCase().includes(search) ||
        server.target.toLowerCase().includes(search) ||
        server.agentId.toLowerCase().includes(search),
    )
  }, [query, servers])
  const errors = inventory.filter((item) => item.error)
  const uniqueServers = new Set(servers.map((server) => server.name)).size
  const connected = servers.filter(
    (server) => server.enabled && server.status !== 'failed' && server.status !== 'disabled',
  ).length

  async function confirmRemoval() {
    if (!pendingRemoval) return
    try {
      await removeServer.mutateAsync({
        machine,
        agentId: pendingRemoval.server.agentId,
        serverName: pendingRemoval.server.name,
      })
      toast.success(`${pendingRemoval.server.name} removed from ${pendingRemoval.agentName}`)
      setPendingRemoval(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove MCP server')
    }
  }

  if (agents.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-4 text-center">
        <div className="flex h-[55vh] w-full max-w-[760px] flex-col items-center justify-center rounded-xl border border-dashed border-devdeck-border-strong">
          <ServerCog size={28} strokeWidth={1.5} className="text-devdeck-dim-2" />
          <div className="mt-3 text-[13px] font-medium text-devdeck-muted">
            No MCP-compatible agent is installed
          </div>
          <div className="mt-1.5 max-w-[46ch] text-[11.5px] leading-relaxed text-devdeck-dim">
            Install Claude Code or Codex to manage native MCP servers from DevDeck.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-none flex-col md:min-h-0 md:flex-1">
      <div className="grid flex-none grid-cols-2 border-b border-devdeck-border bg-devdeck-surface/20 md:grid-cols-[minmax(220px,1.2fr)_minmax(150px,0.7fr)_minmax(150px,0.7fr)]">
        <div className="col-span-2 border-b border-devdeck-border px-3 py-3 sm:px-4 md:col-span-1 md:border-r md:border-b-0">
          <div className="text-[15px] font-semibold tracking-[-0.015em] text-devdeck-fg">
            MCP servers
          </div>
          <p className="mt-1 max-w-[56ch] text-[11.5px] leading-relaxed text-devdeck-muted-2">
            Configure tools once and install them in Claude Code, Codex, or both.
          </p>
        </div>
        <div className="border-r border-devdeck-border px-3 py-3 sm:px-4">
          <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-devdeck-dim">
            Unique servers
          </div>
          <div className="mt-1 font-mono text-[19px] font-semibold text-devdeck-fg">{uniqueServers}</div>
        </div>
        <div className="px-3 py-3 sm:px-4">
          <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-devdeck-dim">
            Active configs
          </div>
          <div className="mt-1 font-mono text-[19px] font-semibold text-devdeck-green-soft">
            {connected}
          </div>
        </div>
      </div>

      <div className="flex flex-none flex-col gap-2 border-b border-devdeck-border px-3 py-3 sm:flex-row sm:items-center sm:px-4">
        <div className="relative min-w-0 flex-1 sm:max-w-[420px]">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-devdeck-dim"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search MCP servers"
            aria-label="Search MCP servers"
            className="pl-8"
          />
        </div>
        <div className="flex-1" />
        <Button className="w-full sm:w-auto" onClick={() => setAddOpen(true)}>
          <Plus size={14} />
          Add MCP server
        </Button>
      </div>

      {errors.length > 0 ? (
        <div className="flex flex-none items-center gap-2 border-b border-devdeck-yellow-tint-border bg-devdeck-yellow-tint px-4 py-2 text-[11px] text-devdeck-yellow-tint-text">
          <CircleAlert size={13} />
          Could not read MCP configuration from {errors.map((item) => item.agent.name).join(', ')}.
        </div>
      ) : null}

      <div className="flex-none overflow-visible p-3 sm:p-4 md:min-h-0 md:flex-1 md:overflow-auto">
        {loading && servers.length === 0 ? (
          <MCPListSkeleton />
        ) : filtered.length === 0 && query ? (
          <div className="flex min-h-[280px] flex-col items-center justify-center rounded-xl border border-dashed border-devdeck-border-strong text-center">
            <Search size={24} strokeWidth={1.5} className="text-devdeck-dim-2" />
            <div className="mt-3 text-[12.5px] font-medium text-devdeck-muted">
              No MCP servers match this search
            </div>
            <button
              type="button"
              className="mt-2 cursor-pointer text-[11px] text-devdeck-accent-soft hover:underline"
              onClick={() => setQuery('')}
            >
              Clear search
            </button>
          </div>
        ) : servers.length === 0 ? (
          <div className="flex min-h-[340px] flex-col items-center justify-center rounded-xl border border-dashed border-devdeck-border-strong text-center">
            <ServerCog size={27} strokeWidth={1.5} className="text-devdeck-dim-2" />
            <div className="mt-3 text-[13px] font-medium text-devdeck-muted">No MCP servers configured</div>
            <div className="mt-1.5 max-w-[46ch] text-[11.5px] leading-relaxed text-devdeck-dim">
              Add a local command or remote HTTP server and DevDeck will write it through the selected
              agent CLI.
            </div>
            <Button className="mt-4" onClick={() => setAddOpen(true)}>
              <Plus size={14} />
              Add MCP server
            </Button>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[1180px] overflow-hidden rounded-xl border border-devdeck-border-card bg-devdeck-card">
            <div className="hidden grid-cols-[minmax(200px,1fr)_110px_120px_96px_36px] gap-3 border-b border-devdeck-border px-3.5 py-2 font-mono text-[9.5px] uppercase tracking-[0.1em] text-devdeck-dim md:grid">
              <span>Server</span>
              <span>Agent</span>
              <span>Transport</span>
              <span>Status</span>
              <span />
            </div>
            {filtered.map((server, index) => {
              const agent = agents.find((item) => item.id === server.agentId)
              return (
                <article
                  key={`${server.agentId}:${server.name}`}
                  className={cn(
                    'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 sm:px-3.5 md:grid-cols-[minmax(200px,1fr)_110px_120px_96px_36px]',
                    index > 0 && 'border-t border-devdeck-border',
                  )}
                >
                  <div className="col-span-2 flex min-w-0 items-start gap-3 md:col-span-1">
                    <div className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-devdeck-border-card bg-devdeck-surface-2 text-devdeck-muted-2">
                      <Server size={14} />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[12px] font-semibold text-devdeck-fg">
                        {server.name}
                      </div>
                      <div className="mt-1 flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-[9.5px] text-devdeck-dim">
                          {server.target || 'Target hidden by agent'}
                        </span>
                        {server.envKeys.length > 0 ? (
                          <span
                            title={server.envKeys.join(', ')}
                            className="inline-flex flex-none items-center gap-1 text-[9.5px] text-devdeck-muted-2"
                          >
                            <KeyRound size={9} />
                            {server.envKeys.length}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <AgentMark
                      id={agent?.id ?? server.agentId}
                      name={agent?.name ?? server.agentId}
                      size="sm"
                      active
                    />
                    <span className="text-[10.5px] text-devdeck-muted">
                      {agent?.name ?? server.agentId}
                    </span>
                  </div>

                  <span className="w-fit rounded-md border border-devdeck-border-card bg-devdeck-surface-2 px-2 py-1 font-mono text-[9.5px] uppercase text-devdeck-muted-2">
                    {server.transport}
                    {server.argCount > 0 ? ` +${server.argCount}` : ''}
                  </span>

                  <span className={statusClass(server.status, server.enabled)}>
                    {server.enabled ? server.status : 'disabled'}
                  </span>

                  <button
                    type="button"
                    aria-label={`Remove ${server.name} from ${agent?.name ?? server.agentId}`}
                    title="Remove server"
                    onClick={() =>
                      setPendingRemoval({
                        server,
                        agentName: agent?.name ?? server.agentId,
                      })
                    }
                    className="flex h-9 w-9 cursor-pointer items-center justify-center justify-self-end rounded-lg text-devdeck-dim transition-colors hover:bg-devdeck-red-tint-hover hover:text-devdeck-red-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:h-8 md:w-8"
                  >
                    <Trash2 size={13} />
                  </button>
                </article>
              )
            })}
          </div>
        )}
      </div>

      <AddMCPDialog open={addOpen} machine={machine} agents={agents} onOpenChange={setAddOpen} />
      <RemoveMCPDialog
        open={pendingRemoval !== null}
        serverName={pendingRemoval?.server.name ?? ''}
        agentName={pendingRemoval?.agentName ?? ''}
        pending={removeServer.isPending}
        onOpenChange={(open) => !open && setPendingRemoval(null)}
        onConfirm={() => void confirmRemoval()}
      />
    </div>
  )
}

function statusClass(status: string, enabled: boolean) {
  const healthy = enabled && status !== 'failed' && status !== 'disabled'
  return cn(
    'w-fit rounded-md border px-2 py-1 font-mono text-[9.5px] capitalize',
    healthy
      ? 'border-devdeck-green-tint-border bg-devdeck-green-tint text-devdeck-green-soft'
      : 'border-devdeck-red-tint bg-devdeck-red-tint-hover text-devdeck-red-soft',
  )
}

function MCPListSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-[1180px] overflow-hidden rounded-xl border border-devdeck-border-card bg-devdeck-card"
      aria-label="Loading MCP servers"
    >
      {[0, 1, 2].map((item) => (
        <div
          key={item}
          className={cn(
            'grid animate-pulse gap-3 px-3.5 py-3 md:grid-cols-[minmax(200px,1fr)_110px_120px_96px_36px]',
            item > 0 && 'border-t border-devdeck-border',
          )}
        >
          <div className="h-8 rounded-md bg-devdeck-elevated" />
          <div className="h-7 rounded-md bg-devdeck-surface-2" />
          <div className="h-7 rounded-md bg-devdeck-surface-2" />
          <div className="h-7 rounded-md bg-devdeck-surface-2" />
          <div className="h-7 w-7 rounded-md bg-devdeck-surface-2" />
        </div>
      ))}
    </div>
  )
}

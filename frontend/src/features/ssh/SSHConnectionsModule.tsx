import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowRight,
  Cable,
  Fingerprint,
  Grid2X2,
  KeyRound,
  List,
  Plus,
  RotateCcw,
  Search,
  Server,
  Settings2,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataLoading } from '@/features/screens/DataLoading'
import { useScope } from '@/features/useScope'
import { cn } from '@/lib/utils'
import type { SSHConnection } from '@/store/types'
import { useAcceptSSHHostKey, useMachines, useSSHConnections } from '@/features/data/queries'
import { ALL_SSH_GROUPS, useDevDeckStore } from '@/store/useDevDeckStore'

type AuthType = SSHConnection['authType']

const UNGROUPED = 'Ungrouped'

function groupLabel(connection: SSHConnection) {
  return connection.group.trim() || UNGROUPED
}

function connectionSubtitle(connection: SSHConnection) {
  return `${connection.username}@${connection.host}:${connection.port}`
}

function authLabel(authType: AuthType) {
  return authType === 'password' ? 'password' : 'private key'
}

function hostSearchText(connection: SSHConnection) {
  return `${connection.name} ${connection.group} ${connection.host} ${connection.port} ${connection.username} ${connection.authType}`.toLowerCase()
}

function HostGlyph({ authType }: { authType: AuthType }) {
  const privateKey = authType === 'privatekey'
  return (
    <span
      className={cn(
        'flex h-9 w-9 flex-none items-center justify-center rounded-[10px] border',
        privateKey
          ? 'border-devdeck-border-accent bg-devdeck-accent-tint text-devdeck-accent-soft'
          : 'border-devdeck-yellow-tint-border bg-devdeck-yellow-tint text-devdeck-yellow-soft',
      )}
    >
      {privateKey ? <KeyRound size={16} /> : <Server size={16} />}
    </span>
  )
}

function HostKeyBadge({ connection }: { connection: SSHConnection }) {
  const acceptHostKey = useAcceptSSHHostKey()
  const showToast = useDevDeckStore((s) => s.showToast)

  if (!connection.hostKeyFingerprint) {
    return <span className="font-mono text-[10px] text-devdeck-dim">trust on first connect</span>
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-devdeck-dim-2">
      <Fingerprint size={10} className="flex-none" />
      <span className="min-w-0 truncate" title={connection.hostKeyFingerprint}>
        {connection.hostKeyFingerprint}
      </span>
      <button
        type="button"
        aria-label="Reset pinned host key"
        title="Reset pinned host key (re-pins on next connect)"
        onClick={(event) => {
          event.stopPropagation()
          acceptHostKey.mutate(connection.id, {
            onSuccess: () => showToast(`Host key for "${connection.name}" reset — re-pins on next connect`),
          })
        }}
        className="flex-none cursor-pointer rounded p-0.5 text-devdeck-muted-2 hover:bg-devdeck-hover-wash hover:text-devdeck-accent-soft"
      >
        <RotateCcw size={11} />
      </button>
    </span>
  )
}

function HostCard({
  connection,
  machineName,
  jumpName,
  variant = 'card',
}: {
  connection: SSHConnection
  machineName: string | null
  jumpName: string | null
  variant?: 'card' | 'list'
}) {
  const navigate = useNavigate()
  const { wsId } = useScope()
  const openSSHShellTab = useDevDeckStore((s) => s.openSSHShellTab)
  const openEditSSHConnection = useDevDeckStore((s) => s.openEditSSHConnection)
  const askDelete = useDevDeckStore((s) => s.askDelete)

  function connect() {
    if (!wsId) return
    openSSHShellTab(wsId, connection.id)
    navigate({ to: '/w/$wsId', params: { wsId } })
  }

  if (variant === 'list') {
    return (
      <article className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-devdeck-border-card bg-devdeck-card px-3 py-2.5 transition-colors hover:border-devdeck-border-accent lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <HostGlyph authType={connection.authType} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-[13px] font-semibold text-devdeck-fg-2">{connection.name}</span>
              <span className="hidden truncate font-mono text-[10.5px] text-devdeck-dim sm:inline">
                — {connectionSubtitle(connection)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-devdeck-dim">
              <span>{authLabel(connection.authType)}</span>
              {machineName ? <span>via {machineName}</span> : null}
              {jumpName ? (
                <span className="flex items-center gap-1">
                  <ArrowRight size={9} />
                  {jumpName}
                </span>
              ) : null}
              <HostKeyBadge connection={connection} />
            </div>
          </div>
        </div>

        <div className="flex flex-none items-center gap-1.5 pl-12 lg:pl-0">
          <button
            type="button"
            onClick={connect}
            className="flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-devdeck-border-accent bg-devdeck-accent-tint px-2.5 text-[11.5px] font-semibold text-devdeck-accent-soft hover:bg-devdeck-accent-tint-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <TerminalSquare size={12} />
            Connect
          </button>
          <button
            type="button"
            aria-label={`Edit ${connection.name}`}
            onClick={() => openEditSSHConnection(connection)}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Settings2 size={13} />
          </button>
          <button
            type="button"
            aria-label={`Delete ${connection.name}`}
            onClick={() => askDelete('ssh', connection.id, connection.name)}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted hover:bg-devdeck-red-tint hover:text-devdeck-red-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </article>
    )
  }

  return (
    <article className="group flex min-h-[150px] flex-col overflow-hidden rounded-[13px] border border-devdeck-border-card bg-devdeck-card transition-colors hover:border-devdeck-border-accent">
      <div className="flex items-start gap-3 px-3 pb-2 pt-3">
        <HostGlyph authType={connection.authType} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="truncate text-[13px] font-semibold text-devdeck-fg-2">{connection.name}</div>
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-devdeck-dim">{connectionSubtitle(connection)}</div>
        </div>
        <button
          type="button"
          aria-label={`Delete ${connection.name}`}
          onClick={() => askDelete('ssh', connection.id, connection.name)}
          className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md text-devdeck-dim hover:bg-devdeck-red-tint hover:text-devdeck-red-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-3">
        <span className="rounded-md bg-devdeck-surface-2 px-2 py-1 font-mono text-[10px] text-devdeck-muted-2">
          {authLabel(connection.authType)}
        </span>
        {machineName ? (
          <span className="rounded-md bg-devdeck-surface-2 px-2 py-1 font-mono text-[10px] text-devdeck-muted-2">via {machineName}</span>
        ) : null}
        {jumpName ? (
          <span className="flex items-center gap-1 rounded-md bg-devdeck-surface-2 px-2 py-1 font-mono text-[10px] text-devdeck-muted-2">
            <ArrowRight size={9} />
            {jumpName}
          </span>
        ) : null}
      </div>

      <div className="px-3 pt-1.5">
        <HostKeyBadge connection={connection} />
      </div>

      <div className="mx-3 my-2 h-px bg-devdeck-border" />

      <div className="grid grid-cols-2 gap-2 px-3 pb-3">
        <button
          type="button"
          onClick={connect}
          className="flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-devdeck-border-accent bg-devdeck-accent-tint text-[12px] font-semibold text-devdeck-accent-soft hover:bg-devdeck-accent-tint-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <TerminalSquare size={13} />
          Connect
        </button>
        <button
          type="button"
          onClick={() => openEditSSHConnection(connection)}
          className="flex h-8 cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-[12px] font-semibold text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Edit
        </button>
      </div>
    </article>
  )
}

function SSHGroupSection({
  group,
  hosts,
  view,
  machineNameById,
  connectionNameById,
}: {
  group: string
  hosts: SSHConnection[]
  view: 'cards' | 'list'
  machineNameById: Map<string, string>
  connectionNameById: Map<string, string>
}) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center gap-3">
        {group === UNGROUPED ? (
          <Server size={13} className="flex-none text-devdeck-dim" />
        ) : (
          <KeyRound size={13} className="flex-none text-devdeck-dim" />
        )}
        <h2 className="truncate text-[18px] font-semibold leading-none text-devdeck-fg-2">{group}</h2>
        <span className="rounded-full bg-devdeck-surface-2 px-2 py-0.5 font-mono text-[10px] text-devdeck-dim">{hosts.length}</span>
        <div className="h-px min-w-6 flex-1 bg-devdeck-border" />
      </div>

      {view === 'cards' ? (
        <div className="grid content-start gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))' }}>
          {hosts.map((connection) => (
            <HostCard
              key={connection.id}
              connection={connection}
              machineName={connection.executorMachineId ? (machineNameById.get(connection.executorMachineId) ?? null) : null}
              jumpName={connection.jumpConnectionId ? (connectionNameById.get(connection.jumpConnectionId) ?? null) : null}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {hosts.map((connection) => (
            <HostCard
              key={connection.id}
              connection={connection}
              machineName={connection.executorMachineId ? (machineNameById.get(connection.executorMachineId) ?? null) : null}
              jumpName={connection.jumpConnectionId ? (connectionNameById.get(connection.jumpConnectionId) ?? null) : null}
              variant="list"
            />
          ))}
        </div>
      )}
    </section>
  )
}

function ViewButton({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-7 w-8 cursor-pointer items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        active ? 'bg-devdeck-accent-tint text-devdeck-accent-soft' : 'text-devdeck-dim hover:text-devdeck-fg',
      )}
    >
      {children}
    </button>
  )
}

function EmptyHostsState({
  title,
  hint,
  actionLabel,
  onAction,
}: {
  title: string
  hint: string
  actionLabel: string
  onAction: () => void
}) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center rounded-[13px] border border-dashed border-devdeck-border-menu bg-devdeck-card/35 px-4 text-center">
      <div className="text-[13px] font-semibold text-devdeck-fg-2">{title}</div>
      <div className="mt-2 max-w-[42ch] text-[12px] leading-relaxed text-devdeck-muted">{hint}</div>
      <button
        type="button"
        onClick={onAction}
        className="mt-4 cursor-pointer rounded-md border border-devdeck-border-accent bg-devdeck-accent-tint px-3 py-1.5 text-[12px] font-semibold text-devdeck-accent-soft hover:bg-devdeck-accent-tint-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {actionLabel}
      </button>
    </div>
  )
}

export function SSHConnectionsModule() {
  const { data: connections, isLoading, error, refetch } = useSSHConnections()
  const machines = useMachines().data ?? []
  const openAddSSHConnection = useDevDeckStore((s) => s.openAddSSHConnection)
  const activeGroup = useDevDeckStore((s) => s.sshActiveGroup)
  const setActiveGroup = useDevDeckStore((s) => s.setSSHActiveGroup)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'cards' | 'list'>('cards')

  const hosts = useMemo(() => connections ?? [], [connections])
  const machineNameById = useMemo(
    () => new Map(machines.map((m) => [m.id, m.isLocal ? `${m.name} (local)` : m.name])),
    [machines],
  )
  const connectionNameById = useMemo(() => new Map(hosts.map((c) => [c.id, c.name])), [hosts])

  useEffect(() => {
    if (activeGroup !== ALL_SSH_GROUPS && !hosts.some((connection) => groupLabel(connection) === activeGroup)) {
      setActiveGroup(ALL_SSH_GROUPS)
    }
  }, [activeGroup, hosts, setActiveGroup])

  const searchNeedle = query.trim().toLowerCase()
  const scopedHosts = activeGroup === ALL_SSH_GROUPS ? hosts : hosts.filter((connection) => groupLabel(connection) === activeGroup)
  const filteredHosts = scopedHosts.filter((connection) => !searchNeedle || hostSearchText(connection).includes(searchNeedle))

  const groups = useMemo(() => {
    const labels = Array.from(new Set(filteredHosts.map(groupLabel))).sort((a, b) =>
      a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b),
    )
    return labels.map((label) => ({ label, hosts: filteredHosts.filter((connection) => groupLabel(connection) === label) }))
  }, [filteredHosts])

  const trustedCount = hosts.filter((connection) => connection.hostKeyFingerprint).length
  const groupCount = new Set(hosts.map(groupLabel)).size

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <DataLoading compact label="loading connections…" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        <div className="flex w-full max-w-[420px] flex-col items-center rounded-[12px] border border-devdeck-border-card bg-devdeck-card px-5 py-6 text-center">
          <Cable size={24} className="mb-3 text-devdeck-dim" />
          <div className="text-[13px] font-medium text-devdeck-fg-2">Could not load SSH hosts</div>
          <p className="mt-1 text-[12px] leading-relaxed text-devdeck-dim">
            {error instanceof Error ? error.message : 'Failed to load SSH connections'}
          </p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      </div>
    )
  }

  const hasHosts = hosts.length > 0
  const hasMatches = groups.length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <section className="flex-none border-b border-devdeck-border bg-devdeck-bg px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-[15px] font-semibold text-devdeck-fg-2">SSH</h1>
              <span className="rounded-full bg-devdeck-surface-2 px-2 py-0.5 font-mono text-[10px] text-devdeck-muted-2">{hosts.length}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-devdeck-dim">
              <span>{trustedCount} trusted</span>
              <span aria-hidden="true">·</span>
              <span>{groupCount} groups</span>
              {activeGroup !== ALL_SSH_GROUPS ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{activeGroup}</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center xl:justify-end">
            <div className="relative min-w-0 sm:w-[280px] lg:w-[340px]">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-devdeck-dim" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter hosts, groups, users…"
                className="h-9 w-full rounded-[10px] border border-devdeck-border-card bg-devdeck-surface px-8 text-[12px] text-devdeck-fg placeholder:text-devdeck-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Clear host search"
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <div className="grid h-9 grid-cols-2 rounded-[10px] border border-devdeck-border-card bg-devdeck-surface p-1" role="group" aria-label="Host layout">
                <ViewButton label="Show card view" active={view === 'cards'} onClick={() => setView('cards')}>
                  <Grid2X2 size={14} />
                </ViewButton>
                <ViewButton label="Show list view" active={view === 'list'} onClick={() => setView('list')}>
                  <List size={15} />
                </ViewButton>
              </div>

              <button
                type="button"
                onClick={openAddSSHConnection}
                className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-devdeck-border-accent bg-devdeck-accent-tint px-3 text-[12px] font-semibold text-devdeck-accent-soft transition-colors hover:bg-devdeck-accent-tint-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Plus size={13} />
                New host
              </button>
            </div>
          </div>
        </div>
      </section>

      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
        {!hasHosts ? (
          <EmptyHostsState
            title="No SSH hosts yet"
            hint="Add any reachable SSH host. DevDeck stores credentials encrypted and opens it as a workspace shell tab."
            actionLabel="+ Add first host"
            onAction={openAddSSHConnection}
          />
        ) : !hasMatches ? (
          <EmptyHostsState
            title={searchNeedle ? 'No hosts match that search' : 'No hosts in this group'}
            hint={
              searchNeedle
                ? 'Try another name, group, host, or user.'
                : 'Add a host to this group, or pick "All hosts" in the sidebar.'
            }
            actionLabel={searchNeedle ? 'Clear filter' : 'New host'}
            onAction={searchNeedle ? () => setQuery('') : openAddSSHConnection}
          />
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <SSHGroupSection
                key={group.label}
                group={group.label}
                hosts={group.hosts}
                view={view}
                machineNameById={machineNameById}
                connectionNameById={connectionNameById}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

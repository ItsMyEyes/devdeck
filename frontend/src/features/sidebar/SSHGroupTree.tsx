import { useNavigate } from '@tanstack/react-router'
import { Cable, KeyRound, Plus, Server } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useScope } from '@/features/useScope'
import { useSSHConnections } from '@/features/data/queries'
import { ALL_SSH_GROUPS, useLoomStore } from '@/store/useLoomStore'
import type { SSHConnection } from '@/store/types'

const UNGROUPED = 'Ungrouped'

function groupLabel(connection: SSHConnection) {
  return connection.group.trim() || UNGROUPED
}

export function SSHGroupTree() {
  const navigate = useNavigate()
  const { wsId } = useScope()
  const hosts = useSSHConnections().data ?? []
  const activeGroup = useLoomStore((s) => s.sshActiveGroup)
  const setActiveGroup = useLoomStore((s) => s.setSSHActiveGroup)
  const openAddSSHConnection = useLoomStore((s) => s.openAddSSHConnection)

  const groups = Array.from(new Set(hosts.map(groupLabel))).sort((a, b) =>
    a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b),
  )

  function selectGroup(group: string) {
    setActiveGroup(group)
    if (!wsId) return
    navigate({ to: '/w/$wsId/ssh', params: { wsId } })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-4">
      <div className="mb-2.5 flex items-center justify-between px-2">
        <span className="font-mono text-[10.5px] font-semibold tracking-[0.16em] text-loom-dim">GROUPS</span>
        <button
          type="button"
          onClick={openAddSSHConnection}
          title="New SSH host"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-loom-dim hover:bg-loom-hover-wash hover:text-loom-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Plus size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pr-1">
        <button
          type="button"
          onClick={() => selectGroup(ALL_SSH_GROUPS)}
          aria-current={activeGroup === ALL_SSH_GROUPS ? 'page' : undefined}
          className={cn(
            'mb-2.5 flex h-11 w-full cursor-pointer items-center gap-3 rounded-[11px] px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            activeGroup === ALL_SSH_GROUPS
              ? 'bg-loom-accent-tint text-loom-accent-soft ring-1 ring-inset ring-loom-border-accent'
              : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
          )}
        >
          <Cable size={17} className="flex-none" />
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">All hosts</span>
          <span className="rounded-full bg-black/10 px-2 py-0.5 font-mono text-[11px] font-semibold opacity-85">{hosts.length}</span>
        </button>

        <div className="flex flex-col gap-1">
          {groups.map((group) => {
            const selected = activeGroup === group
            const count = hosts.filter((host) => groupLabel(host) === group).length
            return (
              <button
                key={group}
                type="button"
                onClick={() => selectGroup(group)}
                aria-current={selected ? 'page' : undefined}
                className={cn(
                  'flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  selected ? 'bg-loom-hover-wash text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
                )}
              >
                {group === UNGROUPED ? (
                  <Server size={16} className="flex-none text-loom-dim" />
                ) : (
                  <KeyRound size={16} className="flex-none text-loom-dim" />
                )}
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{group}</span>
                <span className="font-mono text-[11.5px] font-semibold text-loom-dim">{count}</span>
              </button>
            )
          })}
        </div>

        {hosts.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <div className="font-mono text-[11.5px] text-loom-dim">no hosts yet</div>
            <button
              type="button"
              onClick={openAddSSHConnection}
              className="mt-3 h-8 cursor-pointer rounded-md border border-loom-border-menu bg-loom-elevated px-3 text-[12px] font-semibold text-loom-fg-2 hover:bg-loom-hover-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              + Add host
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

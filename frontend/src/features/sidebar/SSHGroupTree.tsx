import { useNavigate } from '@tanstack/react-router'
import { Cable, KeyRound, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useScope } from '@/features/useScope'
import { useSSHConnections } from '@/features/data/queries'
import { ALL_SSH_GROUPS, useDevDeckStore } from '@/store/useDevDeckStore'
import type { SSHConnection } from '@/store/types'

const UNGROUPED = 'Ungrouped'

function groupLabel(connection: SSHConnection) {
  return connection.group.trim() || UNGROUPED
}

export function SSHGroupTree() {
  const navigate = useNavigate()
  const { wsId } = useScope()
  const hosts = useSSHConnections().data ?? []
  const activeGroup = useDevDeckStore((s) => s.sshActiveGroup)
  const setActiveGroup = useDevDeckStore((s) => s.setSSHActiveGroup)
  const openAddSSHConnection = useDevDeckStore((s) => s.openAddSSHConnection)
  const openRenameSSHGroup = useDevDeckStore((s) => s.openRenameSSHGroup)
  const askDelete = useDevDeckStore((s) => s.askDelete)

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
        <span className="font-mono text-[10.5px] font-semibold tracking-[0.16em] text-devdeck-fg-2">GROUPS</span>
        <button
          type="button"
          onClick={openAddSSHConnection}
          title="New SSH host"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
            'mb-2.5 flex h-11 w-full cursor-pointer items-center gap-3 rounded-control px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            activeGroup === ALL_SSH_GROUPS
              ? 'bg-devdeck-on text-devdeck-fg'
              : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
          )}
        >
          <Cable size={17} className="flex-none" />
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">All hosts</span>
          <span className="rounded-full bg-devdeck-card-wash px-2 py-0.5 font-mono text-[11px] font-semibold opacity-85">{hosts.length}</span>
        </button>

        <div className="flex flex-col gap-1">
          {groups.map((group) => {
            const selected = activeGroup === group
            const count = hosts.filter((host) => groupLabel(host) === group).length
            const manageable = group !== UNGROUPED
            return (
              <div key={group} className="group/row relative">
                <button
                  type="button"
                  onClick={() => selectGroup(group)}
                  aria-current={selected ? 'page' : undefined}
                  className={cn(
                    'flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-control px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    selected ? 'bg-devdeck-hover-wash text-devdeck-fg' : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
                  )}
                >
                  {group === UNGROUPED ? (
                    <Server size={16} className="flex-none text-devdeck-fg-2" />
                  ) : (
                    <KeyRound size={16} className="flex-none text-devdeck-fg-2" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{group}</span>
                  <span
                    className={cn(
                      'font-mono text-[11.5px] font-semibold text-devdeck-fg-2',
                      manageable && 'group-hover/row:hidden',
                    )}
                  >
                    {count}
                  </span>
                </button>
                {manageable ? (
                  <div className="absolute inset-y-0 right-2 hidden items-center gap-1 group-hover/row:flex">
                    <button
                      type="button"
                      aria-label={`Rename group ${group}`}
                      title="Rename group"
                      onClick={() => openRenameSSHGroup(group)}
                      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete group ${group}`}
                      title="Delete group"
                      onClick={() => askDelete('ssh-group', group, group)}
                      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-devdeck-fg-2 hover:bg-devdeck-red-tint hover:text-devdeck-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>

        {hosts.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <div className="font-mono text-[11.5px] text-devdeck-fg-2">no hosts yet</div>
            <button
              type="button"
              onClick={openAddSSHConnection}
              className="mt-3 h-8 cursor-pointer rounded-md border border-devdeck-border-menu bg-devdeck-glass-solid px-3 text-[12px] font-semibold text-devdeck-fg-2 hover:bg-devdeck-hover-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              + Add host
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

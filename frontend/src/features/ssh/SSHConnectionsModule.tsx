import { Cable, Plus, RotateCcw } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { DataLoading } from '@/features/screens/DataLoading'
import { useScope } from '@/features/useScope'
import type { SSHConnection } from '@/store/types'
import { useAcceptSSHHostKey, useSSHConnections } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

function HostKeyBadge({ connection }: { connection: SSHConnection }) {
  const acceptHostKey = useAcceptSSHHostKey()
  const showToast = useLoomStore((s) => s.showToast)
  if (!connection.hostKeyFingerprint) {
    return <span className="font-mono text-[10.5px] text-loom-dim">key: trust on first connect</span>
  }
  return (
    <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-loom-dim-2">
      <span className="max-w-[180px] truncate" title={connection.hostKeyFingerprint}>
        {connection.hostKeyFingerprint}
      </span>
      <button
        type="button"
        aria-label="Reset pinned host key"
        title="Reset pinned host key (re-pins on next connect)"
        onClick={() =>
          acceptHostKey.mutate(connection.id, {
            onSuccess: () => showToast(`Host key for "${connection.name}" reset — re-pins on next connect`),
          })
        }
        className="cursor-pointer p-0.5 text-loom-muted-2 hover:text-loom-accent-soft"
      >
        <RotateCcw size={11} />
      </button>
    </span>
  )
}

function SSHConnectionRow({ connection }: { connection: SSHConnection }) {
  const navigate = useNavigate()
  const { wsId } = useScope()
  const openEditSSHConnection = useLoomStore((s) => s.openEditSSHConnection)
  const openSSHShellTab = useLoomStore((s) => s.openSSHShellTab)
  const askDelete = useLoomStore((s) => s.askDelete)

  function openShell() {
    if (!wsId) return
    openSSHShellTab(wsId, connection.id)
    navigate({ to: '/w/$wsId', params: { wsId } })
  }

  return (
    <div className="flex items-center gap-3 border-b border-loom-border px-3 py-2.5">
      <Cable size={14} className="flex-none text-loom-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate font-mono text-[12.5px] text-loom-fg-2">{connection.name}</div>
          <span className="flex-none rounded-full border border-loom-border px-2 py-0.5 font-mono text-[10.5px] text-loom-dim-2">
            {connection.authType === 'password' ? 'password' : 'private key'}
          </span>
        </div>
        <div className="truncate font-mono text-[10.5px] text-loom-dim-2">
          {connection.username}@{connection.host}:{connection.port}
        </div>
      </div>
      <HostKeyBadge connection={connection} />
      <Button size="sm" onClick={openShell}>
        Shell
      </Button>
      <Button variant="secondary" size="sm" onClick={() => openEditSSHConnection(connection)}>
        Edit
      </Button>
      <Button variant="destructive" size="sm" onClick={() => askDelete('ssh', connection.id, connection.name)}>
        Delete
      </Button>
    </div>
  )
}

export function SSHConnectionsModule() {
  const { data: connections, isLoading, error, refetch } = useSSHConnections()
  const openAddSSHConnection = useLoomStore((s) => s.openAddSSHConnection)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-none items-center gap-2.5 border-b border-loom-border px-4 py-3">
        <h1 className="flex-1 font-mono text-[13px] font-medium text-loom-fg">SSH</h1>
        <Button size="sm" onClick={openAddSSHConnection}>
          <Plus size={13} />
          Add connection
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex h-[120px] items-center justify-center">
            <DataLoading compact label="loading connections…" />
          </div>
        ) : error ? (
          <div className="flex h-[120px] flex-col items-center justify-center gap-3 px-4">
            <span className="text-center font-mono text-xs text-loom-dim-2">
              {error instanceof Error ? error.message : 'Failed to load SSH connections'}
            </span>
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : !connections || connections.length === 0 ? (
          <div className="flex h-[120px] items-center justify-center font-mono text-xs text-loom-dim-2">
            No SSH connections yet
          </div>
        ) : (
          connections.map((c) => <SSHConnectionRow key={c.id} connection={c} />)
        )}
      </div>
    </div>
  )
}

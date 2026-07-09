import { Loader2, Plus, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Machine } from '@/store/types'
import { useMachineHealth, useMachines } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

function HealthBadge({ machineId }: { machineId: string }) {
  const { data, isLoading } = useMachineHealth(machineId)
  if (isLoading || !data) {
    return <span className="font-mono text-[10.5px] text-loom-dim">checking…</span>
  }
  if (data.status === 'online') {
    return (
      <span className="font-mono text-[10.5px] text-loom-green-soft">
        online{data.latencyMs !== undefined ? ` · ${data.latencyMs}ms` : ''}
      </span>
    )
  }
  return <span className="font-mono text-[10.5px] text-loom-red-soft">offline</span>
}

function MachineRow({ machine }: { machine: Machine }) {
  const openEditMachine = useLoomStore((s) => s.openEditMachine)
  const askDelete = useLoomStore((s) => s.askDelete)
  return (
    <div className="flex items-center gap-3 border-b border-loom-border px-3 py-2.5">
      <Server size={14} className="flex-none text-loom-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[12.5px] text-loom-fg-2">{machine.name}</div>
        <div className="truncate font-mono text-[10.5px] text-loom-dim-2">{machine.url}</div>
      </div>
      <HealthBadge machineId={machine.id} />
      <Button
        variant="secondary"
        size="sm"
        onClick={() => openEditMachine(machine.id, machine.name, machine.url, machine.key)}
      >
        Edit
      </Button>
      <Button variant="destructive" size="sm" onClick={() => askDelete('machine', machine.id, machine.name)}>
        Delete
      </Button>
    </div>
  )
}

export function MachinesModule() {
  const { data: machines, isLoading, error, refetch } = useMachines()
  const openAddMachine = useLoomStore((s) => s.openAddMachine)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-none items-center gap-2.5 border-b border-loom-border px-4 py-3">
        <h1 className="flex-1 font-mono text-[13px] font-medium text-loom-fg">Machines</h1>
        <Button size="sm" onClick={openAddMachine}>
          <Plus size={13} />
          Add machine
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex h-[120px] items-center justify-center">
            <Loader2 size={22} strokeWidth={1.5} className="animate-spin text-loom-dim-2" />
          </div>
        ) : error ? (
          <div className="flex h-[120px] flex-col items-center justify-center gap-3 px-4">
            <span className="text-center font-mono text-xs text-loom-dim-2">
              {error instanceof Error ? error.message : 'Failed to load machines'}
            </span>
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : !machines || machines.length === 0 ? (
          <div className="flex h-[120px] items-center justify-center font-mono text-xs text-loom-dim-2">
            No machines registered yet
          </div>
        ) : (
          machines.map((m) => <MachineRow key={m.id} machine={m} />)
        )}
      </div>
    </div>
  )
}

import { Monitor, Plus, Server, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/ui/status-dot'
import { DataLoading } from '@/features/screens/DataLoading'
import type { Machine } from '@/store/types'
import { useMachineHealth, useMachines } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

function RuntimeHealth({ machineId }: { machineId: string }) {
  const { data, isLoading } = useMachineHealth(machineId)
  if (isLoading || !data) {
    return (
      <span className="inline-flex items-center gap-2 font-mono text-[10.5px] text-loom-dim">
        <StatusDot color="#6b7280" size={6} />
        checking
      </span>
    )
  }
  if (data.status === 'online') {
    return (
      <span className="inline-flex items-center gap-2 font-mono text-[10.5px] text-loom-green-soft">
        <StatusDot color="#56d58a" size={6} />
        online{data.latencyMs !== undefined ? ` · ${data.latencyMs}ms` : ''}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[10.5px] text-loom-red-soft">
      <StatusDot color="#f87171" size={6} />
      offline
    </span>
  )
}

function MachineRow({ machine }: { machine: Machine }) {
  const openEditMachine = useLoomStore((s) => s.openEditMachine)
  const askDelete = useLoomStore((s) => s.askDelete)
  return (
    <article className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-[12px] border border-loom-border-card bg-loom-card px-3 py-2.5 transition-colors hover:border-loom-border-accent lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-loom-surface-2 text-loom-muted">
        {machine.isLocal ? <Monitor size={15} /> : <Server size={15} />}
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-[13px] font-semibold text-loom-fg-2">{machine.name}</div>
          {machine.isLocal ? (
            <span className="flex-none rounded-md border border-loom-border-card bg-loom-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] text-loom-dim-2">
              local
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate font-mono text-[10.5px] text-loom-dim-2">{machine.url}</div>
      </div>

      <div className="col-span-2 flex items-center gap-2 pl-12 lg:col-span-1 lg:pl-0">
        <RuntimeHealth machineId={machine.id} />
        <div className="min-w-2 flex-1 lg:hidden" />
        {machine.isLocal ? (
          <span className="ml-auto rounded-md bg-loom-surface-2 px-2 py-1 font-mono text-[10px] text-loom-dim-2 lg:ml-0">
            managed
          </span>
        ) : (
          <div className="ml-auto flex items-center gap-1 lg:ml-0">
            <button
              type="button"
              aria-label={`Edit ${machine.name}`}
              onClick={() => openEditMachine(machine.id, machine.name, machine.url, machine.key)}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-loom-surface-2 text-loom-muted hover:bg-loom-popover hover:text-loom-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Settings2 size={13} />
            </button>
            <button
              type="button"
              aria-label={`Delete ${machine.name}`}
              onClick={() => askDelete('machine', machine.id, machine.name)}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-loom-surface-2 text-loom-muted hover:bg-loom-red-tint hover:text-loom-red-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Trash2 size={13} />
            </button>
          </div>
        )}
      </div>
    </article>
  )
}

export function MachinesModule() {
  const { data: machines, isLoading, error, refetch } = useMachines()
  const openAddMachine = useLoomStore((s) => s.openAddMachine)
  const total = machines?.length ?? 0
  const local = machines?.filter((machine) => machine.isLocal).length ?? 0

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-none items-center gap-3 border-b border-loom-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-[15px] font-semibold text-loom-fg-2">Runtimes</h1>
            <span className="rounded-full bg-loom-surface-2 px-2 py-0.5 font-mono text-[10px] text-loom-muted-2">
              {total}
            </span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-loom-dim">
            {local} local · {Math.max(0, total - local)} remote
          </div>
        </div>
        <Button size="sm" onClick={openAddMachine}>
          <Plus size={13} />
          Add runtime
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
        {isLoading ? (
          <div className="flex h-[160px] items-center justify-center">
            <DataLoading compact label="loading runtimes…" />
          </div>
        ) : error ? (
          <div className="flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-[12px] border border-loom-border-card bg-loom-card px-4">
            <span className="text-center font-mono text-xs text-loom-dim-2">
              {error instanceof Error ? error.message : 'Failed to load runtimes'}
            </span>
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : !machines || machines.length === 0 ? (
          <div className="flex min-h-[180px] flex-col items-center justify-center rounded-[12px] border border-dashed border-loom-border-menu bg-loom-card/35 px-4 text-center">
            <div className="text-[13px] font-semibold text-loom-fg-2">No runtimes registered yet</div>
            <div className="mt-2 max-w-[42ch] text-[12px] leading-relaxed text-loom-muted">
              Add a runtime to run worktrees, terminals, and git on another machine.
            </div>
            <Button className="mt-4" size="sm" onClick={openAddMachine}>
              <Plus size={13} />
              Add runtime
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {machines.map((machine) => (
              <MachineRow key={machine.id} machine={machine} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

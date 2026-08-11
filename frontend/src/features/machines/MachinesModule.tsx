import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Download,
  KeyRound,
  Monitor,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Server,
  Settings2,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/ui/status-dot'
import { DataLoading } from '@/features/screens/DataLoading'
import type { Machine } from '@/store/types'
import { qk } from '@/features/data/keys'
import { useMachineHealth, useMachineUpdateCheck, useMachineVersion, useMachines } from '@/features/data/queries'
import { TerminalSessionsDialog } from '@/features/machines/TerminalSessionsDialog'
import { useDevDeckStore } from '@/store/useDevDeckStore'

function RuntimeHealth({ machineId }: { machineId: string }) {
  const { data, isLoading } = useMachineHealth(machineId)
  if (isLoading || !data) {
    return (
      <span className="inline-flex items-center gap-2 font-mono text-[10.5px] text-devdeck-fg-2">
        <StatusDot color="#6b7280" size={6} />
        checking
      </span>
    )
  }
  if (data.status === 'online') {
    return (
      <span className="inline-flex items-center gap-2 font-mono text-[10.5px] text-devdeck-run">
        <StatusDot color="#56d58a" size={6} />
        online{data.latencyMs !== undefined ? ` · ${data.latencyMs}ms` : ''}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[10.5px] text-devdeck-err">
      <StatusDot color="#f87171" size={6} />
      offline
    </span>
  )
}

function MachineRow({ machine }: { machine: Machine }) {
  const openEditMachine = useDevDeckStore((s) => s.openEditMachine)
  const openRuntimePin = useDevDeckStore((s) => s.openRuntimePin)
  const askDelete = useDevDeckStore((s) => s.askDelete)
  const askMachineAction = useDevDeckStore((s) => s.askMachineAction)
  const build = useMachineVersion(machine.id)
  const check = useMachineUpdateCheck(machine.id)
  const canUpdate = check.data?.updateAvailable === true && check.data.managed === false
  const [sessionsOpen, setSessionsOpen] = useState(false)
  return (
    <article className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-control border border-devdeck-border-card bg-devdeck-glass-solid px-3 py-2.5 transition-colors hover:border-devdeck-border-accent lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-control bg-devdeck-card-wash text-devdeck-fg-2">
        {machine.isLocal ? <Monitor size={15} /> : <Server size={15} />}
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-[13px] font-semibold text-devdeck-fg">{machine.name}</div>
          {machine.isLocal ? (
            <span className="flex-none rounded-md border border-devdeck-border-card bg-devdeck-card-wash px-1.5 py-0.5 font-mono text-[9.5px] text-devdeck-fg-2">
              local
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate font-mono text-[10.5px] text-devdeck-fg-2">{machine.url}</div>
      </div>

      <div className="col-span-2 flex items-center gap-2 pl-12 lg:col-span-1 lg:pl-0">
        <RuntimeHealth machineId={machine.id} />
        <div className="min-w-2 flex-1 lg:hidden" />
        <div className="ml-auto flex items-center gap-1 lg:ml-0">
          {machine.isLocal ? (
            <span className="rounded-md bg-devdeck-card-wash px-2 py-1 font-mono text-[10px] text-devdeck-fg-2">
              managed
            </span>
          ) : null}
          {build.data?.version ? (
            <span className="flex-none rounded-md border border-devdeck-border-card bg-devdeck-card-wash px-1.5 py-0.5 font-mono text-[9.5px] text-devdeck-fg-2">
              {build.data.version}
            </span>
          ) : null}
          {canUpdate ? (
            <button
              type="button"
              aria-label={`Update ${machine.name} to ${check.data?.latest}`}
              onClick={() =>
                askMachineAction('update', machine.id, machine.name, {
                  version: check.data?.latest,
                  activeSessions: check.data?.activeSessions,
                })
              }
              className="flex h-7 cursor-pointer items-center gap-1 rounded-md bg-devdeck-card-wash px-1.5 font-mono text-[9.5px] text-devdeck-run hover:bg-devdeck-glass-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Download size={12} />
              {check.data?.latest}
            </button>
          ) : null}
          {/* Outside the isLocal guard below: the desktop's embedded runtime
              serves a web UI too, and reaching it from a phone over the
              tailnet needs the same PIN. */}
          <button
            type="button"
            aria-label={`Set sign-in PIN for ${machine.name}`}
            title="Set sign-in PIN"
            onClick={() => openRuntimePin(machine.id, machine.name)}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-devdeck-card-wash text-devdeck-fg-2 hover:bg-devdeck-glass-solid hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <KeyRound size={13} />
          </button>
          <button
            type="button"
            aria-label={`Restart ${machine.name}`}
            onClick={() => askMachineAction('restart', machine.id, machine.name)}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-devdeck-card-wash text-devdeck-fg-2 hover:bg-devdeck-glass-solid hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <RotateCw size={13} />
          </button>
          {/* PTY sessions are deliberately never reaped, so one whose id has
              fallen out of the persisted pane layout is otherwise invisible
              and unkillable. This is the way to find and reap it. The dialog
              portals out, so it renders inside the row without affecting it. */}
          <button
            type="button"
            aria-label={`Terminal sessions on ${machine.name}`}
            title="Terminal sessions"
            onClick={() => setSessionsOpen(true)}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-devdeck-card-wash text-devdeck-fg-2 hover:bg-devdeck-glass-solid hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <TerminalSquare size={13} />
          </button>
          <TerminalSessionsDialog machine={machine} open={sessionsOpen} onOpenChange={setSessionsOpen} />
          {machine.isLocal ? null : (
            <>
              <button
                type="button"
                aria-label={`Stop ${machine.name}`}
                onClick={() => askMachineAction('stop', machine.id, machine.name)}
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-devdeck-card-wash text-devdeck-fg-2 hover:bg-devdeck-red-tint hover:text-devdeck-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Power size={13} />
              </button>
              <button
                type="button"
                aria-label={`Edit ${machine.name}`}
                onClick={() => openEditMachine(machine.id, machine.name, machine.url, machine.key)}
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-devdeck-card-wash text-devdeck-fg-2 hover:bg-devdeck-glass-solid hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Settings2 size={13} />
              </button>
              <button
                type="button"
                aria-label={`Delete ${machine.name}`}
                onClick={() => askDelete('machine', machine.id, machine.name)}
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-devdeck-card-wash text-devdeck-fg-2 hover:bg-devdeck-red-tint hover:text-devdeck-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  )
}

export function MachinesModule() {
  const { data: machines, isLoading, error, refetch } = useMachines()
  const openAddMachine = useDevDeckStore((s) => s.openAddMachine)
  const total = machines?.length ?? 0
  const local = machines?.filter((machine) => machine.isLocal).length ?? 0
  const queryClient = useQueryClient()
  const [checking, setChecking] = useState(false)

  async function checkAllForUpdates() {
    setChecking(true)
    try {
      await Promise.all(
        (machines ?? []).map((m) => queryClient.refetchQueries({ queryKey: qk.machineUpdateCheck(m.id) })),
      )
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-none items-center gap-3 border-b border-devdeck-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-[15px] font-semibold text-devdeck-fg">Runtimes</h1>
            <span className="rounded-full bg-devdeck-card-wash px-2 py-0.5 font-mono text-[10px] text-devdeck-fg-2">
              {total}
            </span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-devdeck-fg-2">
            {local} local · {Math.max(0, total - local)} remote
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void checkAllForUpdates()} disabled={checking}>
          <RefreshCw size={13} className={checking ? 'animate-spin' : undefined} />
          Check for updates
        </Button>
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
          <div className="flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-control border border-devdeck-border-card bg-devdeck-glass-solid px-4">
            <span className="text-center font-mono text-xs text-devdeck-fg-2">
              {error instanceof Error ? error.message : 'Failed to load runtimes'}
            </span>
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : !machines || machines.length === 0 ? (
          <div className="flex min-h-[180px] flex-col items-center justify-center rounded-control border border-dashed border-devdeck-border-menu bg-devdeck-glass-solid/35 px-4 text-center">
            <div className="text-[13px] font-semibold text-devdeck-fg">No runtimes registered yet</div>
            <div className="mt-2 max-w-[42ch] text-[12px] leading-relaxed text-devdeck-fg-2">
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

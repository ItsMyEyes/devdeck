import { useState } from 'react'
import { Pencil, Plus, Trash2, Waypoints } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/ui/status-dot'
import { Switch } from '@/components/ui/switch'
import {
  useCreateSSHForward,
  useDeleteSSHForward,
  useSSHForwards,
  useSSHForwardStates,
  useStartSSHForward,
  useStopSSHForward,
  useUpdateSSHForward,
} from '@/features/data/queries'
import { cn } from '@/lib/utils'
import type { SSHForward, SSHForwardState, SSHForwardStatus } from '@/store/types'
import { AddSSHForwardDialog, type ForwardFormBody } from './AddSSHForwardDialog'
import { DeleteSSHForwardDialog } from './DeleteSSHForwardDialog'

const MODE_BADGE: Record<SSHForward['mode'], string> = { local: '-L', remote: '-R', dynamic: '-D' }

const STATUS_META: Record<SSHForwardStatus, { label: string; dot: string; pill: string }> = {
  off: {
    label: 'Off',
    dot: 'var(--devdeck-fg-2)',
    pill: 'border-devdeck-border-card bg-devdeck-card-wash text-devdeck-fg-2',
  },
  starting: {
    label: 'Starting',
    dot: 'var(--devdeck-wait)',
    pill: 'border-devdeck-yellow-tint-border bg-devdeck-yellow-tint text-devdeck-yellow-tint-text',
  },
  running: {
    label: 'Running',
    dot: 'var(--devdeck-run)',
    pill: 'border-devdeck-green-tint-border bg-devdeck-green-tint text-devdeck-run',
  },
  reconnecting: {
    label: 'Reconnecting',
    dot: 'var(--devdeck-wait)',
    pill: 'border-devdeck-yellow-tint-border bg-devdeck-yellow-tint text-devdeck-yellow-tint-text',
  },
  failed: {
    label: 'Failed',
    dot: 'var(--devdeck-err)',
    pill: 'border-devdeck-red-tint bg-devdeck-red-tint-hover text-devdeck-err',
  },
}

/** True while an address is not confined to this machine's own loopback. */
function isNonLoopback(bindHost: string): boolean {
  return bindHost !== '127.0.0.1' && bindHost !== 'localhost'
}

function addressSummary(rule: SSHForward): string {
  const arrow = rule.mode === 'remote' ? '←' : '→'
  const target = rule.mode === 'dynamic' ? '(dynamic SOCKS5)' : `${rule.targetHost}:${rule.targetPort}`
  return `${rule.bindHost}:${rule.bindPort} ${arrow} ${target}`
}

interface ForwardRowProps {
  rule: SSHForward
  state: SSHForwardState
  onEdit: (rule: SSHForward) => void
  onDelete: (rule: SSHForward) => void
  onStart: (rule: SSHForward) => void
  onStop: (id: string) => void
}

function ForwardRow({ rule, state, onEdit, onDelete, onStart, onStop }: ForwardRowProps) {
  const nonLoopback = isNonLoopback(rule.bindHost)
  // "on" covers every state that isn't a deliberate stop — starting,
  // running, reconnecting and failed all read as an armed switch, since the
  // operator's intent was to have this forward up.
  const on = state.status !== 'off'
  const status = STATUS_META[state.status]
  const summary = addressSummary(rule)

  return (
    <div className="rounded-lg border border-devdeck-border bg-devdeck-pane p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex-none rounded-full border border-devdeck-border-menu px-1.5 py-0.5 font-mono text-[9.5px] uppercase text-devdeck-fg-2">
          {MODE_BADGE[rule.mode]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-devdeck-fg">{rule.label || summary}</div>
          {rule.label ? <div className="mt-0.5 truncate font-mono text-[10.5px] text-devdeck-fg-2">{summary}</div> : null}
        </div>
        <Switch checked={on} onCheckedChange={(next) => (next ? onStart(rule) : onStop(rule.id))} aria-label="Toggle forward" />
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[9.5px]', status.pill)}>
          <StatusDot color={status.dot} size={6} />
          {status.label}
          {(state.status === 'reconnecting' || state.status === 'failed') && state.attempts > 0
            ? ` · attempt ${state.attempts}`
            : null}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={`Edit forward ${rule.id}`}
            title="Edit"
            onClick={() => onEdit(rule)}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            aria-label={`Delete forward ${rule.id}`}
            title="Delete"
            onClick={() => onDelete(rule)}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-devdeck-fg-2 transition-colors hover:bg-devdeck-red-tint-hover hover:text-devdeck-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {state.status === 'failed' && state.error ? <p className="mt-2 font-mono text-[10.5px] text-devdeck-err">{state.error}</p> : null}

      {nonLoopback ? (
        <p className="mt-2 font-mono text-[10.5px] text-devdeck-wait">
          {rule.mode === 'remote' ? 'Reachable by anything that can route to the remote host.' : 'Reachable by anything that can route to the hub.'}
        </p>
      ) : null}
      {nonLoopback && rule.mode === 'remote' ? (
        <p className="mt-1 font-mono text-[10.5px] text-devdeck-fg-2">Requires `GatewayPorts yes` on the remote sshd.</p>
      ) : null}
    </div>
  )
}

/** SSH connection port-forwarding rules: list, add, edit, delete, and
 *  start/stop each rule's live listener (always hub-side — see Task 6's
 *  architecture-correction note). Add/edit lives in a modal
 *  (`AddSSHForwardDialog`) rather than an always-open inline form so the
 *  narrow sidebar's default view is just the rule list — matching the
 *  Add/Remove-dialog pattern `MCPManagement` already uses. `visible` mirrors
 *  StatsPane's own prop: the mounting sidebar passes `visible={false}` while
 *  this panel isn't the one showing, so the 2s state poll pauses instead of
 *  running forever. */
export function SSHForwardsPanel({ connectionId, visible }: { connectionId: string; visible: boolean }) {
  const forwardsQuery = useSSHForwards(connectionId)
  const statesQuery = useSSHForwardStates(visible)
  const states: SSHForwardState[] = statesQuery.data ?? []

  const createForward = useCreateSSHForward(connectionId)
  const updateForward = useUpdateSSHForward(connectionId)
  const deleteForward = useDeleteSSHForward(connectionId)
  const startForward = useStartSSHForward()
  const stopForward = useStopSSHForward(connectionId)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<SSHForward | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SSHForward | null>(null)

  function stateFor(forwardId: string): SSHForwardState {
    return states.find((s) => s.forwardId === forwardId) ?? { forwardId, status: 'off', attempts: 0 }
  }

  function openAdd() {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(rule: SSHForward) {
    setEditing(rule)
    setFormOpen(true)
  }

  function handleSubmit(body: ForwardFormBody) {
    if (editing) {
      updateForward.mutate({ id: editing.id, body })
    } else {
      createForward.mutate(body)
    }
    setFormOpen(false)
  }

  function confirmDelete() {
    if (!pendingDelete) return
    deleteForward.mutate(pendingDelete.id)
    setPendingDelete(null)
  }

  if (forwardsQuery.isLoading) {
    return <div className="p-4 font-mono text-[11px] text-devdeck-fg-2">Loading forwarding rules…</div>
  }
  if (forwardsQuery.error) {
    return (
      <div className="p-4 font-mono text-[11px] text-devdeck-err">
        {forwardsQuery.error instanceof Error ? forwardsQuery.error.message : 'Failed to load forwarding rules'}
      </div>
    )
  }

  const rules: SSHForward[] = forwardsQuery.data ?? []
  const pending = createForward.isPending || updateForward.isPending

  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3">
      {rules.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-devdeck-border-strong px-4 py-8 text-center">
          <Waypoints size={22} strokeWidth={1.5} className="text-devdeck-fg-2" />
          <p className="font-mono text-[11px] text-devdeck-fg-2">No forwarding rules yet.</p>
          <Button size="sm" onClick={openAdd}>
            <Plus size={13} />
            Add rule
          </Button>
        </div>
      ) : (
        <>
          <Button size="sm" variant="secondary" className="self-end" onClick={openAdd}>
            <Plus size={13} />
            Add rule
          </Button>
          <div className="flex flex-col gap-2">
            {rules.map((rule) => (
              <ForwardRow
                key={rule.id}
                rule={rule}
                state={stateFor(rule.id)}
                onEdit={openEdit}
                onDelete={setPendingDelete}
                onStart={(r) => startForward.mutate(r)}
                onStop={(id) => stopForward.mutate(id)}
              />
            ))}
          </div>
        </>
      )}

      <AddSSHForwardDialog
        open={formOpen}
        editing={editing}
        pending={pending}
        restartsRunning={editing ? stateFor(editing.id).status !== 'off' : false}
        onOpenChange={setFormOpen}
        onSubmit={handleSubmit}
      />
      <DeleteSSHForwardDialog
        open={pendingDelete !== null}
        rule={pendingDelete}
        pending={deleteForward.isPending}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

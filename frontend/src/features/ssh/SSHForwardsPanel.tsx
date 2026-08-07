import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
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
import type { SSHForward, SSHForwardMode, SSHForwardState, SSHForwardStatus } from '@/store/types'

const MODE_OPTIONS: { value: SSHForwardMode; label: string }[] = [
  { value: 'local', label: '-L local' },
  { value: 'remote', label: '-R remote' },
  { value: 'dynamic', label: '-D dynamic (SOCKS5)' },
]

const MODE_BADGE: Record<SSHForwardMode, string> = { local: '-L', remote: '-R', dynamic: '-D' }

function statusColor(status: SSHForwardStatus): string {
  switch (status) {
    case 'running':
      return 'var(--devdeck-run)'
    case 'reconnecting':
      return 'var(--devdeck-wait)'
    case 'failed':
      return 'var(--devdeck-err)'
    default:
      return 'var(--devdeck-fg-2)'
  }
}

/** True while an address is not confined to this machine's own loopback. */
function isNonLoopback(bindHost: string): boolean {
  return bindHost !== '127.0.0.1' && bindHost !== 'localhost'
}

interface ForwardDraft {
  mode: SSHForwardMode
  bindHost: string
  bindPort: string
  targetHost: string
  targetPort: string
  label: string
}

const EMPTY_DRAFT: ForwardDraft = {
  mode: 'local',
  bindHost: '127.0.0.1',
  bindPort: '',
  targetHost: '',
  targetPort: '',
  label: '',
}

function draftFromRule(rule: SSHForward): ForwardDraft {
  return {
    mode: rule.mode,
    bindHost: rule.bindHost,
    bindPort: String(rule.bindPort),
    targetHost: rule.targetHost,
    targetPort: rule.targetPort === 0 ? '' : String(rule.targetPort),
    label: rule.label,
  }
}

interface ForwardRowProps {
  rule: SSHForward
  state: SSHForwardState
  onEdit: (rule: SSHForward) => void
  onDelete: (id: string) => void
  onStart: (rule: SSHForward) => void
  onStop: (id: string) => void
}

function ForwardRow({ rule, state, onEdit, onDelete, onStart, onStop }: ForwardRowProps) {
  const nonLoopback = isNonLoopback(rule.bindHost)
  // "on" covers every state that isn't a deliberate stop — starting,
  // running, reconnecting and failed all read as an armed switch, since the
  // operator's intent was to have this forward up.
  const on = state.status !== 'off'

  return (
    <div className="rounded-lg border border-devdeck-border bg-devdeck-pane p-3">
      <div className="flex items-center gap-2.5">
        <span className="flex-none rounded-full border border-devdeck-border-menu px-1.5 py-0.5 font-mono text-[9.5px] uppercase text-devdeck-fg-2">
          {MODE_BADGE[rule.mode]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-devdeck-fg">
          {rule.bindHost}:{rule.bindPort}
          <span className="mx-1.5 text-devdeck-fg-2">{rule.mode === 'remote' ? '←' : '→'}</span>
          {rule.mode === 'dynamic' ? '(dynamic SOCKS5)' : `${rule.targetHost}:${rule.targetPort}`}
        </span>
        <StatusDot color={statusColor(state.status)} size={7} />
        <Switch
          checked={on}
          onCheckedChange={(next) => (next ? onStart(rule) : onStop(rule.id))}
          aria-label="Toggle forward"
        />
        <Button variant="ghost" size="sm" aria-label={`Edit forward ${rule.id}`} onClick={() => onEdit(rule)}>
          Edit
        </Button>
        <Button variant="ghost" size="sm" aria-label={`Delete forward ${rule.id}`} onClick={() => onDelete(rule.id)}>
          Delete
        </Button>
      </div>

      {state.status === 'failed' && state.error ? (
        <p className="mt-2 font-mono text-[10.5px] text-devdeck-err">{state.error}</p>
      ) : null}

      {nonLoopback ? (
        <p className="mt-2 font-mono text-[10.5px] text-devdeck-wait">Reachable by anything that can route to the hub.</p>
      ) : null}
      {nonLoopback && rule.mode === 'remote' ? (
        <p className="mt-1 font-mono text-[10.5px] text-devdeck-fg-2">Requires `GatewayPorts yes` on the remote sshd.</p>
      ) : null}
    </div>
  )
}

/** SSH connection port-forwarding rules: list, add, edit, delete, and
 *  start/stop each rule's live listener (always hub-side — see Task 6's
 *  architecture-correction note). `visible` mirrors StatsPane's own prop:
 *  the mounting sidebar passes `visible={false}` while this panel isn't the
 *  one showing, so the 2s state poll pauses instead of running forever. */
export function SSHForwardsPanel({ connectionId, visible }: { connectionId: string; visible: boolean }) {
  const forwardsQuery = useSSHForwards(connectionId)
  const statesQuery = useSSHForwardStates(visible)
  const states: SSHForwardState[] = statesQuery.data ?? []

  const createForward = useCreateSSHForward(connectionId)
  const updateForward = useUpdateSSHForward(connectionId)
  const deleteForward = useDeleteSSHForward(connectionId)
  const startForward = useStartSSHForward()
  const stopForward = useStopSSHForward(connectionId)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ForwardDraft>(EMPTY_DRAFT)

  function stateFor(forwardId: string): SSHForwardState {
    return states.find((s) => s.forwardId === forwardId) ?? { forwardId, status: 'off', attempts: 0 }
  }

  function startEdit(rule: SSHForward) {
    setEditingId(rule.id)
    setDraft(draftFromRule(rule))
  }

  function cancelEdit() {
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const body = {
      mode: draft.mode,
      bindHost: draft.bindHost || '127.0.0.1',
      bindPort: Number(draft.bindPort),
      targetHost: draft.mode === 'dynamic' ? '' : draft.targetHost,
      targetPort: draft.mode === 'dynamic' ? 0 : Number(draft.targetPort),
      label: draft.label,
    }
    if (editingId) {
      updateForward.mutate({ id: editingId, body })
    } else {
      createForward.mutate(body)
    }
    cancelEdit()
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
    <div className="flex flex-col gap-3 overflow-y-auto p-4">
      {rules.length === 0 ? (
        <p className="font-mono text-[11px] text-devdeck-fg-2">No forwarding rules yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rules.map((rule) => (
            <ForwardRow
              key={rule.id}
              rule={rule}
              state={stateFor(rule.id)}
              onEdit={startEdit}
              onDelete={(id) => deleteForward.mutate(id)}
              onStart={(r) => startForward.mutate(r)}
              onStop={(id) => stopForward.mutate(id)}
            />
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-2 rounded-lg border border-devdeck-border-menu p-3">
        <div className="flex gap-2">
          <Select
            value={draft.mode}
            onValueChange={(v) => setDraft((d) => ({ ...d, mode: v as SSHForwardMode }))}
            options={MODE_OPTIONS}
            aria-label="Forward mode"
            className="w-40 flex-none"
          />
          <Input
            value={draft.bindHost}
            onChange={(e) => setDraft((d) => ({ ...d, bindHost: e.target.value }))}
            placeholder="127.0.0.1"
            aria-label="Bind host"
            className="min-w-0 flex-1 font-mono"
          />
          <Input
            value={draft.bindPort}
            onChange={(e) => setDraft((d) => ({ ...d, bindPort: e.target.value }))}
            placeholder="Port"
            inputMode="numeric"
            aria-label="Bind port"
            className="w-20 flex-none font-mono"
          />
        </div>
        <div className="flex gap-2">
          <Input
            value={draft.targetHost}
            onChange={(e) => setDraft((d) => ({ ...d, targetHost: e.target.value }))}
            placeholder="Target host"
            disabled={draft.mode === 'dynamic'}
            aria-label="Target host"
            className="min-w-0 flex-1 font-mono"
          />
          <Input
            value={draft.targetPort}
            onChange={(e) => setDraft((d) => ({ ...d, targetPort: e.target.value }))}
            placeholder="Port"
            inputMode="numeric"
            disabled={draft.mode === 'dynamic'}
            aria-label="Target port"
            className="w-20 flex-none font-mono"
          />
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={draft.label}
            onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
            placeholder="Label (optional)"
            aria-label="Label"
            className="min-w-0 flex-1 font-mono"
          />
          {editingId ? (
            <Button type="button" variant="ghost" size="sm" onClick={cancelEdit}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={pending} className={cn(pending && 'opacity-70')}>
            {editingId ? 'Save' : 'Add'}
          </Button>
        </div>
      </form>
    </div>
  )
}

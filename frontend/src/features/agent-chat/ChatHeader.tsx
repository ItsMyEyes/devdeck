/**
 * Agent · model · mode pickers for one chat thread's header. Modeled on
 * t3code's `ChatHeader.tsx` in shape only (agent-first, controls trailing)
 * — every colour and control here is DevDeck's own `Select`/`StatusDot`,
 * none of t3code's styling crosses over (spec decision 2).
 *
 * Deviation from the plan: "agent picker (disabled entries for uninstalled
 * agents, with `Detail` as the tooltip)" assumes Task 11's per-machine
 * `Probe` snapshot (`provider.Snapshot.Detail`, `.Available`). That task —
 * and `/ws/agent` and the Claude adapter it would describe — isn't
 * implemented in this repo snapshot, so nothing in this header is wired to
 * a live orchestration instance yet. This reads the pre-existing CLI-agent
 * catalog instead (`useAgents`/`useAgentModels`, the same hooks
 * `SpawnDialog`/`AgentManagementModule` already use): an uninstalled agent
 * is disabled and states so inline in its label, since the shared `Select`
 * has no per-item tooltip slot to hang a separate reason off of. The
 * runtime-mode and interaction-mode pickers are local UI state for the same
 * reason — there is no command path yet to dispatch
 * `thread.runtime-mode.set` / `thread.interaction-mode.set` (that lands
 * with the Reactor + `/ws/agent` work, HANDOFF §6's "RuntimeMode vs
 * InteractionMode" — kept as two separate controls here, per the plan,
 * even though neither does anything downstream yet).
 */
import { useEffect, useState } from 'react'
import { MessageSquare } from 'lucide-react'
import { Select } from '@/components/ui/select'
import type { SelectOption } from '@/components/ui/select'
import { StatusDot } from '@/components/ui/status-dot'
import { useAgentModels, useAgents } from '@/features/data/queries'
import type { Machine } from '@/store/types'
import type { AgentThreadView } from '@/features/agent-chat/types'
import type { AgentSocketStatus } from '@/features/agent-chat/useAgentChatSocket'

/** Mirrors `provider.RuntimeMode` (`backend/internal/agentcore/provider/provider.go`) —
 *  UI-only until the Reactor can dispatch `thread.runtime-mode.set`. */
type RuntimeMode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'

/** Mirrors `provider.InteractionMode`. Deliberately a separate enum from
 *  `RuntimeMode` — see HANDOFF §6, collapsing the two was the mistake. */
type InteractionMode = 'default' | 'plan'

const RUNTIME_MODE_OPTIONS: SelectOption[] = [
  { value: 'approval-required', label: 'Approval required' },
  { value: 'auto-accept-edits', label: 'Auto-accept edits' },
  { value: 'auto', label: 'Auto' },
  { value: 'full-access', label: 'Full access' },
]

const INTERACTION_MODE_OPTIONS: SelectOption[] = [
  { value: 'default', label: 'Default' },
  { value: 'plan', label: 'Plan' },
]

const THREAD_STATUS_LABEL: Record<AgentThreadView['status'], string> = {
  idle: 'Idle',
  running: 'Running',
  waiting: 'Waiting',
  stopped: 'Stopped',
}

const SOCKET_DOT_COLOR: Record<AgentSocketStatus, string> = {
  connecting: 'var(--devdeck-wait)',
  open: 'var(--devdeck-run)',
  closed: 'var(--devdeck-err)',
}

/** A `threadKey` beyond the bare worktree id names an extra chat pane split
 *  off the primary one (`paneTree.ts`'s `createAgentChatPane`) — surfaced
 *  as a small suffix badge so a second/third thread on the same worktree is
 *  visually distinguishable from the primary one. */
function extraThreadSuffix(worktreeId: string, threadKey: string): string | null {
  if (threadKey === worktreeId) return null
  const suffix = threadKey.slice(worktreeId.length)
  return suffix.startsWith('::') ? suffix.slice(2) : suffix
}

export interface ChatHeaderProps {
  machine: Machine
  worktreeId: string
  threadKey: string
  socketStatus: AgentSocketStatus
  threadStatus: AgentThreadView['status']
}

export function ChatHeader({ machine, worktreeId, threadKey, socketStatus, threadStatus }: ChatHeaderProps) {
  const agents = useAgents(machine).data ?? []
  const installedAgents = agents.filter((agent) => agent.installed)
  const defaultAgentId = installedAgents[0]?.id ?? agents[0]?.id ?? ''

  const [agentId, setAgentId] = useState(defaultAgentId)
  useEffect(() => {
    if (!agentId && defaultAgentId) setAgentId(defaultAgentId)
  }, [agentId, defaultAgentId])

  const models = useAgentModels(machine, agentId || undefined).data ?? []
  const [modelId, setModelId] = useState('')
  useEffect(() => {
    if (models.length === 0) return
    if (!models.some((model) => model.id === modelId)) setModelId(models[0].id)
  }, [models, modelId])

  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>('approval-required')
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('default')

  const agentOptions: SelectOption[] = agents.map((agent) => ({
    value: agent.id,
    label: agent.installed ? agent.name : `${agent.name} — not installed`,
    disabled: !agent.installed,
  }))
  const modelOptions: SelectOption[] = models.map((model) => ({ value: model.id, label: model.name }))

  const threadSuffix = extraThreadSuffix(worktreeId, threadKey)

  return (
    <div className="flex min-w-0 flex-none flex-wrap items-center gap-2 border-b border-devdeck-line bg-devdeck-pane px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <MessageSquare size={14} className="flex-none text-devdeck-fg-2" />
        <span className="truncate font-mono text-[12.5px] font-medium text-devdeck-fg">Chat</span>
        {threadSuffix ? (
          <span className="flex-none rounded-full border border-devdeck-line bg-devdeck-on px-1.5 py-0.5 font-mono text-[10px] text-devdeck-fg-2">
            {threadSuffix}
          </span>
        ) : null}
        <span className="flex flex-none items-center gap-1.5 font-mono text-[11px] text-devdeck-fg-2">
          <StatusDot color={SOCKET_DOT_COLOR[socketStatus]} size={7} />
          {THREAD_STATUS_LABEL[threadStatus]}
        </span>
      </div>

      <div className="flex flex-none flex-wrap items-center gap-1.5">
        <Select
          value={agentId}
          onValueChange={setAgentId}
          options={agentOptions}
          disabled={agentOptions.length === 0}
          triggerClassName="h-7 min-w-[120px] px-2 text-[11.5px]"
          aria-label="Agent"
        />
        <Select
          value={modelId}
          onValueChange={setModelId}
          options={modelOptions}
          disabled={modelOptions.length === 0}
          triggerClassName="h-7 min-w-[140px] px-2 text-[11.5px]"
          aria-label="Model"
        />
        <Select
          value={runtimeMode}
          onValueChange={(value) => setRuntimeMode(value as RuntimeMode)}
          options={RUNTIME_MODE_OPTIONS}
          triggerClassName="h-7 min-w-[150px] px-2 text-[11.5px]"
          aria-label="Runtime mode"
        />
        <Select
          value={interactionMode}
          onValueChange={(value) => setInteractionMode(value as InteractionMode)}
          options={INTERACTION_MODE_OPTIONS}
          triggerClassName="h-7 min-w-[90px] px-2 text-[11.5px]"
          aria-label="Interaction mode"
        />
      </div>
    </div>
  )
}

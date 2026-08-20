// Renders the composer's queue-of-one approval (`can_use_tool`) prompt.
// Ported from t3code's `apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx`,
// with this repo's semantic tokens (`text-muted-foreground`, `border-border`,
// `bg-muted`) instead of t3code's raw values — mirrors
// `ComposerPendingUserInputPanel`'s queue-of-one UI decision (plan T16).
import { ComposerPendingApprovalActions } from '@/features/agent-chat/ComposerPendingApprovalActions'
import type { PendingApproval } from '@/features/agent-chat/types'
import type { RuntimeMode } from '@/features/agent-chat/useAgentChatSocket'

export interface ComposerPendingApprovalPanelProps {
  pendingApprovals: PendingApproval[]
  onRespondToApproval: (requestId: string, decision: string) => void
  /** Both optional so the panel's own tests — and any caller that has no
   *  composer controls to hand — keep rendering the four decision buttons
   *  unchanged; the mode row simply does not appear. */
  runtimeMode?: RuntimeMode
  onChangeRuntimeMode?: (mode: RuntimeMode) => void
}

const SUMMARY: Record<string, string> = {
  command_execution_approval: 'Command approval requested',
  file_read_approval: 'File-read approval requested',
  file_change_approval: 'File-change approval requested',
}

export function ComposerPendingApprovalPanel({
  pendingApprovals,
  onRespondToApproval,
  runtimeMode,
  onChangeRuntimeMode,
}: ComposerPendingApprovalPanelProps) {
  const active = pendingApprovals[0]
  if (!active) return null

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold tracking-[0.2em] uppercase text-muted-foreground">Pending approval</span>
        <span className="text-sm font-medium">{SUMMARY[active.requestType] ?? 'Approval requested'}</span>
        {pendingApprovals.length > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingApprovals.length}</span>
        ) : null}
      </div>
      {active.detail ? (
        <div className="mt-3 rounded-lg border border-border bg-background/70 p-3">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
            {active.detail}
          </pre>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <ComposerPendingApprovalActions
          requestId={active.requestId}
          options={active.options}
          onRespond={onRespondToApproval}
          runtimeMode={runtimeMode}
          onChangeRuntimeMode={onChangeRuntimeMode}
        />
      </div>
    </div>
  )
}

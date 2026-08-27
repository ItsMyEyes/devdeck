// Renders the composer's queue-of-one approval (`can_use_tool`) prompt.
// Ported from t3code's `apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx`
// — mirrors `ComposerPendingUserInputPanel`'s queue-of-one UI decision (plan T16).
//
// ── Kept in step with the question card ──
// Both panels share one slot in the composer and one situation: the turn is
// parked, waiting on the operator. So they are the same object visually — same
// card shell, same accent glyph, same eyebrow — and the only difference is what
// they ask for. This used to be t3code's shadcn tokens with no container at all
// (see the question panel's own note on what that looked like); it is now
// DESIGN.md's vocabulary, one tone step above the composer's fill.
import { ShieldAlert } from 'lucide-react'
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
    <div className="rounded-container border border-devdeck-border-card bg-devdeck-card px-3.5 py-3">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-3.5 flex-none text-devdeck-wait" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-[10.5px] font-semibold tracking-[0.13em] text-devdeck-fg-2 uppercase">
          Pending approval
        </span>
        {pendingApprovals.length > 1 ? (
          <span className="flex-none rounded-micro bg-devdeck-raised px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-devdeck-fg-2">
            1/{pendingApprovals.length}
          </span>
        ) : null}
      </div>
      {/* The ask itself, at the same weight and size the question card gives its
          question — one focal point per card. */}
      <p className="mt-1.5 text-[13.5px] leading-snug font-medium text-devdeck-fg">
        {SUMMARY[active.requestType] ?? 'Approval requested'}
      </p>
      {active.detail ? (
        <div className="mt-2 rounded-control border border-devdeck-hairline bg-devdeck-raised px-2.5 py-2">
          <pre className="max-h-40 overflow-auto font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-devdeck-fg-2">
            {active.detail}
          </pre>
        </div>
      ) : null}
      <div className="mt-2.5 flex flex-wrap justify-end gap-1.5">
        <ComposerPendingApprovalActions
          requestId={active.requestId}
          options={active.options}
          onRespond={onRespondToApproval}
          // The SAME pair the permission pill is driven by, on purpose: the
          // card's mode buttons and the pill must never be able to disagree
          // about what the thread's mode is.
          runtimeMode={runtimeMode}
          onChangeRuntimeMode={onChangeRuntimeMode}
        />
      </div>
    </div>
  )
}

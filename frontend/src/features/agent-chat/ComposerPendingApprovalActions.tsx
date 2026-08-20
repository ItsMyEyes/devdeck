// Action row for the composer's queue-of-one approval prompt. Ported from
// t3code's `apps/web/src/components/chat/ComposerPendingApprovalActions.tsx`,
// adapted to this repo's `Button` component and variants (plan T16) — no
// `ApprovalRequestId` branded type, plain `string`, matching this plan's
// `PendingApproval`.
import { Button } from '@/components/shadcn/button'
import type { RuntimeMode } from '@/features/agent-chat/useAgentChatSocket'

export interface ComposerPendingApprovalActionsProps {
  requestId: string
  options: string[]
  onRespond: (requestId: string, decision: string) => void
  /** The thread's current permission mode, so the row can drop the button for
   *  the mode already in force rather than offering a no-op. */
  runtimeMode?: RuntimeMode
  /** `ComposerControls`' own `setRuntimeMode` — the SAME dispatcher the
   *  permission pill uses, deliberately, so the two can never disagree about
   *  what the thread's mode is. */
  onChangeRuntimeMode?: (mode: RuntimeMode) => void
}

/**
 * The two mode buttons, and why they answer a prompt at all.
 *
 * Every other button here decides ONE request. These decide the standing
 * policy, and the backend then re-runs that policy against whatever is already
 * waiting (`approval.Gate.ReleasePending`): switching to full access releases
 * this card on its way past, because a mode that never asks cannot be left
 * asking. Switching to auto releases it only if the pending action is a READ —
 * auto's whole definition is "reads run, changes ask" — so a pending file write
 * stays up and still wants an answer. That is the intended difference between
 * the two, not a bug in the button.
 *
 * They are `outline`, not `default`: the primary action on an approval card is
 * still answering the question in front of you. Widening the thread's
 * permissions is the bigger, more durable decision and should not be the one
 * the eye lands on first.
 */
const MODE_ACTIONS: { mode: RuntimeMode; label: string }[] = [
  { mode: 'auto', label: 'Change mode auto' },
  { mode: 'full-access', label: 'Change mode fullaccess' },
]

export function ComposerPendingApprovalActions({
  requestId,
  options,
  onRespond,
  runtimeMode,
  onChangeRuntimeMode,
}: ComposerPendingApprovalActionsProps) {
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => onRespond(requestId, 'cancel')}>
        Cancel turn
      </Button>
      <Button size="sm" variant="outline" onClick={() => onRespond(requestId, 'decline')}>
        Decline
      </Button>
      {options.includes('acceptForSession') ? (
        <Button size="sm" variant="outline" onClick={() => onRespond(requestId, 'acceptForSession')}>
          Always allow this session
        </Button>
      ) : null}
      {onChangeRuntimeMode
        ? MODE_ACTIONS.filter(({ mode }) => mode !== runtimeMode).map(({ mode, label }) => (
            <Button key={mode} size="sm" variant="outline" onClick={() => onChangeRuntimeMode(mode)}>
              {label}
            </Button>
          ))
        : null}
      <Button size="sm" variant="default" onClick={() => onRespond(requestId, 'accept')}>
        Approve once
      </Button>
    </>
  )
}

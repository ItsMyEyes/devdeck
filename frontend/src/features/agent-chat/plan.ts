/**
 * Pure derivation of "is there a plan on the table" from a thread's flat
 * item list. `AgentThreadView` deliberately gains no new field for this —
 * see the design spec §5: deriving it beats storing it, because it is the
 * same rule the backend projector applies to `Thread.ProposedPlan` (set by
 * `EvtThreadPlanProposed`, cleared by the next `EvtThreadTurnStartRequested`
 * — see `orchestration/engine.go`), it replays exactly on reconnect, and it
 * cannot go stale the way a second field can.
 *
 * On the frontend a new turn always starts with a `'user'` item (folded by
 * `thread.message-sent`), so scanning back-to-front and stopping at the
 * first `'user'` item reproduces the backend's rule without a stored field:
 * the two projections key off the same two events by construction.
 */
import type { ChatItem } from '@/features/agent-chat/types'

/** The last `'plan'` item with no `'user'` item after it, or `null` if none.
 *  A `'user'` item anywhere after the last plan means a later turn has
 *  already superseded it. */
export function latestProposedPlan(items: ChatItem[]): ChatItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'user') return null
    if (items[i].kind === 'plan') return items[i]
  }
  return null
}

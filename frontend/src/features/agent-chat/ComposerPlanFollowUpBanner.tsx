/**
 * Plan T10 — the composer's plan follow-up banner. Ported from the 28-line
 * t3code original
 * (`gg/t3code/apps/web/src/components/chat/ComposerPlanFollowUpBanner.tsx`)
 * onto this repo's own component set (design spec §7): `Badge variant="info"`
 * becomes `@/components/ui/pill`'s `Pill`, styled with the same
 * `var(--devdeck-accent)` color `ProposedPlanCard` already uses for its own
 * "Plan" pill.
 *
 * The component owns the full three-way follow-up condition itself —
 * `interactionMode === 'plan' && status === 'idle' && plan !== null` — rather
 * than trusting a single caller-computed boolean (spec §7's
 * `showPlanFollowUpPrompt`, ported here as `plan`/`interactionMode`/`status`
 * props instead of `pendingUserInputs.length === 0` too, since DevDeck's
 * `status === 'idle'` already excludes `'waiting'` — see the design doc's
 * §7 note on the equivalence). `plan` is the caller's
 * `latestProposedPlan(view.items)` (T7) result, not the raw item list, so
 * this component does not need to re-derive it or depend on `ChatItem[]`
 * scanning order.
 *
 * Mounts in the `data-slot="composer-panels"` div `ChatComposer.tsx` reserves
 * (T12's job to wire it into the stack alongside A's pending-input/approval
 * panels).
 */
import { Pill } from '@/components/ui/pill'
import { proposedPlanTitle } from '@/features/agent-chat/planMarkdown'
import type { AgentThreadView, ChatItem } from '@/features/agent-chat/types'
import type { InteractionMode } from '@/features/agent-chat/useAgentChatSocket'

export interface ComposerPlanFollowUpBannerProps {
  /** The plan on the table, i.e. the caller's `latestProposedPlan(items)` —
   *  `null` when there is none. */
  plan: ChatItem | null
  interactionMode: InteractionMode
  status: AgentThreadView['status']
}

export function ComposerPlanFollowUpBanner({ plan, interactionMode, status }: ComposerPlanFollowUpBannerProps) {
  if (interactionMode !== 'plan' || status !== 'idle' || plan === null) return null

  const title = proposedPlanTitle(plan.text)

  return (
    <div data-composer-plan-follow-up-banner="true" className="flex flex-wrap items-center gap-2 px-4 py-3.5 sm:px-5 sm:py-4">
      <Pill color="var(--devdeck-accent)" className="uppercase tracking-wide">
        Plan Ready
      </Pill>
      {title ? <span className="min-w-0 flex-1 truncate text-sm font-medium text-devdeck-fg">{title}</span> : null}
    </div>
  )
}

import { describe, expect, it } from 'vitest'
import { latestProposedPlan } from '@/features/agent-chat/plan'
import type { ChatItem } from '@/features/agent-chat/types'

function item(kind: ChatItem['kind'], id: string, text = ''): ChatItem {
  return { id, kind, text, lastSequence: 0 }
}

describe('latestProposedPlan', () => {
  it('returns null for an empty list', () => {
    expect(latestProposedPlan([])).toBeNull()
  })

  it('returns the one plan item present', () => {
    const plan = item('plan', 'p1', '# Plan')
    expect(latestProposedPlan([item('user', 'u1'), plan])).toBe(plan)
  })

  it('returns the later of two plan items', () => {
    const first = item('plan', 'p1', '# First')
    const second = item('plan', 'p2', '# Second')
    expect(latestProposedPlan([item('user', 'u1'), first, item('assistant', 'a1'), second])).toBe(second)
  })

  // Mirrors the backend projector's rule (T3): EvtThreadPlanProposed sets
  // Thread.ProposedPlan, and the next EvtThreadTurnStartRequested clears it —
  // a new turn supersedes the old plan. On the frontend a new turn always
  // starts with a 'user' item, so scanning back-to-front and stopping at the
  // first 'user' item reproduces the same rule without a stored field.
  it('returns null when a user item follows the plan', () => {
    const plan = item('plan', 'p1', '# Plan')
    expect(latestProposedPlan([plan, item('user', 'u2')])).toBeNull()
  })

  it('returns null when a user item follows even a later plan-then-more-activity run', () => {
    const plan = item('plan', 'p1', '# Plan')
    expect(latestProposedPlan([item('user', 'u1'), plan, item('user', 'u2'), item('assistant', 'a1')])).toBeNull()
  })
})

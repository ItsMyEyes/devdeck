/**
 * Plan T10 — `ComposerPlanFollowUpBanner`, ported from the 28-line t3code
 * original (`gg/t3code/apps/web/src/components/chat/ComposerPlanFollowUpBanner.tsx`)
 * per design spec §7. The component itself owns the three-way follow-up
 * condition (`interactionMode === 'plan' && status === 'idle' && plan !==
 * null`) rather than trusting a single caller-computed boolean, so each leg
 * of that condition is exercised independently below — flipping any one of
 * the three away from its "show" value must render nothing, proving the
 * component actually checks all three rather than, say, only checking
 * `plan`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { ComposerPlanFollowUpBanner } from '@/features/agent-chat/ComposerPlanFollowUpBanner'
import type { ChatItem } from '@/features/agent-chat/types'

afterEach(() => cleanup())

function planItem(text: string): ChatItem {
  return { id: 'plan-1', kind: 'plan', text, lastSequence: 0 }
}

const PLAN = planItem('# Ship the widget\n\n- Wire the endpoint\n- Add a test')

describe('ComposerPlanFollowUpBanner — visibility', () => {
  it('renders when interactionMode is plan, status is idle, and a plan is on the table', () => {
    render(<ComposerPlanFollowUpBanner plan={PLAN} interactionMode="plan" status="idle" />)

    expect(screen.getByText('Plan Ready')).toBeInTheDocument()
  })

  it('renders nothing when interactionMode is not plan', () => {
    const { container } = render(<ComposerPlanFollowUpBanner plan={PLAN} interactionMode="default" status="idle" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when status is not idle', () => {
    const { container } = render(<ComposerPlanFollowUpBanner plan={PLAN} interactionMode="plan" status="running" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when there is no plan on the table', () => {
    const { container } = render(<ComposerPlanFollowUpBanner plan={null} interactionMode="plan" status="idle" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when both interactionMode and status disqualify it', () => {
    const { container } = render(<ComposerPlanFollowUpBanner plan={PLAN} interactionMode="default" status="waiting" />)

    expect(container).toBeEmptyDOMElement()
  })
})

describe('ComposerPlanFollowUpBanner — content', () => {
  it('shows a "Plan Ready" pill plus the plan title derived via proposedPlanTitle', () => {
    render(<ComposerPlanFollowUpBanner plan={PLAN} interactionMode="plan" status="idle" />)

    expect(screen.getByText('Plan Ready')).toBeInTheDocument()
    expect(screen.getByText('Ship the widget')).toBeInTheDocument()
  })

  it('shows just the pill, no title text, when the plan markdown has no heading', () => {
    render(<ComposerPlanFollowUpBanner plan={planItem('- just a list item')} interactionMode="plan" status="idle" />)

    expect(screen.getByText('Plan Ready')).toBeInTheDocument()
    expect(screen.queryByText('- just a list item')).not.toBeInTheDocument()
  })
})

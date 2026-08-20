/**
 * Plan T8 — pure string functions behind `ProposedPlanCard`. Ported from
 * `gg/t3code/apps/web/src/proposedPlan.ts` and its test file
 * `proposedPlan.test.ts` (design spec §6), with two DevDeck-specific
 * additions:
 *
 * - `shouldCollapseProposedPlan` factors out the ">900 chars or >20 lines"
 *   decision t3code inlines in its component (`ProposedPlanCard.tsx:71`) so
 *   the threshold is table-tested here without rendering anything.
 * - `resolvePlanFollowUpSubmission` returns `{action, text, mode}` rather
 *   than t3code's `{text, interactionMode}` — the shape the plan's §7 spells
 *   out, because T10/T12 dispatch on `action` ('refine' | 'implement') to
 *   pick Refine vs Implement, not just on which mode the result carries.
 */
import { describe, expect, it } from 'vitest'

import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildPlanImplementationPrompt,
  buildProposedPlanMarkdownFilename,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
  shouldCollapseProposedPlan,
  stripDisplayedPlanMarkdown,
} from './planMarkdown'

describe('proposedPlanTitle', () => {
  it('reads the first markdown heading as the plan title', () => {
    expect(proposedPlanTitle('# Integrate RPC\n\nBody')).toBe('Integrate RPC')
  })

  it('reads a lower-level heading when it is the first one', () => {
    expect(proposedPlanTitle('## Ship it\n\n- step 1')).toBe('Ship it')
  })

  it('returns null when the plan has no heading', () => {
    expect(proposedPlanTitle('- step 1')).toBeNull()
  })

  it('returns null for an empty plan', () => {
    expect(proposedPlanTitle('')).toBeNull()
  })
})

describe('stripDisplayedPlanMarkdown', () => {
  it('drops the leading title heading from displayed plan markdown', () => {
    expect(stripDisplayedPlanMarkdown('# Integrate RPC\n\n## Summary\n\n- step 1\n')).toBe('- step 1')
  })

  it('preserves non-summary headings after dropping the title heading', () => {
    expect(stripDisplayedPlanMarkdown('# Integrate RPC\n\n## Scope\n\n- step 1\n')).toBe('## Scope\n\n- step 1')
  })

  it('leaves markdown with no title heading untouched', () => {
    expect(stripDisplayedPlanMarkdown('- step 1\n- step 2')).toBe('- step 1\n- step 2')
  })
})

describe('buildCollapsedProposedPlanPreviewMarkdown', () => {
  it('drops the redundant title heading and preserves the following markdown lines', () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown('# Integrate RPC\n\n## Summary\n\n- step 1\n- step 2', {
        maxLines: 4,
      }),
    ).toBe('- step 1\n- step 2')
  })

  it('appends an overflow marker when the preview truncates remaining content', () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown('# Integrate RPC\n\n- step 1\n- step 2\n- step 3', {
        maxLines: 2,
      }),
    ).toBe('- step 1\n- step 2\n\n...')
  })

  it('defaults to an 8-line preview when no maxLines option is given', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `- step ${i + 1}`).join('\n')
    const preview = buildCollapsedProposedPlanPreviewMarkdown(`# Plan\n\n${lines}`)
    const visibleLines = preview.split('\n').filter((line) => line.trim().length > 0 && line.trim() !== '...')
    expect(visibleLines).toHaveLength(8)
    expect(preview.endsWith('...')).toBe(true)
  })

  it('caps the preview at exactly 10 visible lines with maxLines: 10 — the value ProposedPlanCard passes', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `- step ${i + 1}`).join('\n')
    const preview = buildCollapsedProposedPlanPreviewMarkdown(`# Plan\n\n${lines}`, { maxLines: 10 })
    const visibleLines = preview.split('\n').filter((line) => line.trim().length > 0 && line.trim() !== '...')
    expect(visibleLines).toHaveLength(10)
  })

  it('does not append an overflow marker when everything fits', () => {
    const preview = buildCollapsedProposedPlanPreviewMarkdown('# Plan\n\n- step 1\n- step 2', { maxLines: 10 })
    expect(preview).toBe('- step 1\n- step 2')
  })
})

describe('shouldCollapseProposedPlan', () => {
  it('does not collapse a plan at exactly the 900-character threshold', () => {
    expect(shouldCollapseProposedPlan('x'.repeat(900))).toBe(false)
  })

  it('collapses a plan one character over the 900-character threshold', () => {
    expect(shouldCollapseProposedPlan('x'.repeat(901))).toBe(true)
  })

  it('does not collapse a plan at exactly 20 lines', () => {
    const markdown = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    expect(shouldCollapseProposedPlan(markdown)).toBe(false)
  })

  it('collapses a plan with 21 lines', () => {
    const markdown = Array.from({ length: 21 }, (_, i) => `line ${i}`).join('\n')
    expect(shouldCollapseProposedPlan(markdown)).toBe(true)
  })

  it('does not collapse a short plan under both thresholds', () => {
    expect(shouldCollapseProposedPlan('# Plan\n\n- step 1')).toBe(false)
  })
})

describe('buildProposedPlanMarkdownFilename', () => {
  it('derives a stable markdown filename from the plan heading', () => {
    expect(buildProposedPlanMarkdownFilename('# Integrate Effect RPC Into Server App')).toBe(
      'integrate-effect-rpc-into-server-app.md',
    )
  })

  it('falls back to a generic filename when the plan has no heading', () => {
    expect(buildProposedPlanMarkdownFilename('- step 1')).toBe('plan.md')
  })

  it('strips punctuation the filesystem would reject', () => {
    expect(buildProposedPlanMarkdownFilename('# Ship it: "the fast way"?')).toBe('ship-it-the-fast-way.md')
  })
})

describe('normalizePlanMarkdownForExport', () => {
  it('collapses trailing whitespace to exactly one trailing newline', () => {
    expect(normalizePlanMarkdownForExport('# Plan\n\n- step 1\n\n\n')).toBe('# Plan\n\n- step 1\n')
  })

  it('adds a trailing newline when the plan has none', () => {
    expect(normalizePlanMarkdownForExport('# Plan\n\n- step 1')).toBe('# Plan\n\n- step 1\n')
  })
})

describe('buildPlanImplementationPrompt', () => {
  it('formats the plan exactly like the implementation handoff prompt', () => {
    expect(buildPlanImplementationPrompt('## Ship it\n\n- step 1\n')).toBe(
      'PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1',
    )
  })

  it('trims surrounding whitespace from the plan before formatting', () => {
    expect(buildPlanImplementationPrompt('  \n## Ship it\n\n- step 1\n\n  ')).toBe(
      'PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1',
    )
  })
})

describe('resolvePlanFollowUpSubmission', () => {
  const planMarkdown = '## Ship it\n\n- step 1\n'

  it('refines with the trimmed draft and stays in plan mode when the draft is non-empty', () => {
    expect(resolvePlanFollowUpSubmission({ draftText: '  Refine step 2 first  ', planMarkdown })).toEqual({
      action: 'refine',
      text: 'Refine step 2 first',
      mode: 'plan',
    })
  })

  it('implements the plan and switches to default mode when the draft is empty', () => {
    expect(resolvePlanFollowUpSubmission({ draftText: '', planMarkdown })).toEqual({
      action: 'implement',
      text: 'PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1',
      mode: 'default',
    })
  })

  it('implements the plan when the draft is only whitespace', () => {
    expect(resolvePlanFollowUpSubmission({ draftText: '   ', planMarkdown })).toEqual({
      action: 'implement',
      text: 'PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1',
      mode: 'default',
    })
  })
})

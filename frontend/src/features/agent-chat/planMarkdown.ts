/**
 * Plan T8 — pure string functions behind `ProposedPlanCard` and the
 * composer's plan follow-up (T10/T12). Ported from
 * `gg/t3code/apps/web/src/proposedPlan.ts` (design spec §6). Every function
 * here is pure and side-effect-free except `downloadPlanAsTextFile`, which is
 * the one place a file is written — kept here rather than in the component so
 * the component's render logic stays free of save plumbing, matching t3code's
 * own split.
 *
 * `resolvePlanFollowUpSubmission` deliberately does NOT match t3code's
 * return shape (`{text, interactionMode}`): the plan's §7/T8 spells out
 * `{action, text, mode}` instead, because T10/T12 need to know *which*
 * button fired (`'refine' | 'implement'`), not just which mode the result
 * carries.
 */

import { saveText } from '@/lib/saveFile'

const COLLAPSE_CHAR_THRESHOLD = 900
const COLLAPSE_LINE_THRESHOLD = 20

/** Derives a short title from the plan's first markdown heading (any level,
 *  up to 3 leading spaces of indent, per CommonMark's ATX rule) — the same
 *  regex t3code uses. `null` when the plan has no heading at all, so callers
 *  fall back to a generic label ("Proposed plan") instead of showing an
 *  empty string. */
export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim()
  return heading && heading.length > 0 ? heading : null
}

/** The markdown actually rendered in the card body: the leading title
 *  heading is redundant with the "Plan" badge + title already shown in the
 *  header, so it is dropped — along with a lone "## Summary" heading right
 *  under it, which the CLI's own plan template uses as a section label the
 *  card's layout already implies. */
export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(/\r?\n/)
  const sourceLines = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? lines.slice(1) : [...lines]
  while (sourceLines[0]?.trim().length === 0) {
    sourceLines.shift()
  }
  const firstHeadingMatch = sourceLines[0]?.match(/^\s{0,3}#{1,6}\s+(.+)$/)
  if (firstHeadingMatch?.[1]?.trim().toLowerCase() === 'summary') {
    sourceLines.shift()
    while (sourceLines[0]?.trim().length === 0) {
      sourceLines.shift()
    }
  }
  return sourceLines.join('\n')
}

/** The collapsed-card preview: the same stripped markdown, truncated to
 *  `maxLines` *visible* (non-blank) lines, with a trailing "..." marker when
 *  content was actually cut. Falls back to the plan's title when the
 *  stripped markdown has nothing left to preview. */
export function buildCollapsedProposedPlanPreviewMarkdown(
  planMarkdown: string,
  options?: { maxLines?: number },
): string {
  const maxLines = options?.maxLines ?? 8
  const lines = stripDisplayedPlanMarkdown(planMarkdown)
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
  const previewLines: string[] = []
  let visibleLineCount = 0
  let hasMoreContent = false

  for (const line of lines) {
    const isVisibleLine = line.trim().length > 0
    if (isVisibleLine && visibleLineCount >= maxLines) {
      hasMoreContent = true
      break
    }
    previewLines.push(line)
    if (isVisibleLine) {
      visibleLineCount += 1
    }
  }

  while (previewLines.length > 0 && previewLines.at(-1)?.trim().length === 0) {
    previewLines.pop()
  }

  if (previewLines.length === 0) {
    return proposedPlanTitle(planMarkdown) ?? 'Plan preview unavailable.'
  }

  if (hasMoreContent) {
    previewLines.push('', '...')
  }

  return previewLines.join('\n')
}

/** Whether the card should render collapsed by default — over 900
 *  characters or over 20 lines (design spec §6, ported from t3code's
 *  `ProposedPlanCard.tsx:71`). Factored out of the component so the exact
 *  threshold is table-tested here without rendering anything. */
export function shouldCollapseProposedPlan(planMarkdown: string): boolean {
  return planMarkdown.length > COLLAPSE_CHAR_THRESHOLD || planMarkdown.split('\n').length > COLLAPSE_LINE_THRESHOLD
}

function sanitizePlanFileSegment(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}]+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized.length > 0 ? sanitized : 'plan'
}

/** Deterministic filename for the Download / Save-to-workspace actions,
 *  derived from the plan's title (falls back to "plan.md" when the plan has
 *  no heading). */
export function buildProposedPlanMarkdownFilename(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown)
  return `${sanitizePlanFileSegment(title ?? 'plan')}.md`
}

/** Normalizes the plan markdown before Copy/Download/Save: trims trailing
 *  whitespace and ensures exactly one trailing newline, so the exported file
 *  neither ends mid-line nor accumulates a run of blank lines the CLI's own
 *  formatting sometimes leaves behind. */
export function normalizePlanMarkdownForExport(planMarkdown: string): string {
  return `${planMarkdown.trimEnd()}\n`
}

/** The exact handoff prompt the Implement action submits — T12 depends on
 *  this string verbatim, so it is a named, tested function rather than an
 *  inline template literal at the call site. */
export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `PLEASE IMPLEMENT THIS PLAN:\n${planMarkdown.trim()}`
}

export type PlanFollowUpAction = 'refine' | 'implement'

export interface PlanFollowUpSubmission {
  action: PlanFollowUpAction
  text: string
  /** The interaction mode the composer must be in *after* this submission —
   *  `'plan'` (unchanged) for Refine, `'default'` for Implement. */
  mode: 'default' | 'plan'
}

/** The composer's plan follow-up dispatch table (design spec §7): a
 *  non-empty draft refines the plan (stays in plan mode); an empty (or
 *  whitespace-only) draft implements the plan on the table and switches to
 *  default mode. Pure so T10/T12 can unit-test the mapping without wiring a
 *  real composer. */
export function resolvePlanFollowUpSubmission(input: {
  draftText: string
  planMarkdown: string
}): PlanFollowUpSubmission {
  const trimmedDraftText = input.draftText.trim()
  if (trimmedDraftText.length > 0) {
    return { action: 'refine', text: trimmedDraftText, mode: 'plan' }
  }

  return {
    action: 'implement',
    text: buildPlanImplementationPrompt(input.planMarkdown),
    mode: 'default',
  }
}

/**
 * Saves the plan as a markdown file, through the OS save dialog wherever one
 * is available — the one side-effecting function in this module (see file doc
 * comment). Delegates to `@/lib/saveFile` rather than driving an `<a download>`
 * itself: that anchor is silently swallowed inside the desktop shell's
 * webview, so this button did nothing at all there.
 *
 * Returns the promise so callers that want to report failure can await it;
 * `ProposedPlanCard` fires and forgets, and the browser's own download UI (or
 * the dialog) is the feedback.
 */
export function downloadPlanAsTextFile(filename: string, contents: string): Promise<boolean> {
  return saveText(contents, filename, 'text/markdown;charset=utf-8')
}

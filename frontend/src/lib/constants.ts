import type { InvoiceStatus, IssueStatus, LineKind, Priority, WorktreeState } from '@/store/types'

/**
 * Status palettes, as `var(--devdeck-*)` references rather than hex literals.
 *
 * These were hexes because `Pill` built its fill and border by concatenating an
 * alpha suffix (`color + '18'`), which only produces a valid colour from a hex.
 * That pinned every pill in the app to the dark-tuned value: on a light surface
 * `#7fb37f` is 2.4:1 and `#c9a86a` is 2.0:1 — pale highlighter rather than
 * readable text. `Pill` and `StatusDot` both use `color-mix` now, which accepts
 * any CSS <color>, so these follow the theme like everything else.
 *
 * The dark values are unchanged; `.light` in globals.css restates each token at
 * the darker end of the same hue.
 */
export const STATE: Record<WorktreeState, { label: string; color: string }> = {
  running: { label: 'running', color: 'var(--devdeck-run)' },
  waiting: { label: 'needs input', color: 'var(--devdeck-wait)' },
  idle: { label: 'idle', color: 'var(--devdeck-fg-2)' },
  stopped: { label: 'stopped', color: 'var(--devdeck-fg-2)' },
  error: { label: 'error', color: 'var(--devdeck-err)' },
}

export const PRI: Record<Priority, { label: string; color: string }> = {
  high: { label: 'High', color: 'var(--devdeck-st-yellow)' },
  normal: { label: 'Normal', color: 'var(--devdeck-st-blue)' },
  low: { label: 'Low', color: 'var(--devdeck-st-grey-dim)' },
}

export const ISSUE_STATUS: Record<IssueStatus, { label: string; color: string }> = {
  todo: { label: 'Todo', color: 'var(--devdeck-st-grey)' },
  in_progress: { label: 'In Progress', color: 'var(--devdeck-st-blue)' },
  in_review: { label: 'In Review', color: 'var(--devdeck-st-yellow)' },
  done: { label: 'Done', color: 'var(--devdeck-st-green)' },
}

export const INVST: Record<InvoiceStatus, { label: string; color: string }> = {
  draft: { label: 'Draft', color: 'var(--devdeck-st-grey)' },
  sent: { label: 'Sent', color: 'var(--devdeck-st-blue)' },
  paid: { label: 'Paid', color: 'var(--devdeck-st-green)' },
  overdue: { label: 'Overdue', color: 'var(--devdeck-st-red)' },
}

/** Terminal-log line kind → text color. */
export const KIND: Record<LineKind, string> = {
  cmd: 'var(--devdeck-st-cmd)',
  out: 'var(--devdeck-st-out)',
  ok: 'var(--devdeck-st-green)',
  warn: 'var(--devdeck-st-yellow)',
  err: 'var(--devdeck-st-red)',
  sys: 'var(--devdeck-st-grey)',
  file: 'var(--devdeck-st-purple)',
  dim: 'var(--devdeck-st-grey-dim)',
}

/** News tag → accent color. */
export const TAGC: Record<string, string> = {
  AI: 'var(--devdeck-st-purple)',
  Payments: 'var(--devdeck-st-green)',
  Eng: 'var(--devdeck-st-blue)',
  Business: 'var(--devdeck-st-yellow)',
  Finance: 'var(--devdeck-st-red)',
}

export const TAGC_FALLBACK = 'var(--devdeck-st-grey)'

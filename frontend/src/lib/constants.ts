import type { InvoiceStatus, LineKind, Priority, WorktreeState } from '@/store/types'

/** Worktree lifecycle → label + status color. */
export const STATE: Record<WorktreeState, { label: string; color: string }> = {
  running: { label: 'running', color: '#56d58a' },
  waiting: { label: 'needs input', color: '#f5c451' },
  idle: { label: 'idle', color: '#6b7280' },
  stopped: { label: 'stopped', color: '#6b7280' },
  error: { label: 'error', color: '#f87171' },
}

export const PRI: Record<Priority, { label: string; color: string }> = {
  high: { label: 'High', color: '#f5c451' },
  normal: { label: 'Normal', color: '#6d8bff' },
  low: { label: 'Low', color: '#5f6672' },
}

export const INVST: Record<InvoiceStatus, { label: string; color: string }> = {
  draft: { label: 'Draft', color: '#8a919c' },
  sent: { label: 'Sent', color: '#6d8bff' },
  paid: { label: 'Paid', color: '#56d58a' },
  overdue: { label: 'Overdue', color: '#f87171' },
}

/** Terminal-log line kind → text color. */
export const KIND: Record<LineKind, string> = {
  cmd: '#9db1ff',
  out: '#b6bcc6',
  ok: '#56d58a',
  warn: '#f5c451',
  err: '#f87171',
  sys: '#7f8794',
  file: '#c7a3ff',
  dim: '#5f6672',
}

/** News tag → accent color. */
export const TAGC: Record<string, string> = {
  AI: '#c7a3ff',
  Payments: '#56d58a',
  Eng: '#6d8bff',
  Business: '#f5c451',
  Finance: '#f08a8a',
}

export const TAGC_FALLBACK = '#8a919c'

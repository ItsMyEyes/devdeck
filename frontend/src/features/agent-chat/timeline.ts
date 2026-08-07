/**
 * Pure grouping of an `AgentThreadView`'s flat item list into renderable
 * timeline entries. Kept separate from `eventReducer.ts` because grouping
 * ("consecutive tool calls become one row") is a presentation concern, not
 * part of the event-sourced read model — the reducer's `ChatItem[]` stays
 * the single source of truth, and this is purely a view over it.
 */
import type { AgentThreadView, ChatItem } from '@/features/agent-chat/types'

export interface MessageEntry {
  kind: 'message'
  item: ChatItem
}

export interface ReasoningEntry {
  kind: 'reasoning'
  item: ChatItem
  /** Reasoning is verbose relative to the final answer, so entries start
   *  collapsed; the user expands them explicitly. */
  collapsed: boolean
}

export interface ToolGroupEntry {
  kind: 'tool-group'
  items: ChatItem[]
}

export type TimelineEntry = MessageEntry | ReasoningEntry | ToolGroupEntry

/**
 * Groups `view.items` in order. Consecutive `tool` items collapse into a
 * single `tool-group` entry — a turn that reads three files and edits one
 * should render as one compact block, not four separate rows. Any
 * non-`tool` item breaks the run, so two tool calls either side of an
 * assistant message form two separate groups.
 */
export function buildTimeline(view: AgentThreadView): TimelineEntry[] {
  const entries: TimelineEntry[] = []

  for (const item of view.items) {
    if (item.kind === 'tool') {
      const last = entries[entries.length - 1]
      if (last && last.kind === 'tool-group') {
        last.items.push(item)
      } else {
        entries.push({ kind: 'tool-group', items: [item] })
      }
      continue
    }

    if (item.kind === 'reasoning') {
      entries.push({ kind: 'reasoning', item, collapsed: true })
      continue
    }

    entries.push({ kind: 'message', item })
  }

  return entries
}

/** t3code's `MAX_VISIBLE_WORK_LOG_ENTRIES` — a turn that reads twenty files
 *  renders as one visible row plus a disclosure, not twenty rows pushing the
 *  prose off screen. */
export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1

export interface WorkLogCollapse {
  /** The newest `maxVisible` entries — always rendered. */
  visible: ChatItem[]
  /** The earlier entries, folded behind a `▸ N earlier steps` disclosure.
   *  Empty means no disclosure should render at all. */
  hidden: ChatItem[]
}

/**
 * Splits one tool-group's items into the newest `maxVisible` (always shown)
 * and everything before them (folded behind a disclosure). Order is
 * preserved in both halves — `items` is chronological, so "newest" is the
 * tail of the array.
 */
export function collapseWorkLog(items: ChatItem[], maxVisible: number = MAX_VISIBLE_WORK_LOG_ENTRIES): WorkLogCollapse {
  if (items.length <= maxVisible) return { visible: items, hidden: [] }
  const splitAt = items.length - maxVisible
  return { hidden: items.slice(0, splitAt), visible: items.slice(splitAt) }
}

export interface TurnBoundary {
  /** Stable key for this turn — the id of the leading `user` message entry,
   *  or a synthetic `turn-<index>` key for a run of entries with no leading
   *  user message (e.g. the thread's very first turn, replayed mid-stream). */
  key: string
  /** Index into `entries` of this turn's last entry — where a turn stamp
   *  renders, once the turn is complete. */
  lastEntryIndex: number
}

/**
 * Splits `buildTimeline`'s output into turns: a run of entries starting at
 * each `user` message (inclusive) and ending right before the next one, or
 * at the end of the list. Pure grouping only — `MessagesTimeline.tsx` pairs
 * this with wall-clock timestamps it observes itself (see that file's doc
 * comment on why: `ChatItem` carries no timestamp yet).
 */
export function turnBoundaries(entries: TimelineEntry[]): TurnBoundary[] {
  const turns: TurnBoundary[] = []

  entries.forEach((entry, index) => {
    const startsTurn = entry.kind === 'message' && entry.item.kind === 'user'
    if (startsTurn || turns.length === 0) {
      const key = entry.kind === 'message' ? entry.item.id : `turn-${index}`
      turns.push({ key, lastEntryIndex: index })
    } else {
      turns[turns.length - 1].lastEntryIndex = index
    }
  })

  return turns
}

/** Formats a completed turn's footer — `2:40:02 PM • 10s` — matching
 *  t3code's per-turn stamp. Pure formatting only; see `MessagesTimeline.tsx`
 *  for where `startedAt`/`completedAt` come from. */
export function formatTurnStamp(startedAt: number, completedAt: number): string {
  const time = new Date(completedAt).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
  const seconds = Math.max(0, Math.round((completedAt - startedAt) / 1000))
  return `${time} • ${seconds}s`
}

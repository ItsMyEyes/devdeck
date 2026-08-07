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

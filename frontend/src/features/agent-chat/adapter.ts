/**
 * Pure mapping from this app's read model (`AgentThreadView` / `ChatItem` /
 * `TimelineEntry`) onto the props the vendored AI Elements components expect.
 * No React, no rendering — everything here is a total function over plain
 * data, so the mapping is unit-tested rather than asserted through the DOM.
 *
 * It exists so the vendored files stay untouched. AI Elements is written
 * against the AI SDK's `UIMessage`/`ToolUIPart` shapes; this app is
 * event-sourced off a Go orchestration engine. Rather than reshape either
 * side, this module translates at the boundary.
 */
import type { ChatStatus, ToolUIPart } from 'ai'
import type { TimelineEntry } from '@/features/agent-chat/timeline'
import type { AgentThreadView, ChatItem } from '@/features/agent-chat/types'

/** `Message`'s `from` prop. Only the user's own turns are "user"; reasoning,
 *  tool rows, and errors are all things the assistant side produced. */
export function messageRole(kind: ChatItem['kind']): 'user' | 'assistant' {
  return kind === 'user' ? 'user' : 'assistant'
}

/** `ToolHeader`'s `type` prop. It derives the visible label back out with
 *  `type.split('-').slice(1).join('-')`, so the name round-trips including
 *  any hyphens of its own. */
export function toolUIType(toolName: string | undefined): `tool-${string}` {
  return `tool-${toolName && toolName.length > 0 ? toolName : 'Tool'}`
}

/**
 * `ToolHeader`'s `state` prop, which picks the status badge:
 * `input-streaming` → "Pending", `input-available` → "Running",
 * `output-available` → "Completed", `output-error` → "Error".
 *
 * `output-available` here means "the call completed", not "a result is
 * available" — the Claude provider never parses `tool_result`, so this app has
 * no tool output to show and never renders `ToolOutput`. "Completed" is still
 * the honest badge for a finished call.
 */
export function toolUIState(status: ChatItem['status']): ToolUIPart['state'] {
  switch (status) {
    case 'running':
      return 'input-available'
    case 'done':
      return 'output-available'
    case 'failed':
      return 'output-error'
    default:
      return 'input-streaming'
  }
}

/**
 * `PromptInputSubmit`'s `status` prop. It renders a stop button (and a
 * `type="button"`, not `type="submit"`) whenever this is `submitted` or
 * `streaming` — which is exactly the interrupt affordance this composer wants.
 * Enter still steers an in-flight turn, because `PromptInputTextarea` calls
 * `form.requestSubmit()` directly rather than clicking the submit button.
 */
export function promptChatStatus(view: AgentThreadView): ChatStatus {
  if (view.error !== null) return 'error'
  switch (view.status) {
    case 'running':
      return 'streaming'
    case 'waiting':
      return 'submitted'
    default:
      return 'ready'
  }
}

/** When this entry came into being. A tool group is stamped by its earliest
 *  call, matching how the group reads on screen: one block, started once. */
export function entryCreatedAt(entry: TimelineEntry): number | undefined {
  if (entry.kind === 'tool-group') return entry.items[0]?.createdAt
  return entry.item.createdAt
}

export interface TurnSpan {
  /** Stable key — the leading user message's id, or the first entry's id for a
   *  thread replayed with no leading user message. */
  key: string
  firstEntryIndex: number
  lastEntryIndex: number
}

/**
 * Splits a timeline into turns, carrying BOTH ends of each turn.
 *
 * `timeline.ts`'s `turnBoundaries` returns only `lastEntryIndex`, which was
 * enough when the turn stamp was a wall-clock reading taken at render time.
 * Now that `ChatItem` carries `createdAt`, a stamp needs the turn's start too,
 * and deriving it here keeps `timeline.ts` and its tests untouched.
 */
export function turnSpans(entries: TimelineEntry[]): TurnSpan[] {
  const spans: TurnSpan[] = []

  entries.forEach((entry, index) => {
    const startsTurn = entry.kind === 'message' && entry.item.kind === 'user'
    if (startsTurn || spans.length === 0) {
      const key = entry.kind === 'tool-group' ? (entry.items[0]?.id ?? `turn-${index}`) : entry.item.id
      spans.push({ key, firstEntryIndex: index, lastEntryIndex: index })
      return
    }
    spans[spans.length - 1].lastEntryIndex = index
  })

  return spans
}

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
 * The AI SDK `ChatStatus` this thread is in. `ChatComposer` reads it to decide
 * whether the agent is generating (`submitted` | `streaming`), which is when it
 * renders a separate interrupt control beside the submit button.
 *
 * It is deliberately NOT handed to `PromptInputSubmit` as-is: that component
 * turns itself into the stop control for both generating states, and `waiting`
 * is the one state where the agent is asking the user for something, so a
 * click on the action button there must send, not abort.
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

/**
 * When this entry last changed — the end of a turn's span.
 *
 * `entryCreatedAt` is not that end: a streamed assistant message is stamped
 * with the arrival of its FIRST chunk (deliberately — see `applyDelta`), so
 * using it for both ends of a turn reports the time-to-first-token as the whole
 * duration. A tool group ends when its LATEST call last moved, not when its
 * earliest one started.
 */
export function entryCompletedAt(entry: TimelineEntry): number | undefined {
  if (entry.kind !== 'tool-group') return itemCompletedAt(entry.item)
  const stamps = entry.items.map(itemCompletedAt).filter((at): at is number => at !== undefined)
  return stamps.length === 0 ? undefined : Math.max(...stamps)
}

function itemCompletedAt(item: ChatItem): number | undefined {
  return item.updatedAt ?? item.createdAt
}

/**
 * Prepares agent text for `MessageResponse`, turning every single newline into
 * a markdown hard break (two trailing spaces).
 *
 * Agent output is mostly prose with meaningful line breaks — progress
 * narration, un-bulleted step lists, file lists, unfenced command output — and
 * CommonMark collapses a single newline into a space. The bubble this replaced
 * used `whitespace-pre-wrap` and was faithful; Streamdown is not, and it has no
 * way to ADD a remark plugin (passing `remarkPlugins` replaces its own default
 * list, including the code-meta plugin `@streamdown/code` depends on). Doing it
 * to the text keeps the vendored file untouched and the rule unit-testable.
 *
 * Fenced code is left exactly as it arrived: trailing spaces there are content.
 */
export function withHardBreaks(text: string): string {
  if (!text.includes('\n')) return text

  const lines = text.split('\n')
  let inFence = false

  return lines
    .map((line, index) => {
      if (/^\s{0,3}(```|~~~)/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line

      const next = lines[index + 1]
      // Nothing follows, a blank line already ends the paragraph, or the author
      // already wrote a hard break — in all three cases there is nothing to do.
      if (next === undefined || next.trim() === '' || line.trim() === '') return line
      if (line.endsWith('  ') || line.endsWith('\\')) return line
      return `${line}  `
    })
    .join('\n')
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

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

/** The label a tool row shows for the call.
 *
 *  Replaces the former `toolUIType`, which encoded the name as `tool-<name>` so
 *  upstream's `ToolHeader` could decode it back out with
 *  `type.split('-').slice(1).join('-')`. `ToolCompactHeader` takes the name
 *  directly, so the round-trip — and its one real hazard, a tool whose own name
 *  contains a hyphen — is gone.
 *
 *  "Tool" for a call whose name has not arrived yet, which is better than an
 *  empty row that shifts its width when the name lands. */
export function toolDisplayName(toolName: string | undefined): string {
  return toolName && toolName.length > 0 ? toolName : 'Tool'
}

/**
 * The keys a tool's single most identifying argument lives under, most specific
 * first. `Read`/`Edit`/`Write` name a `file_path`, `Bash` a `command`,
 * `Grep`/`Glob` a `pattern`, `WebFetch` a `url`, `Task` a `description`.
 *
 * One ordered list rather than a per-tool table on purpose: the provider can
 * introduce a tool name this app has never heard of at any time (MCP tools
 * especially), and a list of argument names degrades to "something useful" for
 * those, where a name-keyed table degrades to nothing.
 */
const SUMMARY_KEYS = [
  'file_path',
  'path',
  'command',
  'pattern',
  'url',
  'query',
  'description',
  'name',
  'prompt',
] as const

/** How much of a summary survives before the row would stop being one line.
 *  Generous, because CSS truncation does the real work — this only stops a
 *  10,000-character heredoc from reaching the DOM at all. */
const SUMMARY_MAX = 160

/**
 * The one-line gist of what a tool call is doing — the file it reads, the
 * command it runs — for the compact tool row's dim trailing text.
 *
 * This is what makes a collapsed row worth reading. Without it every call in a
 * turn renders as an identical `Read`, `Read`, `Read` and the only way to learn
 * what happened is to expand each one; the argument was always the information,
 * and the tool name was always the label on it.
 *
 * Newlines are collapsed to single spaces (a multi-line heredoc in `command` is
 * still one action, and it has one row) and the result is capped, since it lands
 * in a `truncate` span where anything past the fold is invisible anyway.
 *
 * Returns `undefined` — not `''` — when there is nothing to say: while a call is
 * still streaming its arguments, for a genuinely zero-argument tool, and for any
 * input that is not a JSON object.
 */
export function toolSummary(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  for (const key of SUMMARY_KEYS) {
    const value = record[key]
    if (typeof value !== 'string') continue
    const line = value.replace(/\s+/g, ' ').trim()
    if (line.length === 0) continue
    return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX)}…` : line
  }
  return undefined
}

/**
 * The readable text inside a tool RESULT (`ChatItem.output`), or `undefined`
 * when there is no plain-text form to pull out.
 *
 * Providers that report results wrap them in the same content-part envelope
 * the model protocols use — pi's `tool_execution_end` sends
 * `{"content":[{"type":"text","text":"…"}]}`. Rendered as JSON that is four
 * lines of punctuation around one line of output, which is what a transcript
 * showing `"text": "new-superapps-dev2\nLinux new-…"` on one clipped line
 * actually was. Unwrapping it turns the disclosure back into what the command
 * printed.
 *
 * Deliberately conservative: anything that is not a string, or not that exact
 * envelope, returns `undefined` and the caller falls back to a JSON dump
 * rather than this inventing a rendering for a shape it does not know.
 */
export function toolResultText(output: unknown): string | undefined {
  if (typeof output === 'string') return output.length > 0 ? output : undefined
  if (typeof output !== 'object' || output === null) return undefined
  const content = (output as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) return undefined
    const { type, text } = part as { type?: unknown; text?: unknown }
    if (type !== 'text' || typeof text !== 'string') return undefined
    parts.push(text)
  }
  const joined = parts.join('\n')
  return joined.length > 0 ? joined : undefined
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

/**
 * The agent and model this thread's most recent turn actually ran on, or
 * `undefined` for a thread that has never completed one.
 *
 * ── Why the composer needs it ──
 * The model picker's value is local component state, because a model rides the
 * NEXT turn rather than changing the thread the way a runtime mode does. That
 * makes it correct while you sit in one pane and wrong the moment you leave:
 * switching tabs, panes or SSH sessions remounts `AgentChatPane`, the state
 * goes back to `null`, and the pill falls back to reading "Model" — on a thread
 * that has been running Sonnet for twenty turns. The operator's next message
 * then silently goes to the worktree's DEFAULT model, not the one the
 * conversation was being held on.
 *
 * The thread already knows the answer. `reduceAgentEvents` stamps `turnAgent` /
 * `turnModel` onto the last item of every settled turn, from that turn's own
 * `turn.started`, and those survive a reconnect replay because they are derived
 * from the event log rather than from anything a component remembered.
 *
 * Walks backwards and takes the FIRST turn that carries both: a thread whose
 * model was switched partway through resumes on the model it is on NOW, not
 * the one it started on.
 */
export function lastTurnModel(items: readonly ChatItem[]): { agentId: string; modelId: string } | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const { turnAgent, turnModel } = items[i]
    if (turnAgent && turnModel) return { agentId: turnAgent, modelId: turnModel }
  }
  return undefined
}

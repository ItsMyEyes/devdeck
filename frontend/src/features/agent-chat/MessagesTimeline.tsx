/**
 * Renders `buildTimeline(view)` through the vendored AI Elements components.
 * Purely presentational: grouping lives in `timeline.ts` (pure, unit-tested),
 * the model-to-props mapping lives in `adapter.ts` (pure, unit-tested), and
 * this file only decides which component each `TimelineEntry` becomes.
 *
 * The one piece of state it owns is legitimately a UI concern: which
 * reasoning blocks and tool groups the user has expanded. `buildTimeline`
 * recomputes `collapsed: true` on every call, so it cannot hold that itself.
 *
 * ── Layout ──
 * A transcript is a reading surface, so it is a single centred measure
 * (`max-w-3xl`) rather than the full pane width, and it is set in the UI
 * sans (Arial) at 14px — not in mono. Mono is for code, and it is still what
 * code blocks, tool arguments and the terminal use; running an agent's prose
 * through it was costing ~15% of the reading width in advance and made a
 * markdown reply indistinguishable from command output.
 *
 * Only two shapes carry a bubble: the user's own turn (a right-aligned pill)
 * and an error (an alert). The agent's reply is plain text on the pane, which
 * is what lets its markdown — headings, lists, tables — actually read as a
 * document instead of as a chat bubble's contents.
 *
 * Turn stamps come from `ChatItem.createdAt` (the orchestration event's own
 * timestamp). The previous implementation read `Date.now()` during render and
 * cached it in a ref, because `ChatItem` carried no timestamp; that hack and
 * its "approximate after a reconnect replays a whole thread" caveat are both
 * gone.
 */
import { Fragment, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, ChevronRight, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger, useReasoning } from '@/components/ai-elements/reasoning'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Task, TaskContent, TaskTrigger } from '@/components/ai-elements/task'
import { Tool, ToolContent, ToolHeader, ToolInput } from '@/components/ai-elements/tool'
import { entryCompletedAt, entryCreatedAt, messageRole, toolUIState, toolUIType, turnSpans, withHardBreaks } from '@/features/agent-chat/adapter'
import { buildTimeline, collapseWorkLog, formatTurnStamp } from '@/features/agent-chat/timeline'
import type { ReasoningEntry, TimelineEntry, ToolGroupEntry } from '@/features/agent-chat/timeline'
import type { AgentThreadView, ChatItem } from '@/features/agent-chat/types'

export interface MessagesTimelineProps {
  view: AgentThreadView
}

/** The transcript's reading measure. Everything in the column — messages,
 *  tool cards, the composer above it — shares this width so the eye tracks a
 *  single left edge down the thread. */
const COLUMN = 'mx-auto flex w-full max-w-3xl flex-col'

function entryKey(entry: TimelineEntry, index: number): string {
  if (entry.kind === 'tool-group') return entry.items[0]?.id ?? `tool-group-${index}`
  return entry.item.id
}

/** An agent-reported failure. Deliberately not a `Message`: it is not part of
 *  the conversation, and it must reach a screen reader as an alert. */
function ErrorRow({ item }: { item: ChatItem }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 self-stretch rounded-xl border border-devdeck-red-tint-strong-border bg-devdeck-red-tint px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-devdeck-err"
    >
      <AlertTriangle size={14} className="mt-0.5 flex-none" aria-hidden="true" />
      <span className="min-w-0">{item.text}</span>
    </div>
  )
}

/** A conversation turn.
 *
 *  The user's turn is a right-aligned pill on the raised surface — neutral,
 *  not accent-tinted: DESIGN.md reserves the accent for the focus ring, the
 *  state bar, links and the single primary action per screen, and "every
 *  message you have ever sent" is none of those. The agent's turn has no
 *  bubble at all.
 *
 *  Only the AGENT's text goes through markdown. The user's own text is
 *  rendered verbatim in a pre-wrap block: it is a literal prompt, not a
 *  document, and running it through Streamdown drops `<div>` as an HTML tag,
 *  eats the underscores of `__init__`, turns a pasted `# comment` into an H1,
 *  and collapses the newlines of a Shift+Enter message. */
function MessageRow({ item }: { item: ChatItem }) {
  const isUser = item.kind === 'user'
  return (
    <Message from={messageRole(item.kind)} className={isUser ? 'max-w-[82%]' : 'max-w-full'}>
      <MessageContent
        className={cn(
          'text-[14px]',
          isUser
            ? 'leading-relaxed group-[.is-user]:rounded-2xl group-[.is-user]:bg-devdeck-raised group-[.is-user]:px-4 group-[.is-user]:py-2.5'
            : 'w-full max-w-full',
        )}
      >
        {isUser ? (
          <div className="break-words whitespace-pre-wrap">{item.text || '…'}</div>
        ) : (
          <MessageResponse className="chat-md">{withHardBreaks(item.text) || '…'}</MessageResponse>
        )}
      </MessageContent>
      {isUser ? null : <CopyAction text={item.text} />}
    </Message>
  )
}

/** Message-level copy. Streamdown gives fenced code its own copy button, but
 *  the common case in a transcript is copying the agent's prose, which had no
 *  affordance at all. Hidden until the turn is hovered or focused so a long
 *  thread is not a column of icons. */
function CopyAction({ text }: { text: string }) {
  if (text.length === 0) return null
  return (
    <MessageActions className="-ml-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <MessageAction
        className="size-6 text-devdeck-fg-2 hover:text-devdeck-fg"
        label="Copy message"
        onClick={() => void navigator.clipboard?.writeText(text)}
      >
        <Copy size={12} aria-hidden="true" />
      </MessageAction>
    </MessageActions>
  )
}

/** The reasoning disclosure's label — `Worked for 11s ›`, the shape t3code
 *  uses. The vendored default is a brain glyph plus "Thought for N seconds";
 *  this replaces the whole thing rather than restyling it, because the glyph
 *  is a direct child of the trigger and there is no prop that removes it. */
function ReasoningLabel() {
  const { isStreaming, isOpen, duration } = useReasoning()

  return (
    <>
      {isStreaming ? (
        <Shimmer as="span" duration={1.4}>
          Working…
        </Shimmer>
      ) : (
        <span>{duration === undefined ? 'Worked for a few seconds' : `Worked for ${duration}s`}</span>
      )}
      <ChevronRight aria-hidden="true" className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')} />
    </>
  )
}

/** How long the agent spent on this reasoning block, from the orchestration
 *  event's own timestamps. Handed to `Reasoning` so a REPLAYED thread stamps
 *  the same duration the live one did — the vendored component can only time
 *  a stream it watched itself, so on reconnect every block read "a few
 *  seconds". `undefined` for a block that never advanced, which is what makes
 *  the label fall back rather than claim "0s". */
function reasoningDuration(item: ChatItem): number | undefined {
  if (item.createdAt === undefined) return undefined
  const seconds = Math.round(((item.updatedAt ?? item.createdAt) - item.createdAt) / 1000)
  return seconds > 0 ? seconds : undefined
}

function ReasoningRow({ entry, streaming }: { entry: ReasoningEntry; streaming: boolean }) {
  return (
    <Reasoning
      className="mb-0 max-w-full self-start"
      duration={reasoningDuration(entry.item)}
      isStreaming={streaming}
      defaultOpen={false}
    >
      <ReasoningTrigger className="w-auto cursor-pointer gap-1.5 text-[13px] text-devdeck-fg-2 hover:text-devdeck-fg">
        <ReasoningLabel />
      </ReasoningTrigger>
      {/* Reasoning is prose whose line breaks matter even more than an answer's
          — same treatment, same reason as MessageRow's assistant branch. */}
      <ReasoningContent className="chat-md mt-3 border-l border-devdeck-hairline pl-3.5 text-[13px] text-devdeck-fg-2">
        {withHardBreaks(entry.item.text)}
      </ReasoningContent>
    </Reasoning>
  )
}

/** One tool call. `ToolInput` is rendered only when arguments actually
 *  arrived; `ToolOutput` never is — the Claude provider does not parse
 *  `tool_result`, so this app has no tool output to show.
 *
 *  With no arguments there is nothing to disclose, and `ToolHeader` is
 *  unconditionally the collapsible's trigger — so the row is disabled rather
 *  than offering a chevron that expands to nothing. That is every call while it
 *  is still in flight, plus any zero-argument call. */
function ToolRow({ item }: { item: ChatItem }) {
  return (
    <Tool disabled={item.input === undefined}>
      {/* Radix marks a disabled collapsible's trigger with `data-disabled`;
          hiding its chevron there is what stops the row reading as expandable.
          The chevron is the trigger's only direct `svg` child. */}
      <ToolHeader
        className="data-[disabled]:cursor-default [&[data-disabled]>svg]:invisible"
        type={toolUIType(item.toolName)}
        state={toolUIState(item.status)}
      />
      {item.input === undefined ? null : (
        <ToolContent>
          <ToolInput input={item.input} />
        </ToolContent>
      )}
    </Tool>
  )
}

/** A run of consecutive calls. Everything but the newest folds behind a
 *  disclosure — a turn that reads twenty files must not push the prose off
 *  screen. */
function ToolGroupRow({ entry, expanded, onToggle }: { entry: ToolGroupEntry; expanded: boolean; onToggle: () => void }) {
  const { visible, hidden } = collapseWorkLog(entry.items)
  return (
    <div className="flex w-full flex-col">
      {hidden.length > 0 ? (
        <Task open={expanded} onOpenChange={onToggle}>
          <TaskTrigger title={`${hidden.length} earlier ${hidden.length === 1 ? 'step' : 'steps'}`} />
          <TaskContent>
            {hidden.map((item) => (
              <ToolRow key={item.id} item={item} />
            ))}
          </TaskContent>
        </Task>
      ) : null}
      {visible.map((item) => (
        <ToolRow key={item.id} item={item} />
      ))}
    </div>
  )
}

function TurnStamp({ startedAt, completedAt }: { startedAt: number; completedAt: number }) {
  return <div className="self-start pt-0.5 text-[11px] text-devdeck-dim-pane">{formatTurnStamp(startedAt, completedAt)}</div>
}

/** Ticks once a second while the agent works, so `WorkingRow` can count up.
 *  `since` is the last event's wall clock, not a render-time reading, so the
 *  count survives a re-render and is correct after a reconnect replay. */
function useElapsedSeconds(since: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (since === undefined) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [since])

  if (since === undefined) return null
  return Math.max(0, Math.round((now - since) / 1000))
}

/** `••• Working for 5s` — the gap between "the turn was accepted" and "the
 *  first token arrived", which is otherwise a silent, empty pane. Rendered
 *  only while nothing else is moving on screen (see `showWorking` below): once
 *  text is streaming or a tool row is live, that IS the progress indicator. */
function WorkingRow({ since }: { since: number | undefined }) {
  const seconds = useElapsedSeconds(since)

  return (
    <div className="flex items-center gap-2 self-start text-[13px] text-devdeck-fg-2">
      <span aria-hidden="true" className="flex items-center gap-1">
        <span className="size-[5px] animate-dot-pulse rounded-full bg-current" />
        <span className="size-[5px] animate-dot-pulse rounded-full bg-current [animation-delay:0.22s]" />
        <span className="size-[5px] animate-dot-pulse rounded-full bg-current [animation-delay:0.44s]" />
      </span>
      {seconds === null ? 'Working…' : `Working for ${seconds}s`}
    </div>
  )
}

export function MessagesTimeline({ view }: MessagesTimelineProps) {
  const entries = buildTimeline(view)
  const spans = turnSpans(entries)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const lastIndex = entries.length - 1

  // Only when the agent has accepted the turn and produced nothing visible
  // yet. A streaming reply, a live tool row or a reasoning block is already
  // telling the user the same thing, and two progress indicators at once read
  // as two things happening.
  const lastItem = view.items[view.items.length - 1]
  const showWorking =
    view.status === 'running' && (lastItem === undefined || lastItem.kind === 'user' || lastItem.text.trim().length === 0)

  return (
    <div className={cn(COLUMN, 'gap-5 px-5 py-6 text-[14px] text-devdeck-fg')}>
      {entries.map((entry, index) => {
        const key = entryKey(entry, index)

        // A turn stamp renders on the turn's last entry, but only once that
        // turn is settled. The trailing turn is settled when the thread is
        // neither running nor blocked waiting on the user (a turn parked on an
        // approval has not finished); an earlier turn always is, because the
        // next turn's user message already arrived after it.
        const span = spans.find((s) => s.lastEntryIndex === index)
        const isTrailingTurn = span?.lastEntryIndex === lastIndex
        const inFlight = view.status === 'running' || view.status === 'waiting'
        const settled = span !== undefined && (!isTrailingTurn || !inFlight)
        const startedAt = span ? entryCreatedAt(entries[span.firstEntryIndex]) : undefined
        // The END of the turn, not the creation of its last entry — see
        // `entryCompletedAt`. A streamed reply's createdAt is its
        // time-to-first-token, which is not when the turn finished.
        const completedAt = span ? entryCompletedAt(entries[span.lastEntryIndex]) : undefined

        let node: ReactNode
        if (entry.kind === 'message') {
          node = entry.item.kind === 'error' ? <ErrorRow item={entry.item} /> : <MessageRow item={entry.item} />
        } else if (entry.kind === 'reasoning') {
          node = <ReasoningRow entry={entry} streaming={view.status === 'running' && index === lastIndex} />
        } else {
          const groupKey = `tool-group:${key}`
          node = <ToolGroupRow entry={entry} expanded={expanded.has(groupKey)} onToggle={() => toggle(groupKey)} />
        }

        return (
          <Fragment key={key}>
            {node}
            {settled && startedAt !== undefined && completedAt !== undefined ? (
              <TurnStamp startedAt={startedAt} completedAt={completedAt} />
            ) : null}
          </Fragment>
        )
      })}

      {showWorking ? <WorkingRow since={lastItem?.updatedAt ?? lastItem?.createdAt} /> : null}

      {view.hasGap ? (
        <div className="flex items-center gap-1.5 self-center rounded-full border border-devdeck-hairline bg-devdeck-raised px-2.5 py-1 text-[11.5px] text-devdeck-fg-2">
          <AlertTriangle size={11} className="text-devdeck-wait" />
          Some updates may be missing from this thread
        </div>
      ) : null}
    </div>
  )
}

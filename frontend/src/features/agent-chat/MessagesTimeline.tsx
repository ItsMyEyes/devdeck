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
 * Turn stamps come from `ChatItem.createdAt` (the orchestration event's own
 * timestamp). The previous implementation read `Date.now()` during render and
 * cached it in a ref, because `ChatItem` carried no timestamp; that hack and
 * its "approximate after a reconnect replays a whole thread" caveat are both
 * gone.
 */
import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Task, TaskContent, TaskTrigger } from '@/components/ai-elements/task'
import { Tool, ToolContent, ToolHeader, ToolInput } from '@/components/ai-elements/tool'
import { entryCreatedAt, messageRole, toolUIState, toolUIType, turnSpans } from '@/features/agent-chat/adapter'
import { buildTimeline, collapseWorkLog, formatTurnStamp } from '@/features/agent-chat/timeline'
import type { ReasoningEntry, TimelineEntry, ToolGroupEntry } from '@/features/agent-chat/timeline'
import type { AgentThreadView, ChatItem } from '@/features/agent-chat/types'

export interface MessagesTimelineProps {
  view: AgentThreadView
}

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
      className="self-stretch rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-devdeck-err"
    >
      {item.text}
    </div>
  )
}

/** A conversation turn. The user bubble keeps this app's accent tint rather
 *  than AI Elements' `bg-secondary` default — the tint is what the pane has
 *  always used, and a solid accent fill would break DESIGN.md's rule that the
 *  accent is never decorative. */
function MessageRow({ item }: { item: ChatItem }) {
  const isUser = item.kind === 'user'
  return (
    <Message from={messageRole(item.kind)} className="max-w-[86%]">
      <MessageContent
        className={cn(
          'font-mono text-[12.5px] leading-relaxed',
          isUser && 'group-[.is-user]:border group-[.is-user]:border-devdeck-border-accent group-[.is-user]:bg-devdeck-accent-tint',
        )}
      >
        <MessageResponse>{item.text || '…'}</MessageResponse>
      </MessageContent>
    </Message>
  )
}

function ReasoningRow({ entry, streaming }: { entry: ReasoningEntry; streaming: boolean }) {
  return (
    <Reasoning className="max-w-[86%] self-start" isStreaming={streaming} defaultOpen={false}>
      <ReasoningTrigger />
      <ReasoningContent>{entry.item.text}</ReasoningContent>
    </Reasoning>
  )
}

/** One tool call. `ToolInput` is rendered only when arguments actually
 *  arrived; `ToolOutput` never is — the Claude provider does not parse
 *  `tool_result`, so this app has no tool output to show. */
function ToolRow({ item }: { item: ChatItem }) {
  return (
    <Tool>
      <ToolHeader type={toolUIType(item.toolName)} state={toolUIState(item.status)} />
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
  return <div className="self-start px-1 font-mono text-[10px] text-devdeck-dim-pane">{formatTurnStamp(startedAt, completedAt)}</div>
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

  return (
    <div className="flex flex-col gap-2.5 px-4 py-4">
      {entries.map((entry, index) => {
        const key = entryKey(entry, index)

        // A turn stamp renders on the turn's last entry, but only once that
        // turn is settled. The trailing turn is settled when the thread
        // itself stops running; an earlier turn always is, because the next
        // turn's user message already arrived after it.
        const span = spans.find((s) => s.lastEntryIndex === index)
        const isTrailingTurn = span?.lastEntryIndex === lastIndex
        const settled = span !== undefined && (!isTrailingTurn || view.status !== 'running')
        const startedAt = span ? entryCreatedAt(entries[span.firstEntryIndex]) : undefined
        const completedAt = span ? entryCreatedAt(entries[span.lastEntryIndex]) : undefined

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
      {view.hasGap ? (
        <div className="flex items-center gap-1.5 self-center rounded-full border border-devdeck-hairline bg-devdeck-raised px-2.5 py-1 font-mono text-[10.5px] text-devdeck-fg-2">
          <AlertTriangle size={11} className="text-devdeck-wait" />
          Some updates may be missing from this thread
        </div>
      ) : null}
    </div>
  )
}

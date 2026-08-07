/**
 * Renders `buildTimeline(view)` — grouped messages, reasoning blocks, and
 * read-only tool rows. Purely presentational: all grouping/ordering logic
 * lives in `timeline.ts` (pure, unit-tested); this component only decides
 * how each `TimelineEntry` looks, plus owns the two pieces of state that
 * are legitimately UI concerns rather than view-model ones — which
 * reasoning/tool-group blocks the user has expanded, and (see below) each
 * turn's observed wall-clock timing. `buildTimeline` recomputes `collapsed:
 * true` fresh every call, so it can't hold that toggle itself.
 *
 * Turn stamps (design spec: "Each completed turn is stamped `2:40:02 PM •
 * 10s`") are a documented deviation from the plan's data model: `ChatItem`
 * (`types.ts`) carries no timestamp, and `eventReducer.ts` doesn't fold
 * `AgentEvent.createdAt` into one — extending either is out of Task 8's file
 * list (neither is mentioned anywhere in the plan's file structure, for any
 * task). Rather than fabricate a stamp or silently drop the feature, this
 * component captures its own wall-clock reads the first time it observes a
 * turn start and the first time it observes that turn as settled (via
 * `turnBoundaries` + `view.status`), cached in a ref keyed by the turn's
 * leading message id. This is exact for the common case — a turn watched
 * live, which is what streaming deltas mean this pane is almost always
 * doing — and only approximate after a reconnect that replays a whole
 * historical thread in one burst, where it reads as "just now, instant".
 * That limitation is inherent to the current data model, not to this
 * component; a real fix threads `createdAt` through `ChatItem`.
 */
import { Fragment, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/ui/status-dot'
import { buildTimeline, collapseWorkLog, formatTurnStamp, turnBoundaries } from '@/features/agent-chat/timeline'
import type { ReasoningEntry, TimelineEntry, ToolGroupEntry } from '@/features/agent-chat/timeline'
import type { AgentThreadView, ChatItem } from '@/features/agent-chat/types'

export interface MessagesTimelineProps {
  view: AgentThreadView
}

const TOOL_STATUS_COLOR: Record<'running' | 'done' | 'failed', string> = {
  running: 'var(--devdeck-wait)',
  done: 'var(--devdeck-run)',
  failed: 'var(--devdeck-err)',
}

function entryKey(entry: TimelineEntry, index: number): string {
  if (entry.kind === 'tool-group') return entry.items[0]?.id ?? `tool-group-${index}`
  return entry.item.id
}

function MessageBubble({ item }: { item: ChatItem }) {
  if (item.kind === 'error') {
    return (
      <div className="self-stretch rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-devdeck-err">
        {item.text}
      </div>
    )
  }
  const isUser = item.kind === 'user'
  return (
    <div
      className={cn(
        'max-w-[82%] rounded-lg px-3 py-2 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap',
        isUser
          ? 'self-end border border-devdeck-border-accent bg-devdeck-accent-tint text-devdeck-fg'
          : 'self-start text-devdeck-fg',
      )}
    >
      {item.text || '…'}
    </div>
  )
}

function ReasoningBlock({
  entry,
  expanded,
  onToggle,
}: {
  entry: ReasoningEntry
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div className="max-w-[82%] self-start rounded-lg border border-devdeck-line bg-devdeck-on">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left font-mono text-[11px] text-devdeck-fg-2 hover:text-devdeck-fg"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Reasoning
      </button>
      {expanded ? (
        <div className="border-t border-devdeck-line px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-devdeck-fg-2">
          {entry.item.text}
        </div>
      ) : null}
    </div>
  )
}

function ToolRow({ item }: { item: ChatItem }) {
  return (
    <div className="flex items-center gap-2 font-mono text-[11.5px] text-devdeck-fg-2">
      <Wrench size={12} className="flex-none" />
      <span className="min-w-0 flex-1 truncate">{item.toolName || item.text || 'tool call'}</span>
      <StatusDot color={item.status ? TOOL_STATUS_COLOR[item.status] : 'var(--devdeck-fg-2)'} size={7} />
    </div>
  )
}

function ToolGroup({ entry, expanded, onToggle }: { entry: ToolGroupEntry; expanded: boolean; onToggle: () => void }) {
  const { visible, hidden } = collapseWorkLog(entry.items)
  return (
    <div className="flex w-full flex-col gap-1 rounded-lg border border-devdeck-line bg-devdeck-on px-3 py-2">
      {hidden.length > 0 ? (
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1.5 text-left font-mono text-[11px] text-devdeck-fg-2 hover:text-devdeck-fg"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {hidden.length} earlier {hidden.length === 1 ? 'step' : 'steps'}
        </button>
      ) : null}
      {expanded ? hidden.map((item) => <ToolRow key={item.id} item={item} />) : null}
      {visible.map((item) => (
        <ToolRow key={item.id} item={item} />
      ))}
    </div>
  )
}

/** One turn's observed wall-clock timing — see this file's doc comment on
 *  why these are client-observed reads rather than server timestamps. */
interface TurnTiming {
  startedAt: number
  completedAt: number | null
}

/** Caches each turn's `TurnTiming` in a ref keyed by `TurnBoundary.key`,
 *  computed synchronously during render (safe here: idempotent once a
 *  timing is set, and computing during render — not in an effect — means
 *  the render that first observes a turn as complete is the same render
 *  that shows its stamp, with no extra re-render needed to catch up). */
function useTurnTimings(entries: TimelineEntry[], threadStatus: AgentThreadView['status']) {
  const ref = useRef<Map<string, TurnTiming>>(new Map())
  const boundaries = turnBoundaries(entries)

  boundaries.forEach((boundary, index) => {
    let timing = ref.current.get(boundary.key)
    if (!timing) {
      timing = { startedAt: Date.now(), completedAt: null }
      ref.current.set(boundary.key, timing)
    }
    // The trailing turn is only "complete" once the thread itself isn't
    // running — an earlier turn is always complete, since something after
    // it (the next turn's user message) already arrived.
    const isTrailing = index === boundaries.length - 1
    const complete = !isTrailing || threadStatus !== 'running'
    if (complete && timing.completedAt === null) timing.completedAt = Date.now()
  })

  return { boundaries, timings: ref.current }
}

function TurnStamp({ timing }: { timing: TurnTiming }) {
  if (timing.completedAt === null) return null
  return (
    <div className="self-start px-1 font-mono text-[10px] text-devdeck-fg-2">
      {formatTurnStamp(timing.startedAt, timing.completedAt)}
    </div>
  )
}

export function MessagesTimeline({ view }: MessagesTimelineProps) {
  const entries = buildTimeline(view)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const { boundaries, timings } = useTurnTimings(entries, view.status)

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-2.5 px-4 py-4">
      {entries.map((entry, index) => {
        const key = entryKey(entry, index)
        const turnStamp = boundaries.find((b) => b.lastEntryIndex === index)
        const timing = turnStamp ? timings.get(turnStamp.key) : undefined

        let node: ReactNode
        if (entry.kind === 'message') {
          node = <MessageBubble key={key} item={entry.item} />
        } else if (entry.kind === 'reasoning') {
          node = (
            <ReasoningBlock
              key={key}
              entry={entry}
              expanded={expanded.has(entry.item.id)}
              onToggle={() => toggle(entry.item.id)}
            />
          )
        } else {
          const groupKey = `tool-group:${key}`
          node = (
            <ToolGroup
              key={key}
              entry={entry}
              expanded={expanded.has(groupKey)}
              onToggle={() => toggle(groupKey)}
            />
          )
        }

        return (
          <Fragment key={key}>
            {node}
            {timing ? <TurnStamp timing={timing} /> : null}
          </Fragment>
        )
      })}
      {view.hasGap ? (
        <div className="flex items-center gap-1.5 self-center rounded-full border border-devdeck-line bg-devdeck-on px-2.5 py-1 font-mono text-[10.5px] text-devdeck-fg-2">
          <AlertTriangle size={11} className="text-devdeck-wait" />
          Some updates may be missing from this thread
        </div>
      ) : null}
    </div>
  )
}

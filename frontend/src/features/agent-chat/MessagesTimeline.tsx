/**
 * Renders `buildTimeline(view)` — grouped messages, reasoning blocks, and
 * read-only tool rows. Purely presentational: all grouping/ordering logic
 * lives in `timeline.ts` (pure, unit-tested); this component only decides
 * how each `TimelineEntry` looks, plus owns the one piece of state that's
 * legitimately a UI concern rather than a view-model one — which reasoning
 * blocks the user has expanded. `buildTimeline` recomputes `collapsed:
 * true` fresh every call, so it can't hold that toggle itself.
 */
import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/ui/status-dot'
import { buildTimeline } from '@/features/agent-chat/timeline'
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

function ToolGroup({ entry }: { entry: ToolGroupEntry }) {
  return (
    <div className="flex w-full flex-col gap-1 rounded-lg border border-devdeck-line bg-devdeck-on px-3 py-2">
      {entry.items.map((item) => (
        <div key={item.id} className="flex items-center gap-2 font-mono text-[11.5px] text-devdeck-fg-2">
          <Wrench size={12} className="flex-none" />
          <span className="min-w-0 flex-1 truncate">{item.toolName || item.text || 'tool call'}</span>
          <StatusDot color={item.status ? TOOL_STATUS_COLOR[item.status] : 'var(--devdeck-fg-2)'} size={7} />
        </div>
      ))}
    </div>
  )
}

export function MessagesTimeline({ view }: MessagesTimelineProps) {
  const entries = buildTimeline(view)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

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
        if (entry.kind === 'message') return <MessageBubble key={key} item={entry.item} />
        if (entry.kind === 'reasoning') {
          return (
            <ReasoningBlock
              key={key}
              entry={entry}
              expanded={expanded.has(entry.item.id)}
              onToggle={() => toggle(entry.item.id)}
            />
          )
        }
        return <ToolGroup key={key} entry={entry} />
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

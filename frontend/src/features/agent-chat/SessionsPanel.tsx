/**
 * Sessions sidebar tab body: a worktree's chat threads, newest-touched
 * first (design spec's "Session history" section). Self-contained data
 * fetching, mirroring `GitPanel.tsx`'s shape rather than the presentational
 * (props-only) shape `ComposerControls.tsx` used — `ShellSidebar.tsx`
 * mounts this unconditionally (hidden via CSS, not unmounted) whenever a
 * worktree/machine pair exists, the same way it already mounts `GitPanel`,
 * and `ShellSidebar.test.tsx` has no `QueryClientProvider` in its tree —
 * see that file's mock of `./GitPanel` for the existing precedent this
 * follows.
 *
 * Selecting a row is meant to open that thread in a chat pane (design
 * spec). `onSelectThread` is optional and simply forwarded by
 * `ShellSidebar.tsx`: pane management lives in `ExpandedTerminal.tsx`,
 * which isn't in Task 8's file list (or anywhere else in the plan), so
 * nothing wires it to an actual pane-open yet — same category of gap as
 * `ChatStatusStrip.tsx`'s worktree/branch placeholder from Task 6. See this
 * task's `deviationsFromPlan`.
 */
import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/ui/status-dot'
import { DataLoading } from '@/features/screens/DataLoading'
import type { Machine } from '@/store/types'
import { useAgentThreads } from '@/features/data/queries'
import type { AgentThread } from '@/features/data/queries'

export interface SessionsPanelProps {
  worktreeId: string
  machine: Machine
  /** The threadKey of the pane currently open, if any — highlights that row. */
  activeThreadKey?: string
  /** Design spec: "Selecting a row opens that thread in a chat pane." See
   *  this file's doc comment for why this is optional and not yet wired
   *  end-to-end. */
  onSelectThread?: (threadKey: string) => void
}

/** How many sessions show before folding the rest behind `Show more` — no
 *  fixed number in the plan or spec, so this picks one generous enough that
 *  a worktree with a handful of threads never sees the disclosure at all. */
const INITIAL_VISIBLE_SESSIONS = 5

const THREAD_STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  running: 'Running',
  waiting: 'Waiting',
  stopped: 'Stopped',
}

const THREAD_STATUS_COLOR: Record<string, string> = {
  idle: 'var(--devdeck-fg-2)',
  running: 'var(--devdeck-run)',
  waiting: 'var(--devdeck-wait)',
  stopped: 'var(--devdeck-err)',
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not load sessions'
}

function SessionRow({ thread, active, onSelect }: { thread: AgentThread; active: boolean; onSelect: () => void }) {
  const label = THREAD_STATUS_LABEL[thread.status] ?? thread.status
  const color = THREAD_STATUS_COLOR[thread.status] ?? 'var(--devdeck-fg-2)'
  const title = thread.title.trim() || 'Untitled session'

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full min-w-0 flex-col gap-0.5 px-3 py-2 text-left transition-colors',
        active ? 'bg-devdeck-on text-devdeck-fg' : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
      )}
    >
      <span className="truncate font-mono text-[11.5px]">{title}</span>
      <span className="flex items-center gap-1.5 font-mono text-[10px] text-devdeck-fg-2">
        <StatusDot color={color} size={6} />
        {label}
        <span aria-hidden="true">·</span>
        {formatDistanceToNow(thread.updatedAt, { addSuffix: true })}
      </span>
    </button>
  )
}

export function SessionsPanel({ worktreeId, machine, activeThreadKey, onSelectThread }: SessionsPanelProps) {
  const [showAll, setShowAll] = useState(false)
  const sessions = useAgentThreads(machine, worktreeId)

  if (sessions.isLoading) {
    return (
      <div className="flex h-24 items-center justify-center">
        <DataLoading compact label="loading sessions…" />
      </div>
    )
  }

  if (sessions.error) {
    return (
      <div className="flex flex-col items-center gap-2 px-3 py-6 text-center font-mono text-[10.5px] text-devdeck-err">
        <span>{errMessage(sessions.error)}</span>
        <button
          type="button"
          onClick={() => sessions.refetch()}
          className="cursor-pointer rounded-md border border-devdeck-line px-2.5 py-1 text-devdeck-fg-2 hover:text-devdeck-fg"
        >
          Retry
        </button>
      </div>
    )
  }

  const all = sessions.data ?? []
  if (all.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center px-3 text-center font-mono text-[10.5px] text-devdeck-fg-2">
        No sessions yet — start a chat to create one.
      </div>
    )
  }

  const visible = showAll ? all : all.slice(0, INITIAL_VISIBLE_SESSIONS)
  const hiddenCount = all.length - visible.length

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto py-1">
      {visible.map((thread) => (
        <SessionRow
          key={thread.id}
          thread={thread}
          active={thread.id === activeThreadKey}
          onSelect={() => onSelectThread?.(thread.id)}
        />
      ))}
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mx-2 mt-1 cursor-pointer rounded-md px-2 py-1.5 text-left font-mono text-[10.5px] text-devdeck-fg-2 hover:text-devdeck-fg"
        >
          Show {hiddenCount} more
        </button>
      ) : null}
    </div>
  )
}

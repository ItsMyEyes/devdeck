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
 * The panel owns all three verbs, not just the list:
 *
 *  - **Select** opens the thread in a chat pane, via `onSelectThread`.
 *  - **New** is the same call with a threadKey that doesn't exist yet. There
 *    is no create endpoint and there should not be one: a thread is created
 *    by its WebSocket's hello (see `AgentWSHandler.autoCreateThread`), so
 *    "new session" is just "open a pane for an id nobody has used". That also
 *    means an abandoned new session costs nothing — no row is written until
 *    the socket actually connects.
 *  - **Delete** erases the thread outright (row, transcript, receipts). It is
 *    irreversible, hence the confirmation — an in-app `ConfirmDialog`, NOT
 *    `window.confirm`. The native one cannot be used anywhere in this app: the
 *    Tauri desktop build's WKWebView implements no
 *    `runJavaScriptConfirmPanelWithMessage` delegate, so `confirm()` returns
 *    false with no dialog ever shown and `if (!window.confirm(…)) return`
 *    returns early on every call. That is what made deleting a session
 *    impossible in the shipped app. `TerminalExplorer.tsx` documents the same
 *    defect for `window.prompt`. The other destructive in-panel actions
 *    (`FileEditor.tsx`, `GitPanel.tsx`, `SSHFileEditor.tsx`,
 *    `DBSqlEditor.tsx`, `SkillContentDialog.tsx`) still call `window.confirm`
 *    and are broken the same way — they should adopt `ConfirmDialog` too.
 */
import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/ui/status-dot'
import { Pill } from '@/components/ui/pill'
import { DataLoading } from '@/features/screens/DataLoading'
import type { Machine } from '@/store/types'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useAgentThreads, useDeleteAgentThread } from '@/features/data/queries'
import type { AgentThread } from '@/features/data/queries'

export interface SessionsPanelProps {
  worktreeId: string
  machine: Machine
  /** The threadKey of the pane currently open, if any — highlights that row. */
  activeThreadKey?: string
  /** Design spec: "Selecting a row opens that thread in a chat pane." Also
   *  how a NEW session is started — see this file's doc comment. */
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

/**
 * The first threadKey for this worktree that no existing session is using.
 *
 * The key space is fixed by `paneTree.ts`'s `createAgentChatPane`: the primary
 * pane is the bare worktree id and extras are `<worktreeId>::chat-N`. Extras
 * start at 1 because that helper labels seq N as "Chat N+1", so seq 0 would
 * render a second tab also called "Chat 1".
 *
 * Reusing a freed number (rather than tracking a high-water mark) is
 * deliberate and safe: a deleted thread's events and receipts are erased too,
 * so its id carries nothing forward — which is the whole reason the backend
 * deletes rather than tombstones.
 */
export function nextFreeThreadKey(worktreeId: string, taken: readonly string[]): string {
  const used = new Set(taken)
  if (!used.has(worktreeId)) return worktreeId
  for (let seq = 1; ; seq += 1) {
    const key = `${worktreeId}::chat-${seq}`
    if (!used.has(key)) return key
  }
}

/** What an untitled thread renders as, and therefore what it has to be
 *  findable by — searching for what is on screen is the only rule a user can
 *  reasonably hold. */
const UNTITLED_LABEL = 'Untitled session'

/**
 * Narrows the session list to those matching a free-text query.
 *
 * Every whitespace-separated term must match, so typing more always narrows.
 * The alternative — matching any term — makes the list GROW as you type, which
 * reads as the search being broken rather than as a widening.
 *
 * Matching is on the label the row actually shows, which is why an untitled
 * thread is searchable as "Untitled session": a list you cannot find half the
 * rows of is worse than no search.
 */
export function filterSessions(threads: readonly AgentThread[], query: string): AgentThread[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...threads]
  return threads.filter((thread) => {
    const haystack = (thread.title.trim() || UNTITLED_LABEL).toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

function SessionRow({
  thread,
  active,
  onSelect,
  onDelete,
  deleting,
}: {
  thread: AgentThread
  active: boolean
  onSelect: () => void
  onDelete: () => void
  deleting: boolean
}) {
  const label = THREAD_STATUS_LABEL[thread.status] ?? thread.status
  const color = THREAD_STATUS_COLOR[thread.status] ?? 'var(--devdeck-fg-2)'
  const title = thread.title.trim() || UNTITLED_LABEL

  return (
    <div
      className={cn(
        'group relative flex w-full min-w-0 items-center',
        active ? 'bg-devdeck-on text-devdeck-fg' : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
        deleting && 'opacity-50',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        title={title}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 py-2 pr-8 pl-3 text-left"
      >
        <span className="truncate text-[12.5px]">{title}</span>
        <span className="flex items-center gap-1.5 text-[11px] text-devdeck-fg-2">
          <StatusDot color={color} size={6} />
          {label}
          <span aria-hidden="true">·</span>
          {formatDistanceToNow(thread.updatedAt, { addSuffix: true })}
          {thread.planReady ? <Pill color="var(--devdeck-accent)">Plan</Pill> : null}
        </span>
      </button>
      {/* Hover-revealed so a list of sessions is not a column of bins, but
          always in the DOM so it stays keyboard- and screen-reader-reachable. */}
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        title="Delete session"
        aria-label={`Delete session ${title}`}
        className={cn(
          'absolute right-1.5 flex size-6 cursor-pointer items-center justify-center rounded-md',
          'text-devdeck-fg-2 opacity-0 hover:bg-devdeck-red-tint hover:text-devdeck-err',
          'group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-default',
        )}
      >
        <Trash2 size={12} aria-hidden="true" />
      </button>
    </div>
  )
}

export function SessionsPanel({ worktreeId, machine, activeThreadKey, onSelectThread }: SessionsPanelProps) {
  const [showAll, setShowAll] = useState(false)
  const [query, setQuery] = useState('')
  const sessions = useAgentThreads(machine, worktreeId)
  const deleteThread = useDeleteAgentThread(machine, worktreeId)

  const all = sessions.data ?? []

  function handleNew() {
    onSelectThread?.(nextFreeThreadKey(worktreeId, all.map((t) => t.id)))
  }

  // The thread awaiting confirmation, or null. An in-app dialog rather than
  // `window.confirm`, which is a silent no-op in the Tauri desktop build — its
  // WKWebView implements no `runJavaScriptConfirmPanelWithMessage` delegate, so
  // `confirm()` returns false with no dialog and the guard returned early every
  // single time. Deleting a session was impossible in the shipped app.
  const [pendingDelete, setPendingDelete] = useState<AgentThread | null>(null)

  function handleDelete(thread: AgentThread) {
    setPendingDelete(thread)
  }

  function confirmDelete() {
    const thread = pendingDelete
    if (!thread) return
    deleteThread.mutate(thread.id, {
      onError: (error) => toast.error(errMessage(error)),
    })
    setPendingDelete(null)
  }

  /** The header is outside every early return: "New session" has to work from
   *  the empty state and the error state too, which is exactly when a user
   *  most wants it. */
  const header = (
    <div className="flex flex-none items-center justify-between gap-2 px-3 py-1.5">
      <span className="text-[11px] tracking-wide text-devdeck-dim-pane uppercase">Sessions</span>
      <button
        type="button"
        onClick={handleNew}
        title="New session"
        aria-label="New session"
        className="flex size-6 cursor-pointer items-center justify-center rounded-md text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
      >
        <Plus size={13} aria-hidden="true" />
      </button>
    </div>
  )

  /** Shown only once the list is long enough to be worth searching — a search
   *  box above two rows is furniture, not a feature. Rendered inside the list
   *  branch (not `header`) so it never appears over a loading, error, or empty
   *  state, where there is nothing to filter. */
  const search = (
    <div className="flex-none px-2.5 pb-1.5">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search sessions"
        aria-label="Search sessions"
        className={cn(
          'h-7 w-full rounded-md border border-devdeck-hairline bg-devdeck-raised px-2 text-[12px]',
          'text-devdeck-fg placeholder:text-devdeck-fg-2',
          'focus-visible:border-devdeck-border-accent focus-visible:outline-none',
        )}
      />
    </div>
  )

  if (sessions.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="flex h-24 items-center justify-center">
          <DataLoading compact label="loading sessions…" />
        </div>
      </div>
    )
  }

  if (sessions.error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-[12px] text-devdeck-err">
          <span>{errMessage(sessions.error)}</span>
          <button
            type="button"
            onClick={() => sessions.refetch()}
            className="cursor-pointer rounded-md border border-devdeck-line px-2.5 py-1 text-devdeck-fg-2 hover:text-devdeck-fg"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (all.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-[12px] text-devdeck-fg-2">
          <span>No sessions yet.</span>
          <button
            type="button"
            onClick={handleNew}
            className="cursor-pointer rounded-md border border-devdeck-line px-2.5 py-1 text-devdeck-fg-2 hover:text-devdeck-fg"
          >
            Start a session
          </button>
        </div>
      </div>
    )
  }

  // Filter first, then fold: "Show 3 more" has to count what the search left,
  // not what the thread list started with.
  const matched = filterSessions(all, query)
  const visible = showAll ? matched : matched.slice(0, INITIAL_VISIBLE_SESSIONS)
  const hiddenCount = matched.length - visible.length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {all.length > 2 ? search : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto pb-1">
        {matched.length === 0 ? (
          <p className="px-3 py-4 text-center text-[12px] text-devdeck-fg-2">No sessions match “{query.trim()}”.</p>
        ) : null}
        {visible.map((thread) => (
          <SessionRow
            key={thread.id}
            thread={thread}
            active={thread.id === activeThreadKey}
            onSelect={() => onSelectThread?.(thread.id)}
            onDelete={() => handleDelete(thread)}
            deleting={deleteThread.isPending && deleteThread.variables === thread.id}
          />
        ))}
        {hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="mx-2 mt-1 cursor-pointer rounded-md px-2 py-1.5 text-left text-[12px] text-devdeck-fg-2 hover:text-devdeck-fg"
          >
            Show {hiddenCount} more
          </button>
        ) : null}
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete ${pendingDelete?.title.trim() || 'this session'}?`}
        description="Its whole transcript goes with it. This cannot be undone."
        confirmLabel="Delete session"
        pendingLabel="Deleting…"
        pending={deleteThread.isPending}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

import { useCallback, useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  Columns2,
  GitBranch,
  GitCommitHorizontal,
  History,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Rows3,
  Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import type { GitCommit, GitStatusFile } from '@/lib/machineApi'
import { cn } from '@/lib/utils'
import type { Machine } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { GitDiffTarget } from './paneTree'
import {
  useGitCommit,
  useGitDiff,
  useGitDiscard,
  useGitLog,
  useGitPull,
  useGitPush,
  useGitStage,
  useGitStatus,
  useGitUnstage,
} from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import { DiffView, type DiffMode } from './DiffView'
import { MaterialFileIcon } from './MaterialFileIcon'

interface GitPanelProps {
  worktreeId: string
  machine: Machine
  active: boolean
  /** `wt:<worktreeId>` — keys the selected diff in the store so the compact
   *  sidebar copy and the full-width in-pane copy share one selection. */
  shellKey: string
  /** List-only mode for the ~280px shell sidebar: renders the branch header,
   *  Changes/History, the commit box and the file list, but NOT the diff
   *  column — at that width a side-by-side diff is unreadable, and the
   *  300px file list alone already overflows. Selecting a file instead calls
   *  `onOpenDiff`, which opens the full-width Git tab (same pattern as
   *  clicking a file in Explorer opening an editor tab). */
  compact?: boolean
  /** Opens the picked target as its own `git-diff` pane tab. Ignored when
   *  `compact` is false, since a full panel renders the diff itself. */
  onOpenDiff?: (target: GitDiffTarget) => void
}

type DiffTarget = GitDiffTarget | null

const STATUS_COLOR: Record<string, string> = {
  M: 'text-devdeck-yellow',
  A: 'text-devdeck-green',
  '?': 'text-devdeck-green',
  D: 'text-devdeck-red',
  R: 'text-devdeck-purple',
  C: 'text-devdeck-purple',
  U: 'text-devdeck-red',
}

function errMessage(error: unknown) {
  return error instanceof ApiError ? error.message : 'git operation failed'
}

function basename(path: string) {
  return path.split('/').pop() ?? path
}

function dirname(path: string) {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

export function GitPanel({ worktreeId, machine, active, shellKey, compact = false, onOpenDiff }: GitPanelProps) {
  const [view, setView] = useState<'changes' | 'history'>('changes')
  const [message, setMessage] = useState('')
  const [diffMode, setDiffMode] = useState<DiffMode>('split')
  // The selected diff lives in the store, not local state: the compact sidebar
  // copy writes it and the full-width in-pane copy reads it, so a file clicked
  // in the sidebar shows its diff in the Git tab.
  const target = useDevDeckStore((s) => s.gitDiffs[shellKey]) ?? null
  const setGitDiff = useDevDeckStore((s) => s.setGitDiff)
  const clearGitDiff = useDevDeckStore((s) => s.clearGitDiff)

  const setTarget = useCallback(
    (next: DiffTarget) => {
      if (next === null) clearGitDiff(shellKey)
      else setGitDiff(shellKey, next)
    },
    [shellKey, setGitDiff, clearGitDiff],
  )

  const status = useGitStatus(machine, worktreeId, active)
  const log = useGitLog(machine, worktreeId, active && view === 'history')
  const diff = useGitDiff(machine, worktreeId, target)
  const stage = useGitStage(machine, worktreeId)
  const unstage = useGitUnstage(machine, worktreeId)
  const discard = useGitDiscard(machine, worktreeId)
  const commit = useGitCommit(machine, worktreeId)
  const push = useGitPush(machine, worktreeId)
  const pull = useGitPull(machine, worktreeId)

  const files = status.data?.files ?? []
  const stagedFiles = files.filter((f) => f.index !== '.' && f.index !== '?')
  const unstagedFiles = files.filter((f) => f.worktree !== '.')
  const busy = stage.isPending || unstage.isPending || discard.isPending || commit.isPending

  const onError = (error: unknown) => toast.error(errMessage(error))

  function doDiscard(paths: string[]) {
    const what = paths.length === 1 ? paths[0].split('/').pop() : `${paths.length} files`
    if (!window.confirm(`Discard changes to ${what}? Untracked files will be deleted. This cannot be undone.`)) return
    discard.mutate(paths, {
      onSuccess: () => setTarget(null),
      onError,
    })
  }

  function doCommit() {
    commit.mutate(message, {
      onSuccess: () => {
        setMessage('')
        setTarget(null)
        toast.success('Committed')
      },
      onError,
    })
  }

  function doPush() {
    push.mutate(undefined, { onSuccess: () => toast.success('Pushed'), onError })
  }

  function doPull() {
    pull.mutate(undefined, { onSuccess: () => toast.success('Pulled'), onError })
  }

  /** Compact mode has no diff column of its own, so a selection opens the
   *  target as its own pane tab. The store write stays either way — it drives
   *  the list's own selection highlight. */
  function selectTarget(next: GitDiffTarget) {
    setTarget(next)
    if (compact) onOpenDiff?.(next)
  }

  function selectFile(file: GitStatusFile, staged: boolean) {
    selectTarget({ path: file.path, staged, untracked: !staged && file.worktree === '?' })
  }

  const targetKey = useMemo(() => {
    if (target === null) return ''
    if ('commit' in target) return `commit:${target.commit}`
    return `${target.staged ? 'staged' : 'work'}:${target.path}`
  }, [target])

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1', compact ? 'flex-col' : 'max-md:flex-col md:flex-row')}>
      {/* Compact fills the sidebar's whole width; full keeps the fixed 300px
          list beside the diff column. */}
      <div
        className={cn(
          'flex min-h-0 flex-col border-devdeck-border',
          compact ? 'min-w-0 flex-1' : 'flex-none max-md:max-h-[45%] max-md:border-b md:w-[300px] md:border-r',
        )}
      >
        <div className="flex h-9 min-w-0 flex-none items-center gap-2 border-b border-devdeck-border px-3">
          <GitBranch size={13} className="flex-none text-devdeck-fg-2" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-devdeck-fg" title={status.data?.branch}>
            {status.data?.branch ?? '…'}
          </span>
          {status.data && (status.data.ahead > 0 || status.data.behind > 0) ? (
            <span className="flex flex-none items-center gap-1 font-mono text-[10px] text-devdeck-fg-2">
              {status.data.ahead > 0 && (
                <span className="flex items-center gap-px">
                  {status.data.ahead}
                  <ArrowUp size={10} />
                </span>
              )}
              {status.data.behind > 0 && (
                <span className="flex items-center gap-px">
                  {status.data.behind}
                  <ArrowDown size={10} />
                </span>
              )}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => status.refetch()}
            disabled={status.isFetching}
            title="Refresh status"
            className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg disabled:cursor-wait"
          >
            <RefreshCw size={12} className={cn(status.isFetching && 'animate-spin')} />
          </button>
        </div>

        <div className="flex min-w-0 flex-none items-center gap-1.5 border-b border-devdeck-border p-2">
          <SegButton active={view === 'changes'} onClick={() => setView('changes')}>
            Changes
            {files.length > 0 && <span className="font-mono text-[9.5px] text-devdeck-fg-2">{files.length}</span>}
          </SegButton>
          <SegButton active={view === 'history'} onClick={() => setView('history')}>
            <History size={11} />
            History
          </SegButton>
          <span className="min-w-0 flex-1" />
          {/* Icon-only in the sidebar: at ~280px the four labelled controls
              overflow the row and push Pull/Push off its right edge. */}
          <ActionButton onClick={doPull} pending={pull.isPending} title="git pull" icon={<ArrowDown size={11} />} label="Pull" compact={compact} />
          <ActionButton onClick={doPush} pending={push.isPending} title="git push" icon={<ArrowUp size={11} />} label="Push" compact={compact} />
        </div>

        {view === 'changes' ? (
          <>
            <div className="flex flex-none flex-col gap-1.5 border-b border-devdeck-border p-2">
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && message.trim() && stagedFiles.length > 0) {
                    event.preventDefault()
                    doCommit()
                  }
                }}
                placeholder={`Message (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}Enter to commit)`}
                rows={2}
                className="w-full resize-none rounded-md border border-devdeck-border-strong bg-devdeck-card-wash px-2 py-1.5 font-mono text-[11.5px] text-devdeck-fg placeholder:text-devdeck-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              <button
                type="button"
                onClick={doCommit}
                disabled={busy || !message.trim() || stagedFiles.length === 0}
                className="flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md bg-devdeck-accent text-[11.5px] font-semibold text-devdeck-accent-ink hover:bg-devdeck-accent-hover disabled:cursor-default disabled:opacity-40"
              >
                {commit.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Commit
                {stagedFiles.length > 0 && <span className="font-mono text-[10px] opacity-70">{stagedFiles.length} staged</span>}
              </button>
            </div>

            <div className="min-h-0 min-w-0 flex-1 overflow-auto pb-2">
              {status.isLoading ? (
                <div className="flex h-24 items-center justify-center">
                  <DataLoading compact />
                </div>
              ) : status.error ? (
                <div className="px-3 py-4 text-center font-mono text-[10.5px] text-devdeck-err">
                  {errMessage(status.error)}
                </div>
              ) : files.length === 0 ? (
                <div className="flex h-24 items-center justify-center font-mono text-[10.5px] text-devdeck-fg-2">
                  No changes
                </div>
              ) : (
                <>
                  <FileSection
                    label="STAGED CHANGES"
                    files={stagedFiles}
                    staged
                    selectedKey={targetKey}
                    disabled={busy}
                    onSelect={(file) => selectFile(file, true)}
                    onAction={(paths) => unstage.mutate(paths, { onError })}
                    actionIcon={<Minus size={11} />}
                    actionTitle="Unstage"
                  />
                  <FileSection
                    label="CHANGES"
                    files={unstagedFiles}
                    staged={false}
                    selectedKey={targetKey}
                    disabled={busy}
                    onSelect={(file) => selectFile(file, false)}
                    onAction={(paths) => stage.mutate(paths, { onError })}
                    actionIcon={<Plus size={11} />}
                    actionTitle="Stage"
                    onDiscard={doDiscard}
                  />
                </>
              )}
            </div>
          </>
        ) : (
          <div className="min-h-0 min-w-0 flex-1 overflow-auto py-1">
            {log.isLoading ? (
              <div className="flex h-24 items-center justify-center">
                <DataLoading compact />
              </div>
            ) : log.error ? (
              <div className="px-3 py-4 text-center font-mono text-[10.5px] text-devdeck-err">
                {errMessage(log.error)}
              </div>
            ) : (log.data ?? []).length === 0 ? (
              <div className="flex h-24 items-center justify-center font-mono text-[10.5px] text-devdeck-fg-2">
                No commits yet
              </div>
            ) : (
              (log.data ?? []).map((entry) => (
                <CommitRow
                  key={entry.hash}
                  commit={entry}
                  selected={targetKey === `commit:${entry.hash}`}
                  onSelect={() => selectTarget({ commit: entry.hash })}
                />
              ))
            )}
          </div>
        )}
      </div>

      {compact ? null : (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-devdeck-pane">
        {target === null ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center font-mono text-[11px] text-devdeck-fg-2">
            {view === 'history' ? 'Select a commit to view its diff' : 'Select a file to view its diff'}
          </div>
        ) : (
          <>
            <div className="flex h-8 flex-none items-center gap-2 border-b border-devdeck-border bg-devdeck-card-wash px-3">
              {'commit' in target ? (
                <GitCommitHorizontal size={12} className="flex-none text-devdeck-fg-2" />
              ) : (
                <MaterialFileIcon name={basename(target.path)} size={14} />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-devdeck-fg-2">
                {'commit' in target ? target.commit.slice(0, 10) : target.path}
              </span>
              {'commit' in target ? null : (
                <span className="flex-none font-mono text-[9.5px] text-devdeck-fg-2 max-md:hidden">
                  {target.staged ? 'staged · index vs HEAD' : 'unstaged · worktree'}
                </span>
              )}
              <span className="flex flex-none items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setDiffMode('split')}
                  title="Side-by-side diff"
                  className={cn(
                    'flex h-5 w-5 cursor-pointer items-center justify-center rounded',
                    diffMode === 'split' ? 'bg-devdeck-on text-devdeck-fg' : 'text-devdeck-fg-2 hover:text-devdeck-fg',
                  )}
                >
                  <Columns2 size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => setDiffMode('unified')}
                  title="Unified diff"
                  className={cn(
                    'flex h-5 w-5 cursor-pointer items-center justify-center rounded',
                    diffMode === 'unified' ? 'bg-devdeck-on text-devdeck-fg' : 'text-devdeck-fg-2 hover:text-devdeck-fg',
                  )}
                >
                  <Rows3 size={12} />
                </button>
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {diff.isLoading ? (
                <div className="flex h-24 items-center justify-center">
                  <DataLoading compact />
                </div>
              ) : diff.error ? (
                <div className="px-4 py-4 font-mono text-[10.5px] text-devdeck-err">{errMessage(diff.error)}</div>
              ) : (
                <DiffView
                  text={diff.data?.diff ?? ''}
                  mode={diffMode}
                  showFileSummary={'commit' in target}
                />
              )}
            </div>
          </>
        )}
      </div>
      )}
    </div>
  )
}

function SegButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-6 flex-none cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors',
        active ? 'bg-devdeck-on text-devdeck-fg' : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
      )}
    >
      {children}
    </button>
  )
}

function ActionButton({
  onClick,
  pending,
  title,
  icon,
  label,
  compact = false,
}: {
  onClick: () => void
  pending: boolean
  title: string
  icon: React.ReactNode
  label: string
  /** Drops the text label, leaving the icon — `title` still names the action. */
  compact?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title={title}
      aria-label={label}
      className={cn(
        'flex h-6 flex-none cursor-pointer items-center gap-1 rounded-md border border-devdeck-border-strong text-[11px] text-devdeck-fg-2 hover:bg-devdeck-hover-wash disabled:cursor-wait disabled:opacity-50',
        compact ? 'w-6 justify-center' : 'px-2',
      )}
    >
      {pending ? <Loader2 size={11} className="animate-spin" /> : icon}
      {compact ? null : label}
    </button>
  )
}

interface FileSectionProps {
  label: string
  files: GitStatusFile[]
  staged: boolean
  selectedKey: string
  disabled: boolean
  onSelect: (file: GitStatusFile) => void
  onAction: (paths: string[]) => void
  actionIcon: React.ReactNode
  actionTitle: string
  /** When set, rows and the section header offer a destructive discard action. */
  onDiscard?: (paths: string[]) => void
}

function FileSection({
  label,
  files,
  staged,
  selectedKey,
  disabled,
  onSelect,
  onAction,
  actionIcon,
  actionTitle,
  onDiscard,
}: FileSectionProps) {
  if (files.length === 0) return null
  const allPaths = files.map((file) => file.path)
  return (
    <div className="min-w-0">
      <div className="flex h-7 min-w-0 items-center gap-2 px-3 pt-1">
        <span className="min-w-0 truncate font-mono text-[9.5px] tracking-[0.14em] text-devdeck-fg-2">{label}</span>
        <span className="flex-none font-mono text-[9.5px] text-devdeck-fg-2">{files.length}</span>
        <span className="min-w-0 flex-1" />
        {onDiscard && (
          <button
            type="button"
            onClick={() => onDiscard(allPaths)}
            disabled={disabled}
            title="Discard all changes"
            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-devdeck-fg-2 hover:bg-devdeck-red-tint-hover hover:text-devdeck-err disabled:cursor-wait"
          >
            <Undo2 size={11} />
          </button>
        )}
        <button
          type="button"
          onClick={() => onAction(allPaths)}
          disabled={disabled}
          title={`${actionTitle} all`}
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg disabled:cursor-wait"
        >
          {actionIcon}
        </button>
      </div>
      {files.map((file) => {
        const letter = staged ? file.index : file.worktree
        const selected = selectedKey === `${staged ? 'staged' : 'work'}:${file.path}`
        return (
          <div
            key={file.path}
            className={cn(
              'group flex h-[27px] min-w-0 items-center pr-1.5',
              selected ? 'bg-devdeck-on' : 'hover:bg-devdeck-hover-wash',
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(file)}
              title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
              className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 pl-3 text-left"
            >
              <MaterialFileIcon name={basename(file.path)} size={14} />
              <span className="min-w-0 flex-none truncate font-mono text-[11px] text-devdeck-fg-2">{basename(file.path)}</span>
              {dirname(file.path) && (
                <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-devdeck-fg-2">{dirname(file.path)}</span>
              )}
            </button>
            {onDiscard && (
              <button
                type="button"
                onClick={() => onDiscard([file.path])}
                disabled={disabled}
                title={`Discard changes to ${basename(file.path)}`}
                className="mr-0.5 flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-devdeck-fg-2 opacity-0 hover:bg-devdeck-red-tint-hover hover:text-devdeck-err group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait"
              >
                <Undo2 size={11} />
              </button>
            )}
            <button
              type="button"
              onClick={() => onAction([file.path])}
              disabled={disabled}
              title={`${actionTitle} ${basename(file.path)}`}
              className="mr-0.5 flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-devdeck-fg-2 opacity-0 hover:bg-devdeck-hover-wash hover:text-devdeck-fg group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait"
            >
              {actionIcon}
            </button>
            <span className={cn('w-4 flex-none text-center font-mono text-[10.5px] font-semibold', STATUS_COLOR[letter] ?? 'text-devdeck-fg-2')}>
              {letter === '?' ? 'U' : letter}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function CommitRow({ commit, selected, onSelect }: { commit: GitCommit; selected: boolean; onSelect: () => void }) {
  const date = new Date(commit.date)
  const when = Number.isNaN(date.getTime())
    ? commit.date
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        // min-w-0 on every level: a flex item defaults to min-width:auto and
        // refuses to shrink below its content, which is what let long commit
        // subjects and ref lists spill past the panel's right edge.
        'flex w-full min-w-0 cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-left',
        selected ? 'bg-devdeck-on' : 'hover:bg-devdeck-hover-wash',
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-devdeck-fg-2" title={commit.subject}>
          {commit.subject}
        </span>
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 font-mono text-[9.5px] text-devdeck-fg-2">
        <span className="flex-none text-devdeck-fg">{commit.short}</span>
        <span className="min-w-0 flex-1 truncate">{commit.author}</span>
        <span className="flex-none">{when}</span>
        {commit.refs.length > 0 && (
          <span className="min-w-0 flex-1 truncate text-devdeck-purple" title={commit.refs.join(' ')}>
            {commit.refs.join(' ')}
          </span>
        )}
      </span>
    </button>
  )
}


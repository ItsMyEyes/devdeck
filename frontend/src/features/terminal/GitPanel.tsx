import { useMemo, useState } from 'react'
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
import { DiffView, type DiffMode } from './DiffView'
import { MaterialFileIcon } from './MaterialFileIcon'

interface GitPanelProps {
  worktreeId: string
  machine: Machine
  active: boolean
}

type DiffTarget =
  | { path: string; staged: boolean; untracked: boolean }
  | { commit: string }
  | null

const STATUS_COLOR: Record<string, string> = {
  M: 'text-loom-yellow',
  A: 'text-loom-green',
  '?': 'text-loom-green',
  D: 'text-loom-red',
  R: 'text-loom-purple',
  C: 'text-loom-purple',
  U: 'text-loom-red',
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

export function GitPanel({ worktreeId, machine, active }: GitPanelProps) {
  const [view, setView] = useState<'changes' | 'history'>('changes')
  const [message, setMessage] = useState('')
  const [target, setTarget] = useState<DiffTarget>(null)
  const [diffMode, setDiffMode] = useState<DiffMode>('split')

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

  function selectFile(file: GitStatusFile, staged: boolean) {
    setTarget({ path: file.path, staged, untracked: !staged && file.worktree === '?' })
  }

  const targetKey = useMemo(() => {
    if (target === null) return ''
    if ('commit' in target) return `commit:${target.commit}`
    return `${target.staged ? 'staged' : 'work'}:${target.path}`
  }, [target])

  return (
    <div className="flex min-h-0 flex-1 max-md:flex-col md:flex-row">
      <div className="flex min-h-0 flex-none flex-col border-loom-border max-md:max-h-[45%] max-md:border-b md:w-[300px] md:border-r">
        <div className="flex h-9 flex-none items-center gap-2 border-b border-loom-border px-3">
          <GitBranch size={13} className="flex-none text-loom-accent" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-loom-fg" title={status.data?.branch}>
            {status.data?.branch ?? '…'}
          </span>
          {status.data && (status.data.ahead > 0 || status.data.behind > 0) ? (
            <span className="flex flex-none items-center gap-1 font-mono text-[10px] text-loom-muted">
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
            className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-loom-dim hover:bg-loom-hover-wash hover:text-loom-fg disabled:cursor-wait"
          >
            <RefreshCw size={12} className={cn(status.isFetching && 'animate-spin')} />
          </button>
        </div>

        <div className="flex flex-none items-center gap-1.5 border-b border-loom-border p-2">
          <SegButton active={view === 'changes'} onClick={() => setView('changes')}>
            Changes
            {files.length > 0 && <span className="font-mono text-[9.5px] text-loom-dim">{files.length}</span>}
          </SegButton>
          <SegButton active={view === 'history'} onClick={() => setView('history')}>
            <History size={11} />
            History
          </SegButton>
          <span className="flex-1" />
          <ActionButton onClick={doPull} pending={pull.isPending} title="git pull">
            <ArrowDown size={11} />
            Pull
          </ActionButton>
          <ActionButton onClick={doPush} pending={push.isPending} title="git push">
            <ArrowUp size={11} />
            Push
          </ActionButton>
        </div>

        {view === 'changes' ? (
          <>
            <div className="flex flex-none flex-col gap-1.5 border-b border-loom-border p-2">
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
                className="w-full resize-none rounded-md border border-loom-border-strong bg-loom-surface-2 px-2 py-1.5 font-mono text-[11.5px] text-loom-fg placeholder:text-loom-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              <button
                type="button"
                onClick={doCommit}
                disabled={busy || !message.trim() || stagedFiles.length === 0}
                className="flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md bg-loom-accent text-[11.5px] font-semibold text-loom-accent-ink hover:bg-loom-accent-hover disabled:cursor-default disabled:opacity-40"
              >
                {commit.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Commit
                {stagedFiles.length > 0 && <span className="font-mono text-[10px] opacity-70">{stagedFiles.length} staged</span>}
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto pb-2">
              {status.isLoading ? (
                <div className="flex h-24 items-center justify-center text-loom-dim">
                  <Loader2 size={15} className="animate-spin" />
                </div>
              ) : status.error ? (
                <div className="px-3 py-4 text-center font-mono text-[10.5px] text-loom-red-soft">
                  {errMessage(status.error)}
                </div>
              ) : files.length === 0 ? (
                <div className="flex h-24 items-center justify-center font-mono text-[10.5px] text-loom-dim">
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
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {log.isLoading ? (
              <div className="flex h-24 items-center justify-center text-loom-dim">
                <Loader2 size={15} className="animate-spin" />
              </div>
            ) : log.error ? (
              <div className="px-3 py-4 text-center font-mono text-[10.5px] text-loom-red-soft">
                {errMessage(log.error)}
              </div>
            ) : (log.data ?? []).length === 0 ? (
              <div className="flex h-24 items-center justify-center font-mono text-[10.5px] text-loom-dim">
                No commits yet
              </div>
            ) : (
              (log.data ?? []).map((entry) => (
                <CommitRow
                  key={entry.hash}
                  commit={entry}
                  selected={targetKey === `commit:${entry.hash}`}
                  onSelect={() => setTarget({ commit: entry.hash })}
                />
              ))
            )}
          </div>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-loom-terminal">
        {target === null ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center font-mono text-[11px] text-loom-dim">
            {view === 'history' ? 'Select a commit to view its diff' : 'Select a file to view its diff'}
          </div>
        ) : (
          <>
            <div className="flex h-8 flex-none items-center gap-2 border-b border-loom-border bg-loom-surface-2 px-3">
              {'commit' in target ? (
                <GitCommitHorizontal size={12} className="flex-none text-loom-accent" />
              ) : (
                <MaterialFileIcon name={basename(target.path)} size={14} />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-loom-fg-2">
                {'commit' in target ? target.commit.slice(0, 10) : target.path}
              </span>
              {'commit' in target ? null : (
                <span className="flex-none font-mono text-[9.5px] text-loom-dim max-md:hidden">
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
                    diffMode === 'split' ? 'bg-loom-accent/15 text-loom-accent-soft' : 'text-loom-dim hover:text-loom-fg',
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
                    diffMode === 'unified' ? 'bg-loom-accent/15 text-loom-accent-soft' : 'text-loom-dim hover:text-loom-fg',
                  )}
                >
                  <Rows3 size={12} />
                </button>
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {diff.isLoading ? (
                <div className="flex h-24 items-center justify-center text-loom-dim">
                  <Loader2 size={15} className="animate-spin" />
                </div>
              ) : diff.error ? (
                <div className="px-4 py-4 font-mono text-[10.5px] text-loom-red-soft">{errMessage(diff.error)}</div>
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
    </div>
  )
}

function SegButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors',
        active ? 'bg-loom-accent/10 text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
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
  children,
}: {
  onClick: () => void
  pending: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title={title}
      className="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-loom-border-strong px-2 text-[11px] text-loom-fg-2 hover:bg-loom-hover-wash disabled:cursor-wait disabled:opacity-50"
    >
      {pending ? <Loader2 size={11} className="animate-spin" /> : children}
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
    <div>
      <div className="flex h-7 items-center gap-2 px-3 pt-1">
        <span className="font-mono text-[9.5px] tracking-[0.14em] text-loom-dim">{label}</span>
        <span className="font-mono text-[9.5px] text-loom-dim-2">{files.length}</span>
        <span className="flex-1" />
        {onDiscard && (
          <button
            type="button"
            onClick={() => onDiscard(allPaths)}
            disabled={disabled}
            title="Discard all changes"
            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-loom-dim hover:bg-loom-red-tint-hover hover:text-loom-red-soft disabled:cursor-wait"
          >
            <Undo2 size={11} />
          </button>
        )}
        <button
          type="button"
          onClick={() => onAction(allPaths)}
          disabled={disabled}
          title={`${actionTitle} all`}
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-loom-dim hover:bg-loom-hover-wash hover:text-loom-fg disabled:cursor-wait"
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
              'group flex h-[27px] items-center pr-1.5',
              selected ? 'bg-loom-accent/10' : 'hover:bg-loom-hover-wash',
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(file)}
              title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
              className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 pl-3 text-left"
            >
              <MaterialFileIcon name={basename(file.path)} size={14} />
              <span className="truncate font-mono text-[11px] text-loom-fg-2">{basename(file.path)}</span>
              {dirname(file.path) && (
                <span className="min-w-0 truncate font-mono text-[9.5px] text-loom-dim-2">{dirname(file.path)}</span>
              )}
            </button>
            {onDiscard && (
              <button
                type="button"
                onClick={() => onDiscard([file.path])}
                disabled={disabled}
                title={`Discard changes to ${basename(file.path)}`}
                className="mr-0.5 flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-loom-dim opacity-0 hover:bg-loom-red-tint-hover hover:text-loom-red-soft group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait"
              >
                <Undo2 size={11} />
              </button>
            )}
            <button
              type="button"
              onClick={() => onAction([file.path])}
              disabled={disabled}
              title={`${actionTitle} ${basename(file.path)}`}
              className="mr-0.5 flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-loom-dim opacity-0 hover:bg-loom-hover-wash hover:text-loom-fg group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait"
            >
              {actionIcon}
            </button>
            <span className={cn('w-4 flex-none text-center font-mono text-[10.5px] font-semibold', STATUS_COLOR[letter] ?? 'text-loom-muted')}>
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
        'flex w-full cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-left',
        selected ? 'bg-loom-accent/10' : 'hover:bg-loom-hover-wash',
      )}
    >
      <span className="flex items-center gap-1.5">
        <span className="truncate text-[11.5px] text-loom-fg-2">{commit.subject}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-[9.5px] text-loom-dim">
        <span className="text-loom-accent-soft">{commit.short}</span>
        <span className="truncate">{commit.author}</span>
        <span className="flex-none">{when}</span>
        {commit.refs.length > 0 && (
          <span className="truncate text-loom-purple">{commit.refs.join(' ')}</span>
        )}
      </span>
    </button>
  )
}


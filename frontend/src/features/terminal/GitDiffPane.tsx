import { useState } from 'react'
import { Columns2, GitCommitHorizontal, Rows3 } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { Machine } from '@/store/types'
import type { GitDiffTarget } from '@/store/useDevDeckStore'
import { useGitDiff } from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import { DiffView, type DiffMode } from './DiffView'
import { MaterialFileIcon } from './MaterialFileIcon'

interface GitDiffPaneProps {
  worktreeId: string
  machine: Machine
  /** The file or commit to diff. Owned by the caller — the in-pane tab stores
   *  it on its own tab content, so two diff tabs can show two different files. */
  target: GitDiffTarget
}

function errMessage(error: unknown) {
  return error instanceof ApiError ? error.message : 'git operation failed'
}

function basename(path: string) {
  return path.split('/').pop() ?? path
}

/** Human-readable label for a diff target — also what the pane tab is titled. */
export function gitDiffLabel(target: GitDiffTarget): string {
  return 'commit' in target ? target.commit.slice(0, 10) : basename(target.path)
}

/**
 * One git diff, on its own: the file/commit header, the split/unified toggle,
 * and the diff body. Deliberately carries no file list — it is rendered as a
 * per-file pane tab opened from the sidebar's list, so repeating that list
 * beside it would just duplicate what the sidebar already shows.
 */
export function GitDiffPane({ worktreeId, machine, target }: GitDiffPaneProps) {
  const [diffMode, setDiffMode] = useState<DiffMode>('split')
  const diff = useGitDiff(machine, worktreeId, target)
  const isCommit = 'commit' in target

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-devdeck-pane">
      <div className="flex h-8 flex-none items-center gap-2 border-b border-devdeck-border bg-devdeck-card-wash px-3">
        {isCommit ? (
          <GitCommitHorizontal size={12} className="flex-none text-devdeck-fg-2" />
        ) : (
          <MaterialFileIcon name={basename(target.path)} size={14} />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-devdeck-fg-2">
          {isCommit ? target.commit.slice(0, 10) : target.path}
        </span>
        {isCommit ? null : (
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
          <DiffView text={diff.data?.diff ?? ''} mode={diffMode} showFileSummary={isCommit} />
        )}
      </div>
    </div>
  )
}

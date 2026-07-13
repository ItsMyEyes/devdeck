import { useState } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import { ChevronRight, FilePlus2, Loader2, RefreshCw, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { Machine } from '@/store/types'
import { qk } from '@/features/data/keys'
import {
  useDeleteWorktreeFile,
  useInvalidateWorktreeFiles,
  useWorktreeFiles,
  useWriteWorktreeFile,
} from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import { MaterialFileIcon } from './MaterialFileIcon'

interface TerminalExplorerProps {
  worktreeId: string
  machine: Machine
  rootLabel: string
  onOpenFile: (path: string) => void
  onFileDeleted: (path: string) => void
  onRequestQuickOpen: () => void
}

export function TerminalExplorer({
  worktreeId,
  machine,
  rootLabel,
  onOpenFile,
  onFileDeleted,
  onRequestQuickOpen,
}: TerminalExplorerProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const root = useWorktreeFiles(machine, worktreeId, '')
  const writeFile = useWriteWorktreeFile(machine, worktreeId)
  const deleteFile = useDeleteWorktreeFile(machine, worktreeId)
  const invalidateFiles = useInvalidateWorktreeFiles(machine, worktreeId)
  const isFetching = useIsFetching({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) }) > 0

  function toggleDir(path: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function createFile() {
    const name = window.prompt('New file name')
    if (name === null) return
    const clean = name.trim()
    if (!clean || clean.includes('/') || clean.includes('\\') || clean === '.' || clean === '..') {
      toast.error('Enter a file name without folder separators')
      return
    }
    if ((root.data ?? []).some((entry) => entry.name.toLowerCase() === clean.toLowerCase())) {
      toast.error('A file or folder with that name already exists')
      return
    }
    writeFile.mutate({ path: clean, content: '' }, { onSuccess: () => onOpenFile(clean) })
  }

  function removeFile(filePath: string, name: string) {
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return
    deleteFile.mutate(filePath, { onSuccess: () => onFileDeleted(filePath) })
  }

  return (
    <aside className="flex min-h-0 flex-1 flex-col bg-loom-surface">
      <div className="flex h-9 flex-none items-center border-b border-loom-border bg-loom-surface-2">
        <div
          title={rootLabel}
          className="flex h-full max-w-[60%] items-center truncate border-r border-loom-border bg-loom-surface px-3 font-mono text-[11px] text-loom-fg"
        >
          {rootLabel}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={createFile}
          disabled={writeFile.isPending}
          title="New file"
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-loom-dim hover:text-loom-fg disabled:cursor-wait"
        >
          {writeFile.isPending ? <Loader2 size={13} className="animate-spin" /> : <FilePlus2 size={13} />}
        </button>
        <button
          type="button"
          onClick={invalidateFiles}
          disabled={isFetching}
          title="Refresh files"
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-loom-dim hover:text-loom-fg disabled:cursor-wait"
        >
          <RefreshCw size={13} className={cn(isFetching && 'animate-spin')} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        <TreeLevel
          worktreeId={worktreeId}
          machine={machine}
          path=""
          depth={0}
          expanded={expanded}
          onToggleDir={toggleDir}
          onOpenFile={onOpenFile}
          onRemoveFile={removeFile}
          deletePending={deleteFile.isPending}
        />
      </div>

      <button
        type="button"
        onClick={onRequestQuickOpen}
        className="flex h-9 flex-none cursor-pointer items-center gap-2 border-t border-loom-border bg-loom-surface-2 px-3 text-left font-mono text-[10.5px] text-loom-muted hover:text-loom-fg-2"
      >
        <Search size={12} />
        <span>Regex file search</span>
        <kbd className="ml-auto rounded border border-loom-border-strong bg-loom-terminal px-1.5 py-0.5 text-[9.5px] text-loom-dim">
          Ctrl P
        </kbd>
      </button>
    </aside>
  )
}

interface TreeLevelProps {
  worktreeId: string
  machine: Machine
  path: string
  depth: number
  expanded: ReadonlySet<string>
  onToggleDir: (path: string) => void
  onOpenFile: (path: string) => void
  onRemoveFile: (path: string, name: string) => void
  deletePending: boolean
}

function TreeLevel({ worktreeId, machine, path, depth, ...rest }: TreeLevelProps) {
  const { data, error, isLoading, refetch } = useWorktreeFiles(machine, worktreeId, path)
  const indent = 8 + depth * 14
  const entries = data ?? []

  if (isLoading) {
    return depth === 0 ? (
      <div className="flex h-28 items-center justify-center">
        <DataLoading compact label="loading files…" />
      </div>
    ) : (
      <div className="flex h-[29px] items-center gap-2 text-loom-dim" style={{ paddingLeft: indent + 18 }}>
        <Loader2 size={11} className="animate-spin" />
      </div>
    )
  }

  if (error) {
    const message = error instanceof ApiError ? error.message : 'Could not read this folder'
    return depth === 0 ? (
      <div className="flex h-32 flex-col items-center justify-center gap-3 px-4 text-center">
        <span className="font-mono text-[10.5px] leading-relaxed text-loom-muted">{message}</span>
        <button
          type="button"
          onClick={() => refetch()}
          className="rounded border border-loom-border-strong px-2.5 py-1 text-[11px] text-loom-fg-2 hover:bg-loom-hover-wash"
        >
          Retry
        </button>
      </div>
    ) : (
      <button
        type="button"
        onClick={() => refetch()}
        title={message}
        className="flex h-[29px] w-full cursor-pointer items-center gap-1.5 truncate font-mono text-[10.5px] text-loom-red-soft hover:bg-loom-hover-wash"
        style={{ paddingLeft: indent + 18 }}
      >
        {message} · retry
      </button>
    )
  }

  if (entries.length === 0) {
    return depth === 0 ? (
      <div className="flex h-28 items-center justify-center font-mono text-[10.5px] text-loom-dim">
        Empty folder
      </div>
    ) : (
      <div
        className="flex h-[29px] items-center font-mono text-[10.5px] text-loom-dim"
        style={{ paddingLeft: indent + 18 }}
      >
        empty
      </div>
    )
  }

  return (
    <>
      {entries.map((entry) => {
        const isOpen = entry.isDir && rest.expanded.has(entry.path)
        return (
          <div key={entry.path}>
            <div className="group flex h-[29px] items-center pr-1.5 hover:bg-loom-hover-wash">
              <button
                type="button"
                onClick={() => {
                  if (entry.isDir) rest.onToggleDir(entry.path)
                  else rest.onOpenFile(entry.path)
                }}
                title={entry.isDir ? entry.name : `Edit ${entry.name}`}
                aria-expanded={entry.isDir ? isOpen : undefined}
                className="flex h-full min-w-0 flex-1 cursor-pointer select-none items-center gap-1.5 text-left"
                style={{ paddingLeft: indent }}
              >
                <ChevronRight
                  size={11}
                  className={cn(
                    'flex-none text-loom-dim-3 transition-transform duration-100',
                    isOpen && 'rotate-90',
                    !entry.isDir && 'invisible',
                  )}
                />
                <MaterialFileIcon name={entry.name} isDir={entry.isDir} size={16} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-loom-fg-2">
                  {entry.name}
                </span>
              </button>
              {!entry.isDir ? (
                <button
                  type="button"
                  onClick={() => rest.onRemoveFile(entry.path, entry.name)}
                  disabled={rest.deletePending}
                  title={`Delete ${entry.name}`}
                  className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-loom-dim opacity-0 hover:bg-loom-red-tint-hover hover:text-loom-red-soft group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait"
                >
                  <Trash2 size={11} />
                </button>
              ) : null}
            </div>
            {isOpen && (
              <TreeLevel worktreeId={worktreeId} machine={machine} path={entry.path} depth={depth + 1} {...rest} />
            )}
          </div>
        )
      })}
    </>
  )
}

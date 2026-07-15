import { useMemo, useRef, useState } from 'react'
import type { ChangeEvent, MouseEvent, MutableRefObject } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import { Archive, ChevronRight, FilePlus2, Loader2, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { downloadWorktreeZip } from '@/lib/machineApi'
import { cn } from '@/lib/utils'
import type { Machine } from '@/store/types'
import { qk } from '@/features/data/keys'
import {
  useDeleteWorktreePaths,
  useInvalidateWorktreeFiles,
  useUploadWorktreeFiles,
  useWorktreeFiles,
  useWriteWorktreeFile,
} from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import {
  applySelectionClick,
  emptySelection,
  modifierFromEvent,
  type ClickModifier,
  type SelectedEntry,
  type SelectionState,
} from './fileTreeSelection'
import { MaterialFileIcon } from './MaterialFileIcon'

interface TerminalExplorerProps {
  worktreeId: string
  machine: Machine
  rootLabel: string
  onOpenFile: (path: string) => void
  onFileDeleted: (paths: string[]) => void
  onRequestQuickOpen: () => void
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback
}

function parentPath(filePath: string) {
  const index = filePath.lastIndexOf('/')
  return index >= 0 ? filePath.slice(0, index) : ''
}

function archiveFileName(entries: readonly SelectedEntry[]) {
  if (entries.length === 1) return `${entries[0]?.name ?? 'selection'}.zip`
  return 'selection.zip'
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
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
  const [selection, setSelection] = useState<SelectionState>(emptySelection())
  const entryCacheRef = useRef<Map<string, SelectedEntry>>(new Map())
  const treeContainerRef = useRef<HTMLDivElement>(null)
  const [zipping, setZipping] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const root = useWorktreeFiles(machine, worktreeId, '')
  const writeFile = useWriteWorktreeFile(machine, worktreeId)
  const uploadFiles = useUploadWorktreeFiles(machine, worktreeId)
  const deletePaths = useDeleteWorktreePaths(machine, worktreeId)
  const invalidateFiles = useInvalidateWorktreeFiles(machine, worktreeId)
  const isFetching = useIsFetching({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) }) > 0
  const selectedEntries = useMemo(() => Object.values(selection.selected), [selection.selected])
  const selectedPaths = useMemo(() => selectedEntries.map((entry) => entry.path), [selectedEntries])
  const selectedCount = selectedEntries.length
  const uploadTarget = useMemo(() => {
    if (selectedEntries.length !== 1) return ''
    const entry = selectedEntries[0]
    if (!entry) return ''
    return entry.isDir ? entry.path : parentPath(entry.path)
  }, [selectedEntries])
  const uploadTargetLabel = uploadTarget || 'root'

  function toggleDir(path: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function clearSelection() {
    setSelection(emptySelection())
  }

  function orderedVisiblePaths(): string[] {
    const container = treeContainerRef.current
    if (!container) return []
    return Array.from(container.querySelectorAll<HTMLElement>('[data-row-path]')).map(
      (el) => el.dataset.rowPath ?? '',
    )
  }

  function selectEntry(entry: SelectedEntry, modifier: ClickModifier) {
    setSelection((current) =>
      applySelectionClick(current, entry, modifier, orderedVisiblePaths(), (path) => entryCacheRef.current.get(path)),
    )
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

  function removeEntry(entry: SelectedEntry) {
    if (!window.confirm(`Delete ${entry.name}? This cannot be undone.`)) return
    deletePaths.mutate([entry.path], {
      onSuccess: () => {
        toast.success(`Deleted ${entry.name}`)
        setSelection((current) => {
          if (!current.selected[entry.path]) return current
          const next = { ...current.selected }
          delete next[entry.path]
          return { selected: next, anchor: current.anchor }
        })
        onFileDeleted([entry.path])
      },
      onError: (error) => toast.error(errorMessage(error, `Could not delete ${entry.name}`)),
    })
  }

  function removeSelected() {
    if (selectedPaths.length === 0) return
    const label = selectedPaths.length === 1 ? (selectedEntries[0]?.name ?? 'selection') : `${selectedPaths.length} items`
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return
    deletePaths.mutate(selectedPaths, {
      onSuccess: () => {
        toast.success(`Deleted ${label}`)
        onFileDeleted(selectedPaths)
        clearSelection()
      },
      onError: (error) => toast.error(errorMessage(error, `Could not delete ${label}`)),
    })
  }

  function handleUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (files.length === 0) return
    uploadFiles.mutate(
      { folderPath: uploadTarget, files },
      {
        onSuccess: (entries) => {
          toast.success(`Uploaded ${entries.length} file${entries.length === 1 ? '' : 's'} to ${uploadTargetLabel}`)
        },
        onError: (error) => toast.error(errorMessage(error, `Could not upload to ${uploadTargetLabel}`)),
      },
    )
  }

  async function zipSelected() {
    if (selectedPaths.length === 0 || zipping) return
    setZipping(true)
    try {
      const blob = await downloadWorktreeZip(machine, worktreeId, selectedPaths)
      downloadBlob(blob, archiveFileName(selectedEntries))
      toast.success(`Zipped ${selectedPaths.length} item${selectedPaths.length === 1 ? '' : 's'}`)
    } catch (error) {
      toast.error(errorMessage(error, 'Could not zip selection'))
    } finally {
      setZipping(false)
    }
  }

  return (
    <aside className="flex min-h-0 flex-1 flex-col bg-loom-surface">
      <input ref={uploadInputRef} type="file" multiple className="hidden" onChange={handleUploadChange} />
      <div className="flex h-9 flex-none items-center border-b border-loom-border bg-loom-surface-2">
        <div
          title={rootLabel}
          className="flex h-full max-w-[45%] items-center truncate border-r border-loom-border bg-loom-surface px-3 font-mono text-[11px] text-loom-fg"
        >
          {rootLabel}
        </div>
        {selectedCount > 0 ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 font-mono text-[10.5px] text-loom-muted">
            <span className="truncate">{selectedCount} selected</span>
            <button
              type="button"
              onClick={clearSelection}
              title="Clear selection"
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-loom-dim hover:bg-loom-hover-wash hover:text-loom-fg"
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <div className="flex-1" />
        )}
        <button
          type="button"
          onClick={() => uploadInputRef.current?.click()}
          disabled={uploadFiles.isPending}
          title={`Upload files to ${uploadTargetLabel}`}
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-loom-dim hover:text-loom-fg disabled:cursor-wait"
        >
          {uploadFiles.isPending ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
        </button>
        <button
          type="button"
          onClick={zipSelected}
          disabled={selectedCount === 0 || zipping}
          title="Zip selected files and folders"
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-loom-dim hover:text-loom-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          {zipping ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />}
        </button>
        <button
          type="button"
          onClick={removeSelected}
          disabled={selectedCount === 0 || deletePaths.isPending}
          title="Delete selected files and folders"
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-loom-dim hover:text-loom-red-soft disabled:cursor-not-allowed disabled:opacity-40"
        >
          {deletePaths.isPending ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
        </button>
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

      <div ref={treeContainerRef} className="min-h-0 flex-1 overflow-auto py-1">
        <TreeLevel
          worktreeId={worktreeId}
          machine={machine}
          path=""
          depth={0}
          expanded={expanded}
          selected={selection.selected}
          entryCache={entryCacheRef}
          onToggleDir={toggleDir}
          onSelectEntry={selectEntry}
          onOpenFile={onOpenFile}
          onRemovePath={removeEntry}
          deletePending={deletePaths.isPending}
        />
      </div>

      <button
        type="button"
        onClick={onRequestQuickOpen}
        className="flex h-9 flex-none cursor-pointer items-center gap-2 border-t border-loom-border bg-loom-surface-2 px-3 text-left font-mono text-[10.5px] text-loom-muted hover:text-loom-fg-2"
      >
        <Search size={12} />
        <span>Search files / folders</span>
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
  selected: Readonly<Record<string, SelectedEntry>>
  entryCache: MutableRefObject<Map<string, SelectedEntry>>
  onToggleDir: (path: string) => void
  onSelectEntry: (entry: SelectedEntry, modifier: ClickModifier) => void
  onOpenFile: (path: string) => void
  onRemovePath: (entry: SelectedEntry) => void
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
      <div className="flex h-[29px] items-center font-mono text-[10.5px] text-loom-dim" style={{ paddingLeft: indent + 18 }}>
        empty
      </div>
    )
  }

  return (
    <>
      {entries.map((entry) => {
        const isOpen = entry.isDir && rest.expanded.has(entry.path)
        const isSelected = Boolean(rest.selected[entry.path])
        const selectedEntry: SelectedEntry = { name: entry.name, path: entry.path, isDir: entry.isDir }
        rest.entryCache.current.set(entry.path, selectedEntry)
        return (
          <div key={entry.path}>
            <div
              data-row-path={entry.path}
              className={cn('group flex h-[29px] items-center pr-1.5 hover:bg-loom-hover-wash', isSelected && 'bg-loom-accent/10')}
              style={{ paddingLeft: indent }}
            >
              <button
                type="button"
                onClick={(event: MouseEvent) => {
                  const modifier = modifierFromEvent(event)
                  rest.onSelectEntry(selectedEntry, modifier)
                  if (modifier === 'none') {
                    if (entry.isDir) rest.onToggleDir(entry.path)
                    else rest.onOpenFile(entry.path)
                  }
                }}
                title={entry.isDir ? entry.name : `Edit ${entry.name}`}
                aria-expanded={entry.isDir ? isOpen : undefined}
                className="flex h-full min-w-0 flex-1 cursor-pointer select-none items-center gap-1.5 pl-1.5 text-left"
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
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-loom-fg-2">{entry.name}</span>
              </button>
              <button
                type="button"
                onClick={() => rest.onRemovePath(selectedEntry)}
                disabled={rest.deletePending}
                title={`Delete ${entry.name}`}
                className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-loom-dim opacity-0 hover:bg-loom-red-tint-hover hover:text-loom-red-soft group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait"
              >
                <Trash2 size={11} />
              </button>
            </div>
            {isOpen && <TreeLevel worktreeId={worktreeId} machine={machine} path={entry.path} depth={depth + 1} {...rest} />}
          </div>
        )
      })}
    </>
  )
}

import { useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, MouseEvent, MutableRefObject } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import { Archive, ChevronRight, FilePlus2, FileSearch, Loader2, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { qk } from '@/features/data/keys'
import {
  useDeletePathsTarget,
  useFilesList,
  useInvalidateFilesTarget,
  useWriteFileTarget,
} from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import { DeleteFilesDialog } from './DeleteFilesDialog'
import type { FilesTarget } from './filesTarget'
import {
  applySelectionClick,
  emptySelection,
  modifierFromEvent,
  type ClickModifier,
  type SelectedEntry,
  type SelectionState,
} from './fileTreeSelection'
import { MaterialFileIcon } from './MaterialFileIcon'
import { useFileTransfers } from './useFileTransfers'

interface TerminalExplorerProps {
  target: FilesTarget
  rootLabel: string
  onOpenFile: (path: string) => void
  onFileDeleted: (paths: string[]) => void
  /** Omitted for SSH connections — there's no remote file quick-open (yet). */
  onRequestQuickOpen?: () => void
  /** Opens the "Search in Files" content-search panel (Ctrl+Shift+F). */
  onRequestContentSearch?: () => void
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

function filesRootKey(target: FilesTarget) {
  return target.kind === 'ssh' ? qk.sshFilesRoot(target.connectionId) : qk.worktreeFilesRoot(target.machine.id, target.worktreeId)
}

export function TerminalExplorer({
  target,
  rootLabel,
  onOpenFile,
  onFileDeleted,
  onRequestQuickOpen,
  onRequestContentSearch,
}: TerminalExplorerProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selection, setSelection] = useState<SelectionState>(emptySelection())
  const entryCacheRef = useRef<Map<string, SelectedEntry>>(new Map())
  const treeContainerRef = useRef<HTMLDivElement>(null)
  const [pendingDelete, setPendingDelete] = useState<SelectedEntry[] | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const root = useFilesList(target, '')
  const writeFile = useWriteFileTarget(target)
  const { uploadFiles, downloadZip, uploading, zipping } = useFileTransfers(target)
  const deletePaths = useDeletePathsTarget(target)
  const invalidateFiles = useInvalidateFilesTarget(target)
  const isFetching = useIsFetching({ queryKey: filesRootKey(target) }) > 0
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
    setPendingDelete([entry])
  }

  function removeSelected() {
    if (selectedPaths.length === 0) return
    setPendingDelete(selectedEntries)
  }

  function performDelete() {
    if (!pendingDelete || pendingDelete.length === 0) return
    const paths = pendingDelete.map((entry) => entry.path)
    const label = pendingDelete.length === 1 ? (pendingDelete[0]?.name ?? 'selection') : `${pendingDelete.length} items`
    deletePaths.mutate(paths, {
      onSuccess: () => {
        toast.success(`Deleted ${label}`)
        setSelection((current) => {
          const next = { ...current.selected }
          let changed = false
          for (const path of paths) {
            if (next[path]) {
              delete next[path]
              changed = true
            }
          }
          return changed ? { selected: next, anchor: current.anchor } : current
        })
        onFileDeleted(paths)
        setPendingDelete(null)
      },
      onError: (error) => {
        toast.error(errorMessage(error, `Could not delete ${label}`))
        setPendingDelete(null)
      },
    })
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    const eventTarget = event.target as HTMLElement
    if (eventTarget.tagName === 'INPUT' || eventTarget.tagName === 'TEXTAREA') return
    if (selectedPaths.length === 0) return
    event.preventDefault()
    setPendingDelete(selectedEntries)
  }

  async function uploadToFolder(folderPath: string, files: readonly File[]) {
    if (files.length === 0) return
    const label = folderPath || 'root'
    try {
      const entries = await uploadFiles(folderPath, files)
      toast.success(`Uploaded ${entries.length} file${entries.length === 1 ? '' : 's'} to ${label}`)
    } catch (error) {
      toast.error(errorMessage(error, `Could not upload to ${label}`))
    }
  }

  function handleUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    void uploadToFolder(uploadTarget, files)
  }

  function handleTreeDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    setIsDragOver(true)
  }

  function handleTreeDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setIsDragOver(false)
  }

  function handleTreeDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDragOver(false)
    const files = Array.from(event.dataTransfer.files ?? [])
    void uploadToFolder(uploadTarget, files)
  }

  function handlePaste(event: ClipboardEvent<HTMLElement>) {
    const files = Array.from(event.clipboardData?.files ?? [])
    if (files.length === 0) return
    event.preventDefault()
    void uploadToFolder(uploadTarget, files)
  }

  async function zipSelected() {
    if (selectedPaths.length === 0 || zipping) return
    const filename = archiveFileName(selectedEntries)
    try {
      const blob = await downloadZip(selectedPaths, filename)
      downloadBlob(blob, filename)
      toast.success(`Zipped ${selectedPaths.length} item${selectedPaths.length === 1 ? '' : 's'}`)
    } catch (error) {
      toast.error(errorMessage(error, 'Could not zip selection'))
    }
  }

  return (
    <aside className="flex min-h-0 flex-1 flex-col bg-devdeck-surface" onKeyDown={handleKeyDown} onPaste={handlePaste}>
      <input ref={uploadInputRef} type="file" multiple className="hidden" onChange={handleUploadChange} />
      <div className="flex h-9 flex-none items-center border-b border-devdeck-border bg-devdeck-surface-2">
        <div
          title={rootLabel}
          className="flex h-full max-w-[45%] items-center truncate border-r border-devdeck-border bg-devdeck-surface px-3 font-mono text-[11px] text-devdeck-fg"
        >
          {rootLabel}
        </div>
        {selectedCount > 0 ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 font-mono text-[10.5px] text-devdeck-muted">
            <span className="truncate">{selectedCount} selected</span>
            <button
              type="button"
              onClick={clearSelection}
              title="Clear selection"
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
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
          disabled={uploading}
          title={`Upload files to ${uploadTargetLabel}`}
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-devdeck-dim hover:text-devdeck-fg disabled:cursor-wait"
        >
          {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
        </button>
        <button
          type="button"
          onClick={zipSelected}
          disabled={selectedCount === 0 || zipping}
          title="Zip selected files and folders"
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-devdeck-dim hover:text-devdeck-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          {zipping ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />}
        </button>
        <button
          type="button"
          onClick={removeSelected}
          disabled={selectedCount === 0 || deletePaths.isPending}
          title="Delete selected files and folders"
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-devdeck-dim hover:text-devdeck-red-soft disabled:cursor-not-allowed disabled:opacity-40"
        >
          {deletePaths.isPending ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
        </button>
        <button
          type="button"
          onClick={createFile}
          disabled={writeFile.isPending}
          title="New file"
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-devdeck-dim hover:text-devdeck-fg disabled:cursor-wait"
        >
          {writeFile.isPending ? <Loader2 size={13} className="animate-spin" /> : <FilePlus2 size={13} />}
        </button>
        <button
          type="button"
          onClick={invalidateFiles}
          disabled={isFetching}
          title="Refresh files"
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-devdeck-dim hover:text-devdeck-fg disabled:cursor-wait"
        >
          <RefreshCw size={13} className={cn(isFetching && 'animate-spin')} />
        </button>
      </div>

      <div
        ref={treeContainerRef}
        onDragOver={handleTreeDragOver}
        onDragLeave={handleTreeDragLeave}
        onDrop={handleTreeDrop}
        className={cn(
          'min-h-0 flex-1 overflow-auto py-1',
          isDragOver && 'outline outline-2 outline-dashed outline-devdeck-accent -outline-offset-2',
        )}
      >
        <TreeLevel
          target={target}
          path=""
          depth={0}
          expanded={expanded}
          selected={selection.selected}
          entryCache={entryCacheRef}
          dropTargetPath={dropTargetPath}
          onToggleDir={toggleDir}
          onSelectEntry={selectEntry}
          onOpenFile={onOpenFile}
          onRemovePath={removeEntry}
          onSetDropTarget={setDropTargetPath}
          onDropFilesToFolder={(path, files) => void uploadToFolder(path, files)}
          deletePending={deletePaths.isPending}
        />
      </div>

      {onRequestQuickOpen ? (
        <button
          type="button"
          onClick={onRequestQuickOpen}
          className="flex h-9 flex-none cursor-pointer items-center gap-2 border-t border-devdeck-border bg-devdeck-surface-2 px-3 text-left font-mono text-[10.5px] text-devdeck-muted hover:text-devdeck-fg-2"
        >
          <Search size={12} />
          <span>Search files / folders</span>
          <kbd className="ml-auto rounded border border-devdeck-border-strong bg-devdeck-terminal px-1.5 py-0.5 text-[9.5px] text-devdeck-dim">
            Ctrl P
          </kbd>
        </button>
      ) : null}

      {onRequestContentSearch ? (
        <button
          type="button"
          onClick={onRequestContentSearch}
          className="flex h-9 flex-none cursor-pointer items-center gap-2 border-t border-devdeck-border bg-devdeck-surface-2 px-3 text-left font-mono text-[10.5px] text-devdeck-muted hover:text-devdeck-fg-2"
        >
          <FileSearch size={12} />
          <span>Search in files</span>
          <kbd className="ml-auto rounded border border-devdeck-border-strong bg-devdeck-terminal px-1.5 py-0.5 text-[9.5px] text-devdeck-dim">
            Ctrl Shift F
          </kbd>
        </button>
      ) : null}

      <DeleteFilesDialog
        open={pendingDelete !== null}
        names={pendingDelete?.map((entry) => entry.name) ?? []}
        pending={deletePaths.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={performDelete}
      />
    </aside>
  )
}

interface TreeLevelProps {
  target: FilesTarget
  path: string
  depth: number
  expanded: ReadonlySet<string>
  selected: Readonly<Record<string, SelectedEntry>>
  entryCache: MutableRefObject<Map<string, SelectedEntry>>
  dropTargetPath: string | null
  onToggleDir: (path: string) => void
  onSelectEntry: (entry: SelectedEntry, modifier: ClickModifier) => void
  onOpenFile: (path: string) => void
  onRemovePath: (entry: SelectedEntry) => void
  onSetDropTarget: (path: string | null) => void
  onDropFilesToFolder: (path: string, files: File[]) => void
  deletePending: boolean
}

function TreeLevel({ target, path, depth, ...rest }: TreeLevelProps) {
  const { data, error, isLoading, refetch } = useFilesList(target, path)
  const indent = 8 + depth * 14
  const entries = data ?? []

  if (isLoading) {
    return depth === 0 ? (
      <div className="flex h-28 items-center justify-center">
        <DataLoading compact label="loading files…" />
      </div>
    ) : (
      <div className="flex h-[29px] items-center gap-2 text-devdeck-dim" style={{ paddingLeft: indent + 18 }}>
        <Loader2 size={11} className="animate-spin" />
      </div>
    )
  }

  if (error) {
    const message = error instanceof ApiError ? error.message : 'Could not read this folder'
    return depth === 0 ? (
      <div className="flex h-32 flex-col items-center justify-center gap-3 px-4 text-center">
        <span className="font-mono text-[10.5px] leading-relaxed text-devdeck-muted">{message}</span>
        <button
          type="button"
          onClick={() => refetch()}
          className="rounded border border-devdeck-border-strong px-2.5 py-1 text-[11px] text-devdeck-fg-2 hover:bg-devdeck-hover-wash"
        >
          Retry
        </button>
      </div>
    ) : (
      <button
        type="button"
        onClick={() => refetch()}
        title={message}
        className="flex h-[29px] w-full cursor-pointer items-center gap-1.5 truncate font-mono text-[10.5px] text-devdeck-red-soft hover:bg-devdeck-hover-wash"
        style={{ paddingLeft: indent + 18 }}
      >
        {message} · retry
      </button>
    )
  }

  if (entries.length === 0) {
    return depth === 0 ? (
      <div className="flex h-28 items-center justify-center font-mono text-[10.5px] text-devdeck-dim">
        Empty folder
      </div>
    ) : (
      <div className="flex h-[29px] items-center font-mono text-[10.5px] text-devdeck-dim" style={{ paddingLeft: indent + 18 }}>
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
              onDragOver={(event) => {
                if (!entry.isDir || !event.dataTransfer.types.includes('Files')) return
                event.preventDefault()
                event.stopPropagation()
                rest.onSetDropTarget(entry.path)
              }}
              onDragLeave={(event) => {
                if (!entry.isDir) return
                event.stopPropagation()
                rest.onSetDropTarget(null)
              }}
              onDrop={(event) => {
                if (!entry.isDir) return
                event.preventDefault()
                event.stopPropagation()
                rest.onSetDropTarget(null)
                rest.onDropFilesToFolder(entry.path, Array.from(event.dataTransfer.files ?? []))
              }}
              className={cn(
                'group flex h-[29px] items-center pr-1.5 hover:bg-devdeck-hover-wash',
                isSelected && 'bg-devdeck-accent/10',
                rest.dropTargetPath === entry.path && 'outline outline-2 outline-dashed outline-devdeck-accent -outline-offset-2',
              )}
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
                    'flex-none text-devdeck-dim-3 transition-transform duration-100',
                    isOpen && 'rotate-90',
                    !entry.isDir && 'invisible',
                  )}
                />
                <MaterialFileIcon name={entry.name} isDir={entry.isDir} size={16} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-devdeck-fg-2">{entry.name}</span>
              </button>
              <button
                type="button"
                onClick={() => rest.onRemovePath(selectedEntry)}
                disabled={rest.deletePending}
                title={`Delete ${entry.name}`}
                className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-devdeck-dim opacity-0 hover:bg-devdeck-red-tint-hover hover:text-devdeck-red-soft group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait"
              >
                <Trash2 size={11} />
              </button>
            </div>
            {isOpen && <TreeLevel target={target} path={entry.path} depth={depth + 1} {...rest} />}
          </div>
        )
      })}
    </>
  )
}

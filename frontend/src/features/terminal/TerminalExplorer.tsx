import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, MouseEvent, MutableRefObject } from 'react'
import { ContextMenu } from '@base-ui/react/context-menu'
import { useIsFetching } from '@tanstack/react-query'
import {
  Archive,
  ChevronRight,
  Download,
  FilePlus2,
  FileSearch,
  FolderPlus,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { canPickSaveLocation, pickSaveTarget, SAVE_CANCELLED, type SaveTarget } from '@/lib/saveFile'
import { cn } from '@/lib/utils'
import { qk } from '@/features/data/keys'
import {
  useCopyFileTarget,
  useDeletePathsTarget,
  useFilesList,
  useInvalidateFilesTarget,
  useMkdirTarget,
  useMoveFileTarget,
  useWriteFileTarget,
} from '@/features/data/queries'
import { DataLoading } from '@/features/screens/DataLoading'
import { archiveDefaultName } from './archiveName'
import { ArchiveNameDialog } from './ArchiveNameDialog'
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

function filesRootKey(target: FilesTarget) {
  return target.kind === 'ssh' ? qk.sshFilesRoot(target.connectionId) : qk.worktreeFilesRoot(target.machine.id, target.worktreeId)
}

/** Custom drag MIME carrying the dragged entries' paths — distinct from the
 *  browser's 'Files' type (an OS file drag) so drop handlers can tell an
 *  internal tree move apart from an upload. */
const ENTRY_DRAG_MIME = 'application/x-devdeck-entry-paths'

function readDraggedPaths(event: DragEvent<HTMLDivElement>): string[] {
  const raw = event.dataTransfer.getData(ENTRY_DRAG_MIME)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === 'string') : []
  } catch {
    return []
  }
}

/** Inline "type a name directly in the tree" row backing both New File/New
 *  Folder creation and Rename — replaces the old window.prompt()-based flow,
 *  which is a silent no-op in the Tauri desktop build (its WKWebView
 *  implements no runJavaScriptTextInputPanelWithPrompt delegate method, so
 *  window.prompt() returns null immediately with no dialog ever shown).
 *  Fires onCommit/onCancel at most once (Enter, blur, and Escape can each
 *  independently trigger a fire — `firedRef` collapses them to one). */
function InlineNameInput({
  defaultValue,
  placeholder,
  onCommit,
  onCancel,
}: {
  defaultValue: string
  placeholder?: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const firedRef = useRef(false)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    const dot = defaultValue.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : defaultValue.length)
  }, [defaultValue])

  function fireCommit(value: string) {
    if (firedRef.current) return
    firedRef.current = true
    onCommit(value)
  }

  function fireCancel() {
    if (firedRef.current) return
    firedRef.current = true
    onCancel()
  }

  return (
    <input
      ref={inputRef}
      defaultValue={defaultValue}
      placeholder={placeholder}
      spellCheck={false}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          fireCommit(event.currentTarget.value)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          fireCancel()
        }
      }}
      onBlur={(event) => fireCommit(event.currentTarget.value)}
      className="h-[22px] min-w-0 flex-1 rounded border border-devdeck-border-accent bg-devdeck-elevated px-1.5 font-mono text-[11.5px] text-devdeck-fg-2 outline-none"
    />
  )
}

function ContextMenuAction({
  label,
  shortcut,
  disabled,
  danger,
  onClick,
}: {
  label: string
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <ContextMenu.Item
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left font-mono text-[11.5px] text-devdeck-fg-2 outline-none',
        'data-[highlighted]:bg-devdeck-hover-wash data-[disabled]:cursor-default data-[disabled]:opacity-40',
        danger && 'text-devdeck-red-soft data-[highlighted]:bg-devdeck-red-tint-hover',
      )}
    >
      <span className="flex-1 truncate">{label}</span>
      {shortcut ? <span className="font-mono text-[10px] text-devdeck-dim">{shortcut}</span> : null}
    </ContextMenu.Item>
  )
}

function ContextMenuSeparator() {
  return <ContextMenu.Separator className="my-1 h-px bg-devdeck-border" />
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
  const [pendingArchive, setPendingArchive] = useState<SelectedEntry[] | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null)
  const [draggingPaths, setDraggingPaths] = useState<readonly string[] | null>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const [creating, setCreating] = useState<{ parentPath: string; kind: 'file' | 'folder' } | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [clipboard, setClipboard] = useState<{ paths: string[]; mode: 'cut' | 'copy' } | null>(null)
  const [menuEntry, setMenuEntry] = useState<SelectedEntry | null>(null)
  const writeFile = useWriteFileTarget(target)
  const mkdir = useMkdirTarget(target)
  const moveFile = useMoveFileTarget(target)
  const copyFile = useCopyFileTarget(target)
  const { uploadFiles, downloadZip, downloadFile, uploading, downloading } = useFileTransfers(target)
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
  // Memoized because ArchiveNameDialog re-seeds its input whenever defaultName
  // changes — a fresh array each render would wipe what the user typed.
  const archiveDefault = useMemo(() => archiveDefaultName(pendingArchive ?? []), [pendingArchive])

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

  /** Opens an inline text-input row inside `parent` for typing a new
   *  file/folder name — expands `parent` first so the row is actually
   *  visible if it was collapsed. */
  function startCreate(parent: string, kind: 'file' | 'folder') {
    if (parent) setExpanded((current) => (current.has(parent) ? current : new Set(current).add(parent)))
    setCreating({ parentPath: parent, kind })
  }

  function cancelCreate() {
    setCreating(null)
  }

  function commitCreate(name: string) {
    if (!creating) return
    const clean = name.trim()
    if (!clean) {
      setCreating(null)
      return
    }
    if (clean.includes('/') || clean.includes('\\') || clean === '.' || clean === '..') {
      toast.error('Enter a name without folder separators')
      return
    }
    const fullPath = creating.parentPath ? `${creating.parentPath}/${clean}` : clean
    if (creating.kind === 'folder') {
      mkdir.mutate(fullPath, {
        onSuccess: () => setCreating(null),
        onError: (error) => toast.error(errorMessage(error, `Could not create ${clean}`)),
      })
    } else {
      writeFile.mutate(
        { path: fullPath, content: '' },
        {
          onSuccess: () => {
            setCreating(null)
            onOpenFile(fullPath)
          },
          onError: (error) => toast.error(errorMessage(error, `Could not create ${clean}`)),
        },
      )
    }
  }

  function startRename(entry: SelectedEntry) {
    setRenamingPath(entry.path)
  }

  function cancelRename() {
    setRenamingPath(null)
  }

  function commitRename(entry: SelectedEntry, name: string) {
    const clean = name.trim()
    if (!clean || clean === entry.name || clean.includes('/') || clean.includes('\\')) {
      setRenamingPath(null)
      return
    }
    const parent = parentPath(entry.path)
    const to = parent ? `${parent}/${clean}` : clean
    moveFile.mutate(
      { from: entry.path, to },
      {
        onSuccess: () => {
          setRenamingPath(null)
          toast.success(`Renamed to ${clean}`)
        },
        onError: (error) => {
          toast.error(errorMessage(error, `Could not rename ${entry.name}`))
          setRenamingPath(null)
        },
      },
    )
  }

  /** The entries a context-menu action (Cut/Copy/Rename/Delete/Download)
   *  should apply to: the whole current multi-selection if the right-clicked
   *  row is part of it, otherwise just that one row. */
  function menuTargetEntries(): SelectedEntry[] {
    if (!menuEntry) return []
    if (selectedCount > 1 && selection.selected[menuEntry.path]) return selectedEntries
    return [menuEntry]
  }

  /** Where New File/New Folder/Paste land when triggered from the context
   *  menu: inside the right-clicked folder, alongside a right-clicked file,
   *  or at the root when the menu was opened on empty space. */
  function menuTargetFolder(): string {
    if (!menuEntry) return ''
    return menuEntry.isDir ? menuEntry.path : parentPath(menuEntry.path)
  }

  function cutSelection() {
    const entries = menuTargetEntries()
    if (entries.length === 0) return
    setClipboard({ paths: entries.map((entry) => entry.path), mode: 'cut' })
  }

  function copySelection() {
    const entries = menuTargetEntries()
    if (entries.length === 0) return
    setClipboard({ paths: entries.map((entry) => entry.path), mode: 'copy' })
  }

  function pasteClipboard() {
    if (!clipboard || clipboard.paths.length === 0) return
    const folder = menuTargetFolder()
    const op = clipboard.mode === 'cut' ? moveFile : copyFile
    const paths = clipboard.paths
    Promise.allSettled(
      paths.map((from) => {
        const name = from.split('/').pop() ?? from
        const to = folder ? `${folder}/${name}` : name
        return op.mutateAsync({ from, to })
      }),
    ).then((results) => {
      const failed = results.filter((result) => result.status === 'rejected').length
      const verb = clipboard.mode === 'cut' ? 'move' : 'copy'
      if (failed > 0) toast.error(`Could not ${verb} ${failed} item${failed === 1 ? '' : 's'}`)
      if (failed < paths.length) {
        toast.success(`${paths.length - failed} item${paths.length - failed === 1 ? '' : 's'} ${verb === 'move' ? 'moved' : 'copied'}`)
      }
      if (clipboard.mode === 'cut') setClipboard(null)
    })
  }

  /** Drag-and-drop move: `paths` dropped onto `targetFolder`. Reuses the same
   *  moveFile primitive Cut/Paste and Rename already use. Same-location drops
   *  (dragged back onto their own parent) are silently skipped rather than
   *  surfaced as errors — the backend rejects same source/dest, but that's an
   *  expected no-op here, not a mistake worth a toast. */
  function moveEntries(paths: readonly string[], targetFolder: string) {
    const moves = paths
      .map((from) => {
        const name = from.split('/').pop() ?? from
        const to = targetFolder ? `${targetFolder}/${name}` : name
        return { from, to }
      })
      .filter(({ from, to }) => from !== to)
    if (moves.length === 0) return
    Promise.allSettled(moves.map(({ from, to }) => moveFile.mutateAsync({ from, to }))).then((results) => {
      const failed = results.filter((result) => result.status === 'rejected').length
      if (failed > 0) toast.error(`Could not move ${failed} item${failed === 1 ? '' : 's'}`)
      if (failed < moves.length) {
        toast.success(`${moves.length - failed} item${moves.length - failed === 1 ? '' : 's'} moved`)
      }
    })
  }

  /** Begins an internal tree drag: dragging a selected row drags the whole
   *  multi-selection, dragging an unselected row drags just that entry. */
  function beginDragEntry(entry: SelectedEntry): string[] {
    const paths = selection.selected[entry.path] && selectedCount > 1 ? selectedPaths : [entry.path]
    setDraggingPaths(paths)
    return paths
  }

  function endDragEntry() {
    setDraggingPaths(null)
  }

  function copyPathToPasteboard(entry: SelectedEntry) {
    navigator.clipboard
      ?.writeText(entry.path)
      .then(() => toast.success('Path copied'))
      .catch(() => toast.error('Could not copy path'))
  }

  /** Single onContextMenu handler on the scrollable tree container — reuses
   *  the same entryCacheRef/data-row-path mechanism click-selection already
   *  relies on, instead of threading a per-row handler through TreeLevel. */
  function handleTreeContextMenu(event: MouseEvent<HTMLDivElement>) {
    const rowEl = (event.target as HTMLElement).closest<HTMLElement>('[data-row-path]')
    const path = rowEl?.dataset.rowPath
    const entry = path ? entryCacheRef.current.get(path) : undefined
    if (!entry) {
      setMenuEntry(null)
      return
    }
    setMenuEntry(entry)
    setSelection((current) => {
      if (current.selected[entry.path] && Object.keys(current.selected).length > 1) return current
      return { selected: { [entry.path]: entry }, anchor: entry.path }
    })
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
    const eventTarget = event.target as HTMLElement
    if (eventTarget.tagName === 'INPUT' || eventTarget.tagName === 'TEXTAREA') return
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selectedPaths.length === 0) return
      event.preventDefault()
      setPendingDelete(selectedEntries)
      return
    }
    const primary = event.ctrlKey || event.metaKey
    if (primary && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
      event.preventDefault()
      startCreate(uploadTarget, 'file')
    }
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
    const internal = event.dataTransfer.types.includes(ENTRY_DRAG_MIME)
    if (!internal && !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = internal ? 'move' : 'copy'
    setIsDragOver(true)
  }

  function handleTreeDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setIsDragOver(false)
  }

  function handleTreeDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDragOver(false)
    if (event.dataTransfer.types.includes(ENTRY_DRAG_MIME)) {
      moveEntries(readDraggedPaths(event), uploadTarget)
      return
    }
    const files = Array.from(event.dataTransfer.files ?? [])
    void uploadToFolder(uploadTarget, files)
  }

  function handlePaste(event: ClipboardEvent<HTMLElement>) {
    const files = Array.from(event.clipboardData?.files ?? [])
    if (files.length === 0) return
    event.preventDefault()
    void uploadToFolder(uploadTarget, files)
  }

  /**
   * Zips `entries` into `filename` and saves it to `saveTarget`.
   * Callers own picking the destination, because the native save dialog has
   * to open while the click's user activation is still fresh.
   */
  async function archiveTo(entries: readonly SelectedEntry[], filename: string, saveTarget: SaveTarget) {
    const paths = entries.map((entry) => entry.path)
    try {
      const blob = await downloadZip(paths, filename)
      await saveTarget.write(blob)
      toast.success(`Zipped ${paths.length} item${paths.length === 1 ? '' : 's'}`)
    } catch (error) {
      toast.error(errorMessage(error, 'Could not zip selection'))
    }
  }

  /**
   * Entry point for both the toolbar button and a folder row's Download.
   * Where the OS dialog exists it collects the archive name *and* the
   * location in one step, so ArchiveNameDialog would be a redundant second
   * prompt — it is only used to name the file when there's no native picker.
   */
  async function requestArchive(entries: readonly SelectedEntry[]) {
    if (entries.length === 0 || downloading) return
    if (!canPickSaveLocation()) {
      setPendingArchive([...entries])
      return
    }
    const filename = archiveDefaultName(entries)
    const saveTarget = await pickSaveTarget(filename)
    if (saveTarget === SAVE_CANCELLED) return
    await archiveTo(entries, filename, saveTarget)
  }

  async function performArchive(filename: string) {
    if (!pendingArchive || pendingArchive.length === 0 || downloading) return
    const entries = pendingArchive
    setPendingArchive(null)
    // No native picker here by definition, so this resolves to the anchor
    // fallback and saves straight to the browser's download folder.
    const saveTarget = await pickSaveTarget(filename)
    if (saveTarget === SAVE_CANCELLED) return
    await archiveTo(entries, filename, saveTarget)
  }

  async function downloadEntry(entry: SelectedEntry) {
    if (downloading) return
    // Picked before awaiting the bytes: showSaveFilePicker needs transient
    // activation, which would be gone by the time a large file finished.
    const saveTarget = await pickSaveTarget(entry.name)
    if (saveTarget === SAVE_CANCELLED) return
    try {
      const blob = await downloadFile(entry.path, entry.name)
      await saveTarget.write(blob)
      toast.success(`Downloaded ${entry.name}`)
    } catch (error) {
      toast.error(errorMessage(error, `Could not download ${entry.name}`))
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
          onClick={() => void requestArchive(selectedEntries)}
          disabled={selectedCount === 0 || downloading}
          title="Zip selected files and folders"
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-devdeck-dim hover:text-devdeck-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          {downloading ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />}
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
          onClick={() => startCreate(uploadTarget, 'folder')}
          disabled={mkdir.isPending}
          title={`New folder in ${uploadTargetLabel}`}
          className="flex h-8 w-8 cursor-pointer items-center justify-center text-devdeck-dim hover:text-devdeck-fg disabled:cursor-wait"
        >
          {mkdir.isPending ? <Loader2 size={13} className="animate-spin" /> : <FolderPlus size={13} />}
        </button>
        <button
          type="button"
          onClick={() => startCreate(uploadTarget, 'file')}
          disabled={writeFile.isPending}
          title={`New file in ${uploadTargetLabel} (Ctrl+N)`}
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

      <ContextMenu.Root>
        <ContextMenu.Trigger
          render={
            <div
              ref={treeContainerRef}
              onContextMenu={handleTreeContextMenu}
              onDragOver={handleTreeDragOver}
              onDragLeave={handleTreeDragLeave}
              onDrop={handleTreeDrop}
              className={cn(
                'min-h-0 flex-1 overflow-auto py-1',
                isDragOver && 'outline outline-2 outline-dashed outline-devdeck-accent -outline-offset-2',
              )}
            />
          }
        >
          <TreeLevel
            target={target}
            path=""
            depth={0}
            expanded={expanded}
            selected={selection.selected}
            entryCache={entryCacheRef}
            dropTargetPath={dropTargetPath}
            draggingPaths={draggingPaths}
            creating={creating}
            onCommitCreate={commitCreate}
            onCancelCreate={cancelCreate}
            renamingPath={renamingPath}
            onCommitRename={commitRename}
            onCancelRename={cancelRename}
            onToggleDir={toggleDir}
            onSelectEntry={selectEntry}
            onOpenFile={onOpenFile}
            onRemovePath={removeEntry}
            onRequestArchive={(entry) => void requestArchive([entry])}
            onDownloadFile={(entry) => void downloadEntry(entry)}
            onSetDropTarget={setDropTargetPath}
            onDropFilesToFolder={(path, files) => void uploadToFolder(path, files)}
            onDropEntriesToFolder={(path, paths) => moveEntries(paths, path)}
            onDragStartEntry={beginDragEntry}
            onDragEndEntry={endDragEntry}
            deletePending={deletePaths.isPending}
            downloadPending={downloading}
          />
        </ContextMenu.Trigger>

        <ContextMenu.Portal>
          <ContextMenu.Positioner className="outline-none" style={{ zIndex: 70 }}>
            <ContextMenu.Popup
              className={cn(
                'min-w-[190px] origin-[var(--transform-origin)] rounded-[11px] border border-devdeck-border-menu bg-devdeck-popover p-1.5',
                'shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none transition-all duration-150',
                'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
                'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              )}
            >
              <ContextMenuAction label="New File..." shortcut="⌘N" onClick={() => startCreate(menuTargetFolder(), 'file')} />
              <ContextMenuAction label="New Folder..." onClick={() => startCreate(menuTargetFolder(), 'folder')} />
              <ContextMenuSeparator />
              <ContextMenuAction label="Cut" shortcut="⌘X" disabled={!menuEntry} onClick={cutSelection} />
              <ContextMenuAction label="Copy" shortcut="⌘C" disabled={!menuEntry} onClick={copySelection} />
              <ContextMenuAction label="Paste" shortcut="⌘V" disabled={!clipboard} onClick={pasteClipboard} />
              <ContextMenuSeparator />
              <ContextMenuAction
                label="Copy Path"
                disabled={!menuEntry}
                onClick={() => menuEntry && copyPathToPasteboard(menuEntry)}
              />
              <ContextMenuAction
                label="Rename..."
                disabled={!menuEntry || selectedCount > 1}
                onClick={() => menuEntry && startRename(menuEntry)}
              />
              <ContextMenuAction
                label="Download"
                disabled={!menuEntry}
                onClick={() => {
                  const entries = menuTargetEntries()
                  const only = entries.length === 1 ? entries[0] : undefined
                  if (only && !only.isDir) void downloadEntry(only)
                  else void requestArchive(entries)
                }}
              />
              <ContextMenuSeparator />
              <ContextMenuAction
                danger
                label="Delete"
                disabled={!menuEntry}
                onClick={() => {
                  const entries = menuTargetEntries()
                  if (entries.length > 0) setPendingDelete(entries)
                }}
              />
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>

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

      <ArchiveNameDialog
        open={pendingArchive !== null}
        defaultName={archiveDefault}
        itemCount={pendingArchive?.length ?? 0}
        pending={downloading}
        onCancel={() => setPendingArchive(null)}
        onConfirm={(filename) => void performArchive(filename)}
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
  draggingPaths: readonly string[] | null
  onToggleDir: (path: string) => void
  onSelectEntry: (entry: SelectedEntry, modifier: ClickModifier) => void
  onOpenFile: (path: string) => void
  onRemovePath: (entry: SelectedEntry) => void
  onRequestArchive: (entry: SelectedEntry) => void
  onDownloadFile: (entry: SelectedEntry) => void
  onSetDropTarget: (path: string | null) => void
  onDropFilesToFolder: (path: string, files: File[]) => void
  onDropEntriesToFolder: (path: string, paths: string[]) => void
  onDragStartEntry: (entry: SelectedEntry) => string[]
  onDragEndEntry: () => void
  deletePending: boolean
  downloadPending: boolean
  creating: { parentPath: string; kind: 'file' | 'folder' } | null
  onCommitCreate: (name: string) => void
  onCancelCreate: () => void
  renamingPath: string | null
  onCommitRename: (entry: SelectedEntry, name: string) => void
  onCancelRename: () => void
}

/** The inline "type a name" row for New File/New Folder — rendered as the
 *  first row of whichever folder level is currently creating something. */
function CreateRow({
  indent,
  kind,
  onCommit,
  onCancel,
}: {
  indent: number
  kind: 'file' | 'folder'
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  return (
    <div className="flex h-[29px] items-center gap-1.5 pr-1.5" style={{ paddingLeft: indent + 18 }}>
      <MaterialFileIcon name="" isDir={kind === 'folder'} size={16} />
      <InlineNameInput
        defaultValue=""
        placeholder={kind === 'folder' ? 'Folder name' : 'File name'}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  )
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

  const creatingHere = rest.creating?.parentPath === path ? rest.creating : null

  if (entries.length === 0 && !creatingHere) {
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
      {creatingHere ? (
        <CreateRow indent={indent} kind={creatingHere.kind} onCommit={rest.onCommitCreate} onCancel={rest.onCancelCreate} />
      ) : null}
      {entries.map((entry) => {
        const isOpen = entry.isDir && rest.expanded.has(entry.path)
        const isSelected = Boolean(rest.selected[entry.path])
        const isRenaming = rest.renamingPath === entry.path
        const selectedEntry: SelectedEntry = { name: entry.name, path: entry.path, isDir: entry.isDir }
        rest.entryCache.current.set(entry.path, selectedEntry)
        const isDragging = rest.draggingPaths?.includes(entry.path) ?? false
        return (
          <div key={entry.path}>
            <div
              data-row-path={entry.path}
              draggable={!isRenaming}
              onDragStart={(event) => {
                event.stopPropagation()
                const paths = rest.onDragStartEntry(selectedEntry)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData(ENTRY_DRAG_MIME, JSON.stringify(paths))
              }}
              onDragEnd={(event) => {
                event.stopPropagation()
                rest.onDragEndEntry()
              }}
              onDragOver={(event) => {
                if (!entry.isDir || isDragging) return
                const internal = event.dataTransfer.types.includes(ENTRY_DRAG_MIME)
                if (!internal && !event.dataTransfer.types.includes('Files')) return
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = internal ? 'move' : 'copy'
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
                if (event.dataTransfer.types.includes(ENTRY_DRAG_MIME)) {
                  rest.onDropEntriesToFolder(entry.path, readDraggedPaths(event))
                  return
                }
                rest.onDropFilesToFolder(entry.path, Array.from(event.dataTransfer.files ?? []))
              }}
              className={cn(
                'group flex h-[29px] items-center pr-1.5 hover:bg-devdeck-hover-wash',
                isSelected && 'bg-devdeck-accent/10',
                isDragging && 'opacity-40',
                rest.dropTargetPath === entry.path && 'outline outline-2 outline-dashed outline-devdeck-accent -outline-offset-2',
              )}
              style={{ paddingLeft: indent }}
            >
              {isRenaming ? (
                <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1.5">
                  <ChevronRight size={11} className={cn('flex-none text-devdeck-dim-3', !entry.isDir && 'invisible')} />
                  <MaterialFileIcon name={entry.name} isDir={entry.isDir} size={16} />
                  <InlineNameInput
                    defaultValue={entry.name}
                    onCommit={(name) => rest.onCommitRename(selectedEntry, name)}
                    onCancel={rest.onCancelRename}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={(event: MouseEvent<HTMLButtonElement>) => {
                    // WebKit doesn't focus buttons on click, so without this the
                    // aside's onPaste (Cmd+V a screenshot into the selected folder) never fires.
                    event.currentTarget.focus()
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
              )}
              <button
                type="button"
                onClick={() =>
                  entry.isDir ? rest.onRequestArchive(selectedEntry) : rest.onDownloadFile(selectedEntry)
                }
                disabled={rest.downloadPending}
                title={`Download ${entry.name}`}
                className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-devdeck-dim opacity-0 hover:bg-devdeck-hover-wash hover:text-devdeck-fg group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait"
              >
                <Download size={11} />
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

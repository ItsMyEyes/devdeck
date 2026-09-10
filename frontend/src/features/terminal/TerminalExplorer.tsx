import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, MouseEvent, MutableRefObject, ReactNode } from 'react'
import { ContextMenu } from '@base-ui/react/context-menu'
import { useIsFetching } from '@tanstack/react-query'
import {
  Archive,
  ChevronRight,
  ChevronsDownUp,
  Download,
  FilePlus2,
  FileSearch,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  PackageSearch,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { canPickSaveLocation, pickSaveTarget, SAVE_CANCELLED, type SaveTarget } from '@/lib/saveFile'
import { openWithExternalApp } from '@/lib/openWithExternal'
import { cn } from '@/lib/utils'
import { useIsTauri } from '@/features/tabs/useIsTauri'
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
import { DependenciesDialog } from '@/features/overlays/DependenciesDialog'
import { tourAnchor } from '@/features/tour/tourAnchors'
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
import { setEntryDragImage } from './dragImage'
import { parentPath, planDrop, resolveDropFolder, type DropRow } from './dropTarget'
import {
  clearExplorerClipboard,
  getExplorerClipboard,
  resolvePasteRoute,
  setExplorerClipboard,
  subscribeExplorerClipboard,
} from './explorerClipboard'
import { MaterialFileIcon } from './MaterialFileIcon'
import { useDragAutoExpand } from './useDragAutoExpand'
import {
  encodeShellDragPayload,
  getShellTransferHandle,
  parseShellDragPayload,
  registerShellTransferHandle,
  resolveDropRoute,
  transferAcrossShells,
  unregisterShellTransferHandle,
  type ShellTransferHandle,
} from './shellTransfer'
import { useFileTransfers } from './useFileTransfers'
import { matchesBinding, useCommandChordLabel } from '@/features/keybindings/store'

interface TerminalExplorerProps {
  /** `wt:<worktreeId>` | `ssh:<connectionId>` — this tree's own identity in
   *  the cross-shell drag payload (spec §6). Stamped onto every entry this
   *  tree drags out, and compared against an incoming drop's origin to tell
   *  a same-tree move apart from a transfer from a different shell. */
  shellKey: string
  target: FilesTarget
  rootLabel: string
  onOpenFile: (path: string) => void
  onFileDeleted: (paths: string[]) => void
  /** Omitted for SSH connections — there's no remote file quick-open (yet). */
  onRequestQuickOpen?: () => void
  /** Opens the "Search in Files" content-search panel. */
  onRequestContentSearch?: () => void
  /** Keyboard chord shown next to "Search in files", for the surfaces that
   *  actually bind one. Omitted by the SSH pane, which reaches content search
   *  only through the action itself — advertising a chord it doesn't listen
   *  for would just be a dead key hint. */
  contentSearchShortcut?: string
  /** The path of whichever file tab is currently focused in this shell's pane
   *  area, if any — mirrors VS Code's "reveal active file in Explorer": every
   *  ancestor folder auto-expands and the row scrolls into view and gets a
   *  distinct highlight, independent of click-selection (spec: opening a file
   *  from quick-open, a definition jump, or just switching tabs should reveal
   *  it here exactly like clicking it in the tree does). */
  activePath?: string
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback
}

function plural(count: number, noun = 'item') {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function filesRootKey(target: FilesTarget) {
  return target.kind === 'ssh' ? qk.sshFilesRoot(target.connectionId) : qk.worktreeFilesRoot(target.machine.id, target.worktreeId)
}

/** Custom drag MIME carrying the dragged entries' ShellDragPayload — distinct
 *  from the browser's 'Files' type (an OS file drag) so drop handlers can
 *  tell an internal tree move apart from an upload, and (spec §6) a
 *  same-shell move apart from a cross-shell transfer. */
const ENTRY_DRAG_MIME = 'application/x-devdeck-entry-paths'

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
      className="h-[22px] min-w-0 flex-1 rounded border border-devdeck-border-accent bg-devdeck-glass-solid px-1.5 font-mono text-[11.5px] text-devdeck-fg-2 outline-none"
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
        danger && 'text-devdeck-err data-[highlighted]:bg-devdeck-red-tint-hover',
      )}
    >
      <span className="flex-1 truncate">{label}</span>
      {shortcut ? <span className="font-mono text-[10px] text-devdeck-fg-2">{shortcut}</span> : null}
    </ContextMenu.Item>
  )
}

function ContextMenuSeparator() {
  return <ContextMenu.Separator className="my-1 h-px bg-devdeck-border" />
}

/** One entry in the header's "..." overflow menu. Mirrors ContextMenuAction's
 *  look, but it is a plain button inside a Popover rather than a
 *  ContextMenu.Item — the two menus are different base-ui primitives. */
function HeaderMenuAction({
  label,
  icon,
  shortcut,
  disabled,
  danger,
  onClick,
}: {
  label: string
  icon: ReactNode
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left font-mono text-[11.5px] text-devdeck-fg-2',
        'hover:bg-devdeck-hover-wash disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent',
        danger && 'text-devdeck-err hover:bg-devdeck-red-tint-hover',
      )}
    >
      <span className="flex h-4 w-4 flex-none items-center justify-center">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {shortcut ? <span className="font-mono text-[10px] text-devdeck-fg-2">{shortcut}</span> : null}
    </button>
  )
}

/** `a/b/c.txt` → `['a', 'a/b']` — every folder between the tree root and
 *  `path`, root-to-leaf order, so expanding them in order never has to
 *  backtrack. A top-level path has no ancestors. */
function ancestorPaths(path: string): string[] {
  const ancestors: string[] = []
  let current = parentPath(path)
  while (current) {
    ancestors.unshift(current)
    current = parentPath(current)
  }
  return ancestors
}

export function TerminalExplorer({
  shellKey,
  target,
  rootLabel,
  onOpenFile,
  onFileDeleted,
  onRequestQuickOpen,
  onRequestContentSearch,
  contentSearchShortcut,
  activePath,
}: TerminalExplorerProps) {
  const newFileShortcut = useCommandChordLabel('explorer.newFile')
  const isTauri = useIsTauri()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [depsOpen, setDepsOpen] = useState(false)
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
  // Module-level, not component state: Copy in one pane has to enable Paste in
  // every other mounted pane (spec §5). `useSyncExternalStore` re-renders this
  // tree whenever any tree copies.
  const clipboard = useSyncExternalStore(subscribeExplorerClipboard, getExplorerClipboard, getExplorerClipboard)
  const [menuEntry, setMenuEntry] = useState<SelectedEntry | null>(null)
  const writeFile = useWriteFileTarget(target)
  const mkdir = useMkdirTarget(target)
  const moveFile = useMoveFileTarget(target)
  const copyFile = useCopyFileTarget(target)
  const { uploadFiles, downloadZip, downloadFile, extractArchive, uploading, downloading } = useFileTransfers(target)
  const deletePaths = useDeletePathsTarget(target)
  const invalidateFiles = useInvalidateFilesTarget(target)

  // Registers this tree's download/upload/extract primitives under its own
  // shellKey (spec §6) so a *different* shell's drop handler can transfer
  // out of this one — see shellTransfer.ts's registry doc comment. The
  // sidebar's TerminalExplorer and the in-pane 'explorer' pane-tab
  // TerminalExplorer can both be mounted under the same shellKey at once
  // (spec non-goals: "both surfaces coexist"), so cleanup unregisters this
  // exact handle instance rather than the shellKey outright — the registry
  // itself decides whether some other still-mounted registration survives.
  // useFileTransfers' functions are useCallback-memoized per target, so this
  // only actually re-registers when shellKey or target genuinely change.
  useEffect(() => {
    const handle: ShellTransferHandle = { target, downloadFile, downloadZip, uploadFiles, extractArchive, invalidate: invalidateFiles }
    registerShellTransferHandle(shellKey, handle)
    return () => unregisterShellTransferHandle(shellKey, handle)
  }, [shellKey, target, downloadFile, downloadZip, uploadFiles, extractArchive, invalidateFiles])
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

  const expandDir = useCallback((path: string) => {
    setExpanded((current) => (current.has(path) ? current : new Set(current).add(path)))
  }, [])

  /** Hovering a collapsed folder mid-drag opens it, so a nested destination is
   *  reachable without dropping first (spec §4). */
  const autoExpand = useDragAutoExpand(expandDir)

  /** Reveal-active-file: every ancestor of the active tab's path expands, the
   *  same way a folder the operator clicks open stays open (this merges into
   *  `expanded`, it never collapses anything). Runs off `activePath` alone —
   *  re-opening the same path twice is a no-op via the `changed` guard, so
   *  this can't fight a user's own manual collapse of an unrelated folder. */
  useEffect(() => {
    if (!activePath) return
    const ancestors = ancestorPaths(activePath)
    if (ancestors.length === 0) return
    setExpanded((current) => {
      let changed = false
      const next = new Set(current)
      for (const ancestor of ancestors) {
        if (!next.has(ancestor)) {
          next.add(ancestor)
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [activePath])

  /** Scrolls the active file's row into view once it exists in the DOM. A
   *  freshly-expanded ancestor's children load asynchronously (each level is
   *  its own `useFilesList` query), so the row this targets may not have
   *  rendered yet on the same tick `expanded` changes — the observer keeps
   *  watching until it does, rather than a fixed number of retries. */
  useEffect(() => {
    if (!activePath) return
    const container = treeContainerRef.current
    if (!container) return
    function findRow(): HTMLElement | undefined {
      return Array.from(container!.querySelectorAll<HTMLElement>('[data-row-path]')).find(
        (el) => el.dataset.rowPath === activePath,
      )
    }
    const existing = findRow()
    if (existing) {
      existing.scrollIntoView({ block: 'nearest' })
      return
    }
    const observer = new MutationObserver(() => {
      const row = findRow()
      if (!row) return
      row.scrollIntoView({ block: 'nearest' })
      observer.disconnect()
    })
    observer.observe(container, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [activePath, expanded])

  function collapseAll() {
    setExpanded(new Set())
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

  function putOnClipboard(mode: 'cut' | 'copy') {
    const entries = menuTargetEntries()
    if (entries.length === 0) return
    setExplorerClipboard({
      shellKey,
      paths: entries.map((entry) => entry.path),
      hasDir: entries.some((entry) => entry.isDir),
      mode,
    })
    toast.success(`${plural(entries.length)} ready to paste`)
  }

  /** Paste routes on where the entries came from (spec §5): same shell keeps
   *  the local move/copy primitives, a different shell goes through
   *  shellTransfer — which copies, since the bytes cross the browser and
   *  deleting a source after an unverified remote write is how a transfer
   *  turns into data loss. */
  function pasteClipboard() {
    if (!clipboard || clipboard.paths.length === 0) return
    const folder = menuTargetFolder()
    const route = resolvePasteRoute(clipboard, shellKey)

    if (route === 'transfer') {
      const source = getShellTransferHandle(clipboard.shellKey)
      if (!source) {
        toast.error('That pane is no longer open')
        return
      }
      if (clipboard.mode === 'cut') toast.info('Copied across panes - the original was kept')
      void transferAcrossShells(source, ownTransferHandle(), clipboard.paths, clipboard.hasDir, folder)
      return
    }

    const plan = planDrop(clipboard.paths, folder)
    if (!plan.ok) {
      toast.error(plan.reason)
      return
    }
    if (plan.moves.length === 0) {
      toast.info(`Already in ${folder || 'root'}`)
      return
    }
    runFileOps(plan.moves, route === 'move' ? 'move' : 'copy')
    if (clipboard.mode === 'cut') clearExplorerClipboard()
  }

  /**
   * Runs a planned batch of moves or copies and always reports the outcome.
   * Every drop and paste funnels through here so no path can end without the
   * operator learning what happened — the silent `return` this replaced is
   * what made a broken drop look identical to an ignored one.
   */
  function runFileOps(moves: readonly { from: string; to: string }[], op: 'move' | 'copy') {
    const mutation = op === 'move' ? moveFile : copyFile
    void Promise.allSettled(moves.map(({ from, to }) => mutation.mutateAsync({ from, to }))).then((results) => {
      const rejected = results.filter((result) => result.status === 'rejected')
      const done = moves.length - rejected.length
      if (done > 0) toast.success(`${plural(done)} ${op === 'move' ? 'moved' : 'copied'}`)
      if (rejected.length > 0) {
        const first = rejected[0]
        toast.error(errorMessage(first?.reason, `Could not ${op} ${plural(rejected.length)}`))
      }
    })
  }

  /** Drag-and-drop within this tree: a plain drop moves, ⌥/Alt copies
   *  (spec §2). Rejections and no-ops both get a toast. */
  function applyEntriesToFolder(paths: readonly string[], targetFolder: string, op: 'move' | 'copy') {
    const plan = planDrop(paths, targetFolder)
    if (!plan.ok) {
      toast.error(plan.reason)
      return
    }
    // Every entry already lives here — a genuine no-op, not a failure.
    if (plan.moves.length === 0) return
    runFileOps(plan.moves, op)
  }

  /** Begins an internal tree drag: dragging a selected row drags the whole
   *  multi-selection, dragging an unselected row drags just that entry.
   *  Returns the encoded ENTRY_DRAG_MIME payload (spec §6) rather than a
   *  bare path list, so the row's dragstart handler can set it verbatim
   *  without needing to know this tree's own shellKey. */
  function beginDragEntry(entry: SelectedEntry, dataTransfer: DataTransfer): string {
    const dragging = selection.selected[entry.path] && selectedCount > 1 ? selectedEntries : [entry]
    const paths = dragging.map((dragged) => dragged.path)
    const hasDir = dragging.some((dragged) => dragged.isDir)
    setDraggingPaths(paths)
    setEntryDragImage(dataTransfer, dragging.map((dragged) => dragged.name))
    return encodeShellDragPayload({ shellKey, paths, hasDir })
  }

  function endDragEntry() {
    setDraggingPaths(null)
    setDropTargetPath(null)
    setIsDragOver(false)
    autoExpand.cancel()
  }

  /** This tree's own transfer primitives, in the shape shellTransfer moves
   *  bytes through — the destination half of a cross-shell drop or paste. */
  function ownTransferHandle(): ShellTransferHandle {
    return { target, downloadFile, downloadZip, uploadFiles, extractArchive, invalidate: invalidateFiles }
  }

  /** Cross-shell half of a drop (spec §6): `payload.shellKey` already differs
   *  from this tree's own. A source that vanished mid-drag used to return
   *  silently, which read to the operator as "drag-and-drop doesn't work" —
   *  it says so now. */
  function transferFromOtherShell(payload: { shellKey: string; paths: string[]; hasDir: boolean }, targetFolder: string) {
    const source = getShellTransferHandle(payload.shellKey)
    if (!source) {
      toast.error('That pane is no longer open')
      return
    }
    void transferAcrossShells(source, ownTransferHandle(), payload.paths, payload.hasDir, targetFolder)
  }

  /** Single entry point for both the tree-root and per-row drop handlers.
   *  `row` is whatever the pointer was over — the *pointer* picks the
   *  destination folder, never the selection (spec §3). */
  function handleEntryDrop(event: DragEvent<HTMLDivElement>, row: DropRow | null) {
    const payload = parseShellDragPayload(event.dataTransfer.getData(ENTRY_DRAG_MIME))
    if (!payload) return
    const targetFolder = resolveDropFolder(row)
    if (resolveDropRoute(payload, shellKey) === 'move') {
      applyEntriesToFolder(payload.paths, targetFolder, event.altKey ? 'copy' : 'move')
      return
    }
    transferFromOtherShell(payload, targetFolder)
  }

  /** What a drag hovering this tree would do if dropped now, so the cursor
   *  badge and the outcome can't disagree: an OS file drag uploads, a foreign
   *  shell's entries copy, this tree's own entries move unless ⌥ is held. */
  function dropEffectFor(event: DragEvent<HTMLDivElement>): 'move' | 'copy' {
    if (!event.dataTransfer.types.includes(ENTRY_DRAG_MIME)) return 'copy'
    if (event.altKey) return 'copy'
    const payload = parseShellDragPayload(event.dataTransfer.getData(ENTRY_DRAG_MIME))
    // getData is empty during dragover in most browsers, so an unreadable
    // payload here means "can't tell yet" — assume this tree's own drag,
    // which is the common case and the one whose badge matters.
    return payload && payload.shellKey !== shellKey ? 'copy' : 'move'
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
    if (matchesBinding(event, 'explorer.deleteSelection')) {
      if (selectedPaths.length === 0) return
      event.preventDefault()
      setPendingDelete(selectedEntries)
      return
    }
    if (matchesBinding(event, 'explorer.newFile')) {
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

  /** WebKit only treats an element as a drop target when `dragenter` is
   *  cancelled too — Chromium is happy with `dragover` alone. Both are
   *  cancelled here so the tree accepts drops on every engine. */
  function handleTreeDragOver(event: DragEvent<HTMLDivElement>) {
    const internal = event.dataTransfer.types.includes(ENTRY_DRAG_MIME)
    if (!internal && !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = dropEffectFor(event)
    setIsDragOver(true)
  }

  function handleTreeDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setIsDragOver(false)
    setDropTargetPath(null)
    autoExpand.cancel()
  }

  /** A drop that reaches the container was over empty space or a file row, so
   *  it lands at the tree root. It deliberately no longer consults
   *  `uploadTarget` (the *selected* row's parent) — that was Cause 2. */
  function handleTreeDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDragOver(false)
    setDropTargetPath(null)
    autoExpand.cancel()
    if (event.dataTransfer.types.includes(ENTRY_DRAG_MIME)) {
      handleEntryDrop(event, null)
      return
    }
    const files = Array.from(event.dataTransfer.files ?? [])
    void uploadToFolder('', files)
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

  /** Downloads `entry` to the Tauri shell's private temp store and hands it
   *  to the OS's default app for its extension (desktop-only — the context
   *  menu item this backs is hidden otherwise). Removed again once that app
   *  closes; see openWithExternal.ts / open_with.rs. */
  async function openEntryExternally(entry: SelectedEntry) {
    try {
      const blob = await downloadFile(entry.path, entry.name)
      await openWithExternalApp(entry.name, new Uint8Array(await blob.arrayBuffer()))
    } catch (error) {
      toast.error(errorMessage(error, `Could not open ${entry.name}`))
    }
  }

  return (
    <aside className="flex min-h-0 flex-1 flex-col bg-devdeck-pane" onKeyDown={handleKeyDown} onPaste={handlePaste}>
      <input ref={uploadInputRef} type="file" multiple className="hidden" onChange={handleUploadChange} />
      {/* Two inline actions + an overflow menu, rather than the six-to-seven
          inline buttons this header used to carry. The sidebar this renders in
          is 200-560px wide (SHELL_SIDEBAR_MIN/MAX_WIDTH), and 7 * 32px of
          buttons plus the root label needed ~350px — so at anything near the
          default width the buttons crushed the label and spilled past the
          panel edge. Only New File and Refresh stay inline; everything else
          moves into "..." and keeps its keyboard shortcut and context-menu
          entry. */}
      <div className="flex h-9 flex-none items-center border-b border-devdeck-border bg-devdeck-card-wash">
        <div
          title={rootLabel}
          className="flex h-full min-w-0 flex-1 items-center truncate border-r border-devdeck-border bg-devdeck-pane px-3 font-mono text-[11px] text-devdeck-fg"
        >
          {rootLabel}
        </div>
        <button
          type="button"
          {...tourAnchor('explorer-new-file')}
          onClick={() => startCreate(uploadTarget, 'file')}
          disabled={writeFile.isPending}
          title={newFileShortcut ? `New file in ${uploadTargetLabel} (${newFileShortcut})` : `New file in ${uploadTargetLabel}`}
          aria-label="New file"
          className="flex h-8 w-8 flex-none cursor-pointer items-center justify-center text-devdeck-fg-2 hover:text-devdeck-fg disabled:cursor-wait"
        >
          {writeFile.isPending ? <Loader2 size={13} className="animate-spin" /> : <FilePlus2 size={13} />}
        </button>
        <button
          type="button"
          {...tourAnchor('explorer-new-folder')}
          onClick={() => startCreate(uploadTarget, 'folder')}
          disabled={mkdir.isPending}
          title={`New folder in ${uploadTargetLabel}`}
          aria-label="New folder"
          className="flex h-8 w-8 flex-none cursor-pointer items-center justify-center text-devdeck-fg-2 hover:text-devdeck-fg disabled:cursor-wait"
        >
          {mkdir.isPending ? <Loader2 size={13} className="animate-spin" /> : <FolderPlus size={13} />}
        </button>
        <button
          type="button"
          {...tourAnchor('explorer-refresh')}
          onClick={invalidateFiles}
          disabled={isFetching}
          title="Refresh files"
          aria-label="Refresh files"
          className="flex h-8 w-8 flex-none cursor-pointer items-center justify-center text-devdeck-fg-2 hover:text-devdeck-fg disabled:cursor-wait"
        >
          <RefreshCw size={13} className={cn(isFetching && 'animate-spin')} />
        </button>
        <button
          type="button"
          {...tourAnchor('explorer-collapse')}
          onClick={collapseAll}
          disabled={expanded.size === 0}
          title="Collapse all folders"
          aria-label="Collapse all folders"
          className="flex h-8 w-8 flex-none cursor-pointer items-center justify-center text-devdeck-fg-2 hover:text-devdeck-fg disabled:cursor-default disabled:opacity-40"
        >
          <ChevronsDownUp size={13} />
        </button>
        <TabStripPopoverMenu
          trigger={<MoreHorizontal size={13} />}
          triggerAnchor={tourAnchor('explorer-more')}
          triggerTitle="More file actions"
          triggerAriaLabel="More file actions"
          align="end"
          triggerClassName="flex h-8 w-8 flex-none cursor-pointer items-center justify-center text-devdeck-fg-2 hover:text-devdeck-fg"
        >
          <div className="flex min-w-[190px] flex-col gap-0.5">
            <HeaderMenuAction
              label="Upload files…"
              icon={uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
              disabled={uploading}
              onClick={() => uploadInputRef.current?.click()}
            />
            <HeaderMenuAction
              label="Zip selected"
              icon={downloading ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />}
              disabled={selectedCount === 0 || downloading}
              onClick={() => void requestArchive(selectedEntries)}
            />
            {/* Worktree-only: an SSH target has no machine to probe, and SSH
                files get no language server in the first place. */}
            {target.kind !== 'ssh' ? (
              <HeaderMenuAction
                label="Editor dependencies…"
                icon={<PackageSearch size={13} />}
                onClick={() => setDepsOpen(true)}
              />
            ) : null}
            <HeaderMenuAction
              label="Delete selected"
              icon={deletePaths.isPending ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              disabled={selectedCount === 0 || deletePaths.isPending}
              danger
              onClick={removeSelected}
            />
          </div>
        </TabStripPopoverMenu>
      </div>

      {/* Its own row rather than a chip wedged into the header strip: the
          sidebar is 200-560px wide, and the count competed with the root
          label for the same space. */}
      {selectedCount > 0 ? (
        <div className="flex h-7 flex-none items-center gap-2 border-b border-devdeck-border bg-devdeck-on pl-3 pr-1.5 font-mono text-[10.5px] text-devdeck-fg-2">
          <span className="min-w-0 flex-1 truncate">{selectedCount} selected</span>
          <button
            type="button"
            onClick={clearSelection}
            title="Clear selection"
            aria-label="Clear selection"
            className="flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
          >
            <X size={11} />
          </button>
        </div>
      ) : null}

      {target.kind !== 'ssh' ? (
        <DependenciesDialog open={depsOpen} onOpenChange={setDepsOpen} machine={target.machine} />
      ) : null}

      <ContextMenu.Root>
        <ContextMenu.Trigger
          render={
            <div
              ref={treeContainerRef}
              onContextMenu={handleTreeContextMenu}
              onDragEnter={handleTreeDragOver}
              onDragOver={handleTreeDragOver}
              onDragLeave={handleTreeDragLeave}
              onDrop={handleTreeDrop}
              className={cn(
                'min-h-0 flex-1 overflow-auto py-1',
                // Root-targeted drop: the pointer is over empty space or a
                // file row, so the drop lands at the tree root.
                isDragOver && dropTargetPath === null && 'bg-devdeck-on ring-1 ring-inset ring-devdeck-line',
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
            activePath={activePath}
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
            onDropEntriesToFolder={(row, event) => handleEntryDrop(event, row)}
            onDragStartEntry={beginDragEntry}
            onDragEndEntry={endDragEntry}
            onDragOverFolder={autoExpand.hover}
            onLeaveFolder={autoExpand.cancel}
            dropEffectFor={dropEffectFor}
            deletePending={deletePaths.isPending}
            downloadPending={downloading}
          />
        </ContextMenu.Trigger>

        <ContextMenu.Portal>
          <ContextMenu.Positioner className="outline-none" style={{ zIndex: 70 }}>
            <ContextMenu.Popup
              className={cn(
                'min-w-[190px] origin-[var(--transform-origin)] rounded-control border border-devdeck-border-menu bg-devdeck-glass-solid p-1.5',
                'shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none transition-all duration-150',
                'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
                'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              )}
            >
              <ContextMenuAction label="New File..." shortcut={newFileShortcut} onClick={() => startCreate(menuTargetFolder(), 'file')} />
              <ContextMenuAction label="New Folder..." onClick={() => startCreate(menuTargetFolder(), 'folder')} />
              <ContextMenuSeparator />
              <ContextMenuAction label="Cut" shortcut="⌘X" disabled={!menuEntry} onClick={() => putOnClipboard('cut')} />
              <ContextMenuAction label="Copy" shortcut="⌘C" disabled={!menuEntry} onClick={() => putOnClipboard('copy')} />
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
              {isTauri ? (
                <ContextMenuAction
                  label="Open with default app"
                  disabled={!menuEntry || menuEntry.isDir}
                  onClick={() => menuEntry && void openEntryExternally(menuEntry)}
                />
              ) : null}
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
          {...tourAnchor('explorer-quick-open')}
          onClick={onRequestQuickOpen}
          className="flex h-9 flex-none cursor-pointer items-center gap-2 border-t border-devdeck-border bg-devdeck-card-wash px-3 text-left font-mono text-[10.5px] text-devdeck-fg-2 hover:text-devdeck-fg-2"
        >
          <Search size={12} />
          <span>Search files / folders</span>
          <kbd className="ml-auto rounded border border-devdeck-border-strong bg-devdeck-pane px-1.5 py-0.5 text-[9.5px] text-devdeck-fg-2">
            Ctrl P
          </kbd>
        </button>
      ) : null}

      {onRequestContentSearch ? (
        <button
          type="button"
          {...tourAnchor('explorer-content-search')}
          onClick={onRequestContentSearch}
          className="flex h-9 flex-none cursor-pointer items-center gap-2 border-t border-devdeck-border bg-devdeck-card-wash px-3 text-left font-mono text-[10.5px] text-devdeck-fg-2 hover:text-devdeck-fg-2"
        >
          <FileSearch size={12} />
          <span>Search in files</span>
          {contentSearchShortcut ? (
            <kbd className="ml-auto rounded border border-devdeck-border-strong bg-devdeck-pane px-1.5 py-0.5 text-[9.5px] text-devdeck-fg-2">
              {contentSearchShortcut}
            </kbd>
          ) : null}
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
  /** The open file to reveal/highlight — see `TerminalExplorerProps.activePath`. */
  activePath?: string
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
  onDropEntriesToFolder: (row: DropRow, event: DragEvent<HTMLDivElement>) => void
  onDragStartEntry: (entry: SelectedEntry, dataTransfer: DataTransfer) => string
  onDragEndEntry: () => void
  onDragOverFolder: (path: string) => void
  onLeaveFolder: () => void
  dropEffectFor: (event: DragEvent<HTMLDivElement>) => 'move' | 'copy'
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
  const { data, error, isLoading, isFetching, refetch } = useFilesList(target, path)
  const indent = 8 + depth * 14
  const entries = data ?? []

  if (isLoading) {
    return depth === 0 ? (
      <div className="flex h-28 items-center justify-center">
        <DataLoading compact label="loading files…" />
      </div>
    ) : (
      <div className="flex h-[29px] items-center gap-2 text-devdeck-fg-2" style={{ paddingLeft: indent + 18 }}>
        <Loader2 size={11} className="animate-spin" />
      </div>
    )
  }

  // `data` is what this level last listed SUCCESSFULLY — React Query keeps it
  // alongside a later failure, and it is the difference between "this folder
  // never loaded" and "this folder loaded, and the refresh after it didn't".
  // Only the first has nothing to show. Treating both as the second is what
  // made one dropped SFTP connection wipe every expanded folder in the tree
  // and replace it with an error, while the terminal beside it — a separate
  // SSH connection — carried on working. Note the check is `data`, not
  // `entries.length`: a folder that is genuinely empty has a listing too, and
  // it must not be downgraded to the error screen either.
  if (error && !data) {
    const message = error instanceof ApiError ? error.message : 'Could not read this folder'
    return depth === 0 ? (
      <div className="flex h-32 flex-col items-center justify-center gap-3 px-4 text-center">
        <span className="font-mono text-[10.5px] leading-relaxed text-devdeck-fg-2">{message}</span>
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
        className="flex h-[29px] w-full cursor-pointer items-center gap-1.5 truncate font-mono text-[10.5px] text-devdeck-err hover:bg-devdeck-hover-wash"
        style={{ paddingLeft: indent + 18 }}
      >
        {message} · retry
      </button>
    )
  }

  const creatingHere = rest.creating?.parentPath === path ? rest.creating : null

  // A refresh that failed over a listing we still have. Shown as one thin row
  // ABOVE the entries it belongs to, so the tree stays usable while the link
  // is flaky: everything below is the last good listing, and this says so and
  // offers another attempt. It carries the backend's own sentence because on a
  // bad connection the distinction the operator needs — dropped link vs
  // permission vs missing path — is in that sentence.
  const staleNotice = error ? (
    <button
      type="button"
      onClick={() => refetch()}
      title="Try this folder again"
      className="flex h-[29px] w-full cursor-pointer items-center gap-1.5 truncate font-mono text-[10.5px] text-devdeck-err hover:bg-devdeck-hover-wash"
      style={{ paddingLeft: indent + 18 }}
    >
      <RefreshCw size={11} className={cn('flex-none', isFetching && 'animate-spin')} />
      <span className="truncate">{errorMessage(error, 'Could not refresh this folder')} · retry</span>
    </button>
  ) : null

  if (entries.length === 0 && !creatingHere) {
    return depth === 0 ? (
      <>
        {staleNotice}
        <div className="flex h-28 items-center justify-center font-mono text-[10.5px] text-devdeck-fg-2">
          Empty folder
        </div>
      </>
    ) : (
      <>
        {staleNotice}
        <div className="flex h-[29px] items-center font-mono text-[10.5px] text-devdeck-fg-2" style={{ paddingLeft: indent + 18 }}>
          empty
        </div>
      </>
    )
  }

  return (
    <>
      {staleNotice}
      {creatingHere ? (
        <CreateRow indent={indent} kind={creatingHere.kind} onCommit={rest.onCommitCreate} onCancel={rest.onCancelCreate} />
      ) : null}
      {entries.map((entry) => {
        const isOpen = entry.isDir && rest.expanded.has(entry.path)
        const isSelected = Boolean(rest.selected[entry.path])
        // Not folded into `isSelected`: a bulk multi-select (⌘-click across
        // several rows) must not visually claim the active file as part of
        // that selection when it wasn't clicked into it.
        const isActiveFile = !entry.isDir && !isSelected && entry.path === rest.activePath
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
                const payload = rest.onDragStartEntry(selectedEntry, event.dataTransfer)
                // Both, so the cursor can show a copy badge when ⌥ is held —
                // 'move' alone makes the browser refuse a copy dropEffect.
                event.dataTransfer.effectAllowed = 'copyMove'
                event.dataTransfer.setData(ENTRY_DRAG_MIME, payload)
              }}
              onDragEnd={(event) => {
                event.stopPropagation()
                rest.onDragEndEntry()
              }}
              // dragenter is cancelled alongside dragover because WebKit only
              // accepts a drop on an element that cancelled both.
              onDragEnter={(event) => {
                if (!entry.isDir || isDragging) return
                const internal = event.dataTransfer.types.includes(ENTRY_DRAG_MIME)
                if (!internal && !event.dataTransfer.types.includes('Files')) return
                event.preventDefault()
                event.stopPropagation()
                rest.onSetDropTarget(entry.path)
                if (!isOpen) rest.onDragOverFolder(entry.path)
              }}
              onDragOver={(event) => {
                if (!entry.isDir || isDragging) return
                const internal = event.dataTransfer.types.includes(ENTRY_DRAG_MIME)
                if (!internal && !event.dataTransfer.types.includes('Files')) return
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = internal ? rest.dropEffectFor(event) : 'copy'
                rest.onSetDropTarget(entry.path)
                if (!isOpen) rest.onDragOverFolder(entry.path)
              }}
              onDragLeave={(event) => {
                if (!entry.isDir) return
                event.stopPropagation()
                rest.onSetDropTarget(null)
                rest.onLeaveFolder()
              }}
              onDrop={(event) => {
                if (!entry.isDir) return
                event.preventDefault()
                event.stopPropagation()
                rest.onSetDropTarget(null)
                rest.onLeaveFolder()
                if (event.dataTransfer.types.includes(ENTRY_DRAG_MIME)) {
                  rest.onDropEntriesToFolder({ path: entry.path, isDir: true }, event)
                  return
                }
                rest.onDropFilesToFolder(entry.path, Array.from(event.dataTransfer.files ?? []))
              }}
              className={cn(
                'group flex h-[29px] items-center pr-1.5 hover:bg-devdeck-hover-wash',
                isSelected && 'bg-devdeck-on',
                isActiveFile && 'bg-devdeck-hover-wash ring-1 ring-inset ring-devdeck-border-accent',
                isDragging && 'opacity-40',
                rest.dropTargetPath === entry.path && 'bg-devdeck-on ring-1 ring-inset ring-devdeck-line',
              )}
              style={{ paddingLeft: indent }}
            >
              {isRenaming ? (
                <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1.5">
                  <ChevronRight size={11} className={cn('flex-none text-devdeck-fg-2', !entry.isDir && 'invisible')} />
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
                      'flex-none text-devdeck-fg-2 transition-transform duration-100',
                      isOpen && 'rotate-90',
                      !entry.isDir && 'invisible',
                    )}
                  />
                  <MaterialFileIcon name={entry.name} isDir={entry.isDir} size={16} />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate font-mono text-[11.5px]',
                      isActiveFile ? 'text-devdeck-fg' : 'text-devdeck-fg-2',
                    )}
                  >
                    {entry.name}
                  </span>
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  entry.isDir ? rest.onRequestArchive(selectedEntry) : rest.onDownloadFile(selectedEntry)
                }
                disabled={rest.downloadPending}
                title={`Download ${entry.name}`}
                className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-devdeck-fg-2 opacity-0 hover:bg-devdeck-hover-wash hover:text-devdeck-fg group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait"
              >
                <Download size={11} />
              </button>
              <button
                type="button"
                onClick={() => rest.onRemovePath(selectedEntry)}
                disabled={rest.deletePending}
                title={`Delete ${entry.name}`}
                className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-devdeck-fg-2 opacity-0 hover:bg-devdeck-red-tint-hover hover:text-devdeck-err group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait"
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

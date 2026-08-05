import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import {
  Check,
  FilePlus,
  FilePlus2,
  FileText,
  FolderTree,
  GitBranch,
  GitCompare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { worktreeLabel } from '@/lib/worktreeLabel'
import type { Machine, Worktree } from '@/store/types'
import { useKillTerminalSession, useMachines, useUpdateWorktree, useWorkspace } from '@/features/data/queries'
import { shellSidebarState, useDevDeckStore } from '@/store/useDevDeckStore'
import type { DefinitionReveal, DefinitionTarget } from './CodeFileEditor'
import { ContentSearchPanel } from './ContentSearchPanel'
import { FileEditor } from './FileEditor'
import type { FileEditorHandle } from './FileEditor'
import type { FileLocation } from './fileLocation'
import { FileQuickOpen } from './FileQuickOpen'
import { GitPanel } from './GitPanel'
import { MaterialFileIcon } from './MaterialFileIcon'
import { MobileKeyToolbar } from './MobileKeyToolbar'
import { PaneCanvas } from './PaneCanvas'
import type { PaneContentRendererMap } from './PaneCanvas'
import {
  addContentToLeaf,
  allocateTerminalContent,
  closeTab,
  countUntitledContents,
  createDefaultLayout,
  createExplorerContent,
  createFileContent,
  createGitContent,
  createGitDiffContent,
  createUntitledContent,
  deserializeLayout,
  findContent,
  findLeafForContent,
  findPane,
  firstLeafId,
  focusPane,
  moveTab,
  selectTabInTree,
  splitLeaf,
} from './paneTree'
import type {
  DropZone,
  FileContent,
  GitDiffTarget,
  LeafPane,
  PaneContent,
  PaneNode,
  SplitDirection,
  WorktreeLayout,
} from './paneTree'
import { GitDiffPane, gitDiffLabel } from './GitDiffPane'
import { ShellSidebar } from './ShellSidebar'
import { Terminal, type TerminalHandle } from './Terminal'
import { TerminalExplorer } from './TerminalExplorer'
import { UnsavedChangesDialog } from './UnsavedChangesDialog'
import { UntitledFileEditor } from './UntitledFileEditor'

interface Props {
  worktree: Worktree
  wsId: string
  projectId: string
  /** Whether this tile is the workspace's currently focused leaf — gates the
   *  window-level keyboard shortcuts below so pressing e.g. Ctrl+P with two
   *  tiles open side by side only opens quick-open in the one the user is
   *  actually in, not both. */
  isFocused: boolean
  onPrimaryExit?: () => void
}

function basename(path: string) {
  return path.split('/').pop() ?? path
}

/** Safely larger than any real line's length — see openAtLine's doc comment. */
const LINE_END_CHAR_OFFSET = 1_000_000

/** Matches the existing platform sniff in `WorkspaceTileCanvas.tsx`'s `primaryShortcutLabel`. */
const IS_APPLE_PLATFORM = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)

function isDeletedPath(filePath: string, deletedPath: string) {
  return filePath === deletedPath || filePath.startsWith(`${deletedPath}/`)
}

function fileTabsUnderDeletedPaths(node: PaneNode, deletedPaths: readonly string[]): string[] {
  if (node.type === 'leaf') {
    return node.tabs.flatMap((tab) => {
      if (tab.kind !== 'file') return []
      return deletedPaths.some((deletedPath) => isDeletedPath(tab.path, deletedPath)) ? [tab.path] : []
    })
  }
  return node.children.flatMap((child) => fileTabsUnderDeletedPaths(child, deletedPaths))
}

/** Mobile has no room for side-by-side splits (spec decision 10) — used to gate `PaneCanvas`'s drag-and-drop sensors. */
export function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  )
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)')
    const onChange = () => setIsDesktop(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return isDesktop
}

/** Pane header's flush-left toggle for this shell's own `ShellSidebar` (spec
 *  §2/§4) — `PaneCanvas`'s `paneLeadingContent` renders this only for the
 *  tree's first leaf, so a split shows exactly one, docked next to the
 *  sidebar it drives. Shared by `ExpandedTerminal` (worktree shells) and
 *  `SSHShellPane`, the same way `OverflowItem`/`useIsDesktop` above are. */
export function ShellSidebarToggle({ shellKey }: { shellKey: string }) {
  const open = useDevDeckStore((s) => shellSidebarState(s.shellSidebars, shellKey).open)
  const setShellSidebarOpen = useDevDeckStore((s) => s.setShellSidebarOpen)
  const shortcut = IS_APPLE_PLATFORM ? '⌘B' : 'Ctrl+B'
  return (
    <div className="flex flex-none items-center gap-1 px-1.5">
      <button
        type="button"
        onClick={() => setShellSidebarOpen(shellKey, !open)}
        title={`Toggle sidebar (${shortcut})`}
        aria-label="Toggle sidebar"
        className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
      >
        {open ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
      </button>
    </div>
  )
}

const overflowItemClass =
  'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left font-mono text-[11.5px] text-devdeck-fg-2 hover:bg-devdeck-hover-wash'

export function OverflowItem({
  onClick,
  danger,
  children,
}: {
  onClick: () => void
  danger?: boolean
  children: ReactNode
}) {
  return (
    <Popover.Close
      onClick={onClick}
      className={cn(overflowItemClass, danger && 'text-devdeck-red-soft hover:bg-devdeck-red-tint-hover')}
    >
      {children}
    </Popover.Close>
  )
}

export function ExpandedTerminal({ worktree: w, wsId, projectId, isFocused, onPrimaryExit }: Props) {
  const project = useWorkspace(wsId).data?.projects.find((candidate) => candidate.id === projectId)
  const machines = useMachines().data
  const machine = machines?.find((m) => m.id === project?.machineId)

  if (!machine) {
    return (
      <div className="flex flex-1 items-center justify-center font-mono text-sm text-devdeck-dim">
        no machine assigned to this project — add one from the Machines page
      </div>
    )
  }

  // Keyed by worktree id so switching worktrees (which doesn't itself
  // unmount ExpandedTerminal — the route only updates params) resets every
  // per-worktree local state (dirty files, quick-open, ctrl-armed, the
  // terminal-handle map) instead of leaking it across worktrees.
  return (
    <TerminalWorkspace
      key={w.id}
      worktree={w}
      machine={machine}
      projectName={project?.name}
      label={worktreeLabel(project, w)}
      isFocused={isFocused}
      onPrimaryExit={onPrimaryExit}
    />
  )
}

function TerminalWorkspace({
  worktree,
  machine,
  projectName,
  label,
  isFocused,
  onPrimaryExit,
}: {
  worktree: Worktree
  machine: Machine
  projectName?: string
  label: string
  isFocused: boolean
  onPrimaryExit?: () => void
}) {
  const termHandles = useRef(new Map<string, TerminalHandle>())
  const fileHandles = useRef(new Map<string, FileEditorHandle>())
  const definitionRequest = useRef(0)
  // `WorkspaceTileCanvas`'s `TileLeafView` keeps every open worktree tab mounted
  // (CSS `hidden`, not unmounted) so switching tabs doesn't lose PTY/editor state —
  // meaning every open worktree tab's `TerminalWorkspace` has its own global keydown
  // listener below live at once. Without checking visibility, Cmd/Ctrl+T pressed while
  // looking at a *different* tab (another worktree, Agents, Browser) would silently
  // spawn a new terminal + PTY in a background worktree the user isn't even looking at.
  const containerRef = useRef<HTMLDivElement>(null)
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [contentSearch, setContentSearch] = useState(false)
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(() => new Set())
  const dirtyFilesRef = useRef(dirtyFiles)
  useEffect(() => {
    dirtyFilesRef.current = dirtyFiles
  }, [dirtyFiles])
  const isPathDirty = useCallback((path: string) => dirtyFilesRef.current.has(path), [])
  const [definitionReveals, setDefinitionReveals] = useState<Record<string, DefinitionReveal>>({})
  // Pending "close a dirty file/pane?" confirmation — contentId is null for a
  // whole-pane close (Save saves every dirty tab in the pane at once).
  const [closeConfirm, setCloseConfirm] = useState<{ paneId: string; contentId: string | null; paths: string[] } | null>(
    null,
  )
  const [closeConfirmSaving, setCloseConfirmSaving] = useState(false)
  const isDesktop = useIsDesktop()

  const openEdit = useDevDeckStore((s) => s.openEdit)
  const askDelete = useDevDeckStore((s) => s.askDelete)
  const setDirtyFileCount = useDevDeckStore((s) => s.setDirtyFileCount)
  const setWorktreeLayout = useDevDeckStore((s) => s.setWorktreeLayout)
  const setShellSidebarOpen = useDevDeckStore((s) => s.setShellSidebarOpen)
  const storedLayout = useDevDeckStore((s) => s.worktreeLayouts[worktree.id])
  const updateWorktree = useUpdateWorktree()
  const killTerminalSession = useKillTerminalSession(machine)

  // Per-shell sidebar (spec §1/§3) — keyed the same way for every worktree tab.
  const shellKey = `wt:${worktree.id}`

  const layout = useMemo(
    () => deserializeLayout(storedLayout) ?? createDefaultLayout(worktree.id),
    [storedLayout, worktree.id],
  )
  // `layout` gets a fresh reference on essentially any pane/tab action in this
  // worktree (every `setWorktreeLayout` call produces a new `storedLayout`).
  // `openFile`/`openDefinition` are handed down into `CodeFileEditor`'s
  // `languageExtensions` memo, which rebuilds the whole LSP extension set
  // (tearing down and recreating the live `LanguageServerPlugin`, resending
  // `textDocument/didOpen` at version 0) whenever that callback's identity
  // changes — so they must not depend on `layout` directly. Mirrors the
  // `dirtyFilesRef` pattern just above.
  const layoutRef = useRef(layout)
  useEffect(() => {
    layoutRef.current = layout
  }, [layout])

  function commitLayout(next: WorktreeLayout) {
    setWorktreeLayout(worktree.id, next)
  }

  // Closing a spawned Terminal pane's tab only removes it from the layout —
  // its PTY otherwise lingers for the reconnect grace period. The primary
  // pane (bare worktree id) is excluded: it backs the worktree itself, not
  // one pane's tab, and must survive other panes closing.
  function killIfSpawnedTerminal(content: PaneContent) {
    if (content.kind === 'terminal' && content.sessionKey !== worktree.id) {
      killTerminalSession.mutate(content.sessionKey)
    }
  }

  // Surfaced to `Sidebar`'s collapsed rail (`SidebarRail`) via the store — the
  // "back" button now lives outside this component entirely, so its dirty-file
  // confirm needs the count somewhere both sides can reach.
  useEffect(() => {
    setDirtyFileCount(dirtyFiles.size)
  }, [dirtyFiles.size, setDirtyFileCount])
  useEffect(() => () => setDirtyFileCount(0), [setDirtyFileCount])

  useEffect(() => {
    setCtrlArmed(false)
  }, [layout.focusedPaneId])

  useEffect(() => {
    if (dirtyFiles.size === 0) return
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirtyFiles.size])

  const cleanupFileBookkeeping = useCallback((path: string) => {
    setDirtyFiles((current) => {
      if (!current.has(path)) return current
      const next = new Set(current)
      next.delete(path)
      return next
    })
    setDefinitionReveals((current) => {
      if (!(path in current)) return current
      const next = { ...current }
      delete next[path]
      return next
    })
  }, [])

  const handleDirtyChange = useCallback((path: string, dirty: boolean) => {
    setDirtyFiles((current) => {
      const next = new Set(current)
      if (dirty) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const openFile = useCallback(
    (path: string) => {
      const current = layoutRef.current
      const existingLeaf = findLeafForContent(current.root, path)
      if (existingLeaf) {
        setWorktreeLayout(worktree.id, {
          ...current,
          root: selectTabInTree(current.root, existingLeaf.id, path),
          focusedPaneId: existingLeaf.id,
        })
        return
      }
      const targetPaneId = current.focusedPaneId
      setWorktreeLayout(worktree.id, {
        ...current,
        root: addContentToLeaf(current.root, targetPaneId, createFileContent(path)),
        focusedPaneId: targetPaneId,
      })
    },
    [worktree.id, setWorktreeLayout],
  )

  const openDefinition = useCallback(
    (path: string, target: DefinitionTarget) => {
      definitionRequest.current += 1
      setDefinitionReveals((current) => ({
        ...current,
        [path]: { ...target, requestId: definitionRequest.current },
      }))
      openFile(path)
    },
    [openFile],
  )

  /** Content search's "open at line" entry point (ContentSearchPanel's
   *  onOpenMatch) — reuses openDefinition's existing open+reveal mechanism
   *  (CodeFileEditor already knows how to scroll/select an arbitrary LSP
   *  range on open) instead of needing a parallel reveal system just for
   *  grep matches. `length <= 0` (span unknown) selects through the rest of
   *  the line — LINE_END_CHAR_OFFSET is larger than any real line, and
   *  CodeFileEditor's positionToOffset clamps a too-large character offset
   *  to the line's actual end. */
  const openAtLine = useCallback(
    (path: string, line: number, column: number, length: number) => {
      const zeroLine = Math.max(0, line - 1)
      const startChar = Math.max(0, column - 1)
      const endChar = length > 0 ? startChar + length : startChar + LINE_END_CHAR_OFFSET
      openDefinition(path, {
        range: { start: { line: zeroLine, character: startChar }, end: { line: zeroLine, character: endChar } },
      })
    },
    [openDefinition],
  )

  /** Quick-open's `path:line:column` entry point. Unlike `openAtLine` above
   *  this collapses the range to a caret: the user named a position, not a
   *  match, so selecting through to the end of the line would mean their first
   *  keystroke deletes the rest of it. */
  const openFileAt = useCallback(
    (path: string, location?: FileLocation) => {
      if (!location) {
        openFile(path)
        return
      }
      const position = {
        line: Math.max(0, location.line - 1),
        character: Math.max(0, (location.column ?? 1) - 1),
      }
      openDefinition(path, { range: { start: position, end: position } })
    },
    [openFile, openDefinition],
  )

  const handleFilesDeleted = useCallback(
    (paths: string[]) => {
      const filePaths = fileTabsUnderDeletedPaths(layout.root, paths)
      let nextLayout = layout
      let changed = false
      for (const path of filePaths) {
        cleanupFileBookkeeping(path)
        const leaf = findLeafForContent(nextLayout.root, path)
        if (!leaf) continue
        nextLayout = closeTab(nextLayout, leaf.id, path)
        changed = true
      }
      if (changed) setWorktreeLayout(worktree.id, nextLayout)
    },
    [layout, worktree.id, setWorktreeLayout, cleanupFileBookkeeping],
  )

  const handleFileDeleted = useCallback((path: string) => handleFilesDeleted([path]), [handleFilesDeleted])

  /** UntitledFileEditor's Save As completion — swaps the Untitled tab for a
   *  normal path-backed file tab in the same leaf it was opened in (falling
   *  back to wherever closeTab's own collapse logic refocused, on the rare
   *  chance the Untitled tab was that leaf's only tab). */
  const handleUntitledSaved = useCallback(
    (id: string, path: string) => {
      const leaf = findLeafForContent(layout.root, id)
      if (!leaf) return
      cleanupFileBookkeeping(id)
      const afterClose = closeTab(layout, leaf.id, id)
      const targetPaneId = findPane(afterClose.root, leaf.id) ? leaf.id : afterClose.focusedPaneId
      setWorktreeLayout(worktree.id, {
        ...afterClose,
        root: addContentToLeaf(afterClose.root, targetPaneId, createFileContent(path)),
        focusedPaneId: targetPaneId,
      })
    },
    [layout, worktree.id, setWorktreeLayout, cleanupFileBookkeeping],
  )

  function handleFocusPane(paneId: string) {
    commitLayout(focusPane(layout, paneId))
  }

  function handleSelectTab(paneId: string, contentId: string) {
    commitLayout({ ...layout, root: selectTabInTree(layout.root, paneId, contentId) })
  }

  function handleCloseTab(paneId: string, contentId: string) {
    const content = findContent(layout.root, contentId)
    if (content?.kind === 'file' && dirtyFiles.has(content.path)) {
      setCloseConfirm({ paneId, contentId, paths: [content.path] })
      return
    }
    finishCloseTab(paneId, contentId)
  }

  function finishCloseTab(paneId: string, contentId: string) {
    const content = findContent(layout.root, contentId)
    if (content?.kind === 'file') cleanupFileBookkeeping(content.path)
    if (content) killIfSpawnedTerminal(content)
    commitLayout(closeTab(layout, paneId, contentId))
  }

  function handleTerminalExit(sessionKey: string) {
    termHandles.current.delete(sessionKey)
    if (sessionKey === worktree.id) {
      onPrimaryExit?.()
      return
    }
    const current = deserializeLayout(useDevDeckStore.getState().worktreeLayouts[worktree.id]) ?? createDefaultLayout(worktree.id)
    const leaf = findLeafForContent(current.root, sessionKey)
    if (!leaf) return
    setWorktreeLayout(worktree.id, closeTab(current, leaf.id, sessionKey))
  }

  function handleClosePane(paneId: string) {
    const pane = findPane(layout.root, paneId)
    if (!pane || pane.type !== 'leaf') return
    const dirtyTabs = pane.tabs.filter((t): t is FileContent => t.kind === 'file' && dirtyFiles.has(t.path))
    if (dirtyTabs.length > 0) {
      setCloseConfirm({ paneId, contentId: null, paths: dirtyTabs.map((t) => t.path) })
      return
    }
    finishClosePane(paneId)
  }

  function finishClosePane(paneId: string) {
    const pane = findPane(layout.root, paneId)
    if (!pane || pane.type !== 'leaf') return
    let next = layout
    for (const tab of pane.tabs) {
      next = closeTab(next, paneId, tab.id)
      if (tab.kind === 'file') cleanupFileBookkeeping(tab.path)
      killIfSpawnedTerminal(tab)
    }
    commitLayout(next)
  }

  /** UnsavedChangesDialog's "Save" (or "Save All" for a pane) — saves every
   *  dirty path this close would affect, keeping the dialog open (so the
   *  operator can retry or cancel) if any write fails. */
  async function handleCloseConfirmSave() {
    if (!closeConfirm) return
    setCloseConfirmSaving(true)
    try {
      await Promise.all(closeConfirm.paths.map((path) => fileHandles.current.get(path)?.save()))
    } catch {
      setCloseConfirmSaving(false)
      return
    }
    setCloseConfirmSaving(false)
    const { paneId, contentId } = closeConfirm
    setCloseConfirm(null)
    if (contentId) finishCloseTab(paneId, contentId)
    else finishClosePane(paneId)
  }

  function handleCloseConfirmDiscard() {
    if (!closeConfirm) return
    const { paneId, contentId } = closeConfirm
    setCloseConfirm(null)
    if (contentId) finishCloseTab(paneId, contentId)
    else finishClosePane(paneId)
  }

  function handleCloseConfirmCancel() {
    setCloseConfirmSaving(false)
    setCloseConfirm(null)
  }

  function handleSplitPane(paneId: string, direction: SplitDirection) {
    const pane = findPane(layout.root, paneId)
    if (!pane || pane.type !== 'leaf') return
    const active = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0]
    if (!active) return
    if (active.kind === 'terminal') {
      const allocated = allocateTerminalContent(layout, worktree.id)
      commitLayout(splitLeaf(allocated.layout, paneId, direction, allocated.content))
    } else if (active.kind === 'git') {
      commitLayout(splitLeaf(layout, paneId, direction, createGitContent()))
    } else if (active.kind === 'explorer') {
      commitLayout(splitLeaf(layout, paneId, direction, createExplorerContent()))
    } else {
      // FileContent.id always equals its path (one instance per open path) — a second
      // FileContent for the same path would collide on id, so "split" relocates the tab
      // into the new sibling pane instead of duplicating it. No-op if this pane's only
      // tab is the file being split (nothing left to split into a second pane).
      const zone: DropZone = direction === 'row' ? 'right' : 'bottom'
      const root = moveTab(layout.root, paneId, paneId, active.id, zone)
      if (root !== layout.root) commitLayout({ ...layout, root })
    }
  }

  function handleTreeChange(root: PaneNode) {
    const focusedPaneId = findPane(root, layout.focusedPaneId) ? layout.focusedPaneId : (firstLeafId(root) ?? layout.focusedPaneId)
    commitLayout({ ...layout, root, focusedPaneId })
  }

  /** Fills the gap left by removing the old always-on Git tab / always-on
   *  Explorer sidebar: since "split" only ever duplicates the active tab's
   *  own kind, a fresh worktree (single Terminal leaf) would otherwise never
   *  be able to reach a Git or Explorer pane at all. Adds one to (or
   *  refocuses one already in) the currently focused pane. */
  function openKindInFocusedPane(kind: 'git' | 'explorer') {
    const pane = findPane(layout.root, layout.focusedPaneId)
    if (pane && pane.type === 'leaf') {
      const existing = pane.tabs.find((t) => t.kind === kind)
      if (existing) {
        if (existing.id !== pane.activeTabId) {
          commitLayout({ ...layout, root: selectTabInTree(layout.root, pane.id, existing.id) })
        }
        return
      }
    }
    const content = kind === 'git' ? createGitContent() : createExplorerContent()
    commitLayout({
      ...layout,
      root: addContentToLeaf(layout.root, layout.focusedPaneId, content),
      focusedPaneId: layout.focusedPaneId,
    })
  }

  /** Opens one file's (or commit's) diff as its own pane tab, refocusing the
   *  existing tab when that same target is already open — `createGitDiffContent`
   *  ids by target key, so `findLeafForContent` finds it the same way `openFile`
   *  finds an already-open path. */
  const openGitDiff = useCallback(
    (target: GitDiffTarget) => {
      const current = layoutRef.current
      const content = createGitDiffContent(target, gitDiffLabel(target))
      const existingLeaf = findLeafForContent(current.root, content.id)
      if (existingLeaf) {
        setWorktreeLayout(worktree.id, {
          ...current,
          root: selectTabInTree(current.root, existingLeaf.id, content.id),
          focusedPaneId: existingLeaf.id,
        })
        return
      }
      setWorktreeLayout(worktree.id, {
        ...current,
        root: addContentToLeaf(current.root, current.focusedPaneId, content),
        focusedPaneId: current.focusedPaneId,
      })
    },
    [worktree.id, setWorktreeLayout],
  )

  /** Cmd/Ctrl+G / Cmd/Ctrl+E — opens (or refocuses) the Git/Explorer tab in the
   *  focused pane, or closes it if it's already the focused pane's active tab. */
  function toggleKindInFocusedPane(kind: 'git' | 'explorer') {
    const pane = findPane(layout.root, layout.focusedPaneId)
    if (pane && pane.type === 'leaf') {
      const existing = pane.tabs.find((t) => t.kind === kind)
      if (existing && existing.id === pane.activeTabId) {
        handleCloseTab(pane.id, existing.id)
        return
      }
    }
    openKindInFocusedPane(kind)
  }

  /** "+" new-tab button / `Ctrl+T` — adds a brand-new independent Terminal tab to `paneId`'s
   *  own tab strip (unlike `handleSplitPane`, this never creates a sibling pane). */
  function handleNewTerminalTab(paneId: string) {
    const allocated = allocateTerminalContent(layout, worktree.id)
    commitLayout({
      ...allocated.layout,
      root: addContentToLeaf(allocated.layout.root, paneId, allocated.content),
      focusedPaneId: paneId,
    })
  }

  /** "+" new-tab button's "Open File..." action — focuses `paneId` first so the file quick-open
   *  (which always targets `layout.focusedPaneId`) lands in the pane the user actually clicked. */
  function handleNewFileTab(paneId: string) {
    if (paneId !== layout.focusedPaneId) commitLayout(focusPane(layout, paneId))
    setQuickOpen(true)
  }

  /** "+" new-tab button's "New File" action — opens a blank Untitled buffer
   *  immediately, no path required until the user actually saves it (VS
   *  Code's Cmd+N), unlike "Open File..." above which picks an existing path
   *  up front. */
  function handleNewUntitledTab(paneId: string) {
    const content = createUntitledContent(`Untitled-${countUntitledContents(layout.root) + 1}`)
    commitLayout({
      ...layout,
      root: addContentToLeaf(layout.root, paneId, content),
      focusedPaneId: paneId,
    })
  }

  function approve(ok: boolean) {
    updateWorktree.mutate({
      machine,
      id: worktree.id,
      patch: ok
        ? { state: 'running', pending: null, appendLine: { k: 'ok', t: '✓ approved — continuing' } }
        : { state: 'idle', pending: null, appendLine: { k: 'err', t: '✗ rejected by user — halted' } },
    })
  }

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      // `isFocused` is false when another tile is the one the user's actually
      // in (two tiles can be visible side by side) — ignore the shortcut then.
      // `offsetParent` is `null` when this tab (or an ancestor) is `display:none` —
      // i.e. some other tab within *this* tile is the one currently on screen.
      if (!isFocused || containerRef.current?.offsetParent === null) return
      const primary = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (primary && key === 'p') {
        event.preventDefault()
        setQuickOpen(true)
        return
      }
      if (primary && event.shiftKey && key === 'f') {
        event.preventDefault()
        setContentSearch(true)
        return
      }
      if (primary && key === 't') {
        event.preventDefault()
        handleNewTerminalTab(layout.focusedPaneId)
        return
      }
      if (primary && key === 'w') {
        const pane = findPane(layout.root, layout.focusedPaneId)
        if (!pane || pane.type !== 'leaf') return
        const active = pane.tabs.find((t) => t.id === pane.activeTabId)
        if (!active) return
        event.preventDefault()
        handleCloseTab(pane.id, active.id)
        return
      }
      if (primary && key === 'g') {
        event.preventDefault()
        toggleKindInFocusedPane('git')
        return
      }
      if (primary && key === 'e') {
        event.preventDefault()
        toggleKindInFocusedPane('explorer')
        return
      }
      if (primary && key === 'b') {
        event.preventDefault()
        const isOpen = shellSidebarState(useDevDeckStore.getState().shellSidebars, shellKey).open
        setShellSidebarOpen(shellKey, !isOpen)
        return
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [layout, dirtyFiles, isFocused, shellKey, setShellSidebarOpen])

  const focusedPane = findPane(layout.root, layout.focusedPaneId)
  const focusedActiveContent =
    focusedPane && focusedPane.type === 'leaf'
      ? focusedPane.tabs.find((t) => t.id === focusedPane.activeTabId)
      : undefined
  const focusedTerminalSessionKey =
    focusedActiveContent && focusedActiveContent.kind === 'terminal' ? focusedActiveContent.sessionKey : undefined

  function sendKey(data: string) {
    if (!focusedTerminalSessionKey) return
    const handle = termHandles.current.get(focusedTerminalSessionKey)
    handle?.sendInput(data)
    handle?.focus()
  }

  function tabIcon(content: PaneContent): ReactNode {
    if (content.kind === 'terminal') return <TerminalSquare size={13} className="text-devdeck-accent" />
    if (content.kind === 'git') return <GitBranch size={13} className="text-devdeck-accent" />
    if (content.kind === 'git-diff') return <GitCompare size={13} className="text-devdeck-accent" />
    if (content.kind === 'explorer') return <FolderTree size={13} className="text-devdeck-accent" />
    if (content.kind === 'untitled') return <FileText size={13} className="text-devdeck-dim" />
    return <MaterialFileIcon name={basename(content.path)} size={13} />
  }

  function isTabDirty(content: PaneContent) {
    if (content.kind === 'file') return dirtyFiles.has(content.path)
    if (content.kind === 'untitled') return dirtyFiles.has(content.id)
    return false
  }


  function renderOverflowActions() {
    return (
      <div className="flex min-w-[168px] flex-col gap-0.5">
        {worktree.state === 'waiting' ? (
          <OverflowItem onClick={() => approve(true)}>
            <Check size={13} />
            Approve
          </OverflowItem>
        ) : null}
        <OverflowItem onClick={() => openKindInFocusedPane('git')}>
          <GitBranch size={13} />
          Open Git panel
        </OverflowItem>
        <OverflowItem onClick={() => openKindInFocusedPane('explorer')}>
          <FolderTree size={13} />
          Open file explorer
        </OverflowItem>
        <OverflowItem
          onClick={() => openEdit('worktree', worktree.id, { a: worktree.branch, b: worktree.task, model: worktree.model })}
        >
          <Settings2 size={13} />
          Details
        </OverflowItem>
        <OverflowItem danger onClick={() => askDelete('worktree', worktree.id, label)}>
          <Trash2 size={13} />
          Delete
        </OverflowItem>
      </div>
    )
  }

  function renderNewTabActions(pane: LeafPane) {
    return (
      <div className="flex min-w-[168px] flex-col gap-0.5">
        <OverflowItem onClick={() => handleNewTerminalTab(pane.id)}>
          <TerminalSquare size={13} />
          New Terminal
        </OverflowItem>
        <OverflowItem onClick={() => handleNewUntitledTab(pane.id)}>
          <FilePlus2 size={13} />
          New File
        </OverflowItem>
        <OverflowItem onClick={() => handleNewFileTab(pane.id)}>
          <FilePlus size={13} />
          Open File…
        </OverflowItem>
      </div>
    )
  }

  const renderers: PaneContentRendererMap = {
    terminal: ({ content }) => {
      if (content.kind !== 'terminal') return null
      const isFocusedTerminal = content.sessionKey === focusedTerminalSessionKey
      return (
        <div className="h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden bg-devdeck-terminal px-3 py-2">
          <Terminal
            key={content.sessionKey}
            ref={(handle) => {
              if (handle) termHandles.current.set(content.sessionKey, handle)
              else termHandles.current.delete(content.sessionKey)
            }}
            session={content.sessionKey}
            machine={machine}
            ctrlArmed={ctrlArmed && isFocusedTerminal}
            onCtrlConsumed={() => setCtrlArmed(false)}
            onExit={() => handleTerminalExit(content.sessionKey)}
          />
        </div>
      )
    },
    git: ({ isActive }) => <GitPanel worktreeId={worktree.id} machine={machine} active={isActive} shellKey={shellKey} />,
    'git-diff': ({ content }) => {
      if (content.kind !== 'git-diff') return null
      return <GitDiffPane worktreeId={worktree.id} machine={machine} target={content.target} />
    },
    file: ({ content, isActive }) => {
      if (content.kind !== 'file') return null
      return (
        <FileEditor
          ref={(handle) => {
            if (handle) fileHandles.current.set(content.path, handle)
            else fileHandles.current.delete(content.path)
          }}
          worktreeId={worktree.id}
          machine={machine}
          path={content.path}
          active={isActive}
          onDirtyChange={handleDirtyChange}
          onDeleted={handleFileDeleted}
          onOpenDefinition={openDefinition}
          isPathDirty={isPathDirty}
          reveal={definitionReveals[content.path]}
        />
      )
    },
    explorer: () => (
      <TerminalExplorer
        shellKey={shellKey}
        target={{ kind: 'worktree', machine, worktreeId: worktree.id }}
        rootLabel={projectName ?? label}
        onOpenFile={openFile}
        onFileDeleted={handleFilesDeleted}
        onRequestQuickOpen={() => setQuickOpen(true)}
        onRequestContentSearch={() => setContentSearch(true)}
        contentSearchShortcut="Ctrl Shift F"
      />
    ),
    untitled: ({ content, isActive }) => {
      if (content.kind !== 'untitled') return null
      return (
        <UntitledFileEditor
          target={{ kind: 'worktree', machine, worktreeId: worktree.id }}
          contentId={content.id}
          label={content.label}
          active={isActive}
          onDirtyChange={handleDirtyChange}
          onSaved={handleUntitledSaved}
        />
      )
    },
  }

  // Only the tree's first leaf (document order) gets the toggle — a split
  // shows exactly one, adjacent to the sidebar it controls (spec §4).
  const firstPaneId = firstLeafId(layout.root)

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 bg-devdeck-terminal">
      <ShellSidebar
        shellKey={shellKey}
        target={{ kind: 'worktree', machine, worktreeId: worktree.id }}
        rootLabel={projectName ?? label}
        git={{ worktreeId: worktree.id, machine }}
        onOpenGitDiff={openGitDiff}
        onOpenFile={openFile}
        onFileDeleted={handleFilesDeleted}
        onRequestQuickOpen={() => setQuickOpen(true)}
        onRequestContentSearch={() => setContentSearch(true)}
        contentSearchShortcut="Ctrl Shift F"
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PaneCanvas
          root={layout.root}
          focusedPaneId={layout.focusedPaneId}
          renderers={renderers}
          onTreeChange={handleTreeChange}
          onFocusPane={handleFocusPane}
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
          onSplitPane={handleSplitPane}
          onClosePane={handleClosePane}
          tabIcon={tabIcon}
          isTabDirty={isTabDirty}
          paneLeadingContent={(pane) => (pane.id === firstPaneId ? <ShellSidebarToggle shellKey={shellKey} /> : null)}
          paneOverflowActions={renderOverflowActions}
          paneNewTabActions={renderNewTabActions}
          dragEnabled={isDesktop}
        />

        {focusedTerminalSessionKey ? (
          <MobileKeyToolbar ctrlArmed={ctrlArmed} onToggleCtrl={() => setCtrlArmed((armed) => !armed)} onSend={sendKey} />
        ) : null}

        <FileQuickOpen
          open={quickOpen}
          target={{ kind: 'worktree', machine, worktreeId: worktree.id }}
          onClose={() => setQuickOpen(false)}
          onOpenFile={openFileAt}
        />

        <ContentSearchPanel
          open={contentSearch}
          target={{ kind: 'worktree', machine, worktreeId: worktree.id }}
          onClose={() => setContentSearch(false)}
          onOpenMatch={openAtLine}
        />

        <UnsavedChangesDialog
          open={closeConfirm !== null}
          names={closeConfirm ? closeConfirm.paths.map(basename) : []}
          saving={closeConfirmSaving}
          onSave={() => void handleCloseConfirmSave()}
          onDiscard={handleCloseConfirmDiscard}
          onCancel={handleCloseConfirmCancel}
        />
      </div>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { FolderTree, TerminalSquare } from 'lucide-react'
import { useSSHConnections } from '@/features/data/queries'
import { shellSidebarState, useDevDeckStore } from '@/store/useDevDeckStore'
import { OverflowItem, ShellSidebarToggle, useIsDesktop } from '@/features/terminal/ExpandedTerminal'
import { MaterialFileIcon } from '@/features/terminal/MaterialFileIcon'
import { PaneCanvas } from '@/features/terminal/PaneCanvas'
import type { PaneContentRendererMap } from '@/features/terminal/PaneCanvas'
import {
  addContentToLeaf,
  allocateTerminalContent,
  closeTab,
  createDefaultLayout,
  createExplorerContent,
  createFileContent,
  deserializeLayout,
  findContent,
  findLeafForContent,
  findPane,
  firstLeafId,
  focusPane,
  moveTab,
  selectTabInTree,
  splitLeaf,
} from '@/features/terminal/paneTree'
import type { DropZone, FileContent, LeafPane, PaneContent, PaneNode, SplitDirection, WorktreeLayout } from '@/features/terminal/paneTree'
import { TerminalExplorer } from '@/features/terminal/TerminalExplorer'
import { SSHFileEditor } from '@/features/terminal/SSHFileEditor'
import type { SSHFileEditorHandle } from '@/features/terminal/SSHFileEditor'
import type { FileLocation } from '@/features/terminal/fileLocation'
import { FileQuickOpen } from '@/features/terminal/FileQuickOpen'
import { ContentSearchPanel } from '@/features/terminal/ContentSearchPanel'
import type { LineReveal } from '@/features/terminal/PlainCodeEditor'
import { UnsavedChangesDialog } from '@/features/terminal/UnsavedChangesDialog'
import { ShellSidebar } from '@/features/terminal/ShellSidebar'
import { SSHTerminal } from './SSHTerminal'
import { disposeSSHSession } from './sshTerminalRegistry'

function basename(path: string) {
  return path.split('/').pop() ?? path
}

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

/**
 * Tile body for the 'ssh-shell' tab kind — a scaled-down TerminalWorkspace
 * (ExpandedTerminal.tsx): Terminal + Explorer + File panes on the same
 * PaneCanvas tiling engine, minus everything that's specifically about a
 * local worktree checkout (Git panel, LSP-backed file editing, worktree
 * mutations). File edits go over SFTP via SSHFileEditor instead of
 * FileEditor; file quick-open (Ctrl/Cmd+P) works the same as the worktree
 * side, backed by the SSH FilesTarget.
 */
export function SSHShellPane({
  connectionId,
  isFocused,
}: {
  connectionId: string
  /** Whether this tile is the workspace's currently focused leaf — gates the
   *  window-level keyboard shortcuts below so pressing e.g. Ctrl+P with two
   *  tiles open side by side only opens quick-open in the one the user is
   *  actually in, not both. */
  isFocused: boolean
}) {
  const connections = useSSHConnections().data ?? []
  const connection = connections.find((c) => c.id === connectionId)

  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(() => new Set())
  const [quickOpen, setQuickOpen] = useState(false)
  const [contentSearch, setContentSearch] = useState(false)
  const [lineReveals, setLineReveals] = useState<Record<string, LineReveal>>({})
  // Pending "close a dirty file/pane?" confirmation — contentId is null for a
  // whole-pane close (Save saves every dirty tab in the pane at once).
  const [closeConfirm, setCloseConfirm] = useState<{ paneId: string; contentId: string | null; paths: string[] } | null>(
    null,
  )
  const [closeConfirmSaving, setCloseConfirmSaving] = useState(false)
  const revealRequest = useRef(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const fileHandles = useRef(new Map<string, SSHFileEditorHandle>())
  const isDesktop = useIsDesktop()

  const setDirtyFileCount = useDevDeckStore((s) => s.setDirtyFileCount)
  const setSSHTileLayout = useDevDeckStore((s) => s.setSSHTileLayout)
  const setShellSidebarOpen = useDevDeckStore((s) => s.setShellSidebarOpen)
  const storedLayout = useDevDeckStore((s) => s.sshTileLayouts[connectionId])

  // Per-shell sidebar (spec §1/§3) — keyed the same way for every SSH shell tab.
  const shellKey = `ssh:${connectionId}`

  const layout = useMemo(
    () => deserializeLayout(storedLayout) ?? createDefaultLayout(connectionId),
    [storedLayout, connectionId],
  )

  function commitLayout(next: WorktreeLayout) {
    setSSHTileLayout(connectionId, next)
  }

  // Real teardown for every live session still in this tree happens in the
  // caller (`WorkspaceTileArea`'s `handleCloseTab`), triggered explicitly by
  // the tab actually closing — NOT by this component unmounting. A
  // drag-to-split/relocate of the outer ssh-shell tab (`moveTileTab` always
  // allocates a fresh leaf id) also unmounts this component as a pure view
  // change, which must not tear down the live sessions it doesn't own.

  useEffect(() => {
    setDirtyFileCount(dirtyFiles.size)
  }, [dirtyFiles.size, setDirtyFileCount])
  useEffect(() => () => setDirtyFileCount(0), [setDirtyFileCount])

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
    setLineReveals((current) => {
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
      const existingLeaf = findLeafForContent(layout.root, path)
      if (existingLeaf) {
        commitLayout({
          ...layout,
          root: selectTabInTree(layout.root, existingLeaf.id, path),
          focusedPaneId: existingLeaf.id,
        })
        return
      }
      const targetPaneId = layout.focusedPaneId
      commitLayout({
        ...layout,
        root: addContentToLeaf(layout.root, targetPaneId, createFileContent(path)),
        focusedPaneId: targetPaneId,
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, connectionId],
  )

  /** Content search's "open at line" entry point (ContentSearchPanel's
   *  onOpenMatch). Unlike the worktree side (ExpandedTerminal.tsx's
   *  openAtLine, which reuses CodeFileEditor's existing LSP reveal), SSH
   *  files render PlainCodeEditor with no LSP reveal mechanism, so this
   *  tracks a small requestId-keyed LineReveal map instead — see
   *  PlainCodeEditor.tsx's LineReveal doc comment. */
  const openAtLine = useCallback(
    (path: string, line: number, column: number, length: number) => {
      revealRequest.current += 1
      setLineReveals((current) => ({ ...current, [path]: { line, column, length, requestId: revealRequest.current } }))
      openFile(path)
    },
    [openFile],
  )

  /** Quick-open's `path:line:column` entry point. The SSH reveal is already a
   *  bare caret (PlainCodeEditor has no match-selection concept), so this is
   *  `openAtLine` with a zero-length span. */
  const openFileAt = useCallback(
    (path: string, location?: FileLocation) => {
      if (!location) {
        openFile(path)
        return
      }
      openAtLine(path, location.line, location.column ?? 1, 0)
    },
    [openFile, openAtLine],
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
      if (changed) commitLayout(nextLayout)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, connectionId, cleanupFileBookkeeping],
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
    if (content?.kind === 'terminal') disposeSSHSession(content.sessionKey)
    commitLayout(closeTab(layout, paneId, contentId))
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
      if (tab.kind === 'terminal') disposeSSHSession(tab.sessionKey)
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
      const allocated = allocateTerminalContent(layout, connectionId)
      commitLayout(splitLeaf(allocated.layout, paneId, direction, allocated.content))
    } else if (active.kind === 'explorer') {
      commitLayout(splitLeaf(layout, paneId, direction, createExplorerContent()))
    } else if (active.kind === 'file') {
      const zone: DropZone = direction === 'row' ? 'right' : 'bottom'
      const root = moveTab(layout.root, paneId, paneId, active.id, zone)
      if (root !== layout.root) commitLayout({ ...layout, root })
    }
  }

  function handleTreeChange(root: PaneNode) {
    const focusedPaneId = findPane(root, layout.focusedPaneId) ? layout.focusedPaneId : (firstLeafId(root) ?? layout.focusedPaneId)
    commitLayout({ ...layout, root, focusedPaneId })
  }

  /** Fills the gap left by a fresh shell (single Terminal leaf) that would
   *  otherwise never reach an Explorer pane — "split" only ever duplicates
   *  the active tab's own kind. Adds one to (or refocuses one already in)
   *  the currently focused pane. */
  function openExplorerInFocusedPane() {
    const pane = findPane(layout.root, layout.focusedPaneId)
    if (pane && pane.type === 'leaf') {
      const existing = pane.tabs.find((t) => t.kind === 'explorer')
      if (existing) {
        if (existing.id !== pane.activeTabId) {
          commitLayout({ ...layout, root: selectTabInTree(layout.root, pane.id, existing.id) })
        }
        return
      }
    }
    commitLayout({
      ...layout,
      root: addContentToLeaf(layout.root, layout.focusedPaneId, createExplorerContent()),
      focusedPaneId: layout.focusedPaneId,
    })
  }

  function toggleExplorerInFocusedPane() {
    const pane = findPane(layout.root, layout.focusedPaneId)
    if (pane && pane.type === 'leaf') {
      const existing = pane.tabs.find((t) => t.kind === 'explorer')
      if (existing && existing.id === pane.activeTabId) {
        handleCloseTab(pane.id, existing.id)
        return
      }
    }
    openExplorerInFocusedPane()
  }

  function handleNewTerminalTab(paneId: string) {
    const allocated = allocateTerminalContent(layout, connectionId)
    commitLayout({
      ...allocated.layout,
      root: addContentToLeaf(allocated.layout.root, paneId, allocated.content),
      focusedPaneId: paneId,
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
      // Deliberately no Ctrl/Cmd+Shift+F binding here, unlike the worktree
      // pane (ExpandedTerminal.tsx): content search over SSH is reachable
      // only from the explorer's "Search in files" action, so the chord stays
      // free for the browser/OS while an SSH shell has focus. TerminalExplorer
      // is told not to advertise it either (contentSearchShortcut is omitted
      // in this file's renderers).
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
      if (primary && key === 'e') {
        event.preventDefault()
        toggleExplorerInFocusedPane()
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, dirtyFiles, isFocused, shellKey, setShellSidebarOpen])

  function tabIcon(content: PaneContent): ReactNode {
    if (content.kind === 'terminal') return <TerminalSquare size={13} className="text-devdeck-dim" />
    if (content.kind === 'explorer') return <FolderTree size={13} className="text-devdeck-dim" />
    if (content.kind === 'file') return <MaterialFileIcon name={basename(content.path)} size={13} />
    return null
  }

  function isTabDirty(content: PaneContent) {
    return content.kind === 'file' && dirtyFiles.has(content.path)
  }

  function renderOverflowActions() {
    return (
      <div className="flex min-w-[168px] flex-col gap-0.5">
        <OverflowItem onClick={openExplorerInFocusedPane}>
          <FolderTree size={13} />
          Open file explorer
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
      </div>
    )
  }

  const renderers: PaneContentRendererMap = {
    terminal: ({ content }) => {
      if (content.kind !== 'terminal') return null
      return (
        <div className="h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden bg-devdeck-terminal px-3 py-2">
          <SSHTerminal key={content.sessionKey} connectionId={connectionId} sessionKey={content.sessionKey} />
        </div>
      )
    },
    git: () => null,
    // No git over SSH, so neither the panel nor a diff tab can ever exist here.
    'git-diff': () => null,
    // No SSH UI path creates an 'untitled' tab yet (only the worktree pane's
    // "+" menu has "New File") — this satisfies PaneContentRendererMap's
    // exhaustiveness without dead-wiring an editor no user action can reach.
    untitled: () => null,
    // Task 8 supplies the real stats renderer; no UI path opens a 'stats'
    // tab here yet, so this satisfies PaneContentRendererMap's exhaustiveness.
    stats: () => null,
    file: ({ content, isActive }) => {
      if (content.kind !== 'file') return null
      return (
        <SSHFileEditor
          ref={(handle) => {
            if (handle) fileHandles.current.set(content.path, handle)
            else fileHandles.current.delete(content.path)
          }}
          connectionId={connectionId}
          path={content.path}
          active={isActive}
          onDirtyChange={handleDirtyChange}
          onDeleted={(path) => handleFilesDeleted([path])}
          reveal={lineReveals[content.path]}
        />
      )
    },
    explorer: () => (
      <TerminalExplorer
        shellKey={shellKey}
        target={{ kind: 'ssh', connectionId }}
        rootLabel={connection?.name ?? 'SSH'}
        onOpenFile={openFile}
        onFileDeleted={handleFilesDeleted}
        onRequestQuickOpen={() => setQuickOpen(true)}
        onRequestContentSearch={() => setContentSearch(true)}
      />
    ),
  }

  // Only the tree's first leaf (document order) gets the toggle — a split
  // shows exactly one, adjacent to the sidebar it controls (spec §4).
  const firstPaneId = firstLeafId(layout.root)

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 bg-devdeck-terminal">
      <ShellSidebar
        shellKey={shellKey}
        target={{ kind: 'ssh', connectionId }}
        rootLabel={connection?.name ?? 'SSH'}
        onOpenFile={openFile}
        onFileDeleted={handleFilesDeleted}
        onRequestQuickOpen={() => setQuickOpen(true)}
        onRequestContentSearch={() => setContentSearch(true)}
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

        <FileQuickOpen
          open={quickOpen}
          target={{ kind: 'ssh', connectionId }}
          onClose={() => setQuickOpen(false)}
          onOpenFile={openFileAt}
        />

        <ContentSearchPanel
          open={contentSearch}
          target={{ kind: 'ssh', connectionId }}
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

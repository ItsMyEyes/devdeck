import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { FolderTree, TerminalSquare } from 'lucide-react'
import { useSSHConnections } from '@/features/data/queries'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { OverflowItem, useIsDesktop } from '@/features/terminal/ExpandedTerminal'
import { MaterialFileIcon } from '@/features/terminal/MaterialFileIcon'
import { PaneCanvas } from '@/features/terminal/PaneCanvas'
import type { PaneContentRendererMap } from '@/features/terminal/PaneCanvas'
import {
  addContentToLeaf,
  allocateTerminalContent,
  closeTab,
  collectTerminalSessionKeys,
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
import type { DropZone, LeafPane, PaneContent, PaneNode, SplitDirection, WorktreeLayout } from '@/features/terminal/paneTree'
import { TerminalExplorer } from '@/features/terminal/TerminalExplorer'
import { SSHFileEditor } from '@/features/terminal/SSHFileEditor'
import { FileQuickOpen } from '@/features/terminal/FileQuickOpen'
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
export function SSHShellPane({ connectionId }: { connectionId: string }) {
  const connections = useSSHConnections().data ?? []
  const connection = connections.find((c) => c.id === connectionId)

  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(() => new Set())
  const [quickOpen, setQuickOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const isDesktop = useIsDesktop()

  const setDirtyFileCount = useDevDeckStore((s) => s.setDirtyFileCount)
  const setSSHTileLayout = useDevDeckStore((s) => s.setSSHTileLayout)
  const storedLayout = useDevDeckStore((s) => s.sshTileLayouts[connectionId])

  const layout = useMemo(
    () => deserializeLayout(storedLayout) ?? createDefaultLayout(connectionId),
    [storedLayout, connectionId],
  )

  function commitLayout(next: WorktreeLayout) {
    setSSHTileLayout(connectionId, next)
  }

  // Real teardown for every live session still in this tree, but only when
  // the whole SSH shell tab unmounts — not on every render, hence the ref
  // (closing over the latest layout without retriggering the effect).
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  useEffect(() => {
    return () => {
      collectTerminalSessionKeys(layoutRef.current.root).forEach(disposeSSHSession)
    }
  }, [])

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
    if (content?.kind === 'file') {
      if (dirtyFiles.has(content.path) && !window.confirm(`Close ${basename(content.path)} without saving?`)) return
      cleanupFileBookkeeping(content.path)
    }
    if (content?.kind === 'terminal') disposeSSHSession(content.sessionKey)
    commitLayout(closeTab(layout, paneId, contentId))
  }

  function handleClosePane(paneId: string) {
    const pane = findPane(layout.root, paneId)
    if (!pane || pane.type !== 'leaf') return
    const dirtyTabs = pane.tabs.filter((t) => t.kind === 'file' && dirtyFiles.has(t.path))
    if (dirtyTabs.length > 0 && !window.confirm(`Close this pane? ${dirtyTabs.length} file${dirtyTabs.length === 1 ? '' : 's'} unsaved.`))
      return
    let next = layout
    for (const tab of pane.tabs) {
      next = closeTab(next, paneId, tab.id)
      if (tab.kind === 'file') cleanupFileBookkeeping(tab.path)
      if (tab.kind === 'terminal') disposeSSHSession(tab.sessionKey)
    }
    commitLayout(next)
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
      if (containerRef.current?.offsetParent === null) return
      const primary = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (primary && key === 'p') {
        event.preventDefault()
        setQuickOpen(true)
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
      if (primary && key === 'e') {
        event.preventDefault()
        toggleExplorerInFocusedPane()
        return
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, dirtyFiles])

  function tabIcon(content: PaneContent): ReactNode {
    if (content.kind === 'terminal') return <TerminalSquare size={13} className="text-devdeck-accent" />
    if (content.kind === 'explorer') return <FolderTree size={13} className="text-devdeck-accent" />
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
    file: ({ content, isActive }) => {
      if (content.kind !== 'file') return null
      return (
        <SSHFileEditor
          connectionId={connectionId}
          path={content.path}
          active={isActive}
          onDirtyChange={handleDirtyChange}
          onDeleted={(path) => handleFilesDeleted([path])}
        />
      )
    },
    explorer: () => (
      <TerminalExplorer
        target={{ kind: 'ssh', connectionId }}
        rootLabel={connection?.name ?? 'SSH'}
        onOpenFile={openFile}
        onFileDeleted={handleFilesDeleted}
        onRequestQuickOpen={() => setQuickOpen(true)}
      />
    ),
  }

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col bg-devdeck-terminal">
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
        paneOverflowActions={renderOverflowActions}
        paneNewTabActions={renderNewTabActions}
        dragEnabled={isDesktop}
      />

      <FileQuickOpen
        open={quickOpen}
        target={{ kind: 'ssh', connectionId }}
        onClose={() => setQuickOpen(false)}
        onOpenFile={openFile}
      />
    </div>
  )
}

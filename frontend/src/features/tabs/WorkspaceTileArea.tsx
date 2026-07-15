import { useEffect } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { BrowserTile } from '@/features/browser/BrowserTile'
import { closeBrowserTile as closeNativeBrowserTile } from '@/features/browser/browserTilesBridge'
import { WorktreeCardsGrid } from '@/features/agents/WorktreeCardsGrid'
import { WorkspaceHostsView } from '@/features/agents/WorkspaceHostsView'
import { ExpandedTerminal } from '@/features/terminal/ExpandedTerminal'
import { collectTerminalSessionKeys, deserializeLayout } from '@/features/terminal/paneTree'
import { useMachines, useSSHConnections, useWorkspace } from '@/features/data/queries'
import { SSHShellPane } from '@/features/ssh/SSHShellPane'
import { STATE } from '@/lib/constants'
import { killTerminalSession } from '@/lib/machineApi'
import { worktreeLabel } from '@/lib/worktreeLabel'
import { useLoomStore } from '@/store/useLoomStore'
import { NewTabDialog } from './NewTabDialog'
import { WorkspaceTileCanvas } from './WorkspaceTileCanvas'
import { createDefaultTileLayout, findTileLeaf, findTileTab, firstLeafId, focusTileLeaf, selectTileTab } from './tileTree'
import type { TileTab, WorkspaceTileLayout } from './tileTree'
import type { BrowserTileTab, SSHShellTileTab, WorktreeTileTab } from './WorkspaceTileCanvas'

interface WorkspaceTileAreaProps {
  wsId: string
  /** `false` on non-tiled workspace routes (Machines, Tools, Invoices, ...)
   *  — the pinned tab strip still renders, but the tiling body doesn't, so
   *  `<Outlet/>` can take over the content area below it. Defaults to `true`. */
  showContent?: boolean
}

/** Wires `WorkspaceTileCanvas` to the store (persisted tiling tree) and the
 *  router (URL follows the focused leaf's active worktree). Supersedes the
 *  previously-shipped flat `TabBar` — a single leaf with no splits *is*
 *  what that looked like. */
export function WorkspaceTileArea({ wsId, showContent = true }: WorkspaceTileAreaProps) {
  const navigate = useNavigate()
  const { projectId: currentProjectId } = useParams({ strict: false }) as { projectId?: string }
  const layout = useLoomStore((s) => s.workspaceTileLayouts[wsId]) ?? createDefaultTileLayout()
  const setWorkspaceTileLayout = useLoomStore((s) => s.setWorkspaceTileLayout)
  const closeWorktreeTab = useLoomStore((s) => s.closeWorktreeTab)
  const pruneWorktreeTabs = useLoomStore((s) => s.pruneWorktreeTabs)
  const removeBrowserTile = useLoomStore((s) => s.removeBrowserTile)
  const openSpawn = useLoomStore((s) => s.openSpawn)
  const openNewTab = useLoomStore((s) => s.openNewTab)
  const openBrowserTab = useLoomStore((s) => s.openBrowserTab)
  const workspace = useWorkspace(wsId).data
  const worktrees = workspace ? workspace.projects.flatMap((p) => p.worktrees) : []
  const machines = useMachines().data ?? []
  const sshConnections = useSSHConnections().data ?? []
  const machinesById = new Map(machines.map((m) => [m.id, m]))
  const projectsById = new Map(workspace ? workspace.projects.map((p) => [p.id, p]) : [])

  function commit(next: WorkspaceTileLayout) {
    setWorkspaceTileLayout(wsId, next)
  }

  function navigateToTab(tab: TileTab) {
    if (tab.kind === 'worktree') {
      navigate({
        to: '/w/$wsId/p/$projectId/wt/$wtId',
        params: { wsId, projectId: tab.projectId, wtId: tab.wtId },
      })
    } else if (tab.kind === 'browser') {
      navigate({ to: '/w/$wsId/browser', params: { wsId } })
    } else {
      navigate({ to: '/w/$wsId', params: { wsId } })
    }
  }

  function handleCreateBrowser(machineId: string) {
    openBrowserTab(wsId, machineId)
    navigate({ to: '/w/$wsId/browser', params: { wsId } })
  }

  // Drop tabs for worktrees deleted while the app was closed (or by another tab).
  useEffect(() => {
    if (!workspace) return
    pruneWorktreeTabs(wsId, new Set(worktrees.map((w) => w.id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, wsId])

  function handleFocusLeaf(leafId: string) {
    const next = focusTileLeaf(layout, leafId)
    if (next === layout) return
    commit(next)
    const leaf = findTileLeaf(next.root, leafId)
    const activeTab = leaf?.type === 'leaf' ? leaf.tabs.find((t) => t.id === leaf.activeTabId) : undefined
    if (activeTab) navigateToTab(activeTab)
  }

  function handleSelectTab(leafId: string, tabId: string) {
    commit(selectTileTab(layout, leafId, tabId))
    const tab = findTileTab(layout.root, tabId)
    if (tab) navigateToTab(tab)
  }

  // Closing a 'browser' tab must tear down every native child webview it
  // owns (all internal docs, not just the active one) before the tile
  // itself is dropped from the tree — otherwise the Rust side leaks an
  // orphaned webview per doc, and `browserTiles[tabId]` dangles forever in
  // the store. `closeWorktreeTab` itself is id-based, not worktree-specific
  // (see tileTree.ts's `closeTileTab`), so it's reused as-is for the
  // generic tree removal regardless of tab kind.
  //
  // Closing a 'worktree' tab only drops it from this workspace's tab strip
  // — the worktree itself (and its primary terminal session) keeps running
  // so reopening it reattaches instead of respawning. Any *spawned* extra
  // Terminal panes inside it (ExpandedTerminal's "Terminal 2", ...) are
  // killed outright: unlike the primary session, they exist only as long as
  // their tab does, and ExpandedTerminal unmounting here bypasses its own
  // per-pane close handlers that would otherwise do this.
  async function handleCloseTab(_leafId: string, tabId: string) {
    const tab = findTileTab(layout.root, tabId)
    if (tab?.kind === 'browser') {
      const tile = useLoomStore.getState().browserTiles[tabId]
      if (tile) {
        await Promise.all(
          tile.docs.filter((d) => d.url).map((d) => closeNativeBrowserTile(tabId, d.id)),
        )
      }
      removeBrowserTile(tabId)
    }
    if (tab?.kind === 'worktree') {
      const project = projectsById.get(tab.projectId)
      const machine = project?.machineId ? machinesById.get(project.machineId) : undefined
      const storedLayout = useLoomStore.getState().worktreeLayouts[tab.wtId]
      const paneLayout = deserializeLayout(storedLayout)
      if (machine && paneLayout) {
        for (const sessionKey of collectTerminalSessionKeys(paneLayout.root)) {
          if (sessionKey !== tab.wtId) void killTerminalSession(machine, sessionKey).catch(() => {})
        }
      }
    }
    closeWorktreeTab(wsId, tabId)
    const next = useLoomStore.getState().workspaceTileLayouts[wsId]
    if (!next) return
    const leaf = findTileLeaf(next.root, next.focusedLeafId)
    const activeTab = leaf?.type === 'leaf' ? leaf.tabs.find((t) => t.id === leaf.activeTabId) : undefined
    if (activeTab) navigateToTab(activeTab)
  }

  function handleNewTab(leafId: string) {
    commit(focusTileLeaf(layout, leafId))
    openNewTab(wsId, leafId)
  }

  // `WorkspaceTileCanvas.onTreeChange` only ever hands back the new `root`
  // (used for both DnD-drop commits and divider-resize commits) — a drop
  // can collapse the currently-focused leaf away, so `focusedLeafId` is
  // recomputed here rather than carried over unchanged, mirroring how
  // `../terminal/ExpandedTerminal.tsx` commits `PaneCanvas`'s `onTreeChange`.
  function handleTreeChange(root: WorkspaceTileLayout['root']) {
    const focusedLeafId = findTileLeaf(root, layout.focusedLeafId)
      ? layout.focusedLeafId
      : (firstLeafId(root) ?? layout.focusedLeafId)
    commit({ ...layout, root, focusedLeafId })
  }

  function resolveWorktreeTab(tab: WorktreeTileTab) {
    const worktree = worktrees.find((w) => w.id === tab.wtId)
    if (!worktree) return undefined
    const st = STATE[worktree.state]
    const project = projectsById.get(tab.projectId)
    return {
      label: worktreeLabel(project, worktree),
      color: st.color,
    }
  }

  function resolveBrowserTab(tab: BrowserTileTab) {
    const tile = useLoomStore.getState().browserTiles[tab.id]
    const doc = tile?.docs.find((d) => d.id === tile.activeDocId)
    return { label: doc?.title ?? 'Web' }
  }

  function resolveSSHShellTab(tab: SSHShellTileTab) {
    const connection = sshConnections.find((c) => c.id === tab.connectionId)
    return { label: connection?.name ?? 'SSH' }
  }

  // Cmd/Ctrl+T opens the workspace tab chooser outside a visible worktree
  // terminal. Inside a worktree terminal, Cmd/Ctrl+T stays reserved for
  // TerminalWorkspace's own "new terminal" tab, so Cmd/Ctrl+O opens the
  // workspace tab chooser instead. Cmd/Ctrl+W closes the focused leaf's active
  // tab, except visible worktree terminals handle their own pane tab strip.
  // Cmd+Shift+[ / Cmd+Shift+] cycle the focused leaf's own tab strip.
  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      const primary = event.metaKey || event.ctrlKey
      if (!primary) return
      const leaf = findTileLeaf(layout.root, layout.focusedLeafId)
      if (!leaf || leaf.type !== 'leaf') return

      const activeTab = leaf.tabs.find((t) => t.id === leaf.activeTabId)
      const inTerminalWorkspace = showContent && activeTab?.kind === 'worktree'
      const key = event.key.toLowerCase()

      if ((key === 't' && !inTerminalWorkspace) || (key === 'o' && inTerminalWorkspace)) {
        event.preventDefault()
        handleNewTab(leaf.id)
        return
      }

      if (key === 'w') {
        if (leaf.activeTabId === 'agents') return
        event.preventDefault()
        if (!inTerminalWorkspace) handleCloseTab(leaf.id, leaf.activeTabId)
        return
      }

      if (!event.metaKey) return

      if (event.key === '[' || event.key === ']') {
        event.preventDefault()
        const idx = leaf.tabs.findIndex((t) => t.id === leaf.activeTabId)
        const delta = event.key === ']' ? 1 : -1
        const nextTab = leaf.tabs[(idx + delta + leaf.tabs.length) % leaf.tabs.length]
        if (nextTab) handleSelectTab(leaf.id, nextTab.id)
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, showContent])

  return (
    <>
      <WorkspaceTileCanvas
        root={layout.root}
        renderers={{
          agents: () => {
            if (!workspace) return null
            if (!currentProjectId) return <WorkspaceHostsView wsId={wsId} projects={workspace.projects} />
            const project = workspace.projects.find((p) => p.id === currentProjectId)
            if (!project) return null
            return <WorktreeCardsGrid project={project} wsId={wsId} />
          },
          worktree: ({ leafId, tab }) => {
            const worktree = worktrees.find((w) => w.id === tab.wtId)
            if (!worktree) return null
            return (
              <ExpandedTerminal
                worktree={worktree}
                wsId={wsId}
                projectId={tab.projectId}
                onPrimaryExit={() => void handleCloseTab(leafId, tab.id)}
              />
            )
          },
          browser: ({ tab }) => <BrowserTile tabId={tab.id} />,
          sshShell: ({ tab }) => <SSHShellPane connectionId={tab.connectionId} />,
        }}
        onTreeChange={handleTreeChange}
        onFocusLeaf={handleFocusLeaf}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onNewTab={handleNewTab}
        resolveWorktreeTab={resolveWorktreeTab}
        resolveBrowserTab={resolveBrowserTab}
        resolveSSHShellTab={resolveSSHShellTab}
        showContent={showContent}
        className="min-h-0"
      />
      <NewTabDialog
        wsId={wsId}
        projects={workspace?.projects ?? []}
        currentProjectId={currentProjectId}
        onCreateBrowser={handleCreateBrowser}
        onCreateShell={(projectId) => openSpawn(projectId, 'root')}
      />
    </>
  )
}

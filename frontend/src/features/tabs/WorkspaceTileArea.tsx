import { useEffect } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { BrowserTile } from '@/features/browser/BrowserTile'
import { closeBrowserTile as closeNativeBrowserTile } from '@/features/browser/browserTilesBridge'
import { WorktreeCardsGrid } from '@/features/agents/WorktreeCardsGrid'
import { WorkspaceHostsView } from '@/features/agents/WorkspaceHostsView'
import { ExpandedTerminal } from '@/features/terminal/ExpandedTerminal'
import { useMachines, useSSHConnections, useWorkspace } from '@/features/data/queries'
import { SSHShellPane } from '@/features/ssh/SSHShellPane'
import { disposeSSHSession } from '@/features/ssh/sshTerminalRegistry'
import { collectTerminalSessionKeys, deserializeLayout } from '@/features/terminal/paneTree'
import { worktreeTabLabel } from '@/lib/worktreeLabel'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { SSHQuickAddDialog } from '@/features/ssh/SSHQuickAddDialog'
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
  const layout = useDevDeckStore((s) => s.workspaceTileLayouts[wsId]) ?? createDefaultTileLayout()
  const setWorkspaceTileLayout = useDevDeckStore((s) => s.setWorkspaceTileLayout)
  const closeWorktreeTab = useDevDeckStore((s) => s.closeWorktreeTab)
  const pruneWorktreeTabs = useDevDeckStore((s) => s.pruneWorktreeTabs)
  const removeBrowserTile = useDevDeckStore((s) => s.removeBrowserTile)
  const openPalette = useDevDeckStore((s) => s.openPalette)
  const openSSHShellTab = useDevDeckStore((s) => s.openSSHShellTab)
  const workspace = useWorkspace(wsId).data
  const worktrees = workspace ? workspace.projects.flatMap((p) => p.worktrees) : []
  const sshConnections = useSSHConnections().data ?? []
  const machines = useMachines().data ?? []
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

  /** Called after the SSH quick-add dialog saves a host, so the freshly
   *  created connection opens in a shell straight away. Browser and Agent
   *  creation no longer pass through here — the palette's own hook opens
   *  those and navigates itself. */
  function handleCreateSSH(connectionId: string) {
    openSSHShellTab(wsId, connectionId)
    navigate({ to: '/w/$wsId', params: { wsId } })
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
  // Closing an 'ssh-shell' tab must likewise tear down every live SSH
  // session still in its own inner pane tree explicitly, here, rather than
  // from an unmount effect inside `SSHShellPane` — a drag-to-split/relocate
  // of the ssh-shell tab itself (`moveTileTab` always allocates a fresh
  // leaf id, see tileTree.ts) also unmounts `SSHShellPane` as a pure view
  // change, which must NOT kill the remote shell (its lifetime IS its
  // socket's lifetime, unlike the worktree Terminal's server-reattached
  // PTY). See `sshTerminalRegistry.ts`'s doc comment for the same hazard
  // one layer down.
  //
  // Closing a 'worktree' tab only drops it from this workspace's tab strip —
  // the worktree itself, its primary terminal session, AND any *spawned*
  // extra Terminal panes inside it (ExpandedTerminal's "Terminal 2", ...)
  // all keep running server-side, so reopening the worktree reattaches every
  // pane instead of respawning it — a spawned pane may be running its own
  // long-lived agent process, not just a throwaway shell, so it deserves the
  // same "survive the tab closing" treatment as the primary session.
  async function handleCloseTab(_leafId: string, tabId: string) {
    const tab = findTileTab(layout.root, tabId)
    if (tab?.kind === 'browser') {
      const tile = useDevDeckStore.getState().browserTiles[tabId]
      if (tile) {
        await Promise.all(
          tile.docs.filter((d) => d.url).map((d) => closeNativeBrowserTile(tabId, d.id)),
        )
      }
      removeBrowserTile(tabId)
    } else if (tab?.kind === 'ssh-shell') {
      const sshLayout = deserializeLayout(useDevDeckStore.getState().sshTileLayouts[tab.connectionId])
      if (sshLayout) collectTerminalSessionKeys(sshLayout.root).forEach(disposeSSHSession)
    }
    closeWorktreeTab(wsId, tabId)
    const next = useDevDeckStore.getState().workspaceTileLayouts[wsId]
    if (!next) return
    const leaf = findTileLeaf(next.root, next.focusedLeafId)
    const activeTab = leaf?.type === 'leaf' ? leaf.tabs.find((t) => t.id === leaf.activeTabId) : undefined
    if (activeTab) navigateToTab(activeTab)
  }

  /** The tab strip's `+` button and every palette-opening chord land here, so
   *  the palette always acts on a leaf that is actually focused. */
  function handleNewTab(leafId: string) {
    commit(focusTileLeaf(layout, leafId))
    openPalette(wsId, leafId)
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

  // A project with no `machineId` is unassigned — it runs in whichever process
  // is serving this UI, so the tab strip calls that "local" rather than
  // leaving the machine segment blank.
  function machineNameFor(project: { machineId: string } | undefined) {
    if (!project?.machineId) return 'local'
    return machines.find((m) => m.id === project.machineId)?.name ?? 'local'
  }

  function resolveWorktreeTab(tab: WorktreeTileTab) {
    const worktree = worktrees.find((w) => w.id === tab.wtId)
    if (!worktree) return undefined
    const project = projectsById.get(tab.projectId)
    return worktreeTabLabel(project, worktree, machineNameFor(project))
  }

  function resolveBrowserTab(tab: BrowserTileTab) {
    const tile = useDevDeckStore.getState().browserTiles[tab.id]
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
  // Cmd/Ctrl+1..4 selects the matching tab in the focused leaf (Agents is #1).
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

      // Cmd/Ctrl+K is the one chord that always means "open the palette",
      // with no context rule at all — including inside a worktree terminal,
      // where xterm is told to let it through via `isAppShortcut`.
      if (key === 'k' && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        handleNewTab(leaf.id)
        return
      }

      if (!event.altKey && !event.shiftKey && /^[1-4]$/.test(event.key)) {
        const nextTab = leaf.tabs[Number(event.key) - 1]
        if (!nextTab) return
        event.preventDefault()
        handleSelectTab(leaf.id, nextTab.id)
        return
      }

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
        focusedLeafId={layout.focusedLeafId}
        renderers={{
          agents: () => {
            if (!workspace) return null
            if (!currentProjectId) return <WorkspaceHostsView wsId={wsId} projects={workspace.projects} />
            const project = workspace.projects.find((p) => p.id === currentProjectId)
            if (!project) return null
            return <WorktreeCardsGrid project={project} projects={workspace.projects} wsId={wsId} />
          },
          worktree: ({ leafId, tab }) => {
            const worktree = worktrees.find((w) => w.id === tab.wtId)
            if (!worktree) return null
            return (
              <ExpandedTerminal
                worktree={worktree}
                wsId={wsId}
                projectId={tab.projectId}
                isFocused={leafId === layout.focusedLeafId}
                onPrimaryExit={() => void handleCloseTab(leafId, tab.id)}
              />
            )
          },
          browser: ({ leafId, tab }) => <BrowserTile tabId={tab.id} isFocused={leafId === layout.focusedLeafId} />,
          sshShell: ({ leafId, tab }) => (
            <SSHShellPane connectionId={tab.connectionId} isFocused={leafId === layout.focusedLeafId} />
          ),
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
      <CommandPalette wsId={wsId} leafId={layout.focusedLeafId} />
      <SSHQuickAddDialog onCreateSSH={handleCreateSSH} />
    </>
  )
}

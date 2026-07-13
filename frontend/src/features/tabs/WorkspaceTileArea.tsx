import { useEffect } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { WorktreeCardsGrid } from '@/features/agents/WorktreeCardsGrid'
import { ExpandedTerminal } from '@/features/terminal/ExpandedTerminal'
import { useMachines, useWorkspace } from '@/features/data/queries'
import { STATE } from '@/lib/constants'
import { useLoomStore } from '@/store/useLoomStore'
import { WorkspaceTileCanvas } from './WorkspaceTileCanvas'
import { createDefaultTileLayout, findTileLeaf, findTileTab, firstLeafId, focusTileLeaf, selectTileTab } from './tileTree'
import type { TileTab, WorkspaceTileLayout } from './tileTree'
import type { WorktreeTileTab } from './WorkspaceTileCanvas'

interface WorkspaceTileAreaProps {
  wsId: string
}

/** Wires `WorkspaceTileCanvas` to the store (persisted tiling tree) and the
 *  router (URL follows the focused leaf's active worktree). Supersedes the
 *  previously-shipped flat `TabBar` — a single leaf with no splits *is*
 *  what that looked like. */
export function WorkspaceTileArea({ wsId }: WorkspaceTileAreaProps) {
  const navigate = useNavigate()
  const { projectId: currentProjectId } = useParams({ strict: false }) as { projectId?: string }
  const layout = useLoomStore((s) => s.workspaceTileLayouts[wsId]) ?? createDefaultTileLayout()
  const setWorkspaceTileLayout = useLoomStore((s) => s.setWorkspaceTileLayout)
  const closeWorktreeTab = useLoomStore((s) => s.closeWorktreeTab)
  const pruneWorktreeTabs = useLoomStore((s) => s.pruneWorktreeTabs)
  const openSpawn = useLoomStore((s) => s.openSpawn)
  const showToast = useLoomStore((s) => s.showToast)
  const workspace = useWorkspace(wsId).data
  const worktrees = workspace ? workspace.projects.flatMap((p) => p.worktrees) : []
  const machines = useMachines().data ?? []
  const machinesById = new Map(machines.map((m) => [m.id, m]))
  const projectsById = new Map(workspace ? workspace.projects.map((p) => [p.id, p]) : [])

  function commit(next: WorkspaceTileLayout) {
    setWorkspaceTileLayout(wsId, next)
  }

  function navigateToTab(tab: TileTab) {
    if (tab.kind === 'agents') {
      navigate({ to: '/w/$wsId', params: { wsId } })
    } else {
      navigate({
        to: '/w/$wsId/p/$projectId/wt/$wtId',
        params: { wsId, projectId: tab.projectId, wtId: tab.wtId },
      })
    }
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

  function handleCloseTab(_leafId: string, tabId: string) {
    closeWorktreeTab(wsId, tabId)
    const next = useLoomStore.getState().workspaceTileLayouts[wsId]
    if (!next) return
    const leaf = findTileLeaf(next.root, next.focusedLeafId)
    const activeTab = leaf?.type === 'leaf' ? leaf.tabs.find((t) => t.id === leaf.activeTabId) : undefined
    if (activeTab) navigateToTab(activeTab)
  }

  function handleNewTab(leafId: string) {
    const targetProjectId = currentProjectId ?? workspace?.projects[0]?.id
    if (!targetProjectId) {
      showToast('Add a project first')
      return
    }
    commit(focusTileLeaf(layout, leafId))
    openSpawn(targetProjectId)
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
    const machine = project?.machineId ? machinesById.get(project.machineId) : undefined
    const short = machine && !machine.isLocal ? `${project?.name ?? 'project'} · ${machine.name}` : (project?.name ?? 'project')
    return {
      label: worktree.root ? 'project root' : worktree.branch,
      color: st.color,
      pulse: worktree.state === 'running' || worktree.state === 'waiting',
      short,
    }
  }

  // Cmd+W closes the focused leaf's active tab (no-op on the Agents tab);
  // Cmd+Shift+[ / Cmd+Shift+] cycle the focused leaf's own tab strip —
  // scoped per-leaf now that tabs live inside panes instead of one global
  // strip. metaKey only, matching the flat TabBar's prior shortcuts — see
  // that spec's decision 9 for why ctrlKey would collide with
  // ExpandedTerminal's own Ctrl+T/Ctrl+W handler.
  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (!event.metaKey) return
      const leaf = findTileLeaf(layout.root, layout.focusedLeafId)
      if (!leaf || leaf.type !== 'leaf') return

      if (event.key.toLowerCase() === 'w') {
        if (leaf.activeTabId === 'agents') return
        event.preventDefault()
        handleCloseTab(leaf.id, leaf.activeTabId)
        return
      }

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
  }, [layout])

  return (
    <WorkspaceTileCanvas
      root={layout.root}
      renderers={{
        agents: () => {
          const project = workspace?.projects.find((p) => p.id === (currentProjectId ?? workspace.projects[0]?.id))
          if (!project) return null
          return <WorktreeCardsGrid project={project} wsId={wsId} />
        },
        worktree: ({ tab }) => {
          const worktree = worktrees.find((w) => w.id === tab.wtId)
          if (!worktree) return null
          return <ExpandedTerminal worktree={worktree} wsId={wsId} projectId={tab.projectId} />
        },
      }}
      onTreeChange={handleTreeChange}
      onFocusLeaf={handleFocusLeaf}
      onSelectTab={handleSelectTab}
      onCloseTab={handleCloseTab}
      onNewTab={handleNewTab}
      resolveWorktreeTab={resolveWorktreeTab}
      className="min-h-0"
    />
  )
}

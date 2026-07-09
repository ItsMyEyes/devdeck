import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Check, FolderTree, GitBranch, Settings2, TerminalSquare, Trash2 } from 'lucide-react'
import { STATE } from '@/lib/constants'
import { fmtCost, fmtEl, fmtTok } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Machine, Worktree } from '@/store/types'
import { StatusDot } from '@/components/ui/status-dot'
import { Pill } from '@/components/ui/pill'
import { WorktreeGlyph } from '@/features/agents/WorktreeGlyph'
import { useMachines, useUpdateWorktree, useWorkspace } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'
import type { DefinitionReveal, DefinitionTarget } from './CodeFileEditor'
import { FileEditor } from './FileEditor'
import { FileQuickOpen } from './FileQuickOpen'
import { GitPanel } from './GitPanel'
import { MaterialFileIcon } from './MaterialFileIcon'
import { MobileKeyToolbar } from './MobileKeyToolbar'
import { PaneCanvas } from './PaneCanvas'
import type { PaneContentRendererMap } from './PaneCanvas'
import {
  allocateTerminalContent,
  closeTab,
  createDefaultLayout,
  createExplorerContent,
  createFileContent,
  createGitContent,
  deserializeLayout,
  findContent,
  findLeafForContent,
  findPane,
  focusPane,
  moveTab,
  splitLeaf,
} from './paneTree'
import type { DropZone, PaneContent, PaneNode, SplitDirection, WorktreeLayout } from './paneTree'
import { Terminal, type TerminalHandle } from './Terminal'
import { TerminalExplorer } from './TerminalExplorer'

interface Props {
  worktree: Worktree
  wsId: string
  projectId: string
}

function basename(path: string) {
  return path.split('/').pop() ?? path
}

/**
 * paneTree.ts deliberately only exports split/close/move/resize — "select a
 * tab" and "add a brand-new content item to an existing leaf" are needed
 * here (quick-open, jump-to-definition, the Git/Explorer overflow actions)
 * but not by any pure tree op, so these mirror its structurally-sharing
 * style locally instead of widening that file's surface for one caller.
 */
function firstLeafId(node: PaneNode): string | undefined {
  if (node.type === 'leaf') return node.id
  for (const child of node.children) {
    const found = firstLeafId(child)
    if (found) return found
  }
  return undefined
}

function selectTabInTree(node: PaneNode, paneId: string, tabId: string): PaneNode {
  if (node.type === 'leaf') {
    if (node.id !== paneId || node.activeTabId === tabId) return node
    if (!node.tabs.some((t) => t.id === tabId)) return node
    return { ...node, activeTabId: tabId }
  }
  let changed = false
  const children = node.children.map((child) => {
    const next = selectTabInTree(child, paneId, tabId)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...node, children } : node
}

function addContentToLeaf(node: PaneNode, paneId: string, content: PaneContent): PaneNode {
  if (node.type === 'leaf') {
    if (node.id !== paneId) return node
    if (node.tabs.some((t) => t.id === content.id)) return { ...node, activeTabId: content.id }
    return { ...node, tabs: [...node.tabs, content], activeTabId: content.id }
  }
  let changed = false
  const children = node.children.map((child) => {
    const next = addContentToLeaf(child, paneId, content)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...node, children } : node
}

/** Mobile has no room for side-by-side splits (spec decision 10) — used to gate `PaneCanvas`'s drag-and-drop sensors. */
function useIsDesktop() {
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

const overflowItemClass =
  'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left font-mono text-[11.5px] text-loom-fg-2 hover:bg-loom-hover-wash'

function OverflowItem({
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
      className={cn(overflowItemClass, danger && 'text-loom-red-soft hover:bg-loom-red-tint-hover')}
    >
      {children}
    </Popover.Close>
  )
}

export function ExpandedTerminal({ worktree: w, wsId, projectId }: Props) {
  const project = useWorkspace(wsId).data?.projects.find((candidate) => candidate.id === projectId)
  const machines = useMachines().data
  const machine = machines?.find((m) => m.id === project?.machineId)

  if (!machine) {
    return (
      <div className="flex flex-1 items-center justify-center font-mono text-sm text-loom-dim">
        no machine assigned to this project — add one from the Machines page
      </div>
    )
  }

  // Keyed by worktree id so switching worktrees (which doesn't itself
  // unmount ExpandedTerminal — the route only updates params) resets every
  // per-worktree local state (dirty files, quick-open, ctrl-armed, the
  // terminal-handle map) instead of leaking it across worktrees.
  return <TerminalWorkspace key={w.id} worktree={w} machine={machine} projectName={project?.name} />
}

function TerminalWorkspace({
  worktree,
  machine,
  projectName,
}: {
  worktree: Worktree
  machine: Machine
  projectName?: string
}) {
  const termHandles = useRef(new Map<string, TerminalHandle>())
  const definitionRequest = useRef(0)
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(() => new Set())
  const [definitionReveals, setDefinitionReveals] = useState<Record<string, DefinitionReveal>>({})
  const isDesktop = useIsDesktop()

  const openEdit = useLoomStore((s) => s.openEdit)
  const askDelete = useLoomStore((s) => s.askDelete)
  const setDirtyFileCount = useLoomStore((s) => s.setDirtyFileCount)
  const setWorktreeLayout = useLoomStore((s) => s.setWorktreeLayout)
  const storedLayout = useLoomStore((s) => s.worktreeLayouts[worktree.id])
  const updateWorktree = useUpdateWorktree()

  const layout = useMemo(
    () => deserializeLayout(storedLayout) ?? createDefaultLayout(worktree.id),
    [storedLayout, worktree.id],
  )

  function commitLayout(next: WorktreeLayout) {
    setWorktreeLayout(worktree.id, next)
  }

  const st = STATE[worktree.state]
  const label = worktree.root ? 'project root' : worktree.branch

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
      const existingLeaf = findLeafForContent(layout.root, path)
      if (existingLeaf) {
        setWorktreeLayout(worktree.id, {
          ...layout,
          root: selectTabInTree(layout.root, existingLeaf.id, path),
          focusedPaneId: existingLeaf.id,
        })
        return
      }
      const targetPaneId = layout.focusedPaneId
      setWorktreeLayout(worktree.id, {
        ...layout,
        root: addContentToLeaf(layout.root, targetPaneId, createFileContent(path)),
        focusedPaneId: targetPaneId,
      })
    },
    [layout, worktree.id, setWorktreeLayout],
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

  const handleFileDeleted = useCallback(
    (path: string) => {
      cleanupFileBookkeeping(path)
      const leaf = findLeafForContent(layout.root, path)
      if (!leaf) return
      setWorktreeLayout(worktree.id, closeTab(layout, leaf.id, path))
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
    if (content?.kind === 'file') {
      if (dirtyFiles.has(content.path) && !window.confirm(`Close ${basename(content.path)} without saving?`)) return
      cleanupFileBookkeeping(content.path)
    }
    commitLayout(closeTab(layout, paneId, contentId))
  }

  function handleClosePane(paneId: string) {
    const pane = findPane(layout.root, paneId)
    if (!pane || pane.type !== 'leaf') return
    const dirtyTabs = pane.tabs.filter((t) => t.kind === 'file' && dirtyFiles.has(t.path))
    if (
      dirtyTabs.length > 0 &&
      !window.confirm(`Close this pane? ${dirtyTabs.length} file${dirtyTabs.length === 1 ? '' : 's'} unsaved.`)
    )
      return
    let next = layout
    for (const tab of pane.tabs) {
      next = closeTab(next, paneId, tab.id)
      if (tab.kind === 'file') cleanupFileBookkeeping(tab.path)
    }
    commitLayout(next)
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setQuickOpen(true)
        return
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'w') {
        const pane = findPane(layout.root, layout.focusedPaneId)
        if (!pane || pane.type !== 'leaf') return
        const active = pane.tabs.find((t) => t.id === pane.activeTabId)
        if (!active || active.kind !== 'file') return
        event.preventDefault()
        handleCloseTab(pane.id, active.id)
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [layout, dirtyFiles])

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
    if (content.kind === 'terminal') return <TerminalSquare size={13} className="text-loom-accent" />
    if (content.kind === 'git') return <GitBranch size={13} className="text-loom-accent" />
    if (content.kind === 'explorer') return <FolderTree size={13} className="text-loom-accent" />
    return <MaterialFileIcon name={basename(content.path)} size={13} />
  }

  function isTabDirty(content: PaneContent) {
    return content.kind === 'file' && dirtyFiles.has(content.path)
  }

  function renderTerminalTitle() {
    return (
      <div className="flex min-w-0 flex-none items-center gap-2 px-2">
        <StatusDot color={st.color} pulse={worktree.state === 'running' || worktree.state === 'waiting'} />
        <WorktreeGlyph root={worktree.root} size={12} />
        <span className="max-w-[160px] flex-none truncate font-mono text-[11px] font-medium">{label}</span>
        <Pill color={st.color}>{st.label}</Pill>
        <span className="hidden min-w-[70px] flex-1 truncate whitespace-nowrap font-mono text-[10px] text-loom-dim lg:block">
          {worktree.model} · {fmtEl(worktree.elapsed)} · {fmtTok(worktree.tokens)} tok · {fmtCost(worktree.tokens)}
        </span>
      </div>
    )
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

  const renderers: PaneContentRendererMap = {
    terminal: ({ content }) => {
      if (content.kind !== 'terminal') return null
      const isFocusedTerminal = content.sessionKey === focusedTerminalSessionKey
      return (
        <div className="h-full min-h-0 overflow-hidden bg-loom-terminal px-3 py-2">
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
          />
        </div>
      )
    },
    git: ({ isActive }) => <GitPanel worktreeId={worktree.id} machine={machine} active={isActive} />,
    file: ({ content, isActive }) => {
      if (content.kind !== 'file') return null
      return (
        <FileEditor
          worktreeId={worktree.id}
          machine={machine}
          path={content.path}
          active={isActive}
          onDirtyChange={handleDirtyChange}
          onDeleted={handleFileDeleted}
          onOpenDefinition={openDefinition}
          reveal={definitionReveals[content.path]}
        />
      )
    },
    explorer: () => (
      <TerminalExplorer
        worktreeId={worktree.id}
        machine={machine}
        rootLabel={projectName ?? label}
        onOpenFile={openFile}
        onFileDeleted={handleFileDeleted}
        onRequestQuickOpen={() => setQuickOpen(true)}
      />
    ),
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-loom-terminal">
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
        paneTitleContent={renderTerminalTitle}
        paneOverflowActions={renderOverflowActions}
        dragEnabled={isDesktop}
      />

      {focusedTerminalSessionKey ? (
        <MobileKeyToolbar ctrlArmed={ctrlArmed} onToggleCtrl={() => setCtrlArmed((armed) => !armed)} onSend={sendKey} />
      ) : null}

      <FileQuickOpen
        open={quickOpen}
        worktreeId={worktree.id}
        machine={machine}
        onClose={() => setQuickOpen(false)}
        onOpenFile={openFile}
      />
    </div>
  )
}

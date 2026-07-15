import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { toast as sonnerToast } from 'sonner'
import type { WorktreeLayout } from '@/features/terminal/paneTree'
import {
  closeTileTab,
  createBrowserTab,
  createDefaultTileLayout,
  createSSHShellTab,
  createWorktreeTab,
  findLeafForTab,
  openTileTab,
  pruneTileTabs,
} from '@/features/tabs/tileTree'
import type { WorkspaceTileLayout } from '@/features/tabs/tileTree'
import type {
  Priority,
  Project,
  SSHConnection,
  Workspace,
  Worktree,
} from './types'

export type EditKind = 'worktree' | 'project' | 'workspace' | 'machine' | 'ssh'
export type TodoFilter = 'all' | 'active' | 'done'
export type NewProjectMode = 'local' | 'clone'
export type BrowseTarget = 'newPath' | 'cloneParent' | 'edit'
export type NewTabKind = 'browser' | 'shell'

interface NewTabState {
  open: boolean
  wsId: string | null
  leafId: string | null
  kind: NewTabKind
  /** Empty until the user (or the dialog's own default-to-first-machine
   *  effect) picks one — both kinds require this before Create is enabled. */
  machineId: string
}
interface SpawnState {
  open: boolean
  projectId: string | null
  mode: 'branch' | 'root'
  branch: string
  base: string
  model: string
  task: string
}
interface EditState {
  kind: EditKind | null
  id: string | null
  a: string
  b: string
  model: string
}
interface NewProjectState {
  open: boolean
  mode: NewProjectMode
  name: string
  path: string
  repo: string
  cloneParent: string
  cloneFolder: string
  machineId: string
}
interface MachineDialogState {
  open: boolean
  editingId: string | null
  name: string
  url: string
  key: string
}
interface SSHDialogState {
  open: boolean
  editingId: string | null
  name: string
  host: string
  /** Kept as the text field's raw string; parsed + validated on submit. */
  port: string
  username: string
  authType: 'password' | 'privatekey'
  password: string
  privateKey: string
  passphrase: string
}

export interface BrowserProxyInfo {
  socks5Addr: string
  httpProxyAddr: string
}

/** One browsing "document" within a Browser tile — plural because
 *  fullscreen mode reveals an internal tab strip so a single Browser tile
 *  can hold more than one page at once (see the design spec's Decision 2). */
export interface BrowserDocState {
  id: string
  machineId: string | null
  proxy: BrowserProxyInfo | null
  url: string | null
  title: string
  loading: boolean
  history: string[]
  historyIndex: number
}

export interface BrowserTileState {
  fullscreen: boolean
  activeDocId: string
  docs: BrowserDocState[]
}

function generateDocId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createBrowserDoc(id: string, machineId: string | null = null): BrowserDocState {
  return { id, machineId, proxy: null, url: null, title: 'New Tab', loading: false, history: [], historyIndex: -1 }
}

function createBrowserTileState(machineId: string | null = null): BrowserTileState {
  const docId = generateDocId()
  return { fullscreen: false, activeDocId: docId, docs: [createBrowserDoc(docId, machineId)] }
}

/**
 * Transient UI-only state.
 *
 * Domain data (workspaces / projects / worktrees / news / todos / invoices /
 * settings) lives in react-query and the Go backend is the source of truth —
 * this store no longer holds or persists any of it. What remains here is purely
 * ephemeral interface state: dialog drafts, the folder picker, the mobile
 * sidebar and the toast relay. Domain mutations happen in components via the
 * react-query hooks in src/features/data/queries.ts.
 */
interface LoomState {
  // ---- transient UI ----
  sidebarOpen: boolean
  wsMenuOpen: boolean
  newTab: NewTabState
  spawn: SpawnState
  newProject: NewProjectState
  newWorkspace: { open: boolean; name: string }
  browse: { open: boolean; target: BrowseTarget; path: string[]; machineId: string }
  edit: EditState
  confirmDelete: { kind: EditKind; id: string; name: string } | null
  todoDraft: { text: string; pri: Priority }
  todoFilter: TodoFilter
  machineDialog: MachineDialogState
  /** Not persisted — how many files the currently-open worktree (if any) has
   *  unsaved. `SidebarRail`'s back button lives outside `ExpandedTerminal`
   *  now, so this is how it gates its own dirty-file confirm. */
  dirtyFileCount: number

  // ---- persisted UI preference ----
  /** Each worktree's tiling pane-tree layout (structure, split sizes, open
   *  tabs, active tab), keyed by worktree id. */
  worktreeLayouts: Record<string, WorktreeLayout>
  /** Widens the sidebar from its default icon-only rail out to the full labeled width —
   *  applies globally, on every route. Independent of `sidebarOpen`, which is the mobile
   *  drawer's open/close — this is a small/big toggle for the rail's own width. */
  railExpanded: boolean
  /** Chrome-style desktop tab bar (Tauri only): each workspace's tiling
   *  tree of open worktree tabs (splits, per-leaf tab strips). Unused by
   *  the web app. */
  workspaceTileLayouts: Record<string, WorkspaceTileLayout>
  /** Live browsing state for every open Browser tile, keyed by the tile's
   *  TileTab id. Deliberately NOT persisted (see the `partialize` config
   *  below) — a restored `browser` tab reopens to its blank/bookmarks home
   *  state, same as `ensureBrowserTile` lazily re-creating a missing entry. */
  browserTiles: Record<string, BrowserTileState>
  /** Count of currently-open DOM overlays that must render above everything
   *  (command palettes, dialogs, dropdowns) — Tauri's native child webviews
   *  (Browser tiles) are separate OS-composited surfaces the window manager
   *  always stacks above the app's own DOM, so no CSS `z-index` can put a
   *  DOM overlay in front of one. `BrowserTile` hides its native webview
   *  while this is nonzero and restores it once every blocker has closed —
   *  see `FileQuickOpen`'s `useEffect` for the push/pop pattern other
   *  full-screen overlays should follow. */
  nativeOverlayBlockers: number

  // ---- actions ----
  showToast: (msg: string) => void
  setSidebarOpen: (open: boolean) => void
  toggleRailExpanded: () => void
  toggleWsMenu: () => void
  closeWsMenu: () => void
  setDirtyFileCount: (n: number) => void
  setWorktreeLayout: (worktreeId: string, layout: WorktreeLayout) => void
  removeWorktreeLayout: (worktreeId: string) => void
  openWorktreeTab: (wsId: string, projectId: string, wtId: string) => void
  closeWorktreeTab: (wsId: string, wtId: string) => void
  pruneWorktreeTabs: (wsId: string, liveWtIds: Set<string>) => void
  setWorkspaceTileLayout: (wsId: string, layout: WorkspaceTileLayout) => void

  // new tab chooser (tab strip "+")
  openNewTab: (wsId: string, leafId: string) => void
  closeNewTab: () => void
  setNewTab: (patch: Partial<Pick<NewTabState, 'kind' | 'machineId'>>) => void

  // browser tile (Tauri only)
  openBrowserTab: (wsId: string, machineId?: string) => void
  openSSHShellTab: (wsId: string, connectionId: string) => void
  ensureBrowserTile: (tabId: string) => void
  setBrowserDocState: (tabId: string, docId: string, patch: Partial<Omit<BrowserDocState, 'id'>>) => void
  addBrowserDoc: (tabId: string) => void
  closeBrowserDoc: (tabId: string, docId: string) => void
  selectBrowserDoc: (tabId: string, docId: string) => void
  setBrowserTileFullscreen: (tabId: string, fullscreen: boolean) => void
  removeBrowserTile: (tabId: string) => void
  pushNativeOverlayBlocker: () => void
  popNativeOverlayBlocker: () => void

  // spawn worktree
  openSpawn: (projectId: string, mode?: 'branch' | 'root', model?: string) => void
  closeSpawn: () => void
  setSpawn: (patch: Partial<SpawnState>) => void

  // new project
  openNewProject: () => void
  closeNewProject: () => void
  setNewProject: (patch: Partial<Omit<NewProjectState, 'open'>>) => void

  // new workspace
  openNewWorkspace: () => void
  closeNewWorkspace: () => void
  setNewWorkspace: (patch: Partial<{ name: string }>) => void

  // edit drawer
  openEdit: (kind: EditKind, id: string, prefill: { a: string; b?: string; model?: string }) => void
  closeEdit: () => void
  setEdit: (patch: Partial<Pick<EditState, 'a' | 'b' | 'model'>>) => void
  askDelete: (kind: EditKind, id: string, name: string) => void
  cancelConfirm: () => void

  // folder browser
  openBrowse: (target: BrowseTarget, initialPath?: string, machineId?: string) => void
  closeBrowse: () => void
  enterFolder: (name: string) => void
  browseUp: () => void
  browseTo: (index: number) => void
  useFolder: () => void

  // todos (draft only — mutations live in the module UI)
  setTodoDraft: (patch: Partial<{ text: string; pri: Priority }>) => void
  setTodoFilter: (f: TodoFilter) => void

  // machine dialog
  openAddMachine: () => void
  openEditMachine: (id: string, name: string, url: string, key: string) => void
  closeMachineDialog: () => void
  setMachineDialog: (patch: Partial<Omit<MachineDialogState, 'open' | 'editingId'>>) => void

  // ssh dialog
  sshDialog: SSHDialogState
  openAddSSHConnection: () => void
  openEditSSHConnection: (conn: SSHConnection) => void
  closeSSHDialog: () => void
  setSSHDialog: (patch: Partial<SSHDialogState>) => void
}

// ---------- pure lookup helpers (operate on a workspaces array) ----------
function findWs(list: Workspace[], id: string) {
  return list.find((w) => w.id === id) ?? null
}
function allProjects(list: Workspace[]) {
  return list.flatMap((ws) => ws.projects)
}
function findProject(list: Workspace[], id: string): Project | null {
  return allProjects(list).find((p) => p.id === id) ?? null
}
function findWorktree(list: Workspace[], id: string): Worktree | null {
  for (const p of allProjects(list)) {
    const w = p.worktrees.find((wt) => wt.id === id)
    if (w) return w
  }
  return null
}
function wsOfProject(list: Workspace[], projectId: string) {
  return list.find((ws) => ws.projects.some((p) => p.id === projectId)) ?? null
}
function projectOfWorktree(list: Workspace[], wtId: string): Project | null {
  for (const p of allProjects(list)) {
    if (p.worktrees.some((w) => w.id === wtId)) return p
  }
  return null
}

function browsePathSegments(path: string | undefined) {
  const trimmed = path?.trim() ?? ''
  if (!trimmed || trimmed === '~') return []
  if (!trimmed.startsWith('~/')) return []
  return trimmed
    .slice(2)
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
}

export const useLoomStore = create<LoomState>()(
  persist(
    immer((set) => ({
      sidebarOpen: false,
      wsMenuOpen: false,
      newTab: { open: false, wsId: null, leafId: null, kind: 'browser', machineId: '' },
      spawn: { open: false, projectId: null, mode: 'branch', branch: '', base: 'main', model: 'claude-sonnet-5', task: '' },
      newProject: { open: false, mode: 'local', name: '', path: '', repo: '', cloneParent: '~', cloneFolder: '', machineId: '' },
      newWorkspace: { open: false, name: '' },
      browse: { open: false, target: 'newPath', path: [], machineId: '' },
      edit: { kind: null, id: null, a: '', b: '', model: '' },
      confirmDelete: null,
      todoDraft: { text: '', pri: 'normal' },
      todoFilter: 'all',
      machineDialog: { open: false, editingId: null, name: '', url: '', key: '' },
      sshDialog: { open: false, editingId: null, name: '', host: '', port: '22', username: '', authType: 'password', password: '', privateKey: '', passphrase: '' },
      dirtyFileCount: 0,
      worktreeLayouts: {},
      railExpanded: false,
      workspaceTileLayouts: {},
      browserTiles: {},
      nativeOverlayBlockers: 0,

      // Toasts are fired directly through sonner — no store field, so coalesced
      // calls can no longer drop a message.
      showToast: (msg) => sonnerToast(msg),
      setSidebarOpen: (open) => set((s) => void (s.sidebarOpen = open)),
      toggleRailExpanded: () => set((s) => void (s.railExpanded = !s.railExpanded)),
      toggleWsMenu: () => set((s) => void (s.wsMenuOpen = !s.wsMenuOpen)),
      closeWsMenu: () => set((s) => void (s.wsMenuOpen = false)),
      setDirtyFileCount: (n) => set((s) => void (s.dirtyFileCount = n)),
      setWorktreeLayout: (worktreeId, layout) => set((s) => void (s.worktreeLayouts[worktreeId] = layout)),
      removeWorktreeLayout: (worktreeId) => set((s) => void delete s.worktreeLayouts[worktreeId]),
      setWorkspaceTileLayout: (wsId, layout) => set((s) => void (s.workspaceTileLayouts[wsId] = layout)),
      openWorktreeTab: (wsId, projectId, wtId) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId] ?? createDefaultTileLayout()
          s.workspaceTileLayouts[wsId] = openTileTab(layout, createWorktreeTab(projectId, wtId))
        }),
      closeWorktreeTab: (wsId, wtId) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId]
          if (!layout) return
          const leaf = findLeafForTab(layout.root, wtId)
          if (!leaf) return
          s.workspaceTileLayouts[wsId] = closeTileTab(layout, leaf.id, wtId)
        }),
      pruneWorktreeTabs: (wsId, liveWtIds) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId]
          if (!layout) return
          s.workspaceTileLayouts[wsId] = pruneTileTabs(layout, liveWtIds)
        }),

      openNewTab: (wsId, leafId) =>
        set((s) => void (s.newTab = { open: true, wsId, leafId, kind: 'browser', machineId: '' })),
      closeNewTab: () => set((s) => void (s.newTab.open = false)),
      setNewTab: (patch) => set((s) => void Object.assign(s.newTab, patch)),

      openBrowserTab: (wsId, machineId) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId] ?? createDefaultTileLayout()
          const tab = createBrowserTab()
          s.workspaceTileLayouts[wsId] = openTileTab(layout, tab)
          s.browserTiles[tab.id] = createBrowserTileState(machineId ?? null)
        }),
      openSSHShellTab: (wsId, connectionId) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId] ?? createDefaultTileLayout()
          s.workspaceTileLayouts[wsId] = openTileTab(layout, createSSHShellTab(connectionId))
        }),
      ensureBrowserTile: (tabId) =>
        set((s) => {
          if (!s.browserTiles[tabId]) s.browserTiles[tabId] = createBrowserTileState()
        }),
      setBrowserDocState: (tabId, docId, patch) =>
        set((s) => {
          const tile = s.browserTiles[tabId]
          const doc = tile?.docs.find((d) => d.id === docId)
          if (doc) Object.assign(doc, patch)
        }),
      addBrowserDoc: (tabId) =>
        set((s) => {
          const tile = s.browserTiles[tabId]
          if (!tile) return
          const doc = createBrowserDoc(generateDocId())
          tile.docs.push(doc)
          tile.activeDocId = doc.id
        }),
      closeBrowserDoc: (tabId, docId) =>
        set((s) => {
          const tile = s.browserTiles[tabId]
          if (!tile || tile.docs.length === 1) return
          const idx = tile.docs.findIndex((d) => d.id === docId)
          if (idx === -1) return
          tile.docs.splice(idx, 1)
          if (tile.activeDocId === docId) {
            tile.activeDocId = (tile.docs[idx] ?? tile.docs[idx - 1]).id
          }
        }),
      selectBrowserDoc: (tabId, docId) =>
        set((s) => {
          const tile = s.browserTiles[tabId]
          if (tile) tile.activeDocId = docId
        }),
      setBrowserTileFullscreen: (tabId, fullscreen) =>
        set((s) => {
          const tile = s.browserTiles[tabId]
          if (tile) tile.fullscreen = fullscreen
        }),
      removeBrowserTile: (tabId) => set((s) => void delete s.browserTiles[tabId]),
      pushNativeOverlayBlocker: () => set((s) => void (s.nativeOverlayBlockers += 1)),
      popNativeOverlayBlocker: () => set((s) => void (s.nativeOverlayBlockers = Math.max(0, s.nativeOverlayBlockers - 1))),

      openSpawn: (projectId, mode, model) =>
        set((s) => {
          s.spawn = {
            open: true,
            projectId,
            mode: mode ?? 'branch',
            branch: '',
            base: 'main',
            model: model ?? 'claude-sonnet-5',
            task: '',
          }
          s.wsMenuOpen = false
        }),
      closeSpawn: () => set((s) => void (s.spawn.open = false)),
      setSpawn: (patch) => set((s) => void Object.assign(s.spawn, patch)),

      openNewProject: () =>
        set((s) => {
          s.newProject = {
            open: true,
            mode: 'local',
            name: '',
            path: '',
            repo: '',
            cloneParent: '~',
            cloneFolder: '',
            machineId: '',
          }
          s.browse.path = []
          s.wsMenuOpen = false
        }),
      closeNewProject: () => set((s) => void (s.newProject.open = false)),
      setNewProject: (patch) => set((s) => void Object.assign(s.newProject, patch)),

      openNewWorkspace: () =>
        set((s) => {
          s.newWorkspace = { open: true, name: '' }
          s.wsMenuOpen = false
        }),
      closeNewWorkspace: () => set((s) => void (s.newWorkspace.open = false)),
      setNewWorkspace: (patch) => set((s) => void Object.assign(s.newWorkspace, patch)),

      openEdit: (kind, id, prefill) =>
        set((s) => {
          s.wsMenuOpen = false
          s.edit = { kind, id, a: prefill.a, b: prefill.b ?? '', model: prefill.model ?? '' }
        }),
      closeEdit: () => set((s) => void (s.edit = { kind: null, id: null, a: '', b: '', model: '' })),
      setEdit: (patch) => set((s) => void Object.assign(s.edit, patch)),
      askDelete: (kind, id, name) => set((s) => void (s.confirmDelete = { kind, id, name })),
      cancelConfirm: () => set((s) => void (s.confirmDelete = null)),

      openBrowse: (target, initialPath, machineId) =>
        set(
          (s) =>
            void (s.browse = { open: true, target, path: browsePathSegments(initialPath), machineId: machineId ?? '' }),
        ),
      closeBrowse: () => set((s) => void (s.browse.open = false)),
      enterFolder: (name) => set((s) => void s.browse.path.push(name)),
      browseUp: () => set((s) => void s.browse.path.pop()),
      browseTo: (index) => set((s) => void (s.browse.path = s.browse.path.slice(0, index))),
      useFolder: () =>
        set((s) => {
          const bp = s.browse.path
          const path = '~' + (bp.length ? '/' + bp.join('/') : '')
          const last = bp[bp.length - 1] ?? ''
          if (s.browse.target === 'edit') {
            s.browse.open = false
            s.edit.b = path
          } else if (s.browse.target === 'cloneParent') {
            s.browse.open = false
            s.newProject.cloneParent = path
          } else {
            s.browse.open = false
            s.newProject.path = path
            s.newProject.name = s.newProject.name || last
          }
        }),

      setTodoDraft: (patch) => set((s) => void Object.assign(s.todoDraft, patch)),
      setTodoFilter: (f) => set((s) => void (s.todoFilter = f)),

      openAddMachine: () =>
        set((s) => void (s.machineDialog = { open: true, editingId: null, name: '', url: '', key: '' })),
      openEditMachine: (id, name, url, key) =>
        set((s) => void (s.machineDialog = { open: true, editingId: id, name, url, key })),
      closeMachineDialog: () => set((s) => void (s.machineDialog.open = false)),
      setMachineDialog: (patch) => set((s) => void Object.assign(s.machineDialog, patch)),

      openAddSSHConnection: () =>
        set(
          (s) =>
            void (s.sshDialog = {
              open: true,
              editingId: null,
              name: '',
              host: '',
              port: '22',
              username: '',
              authType: 'password',
              password: '',
              privateKey: '',
              passphrase: '',
            }),
        ),
      openEditSSHConnection: (conn) =>
        set(
          (s) =>
            void (s.sshDialog = {
              open: true,
              editingId: conn.id,
              name: conn.name,
              host: conn.host,
              port: String(conn.port),
              username: conn.username,
              authType: conn.authType,
              password: '',
              privateKey: '',
              passphrase: '',
            }),
        ),
      closeSSHDialog: () => set((s) => void (s.sshDialog.open = false)),
      setSSHDialog: (patch) => set((s) => void Object.assign(s.sshDialog, patch)),
    })),
    {
      name: 'loom-ui-v2',
      version: 3,
      // Persist only harmless UI preferences; no domain data ever touches
      // localStorage now that the backend is the source of truth.
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        worktreeLayouts: s.worktreeLayouts,
        railExpanded: s.railExpanded,
        workspaceTileLayouts: s.workspaceTileLayouts,
      }),
      // v2 -> v3 retires the flat `openTabs` shape for `workspaceTileLayouts`.
      // A bare version bump with no `migrate` discards the *entire*
      // persisted blob, which would also wipe the unrelated
      // `worktreeLayouts`/`railExpanded` — so this carries those two
      // forward unchanged and only drops the old `openTabs` key.
      migrate: (persisted) => {
        const old = persisted as {
          sidebarOpen?: boolean
          worktreeLayouts?: Record<string, WorktreeLayout>
          railExpanded?: boolean
        }
        return {
          sidebarOpen: old.sidebarOpen ?? false,
          worktreeLayouts: old.worktreeLayouts ?? {},
          railExpanded: old.railExpanded ?? false,
          workspaceTileLayouts: {},
        } as LoomState
      },
    },
  ),
)

export { findWs, findProject, findWorktree, wsOfProject, projectOfWorktree }

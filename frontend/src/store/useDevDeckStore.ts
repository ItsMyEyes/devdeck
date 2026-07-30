import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { toast as sonnerToast } from 'sonner'
import type { WorktreeLayout } from '@/features/terminal/paneTree'
import { closeTab, emptyDBTabState, openTab, reorderTab, setActiveTab, type DBTabDraft, type DBTabState } from '@/features/database/dbTabs'
import {
  closeTileTab,
  createBrowserTab,
  createDefaultTileLayout,
  createSSHShellTab,
  createWorktreeTab,
  findLeafForTab,
  focusTileLeaf,
  openTileTab,
  selectTileTab,
  pruneTileTabs,
} from '@/features/tabs/tileTree'
import type { WorkspaceTileLayout } from '@/features/tabs/tileTree'
import type { DBRowEdit } from '@/lib/api'
import type {
  DBConnection,
  DBEngine,
  Priority,
  Project,
  SSHConnection,
  Workspace,
  Worktree,
} from './types'

export type EditKind = 'worktree' | 'project' | 'workspace' | 'machine' | 'ssh' | 'ssh-group'
export type MachineAction = 'restart' | 'stop'

export interface Transfer {
  id: string
  kind: 'upload' | 'download'
  label: string
  totalFiles: number
  completedFiles: number
  totalBytes: number
  loadedBytes: number
  status: 'active' | 'done' | 'error'
  error?: string
}
export type TodoFilter = 'all' | 'active' | 'done'
/** Sentinel for the SSH group filter meaning "no group selected, show every host". */
export const ALL_SSH_GROUPS = '__all__'
export type NewProjectMode = 'local' | 'clone'
export type BrowseTarget = 'newPath' | 'cloneParent' | 'edit'
export type NewTabKind = 'browser' | 'shell' | 'ssh'

interface NewTabState {
  open: boolean
  wsId: string | null
  leafId: string | null
  kind: NewTabKind
  /** Empty until the user (or the dialog's own default-to-first-machine
   *  effect) picks one — both kinds require this before Create is enabled. */
  machineId: string
  /** SSH kind only: the saved connection to open, or `NEW_SSH_HOST` for the
   *  inline "create from an ssh command" form. Empty until the dialog's own
   *  default-selection effect picks one. */
  sshConnectionId: string
}
interface SpawnState {
  open: boolean
  projectId: string | null
  chooseProject: boolean
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
  group: string
  host: string
  /** Kept as the text field's raw string; parsed + validated on submit. */
  port: string
  username: string
  authType: 'password' | 'privatekey'
  password: string
  privateKey: string
  privateKeyPath: string
  passphrase: string
  /** Flow step 1: which Machine dials this host. '' means "hub decides". */
  executorMachineId: string
  /** Flow step 3 (alternative to direct): another saved connection id this
   *  one bastions through. '' means connect directly. */
  jumpConnectionId: string
}
interface DBDialogState {
  open: boolean
  editingId: string | null
  name: string
  group: string
  engine: DBEngine
  host: string
  /** Kept as the text field's raw string; parsed + validated on submit. */
  port: string
  username: string
  database: string
  sslMode: string
  isProduction: boolean
  executorMachineId: string
  tunnelConnectionId: string
  password: string
  caCert: string
  clientCert: string
  clientKey: string
}
interface RenameSSHGroupState {
  open: boolean
  oldName: string
  value: string
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
interface DevDeckState {
  // ---- transient UI ----
  sidebarOpen: boolean
  wsMenuOpen: boolean
  /** Desktop settings dialog (Tauri + local hub only) — hub-mode switch,
   *  Tailscale status, sidecar log access. Not persisted, same as `wsMenuOpen`. */
  desktopSettingsOpen: boolean
  /** This session's hub API key, captured once from the desktop bootstrap's
   *  `?key=` query param before it's scrubbed from the URL (see main.tsx's
   *  `bootstrapDesktopSession`) — shown masked-by-default in
   *  DesktopSettingsDialog. In-memory only, never persisted; regenerates on
   *  every app restart since the Rust side mints a fresh key per launch. */
  hubApiKey: string | null
  newTab: NewTabState
  spawn: SpawnState
  newProject: NewProjectState
  newWorkspace: { open: boolean; name: string }
  browse: { open: boolean; target: BrowseTarget; path: string[]; machineId: string }
  edit: EditState
  confirmDelete: { kind: EditKind; id: string; name: string } | null
  confirmMachineAction: { action: MachineAction; id: string; name: string } | null
  todoDraft: { text: string; pri: Priority }
  todoFilter: TodoFilter
  machineDialog: MachineDialogState
  /** Not persisted — how many files the currently-open worktree (if any) has
   *  unsaved. `SidebarRail`'s back button lives outside `ExpandedTerminal`
   *  now, so this is how it gates its own dirty-file confirm. */
  dirtyFileCount: number
  /** In-flight/recently-finished file transfers for the explorer's upload/
   *  download status panel. Not persisted — purely a live progress view. */
  transfers: Transfer[]

  // ---- persisted UI preference ----
  /** Each worktree's tiling pane-tree layout (structure, split sizes, open
   *  tabs, active tab), keyed by worktree id. */
  worktreeLayouts: Record<string, WorktreeLayout>
  /** Same pane-tree layout shape, reused for an SSH shell tab's own
   *  Terminal/Explorer/File panes — keyed by connection id. */
  sshTileLayouts: Record<string, WorktreeLayout>
  /** Widens the sidebar from its default icon-only rail out to the full labeled width —
   *  applies globally, on every route. Independent of `sidebarOpen`, which is the mobile
   *  drawer's open/close — this is a small/big toggle for the rail's own width. */
  railExpanded: boolean
  /** Selected SSH host group filter — shared between the sidebar's compact
   *  group list (rendered when the rail is expanded) and the full SSH
   *  module, so picking a group in either place stays in sync. Not
   *  persisted, same as `wsMenuOpen`. */
  sshActiveGroup: string
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
  setSSHActiveGroup: (group: string) => void
  toggleWsMenu: () => void
  closeWsMenu: () => void
  openDesktopSettings: () => void
  closeDesktopSettings: () => void
  setHubApiKey: (key: string | null) => void
  setDirtyFileCount: (n: number) => void
  setWorktreeLayout: (worktreeId: string, layout: WorktreeLayout) => void
  removeWorktreeLayout: (worktreeId: string) => void
  setSSHTileLayout: (connectionId: string, layout: WorktreeLayout) => void
  removeSSHTileLayout: (connectionId: string) => void
  openWorktreeTab: (wsId: string, projectId: string, wtId: string) => void
  closeWorktreeTab: (wsId: string, wtId: string) => void
  pruneWorktreeTabs: (wsId: string, liveWtIds: Set<string>) => void
  setWorkspaceTileLayout: (wsId: string, layout: WorkspaceTileLayout) => void
  selectAgentsTab: (wsId: string) => void

  // new tab chooser (tab strip "+")
  openNewTab: (wsId: string, leafId: string) => void
  closeNewTab: () => void
  setNewTab: (patch: Partial<Pick<NewTabState, 'kind' | 'machineId' | 'sshConnectionId'>>) => void

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
  startTransfer: (transfer: Transfer) => void
  updateTransferProgress: (
    id: string,
    patch: { loadedBytes?: number; totalBytes?: number; completedFiles?: number },
  ) => void
  finishTransfer: (id: string, status: 'done' | 'error', error?: string) => void
  dismissTransfer: (id: string) => void

  // spawn worktree
  openSpawn: (projectId: string | null, mode?: 'branch' | 'root', model?: string) => void
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
  askMachineAction: (action: MachineAction, id: string, name: string) => void
  cancelMachineAction: () => void

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

  // db connection dialog
  dbDialog: DBDialogState
  openAddDBConnection: () => void
  openEditDBConnection: (conn: DBConnection) => void
  closeDBDialog: () => void
  setDBDialog: (patch: Partial<DBDialogState>) => void
  dbActiveGroup: string
  setDBActiveGroup: (group: string) => void

  // db tabs (per-connection open-object tabs)
  dbTabs: Record<string, DBTabState>
  openDBTab: (connectionId: string, content: DBTabDraft) => void
  closeDBTab: (connectionId: string, tabId: string) => void
  setDBActiveTab: (connectionId: string, tabId: string) => void
  reorderDBTab: (connectionId: string, fromId: string, toId: string) => void

  // db active connection + inspector pane (frontend-only UI state, not domain data)
  dbActiveConnectionId: string | null
  setDBActiveConnectionId: (id: string | null) => void
  dbInspectorCollapsed: boolean
  setDBInspectorCollapsed: (collapsed: boolean) => void

  // db connection test status — the last explicit "Test" result per
  // connection, not a live health check (the backend has no health-check
  // endpoint); shown as a status dot in the object tree header.
  dbConnectionTestStatus: Record<string, { ok: boolean; testedAt: string }>
  setDBConnectionTestStatus: (connectionId: string, ok: boolean) => void

  // db commit-preview dialog (pending row edits from DBTableGrid)
  commitDialog: { open: boolean; connectionId: string; edits: DBRowEdit[]; onCommitted: (() => void) | null }
  openCommitDialog: (connectionId: string, edits: DBRowEdit[], onCommitted: () => void) => void
  closeCommitDialog: () => void

  // ssh group rename (delete reuses askDelete/confirmDelete with kind 'ssh-group')
  renameSSHGroup: RenameSSHGroupState
  openRenameSSHGroup: (group: string) => void
  closeRenameSSHGroup: () => void
  setRenameSSHGroupValue: (value: string) => void
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

export const useDevDeckStore = create<DevDeckState>()(
  persist(
    immer((set) => ({
      sidebarOpen: false,
      wsMenuOpen: false,
      desktopSettingsOpen: false,
      hubApiKey: null,
      newTab: { open: false, wsId: null, leafId: null, kind: 'browser', machineId: '', sshConnectionId: '' },
      spawn: { open: false, projectId: null, chooseProject: false, mode: 'branch', branch: '', base: 'main', model: 'claude-sonnet-5', task: '' },
      newProject: { open: false, mode: 'local', name: '', path: '', repo: '', cloneParent: '~', cloneFolder: '', machineId: '' },
      newWorkspace: { open: false, name: '' },
      browse: { open: false, target: 'newPath', path: [], machineId: '' },
      edit: { kind: null, id: null, a: '', b: '', model: '' },
      confirmDelete: null,
      confirmMachineAction: null,
      transfers: [],
      todoDraft: { text: '', pri: 'normal' },
      todoFilter: 'all',
      machineDialog: { open: false, editingId: null, name: '', url: '', key: '' },
      sshDialog: {
        open: false,
        editingId: null,
        name: '',
        group: '',
        host: '',
        port: '22',
        username: '',
        authType: 'password',
        password: '',
        privateKey: '',
        privateKeyPath: '',
        passphrase: '',
        executorMachineId: '',
        jumpConnectionId: '',
      },
      dbDialog: {
        open: false,
        editingId: null,
        name: '',
        group: '',
        engine: 'postgres',
        host: '',
        port: '5432',
        username: '',
        database: '',
        sslMode: 'verify-full',
        isProduction: false,
        executorMachineId: '',
        tunnelConnectionId: '',
        password: '',
        caCert: '',
        clientCert: '',
        clientKey: '',
      },
      dbActiveGroup: ALL_SSH_GROUPS, // reuse the existing "all groups" sentinel; see SSHConnectionsModule's identical usage
      dbTabs: {},
      dbActiveConnectionId: null,
      dbInspectorCollapsed: false,
      dbConnectionTestStatus: {},
      commitDialog: { open: false, connectionId: '', edits: [], onCommitted: null },
      renameSSHGroup: { open: false, oldName: '', value: '' },
      dirtyFileCount: 0,
      worktreeLayouts: {},
      sshTileLayouts: {},
      railExpanded: false,
      sshActiveGroup: ALL_SSH_GROUPS,
      workspaceTileLayouts: {},
      browserTiles: {},
      nativeOverlayBlockers: 0,

      // Toasts are fired directly through sonner — no store field, so coalesced
      // calls can no longer drop a message.
      showToast: (msg) => sonnerToast(msg),
      setSidebarOpen: (open) => set((s) => void (s.sidebarOpen = open)),
      toggleRailExpanded: () => set((s) => void (s.railExpanded = !s.railExpanded)),
      setSSHActiveGroup: (group) => set((s) => void (s.sshActiveGroup = group)),
      toggleWsMenu: () => set((s) => void (s.wsMenuOpen = !s.wsMenuOpen)),
      closeWsMenu: () => set((s) => void (s.wsMenuOpen = false)),
      openDesktopSettings: () => set((s) => void (s.desktopSettingsOpen = true)),
      closeDesktopSettings: () => set((s) => void (s.desktopSettingsOpen = false)),
      setHubApiKey: (key) => set((s) => void (s.hubApiKey = key)),
      setDirtyFileCount: (n) => set((s) => void (s.dirtyFileCount = n)),
      setWorktreeLayout: (worktreeId, layout) => set((s) => void (s.worktreeLayouts[worktreeId] = layout)),
      removeWorktreeLayout: (worktreeId) => set((s) => void delete s.worktreeLayouts[worktreeId]),
      setSSHTileLayout: (connectionId, layout) => set((s) => void (s.sshTileLayouts[connectionId] = layout)),
      removeSSHTileLayout: (connectionId) => set((s) => void delete s.sshTileLayouts[connectionId]),
      setWorkspaceTileLayout: (wsId, layout) => set((s) => void (s.workspaceTileLayouts[wsId] = layout)),
      selectAgentsTab: (wsId) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId] ?? createDefaultTileLayout()
          const leaf = findLeafForTab(layout.root, 'agents')
          if (!leaf) {
            s.workspaceTileLayouts[wsId] = openTileTab(layout, { kind: 'agents', id: 'agents' })
            return
          }
          s.workspaceTileLayouts[wsId] = focusTileLeaf(selectTileTab(layout, leaf.id, 'agents'), leaf.id)
        }),
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
        set(
          (s) =>
            void (s.newTab = { open: true, wsId, leafId, kind: 'browser', machineId: '', sshConnectionId: '' }),
        ),
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
      startTransfer: (transfer) => set((s) => void s.transfers.push(transfer)),
      updateTransferProgress: (id, patch) =>
        set((s) => {
          const t = s.transfers.find((t) => t.id === id)
          if (!t) return
          if (patch.loadedBytes !== undefined) t.loadedBytes = patch.loadedBytes
          if (patch.totalBytes !== undefined) t.totalBytes = patch.totalBytes
          if (patch.completedFiles !== undefined) t.completedFiles = patch.completedFiles
        }),
      finishTransfer: (id, status, error) =>
        set((s) => {
          const t = s.transfers.find((t) => t.id === id)
          if (t) {
            t.status = status
            t.error = error
          }
        }),
      dismissTransfer: (id) => set((s) => void (s.transfers = s.transfers.filter((t) => t.id !== id))),

      openSpawn: (projectId, mode, model) =>
        set((s) => {
          s.spawn = {
            open: true,
            projectId,
            chooseProject: projectId === null,
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
      askMachineAction: (action, id, name) => set((s) => void (s.confirmMachineAction = { action, id, name })),
      cancelMachineAction: () => set((s) => void (s.confirmMachineAction = null)),

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
              group: '',
              host: '',
              port: '22',
              username: '',
              authType: 'password',
              password: '',
              privateKey: '',
              privateKeyPath: '',
              passphrase: '',
              executorMachineId: '',
              jumpConnectionId: '',
            }),
        ),
      openEditSSHConnection: (conn) =>
        set(
          (s) =>
            void (s.sshDialog = {
              open: true,
              editingId: conn.id,
              name: conn.name,
              group: conn.group,
              host: conn.host,
              port: String(conn.port),
              username: conn.username,
              authType: conn.authType,
              password: '',
              privateKey: '',
              privateKeyPath: '',
              passphrase: '',
              executorMachineId: conn.executorMachineId ?? '',
              jumpConnectionId: conn.jumpConnectionId ?? '',
            }),
        ),
      closeSSHDialog: () => set((s) => void (s.sshDialog.open = false)),
      setSSHDialog: (patch) => set((s) => void Object.assign(s.sshDialog, patch)),

      openAddDBConnection: () =>
        set(
          (s) =>
            void (s.dbDialog = {
              open: true,
              editingId: null,
              name: '',
              group: '',
              engine: 'postgres',
              host: '',
              port: '5432',
              username: '',
              database: '',
              sslMode: 'verify-full',
              isProduction: false,
              executorMachineId: '',
              tunnelConnectionId: '',
              password: '',
              caCert: '',
              clientCert: '',
              clientKey: '',
            }),
        ),
      openEditDBConnection: (conn) =>
        set(
          (s) =>
            void (s.dbDialog = {
              open: true,
              editingId: conn.id,
              name: conn.name,
              group: conn.group,
              engine: conn.engine,
              host: conn.host,
              port: String(conn.port || (conn.engine === 'mysql' ? 3306 : 5432)),
              username: conn.username,
              database: conn.database,
              sslMode: conn.sslMode,
              isProduction: conn.isProduction,
              executorMachineId: conn.executorMachineId ?? '',
              tunnelConnectionId: conn.tunnelConnectionId ?? '',
              password: '',
              caCert: '',
              clientCert: '',
              clientKey: '',
            }),
        ),
      closeDBDialog: () => set((s) => void (s.dbDialog.open = false)),
      setDBDialog: (patch) => set((s) => void Object.assign(s.dbDialog, patch)),
      setDBActiveGroup: (group) => set((s) => void (s.dbActiveGroup = group)),

      openDBTab: (connectionId, content) =>
        set((s) => void (s.dbTabs[connectionId] = openTab(s.dbTabs[connectionId] ?? emptyDBTabState(), content))),
      closeDBTab: (connectionId, id) =>
        set((s) => void (s.dbTabs[connectionId] = closeTab(s.dbTabs[connectionId] ?? emptyDBTabState(), id))),
      setDBActiveTab: (connectionId, id) =>
        set((s) => void (s.dbTabs[connectionId] = setActiveTab(s.dbTabs[connectionId] ?? emptyDBTabState(), id))),
      reorderDBTab: (connectionId, fromId, toId) =>
        set((s) => void (s.dbTabs[connectionId] = reorderTab(s.dbTabs[connectionId] ?? emptyDBTabState(), fromId, toId))),

      setDBActiveConnectionId: (id) => set((s) => void (s.dbActiveConnectionId = id)),
      setDBInspectorCollapsed: (collapsed) => set((s) => void (s.dbInspectorCollapsed = collapsed)),
      setDBConnectionTestStatus: (connectionId, ok) =>
        set((s) => void (s.dbConnectionTestStatus[connectionId] = { ok, testedAt: new Date().toISOString() })),

      openCommitDialog: (connectionId, edits, onCommitted) =>
        set((s) => void (s.commitDialog = { open: true, connectionId, edits, onCommitted })),
      closeCommitDialog: () => set((s) => void (s.commitDialog.open = false)),

      openRenameSSHGroup: (group) =>
        set((s) => void (s.renameSSHGroup = { open: true, oldName: group, value: group })),
      closeRenameSSHGroup: () => set((s) => void (s.renameSSHGroup.open = false)),
      setRenameSSHGroupValue: (value) => set((s) => void (s.renameSSHGroup.value = value)),
    })),
    {
      name: 'devdeck-ui-v2',
      version: 3,
      // Persist only harmless UI preferences; no domain data ever touches
      // localStorage now that the backend is the source of truth.
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        worktreeLayouts: s.worktreeLayouts,
        sshTileLayouts: s.sshTileLayouts,
        railExpanded: s.railExpanded,
        workspaceTileLayouts: s.workspaceTileLayouts,
        dbActiveConnectionId: s.dbActiveConnectionId,
        dbTabs: s.dbTabs,
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
        } as DevDeckState
      },
    },
  ),
)

export { findWs, findProject, findWorktree, wsOfProject, projectOfWorktree }

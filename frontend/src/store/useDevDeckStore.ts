import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { toast as sonnerToast } from 'sonner'
import type { BrowserLoadError } from '@/features/browser/browserLoadError'
import { emptyThreadView, reduceAgentEvents } from '@/features/agent-chat/eventReducer'
import type { AgentEvent, AgentThreadView } from '@/features/agent-chat/types'
import type { GitDiffTarget, WorktreeLayout } from '@/features/terminal/paneTree'
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
  OverlayBlockerRegion,
  Priority,
  Project,
  SSHConnection,
  Workspace,
  Worktree,
} from './types'

export type EditKind = 'worktree' | 'project' | 'workspace' | 'machine' | 'ssh' | 'ssh-group'
export type MachineAction = 'restart' | 'stop' | 'update'

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

/** Which leaf the palette will act on. Not persisted — see `partialize`. */
interface PaletteState {
  open: boolean
  wsId: string | null
  leafId: string | null
}

/** The SSH quick-add form, reached from the palette's Create group or from a
 *  typed `ssh …` command that needs credentials the palette cannot supply.
 *  `prefillRaw` seeds the ssh-command field. */
interface SSHQuickAddState {
  open: boolean
  wsId: string | null
  leafId: string | null
  prefillRaw: string
}
interface SpawnState {
  open: boolean
  projectId: string | null
  chooseProject: boolean
  mode: 'branch' | 'root' | 'existing'
  branch: string
  base: string
  model: string
  task: string
  /** Selected worktree id when mode === 'existing' — reuses an already-checked-out
   *  worktree instead of creating a new branch/root session. */
  existingWtId: string
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
/** Which runtime's 6-digit sign-in PIN the RuntimePinDialog is rotating.
 *  machineId is null when the dialog targets *this* process (a runtime
 *  changing its own PIN from settings) rather than a remote runtime. */
interface RuntimePinDialogState {
  open: boolean
  machineId: string | null
  machineName: string
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
  /** Set when a load times out or fails; cleared when the next one starts or
   *  when a late `on_page_load` proves the page arrived after all. While it is
   *  set, `BrowserTile` keeps the native webview hidden so the DOM panel is
   *  actually visible — a native child webview always composites above the
   *  app's own DOM. */
  loadError: BrowserLoadError | null
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

function createBrowserDoc(id: string, machineId: string | null = null, url: string | null = null): BrowserDocState {
  return { id, machineId, proxy: null, url, title: 'New Tab', loading: false, loadError: null, history: [], historyIndex: -1 }
}

function createBrowserTileState(machineId: string | null = null, url: string | null = null): BrowserTileState {
  const docId = generateDocId()
  return { fullscreen: false, activeDocId: docId, docs: [createBrowserDoc(docId, machineId, url)] }
}

/** Which panel a shell's own sidebar (§3 of the sidebar-shell-explorer design)
 *  currently shows. SSH shells never offer 'git' or 'sessions' in the rail,
 *  but the stored panel value isn't restricted — see ShellSidebar for the
 *  rail gating. */
export type ShellSidebarPanel = 'explorer' | 'git' | 'sessions'

/** One shell tab's sidebar: open/closed, which panel, and drag-resized width.
 *  Keyed by `wt:<worktreeId>` / `ssh:<connectionId>` in `shellSidebars` below. */
export interface ShellSidebarState {
  open: boolean
  panel: ShellSidebarPanel
  width: number
}

export const SHELL_SIDEBAR_MIN_WIDTH = 200
export const SHELL_SIDEBAR_MAX_WIDTH = 560
const DEFAULT_SHELL_SIDEBAR: ShellSidebarState = { open: true, panel: 'explorer', width: 280 }

function clampShellSidebarWidth(width: number): number {
  return Math.min(SHELL_SIDEBAR_MAX_WIDTH, Math.max(SHELL_SIDEBAR_MIN_WIDTH, width))
}

/** Reads one shell's sidebar state with defaults applied, so consumers never
 *  have to repeat the unseen-key fallback themselves. */
export function shellSidebarState(shellSidebars: Record<string, ShellSidebarState>, shellKey: string): ShellSidebarState {
  return shellSidebars[shellKey] ?? DEFAULT_SHELL_SIDEBAR
}

export type SSHRightSidebarPanel = 'forwards' | 'stats'

/** The SSH pane's right sidebar: Port Forwarding + Stats, mirroring
 *  ShellSidebar's left-side Explorer/Git sidebar. Keyed by the same
 *  `ssh:<connectionId>` shellKey ShellSidebar already uses for this pane —
 *  SSH-only, there is no worktree-pane equivalent. */
export interface SSHRightSidebarState {
  open: boolean
  panel: SSHRightSidebarPanel
  width: number
}

export const SSH_RIGHT_SIDEBAR_MIN_WIDTH = 240
export const SSH_RIGHT_SIDEBAR_MAX_WIDTH = 480
// Closed by default so existing SSH tabs don't suddenly lose horizontal
// space on first load after this ships.
const DEFAULT_SSH_RIGHT_SIDEBAR: SSHRightSidebarState = { open: false, panel: 'stats', width: 300 }

function clampSSHRightSidebarWidth(width: number): number {
  return Math.min(SSH_RIGHT_SIDEBAR_MAX_WIDTH, Math.max(SSH_RIGHT_SIDEBAR_MIN_WIDTH, width))
}

export function sshRightSidebarState(
  sidebars: Record<string, SSHRightSidebarState>,
  shellKey: string,
): SSHRightSidebarState {
  return sidebars[shellKey] ?? DEFAULT_SSH_RIGHT_SIDEBAR
}

/** The diff currently highlighted in a shell's git file list, keyed by
 *  `wt:<worktreeId>` / `ssh:<connectionId>`. Only drives the list's selection
 *  highlight — the diff itself is rendered by a `git-diff` pane tab that owns
 *  its own target. Persisted so a reloaded shell restores the highlight.
 *  The type lives in paneTree.ts, which is deliberately store-free. */
export type { GitDiffTarget } from '@/features/terminal/paneTree'

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
  palette: PaletteState
  sshQuickAdd: SSHQuickAddState
  spawn: SpawnState
  newProject: NewProjectState
  newWorkspace: { open: boolean; name: string }
  browse: { open: boolean; target: BrowseTarget; path: string[]; machineId: string }
  edit: EditState
  confirmDelete: { kind: EditKind; id: string; name: string } | null
  confirmMachineAction: {
    action: MachineAction
    id: string
    name: string
    /** Target release tag, set only for 'update'. */
    version?: string
    /** Live PTY sessions that a restart will disconnect, from the update check. */
    activeSessions?: number
  } | null
  todoDraft: { text: string; pri: Priority }
  todoFilter: TodoFilter
  machineDialog: MachineDialogState
  runtimePinDialog: RuntimePinDialogState
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
  /** Per-shell sidebar (Explorer/Git rail, open state, drag-resized width) —
   *  keyed by `wt:<worktreeId>` / `ssh:<connectionId>`. Unseen keys default
   *  via `shellSidebarState`; read through that helper, not this map directly. */
  shellSidebars: Record<string, ShellSidebarState>
  /** The SSH pane's right sidebar (Port Forwarding + Stats) — keyed the
   *  same way as `shellSidebars`. See `sshRightSidebarState`. */
  sshRightSidebars: Record<string, SSHRightSidebarState>
  /** Selected git diff per shell, shared between the compact sidebar GitPanel
   *  and the full-width in-pane Git tab. See `GitDiffTarget` above. */
  gitDiffs: Record<string, GitDiffTarget>
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
  /** Streamed view model for every open agent-chat thread, keyed by
   *  `threadKey` (== the backend's ThreadID). Deliberately NOT persisted
   *  (see the `partialize` config below) — this is rebuilt from the
   *  server's event log on every reconnect via `useAgentChatSocket`, and
   *  persisting it would resurrect stale half-written messages across a
   *  reload. */
  agentThreads: Record<string, AgentThreadView>
  /** Currently-open DOM overlays that must render above the entire app DOM
   *  (command palettes, dialogs, dropdowns) — Tauri's native child webviews
   *  (Browser tiles) are separate OS-composited surfaces the window manager
   *  always stacks above the app's own DOM, so no CSS `z-index` can put a
   *  DOM overlay in front of one. Keyed by a per-hook-instance id (see
   *  `useNativeOverlayBlocker.ts`'s `useId()`) rather than a bare counter,
   *  so `BrowserTile` can hide only for the blockers whose own reported
   *  region actually overlaps its rect — an empty object is the exact
   *  equivalent of today's `nativeOverlayBlockers === 0`. */
  nativeOverlayBlockers: Record<string, OverlayBlockerRegion>
  /** True for the duration of an interactive pane-divider drag (see
   *  `WorkspaceTileCanvas.tsx`'s `TileSplitView`). Native child webviews
   *  (Browser tiles) ignore CSS `overflow-hidden` clipping and can visibly
   *  lag behind a fast divider drag — `BrowserTile` hides its webview for as
   *  long as this is true and reveals it once at the final settled rect, the
   *  same way it already does for `nativeOverlayBlockers`. */
  tileDragActive: boolean

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
  setShellSidebarOpen: (shellKey: string, open: boolean) => void
  setShellSidebarPanel: (shellKey: string, panel: ShellSidebarPanel) => void
  setShellSidebarWidth: (shellKey: string, width: number) => void
  setSSHRightSidebarOpen: (shellKey: string, open: boolean) => void
  setSSHRightSidebarPanel: (shellKey: string, panel: SSHRightSidebarPanel) => void
  setSSHRightSidebarWidth: (shellKey: string, width: number) => void
  setGitDiff: (shellKey: string, target: GitDiffTarget) => void
  clearGitDiff: (shellKey: string) => void
  openWorktreeTab: (wsId: string, projectId: string, wtId: string) => void
  closeWorktreeTab: (wsId: string, wtId: string) => void
  pruneWorktreeTabs: (wsId: string, liveWtIds: Set<string>) => void
  setWorkspaceTileLayout: (wsId: string, layout: WorkspaceTileLayout) => void
  selectAgentsTab: (wsId: string) => void

  // command palette
  openPalette: (wsId: string, leafId: string) => void
  closePalette: () => void
  openSSHQuickAdd: (wsId: string, leafId: string, prefillRaw: string) => void
  closeSSHQuickAdd: () => void

  // browser tile (Tauri only)
  openBrowserTab: (wsId: string, machineId?: string, url?: string) => void
  openSSHShellTab: (wsId: string, connectionId: string) => void
  ensureBrowserTile: (tabId: string) => void
  setBrowserDocState: (tabId: string, docId: string, patch: Partial<Omit<BrowserDocState, 'id'>>) => void
  addBrowserDoc: (tabId: string) => void
  closeBrowserDoc: (tabId: string, docId: string) => void
  selectBrowserDoc: (tabId: string, docId: string) => void
  setBrowserTileFullscreen: (tabId: string, fullscreen: boolean) => void
  removeBrowserTile: (tabId: string) => void

  // agent-chat threads (streamed view model, driven by useAgentChatSocket)
  /** Folds `events` into `threadKey`'s view via `reduceAgentEvents`, seeding
   *  an `emptyThreadView()` if this is the thread's first batch. */
  applyAgentEvents: (threadKey: string, events: AgentEvent[]) => void
  /** Drops a thread's view model entirely — used when a chat pane closes for
   *  good (not on a mere reconnect, which replays instead of resetting). */
  resetAgentThread: (threadKey: string) => void

  pushNativeOverlayBlocker: (id: string, region: OverlayBlockerRegion) => void
  popNativeOverlayBlocker: (id: string) => void
  setTileDragActive: (active: boolean) => void
  startTransfer: (transfer: Transfer) => void
  updateTransferProgress: (
    id: string,
    patch: { loadedBytes?: number; totalBytes?: number; completedFiles?: number },
  ) => void
  finishTransfer: (id: string, status: 'done' | 'error', error?: string) => void
  dismissTransfer: (id: string) => void

  // spawn worktree
  openSpawn: (projectId: string | null, mode?: 'branch' | 'root' | 'existing', model?: string) => void
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
  askMachineAction: (
    action: MachineAction,
    id: string,
    name: string,
    extra?: { version?: string; activeSessions?: number },
  ) => void
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

  // runtime sign-in PIN dialog
  /** Pass a machineId to rotate a remote runtime's PIN from the hub, or null
   *  to rotate this process's own (a runtime's settings). */
  openRuntimePin: (machineId: string | null, machineName: string) => void
  closeRuntimePin: () => void

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
      palette: { open: false, wsId: null, leafId: null },
      sshQuickAdd: { open: false, wsId: null, leafId: null, prefillRaw: '' },
      spawn: { open: false, projectId: null, chooseProject: false, mode: 'branch', branch: '', base: 'main', model: 'claude-sonnet-5', task: '', existingWtId: '' },
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
      runtimePinDialog: { open: false, machineId: null, machineName: '' },
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
      shellSidebars: {},
      sshRightSidebars: {},
      gitDiffs: {},
      railExpanded: false,
      sshActiveGroup: ALL_SSH_GROUPS,
      workspaceTileLayouts: {},
      browserTiles: {},
      agentThreads: {},
      nativeOverlayBlockers: {},
      tileDragActive: false,

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
      setShellSidebarOpen: (shellKey, open) =>
        set((s) => void (s.shellSidebars[shellKey] = { ...(s.shellSidebars[shellKey] ?? DEFAULT_SHELL_SIDEBAR), open })),
      setShellSidebarPanel: (shellKey, panel) =>
        set((s) => void (s.shellSidebars[shellKey] = { ...(s.shellSidebars[shellKey] ?? DEFAULT_SHELL_SIDEBAR), panel })),
      setShellSidebarWidth: (shellKey, width) =>
        set(
          (s) =>
            void (s.shellSidebars[shellKey] = {
              ...(s.shellSidebars[shellKey] ?? DEFAULT_SHELL_SIDEBAR),
              width: clampShellSidebarWidth(width),
            }),
        ),
      setSSHRightSidebarOpen: (shellKey, open) =>
        set(
          (s) =>
            void (s.sshRightSidebars[shellKey] = {
              ...(s.sshRightSidebars[shellKey] ?? DEFAULT_SSH_RIGHT_SIDEBAR),
              open,
            }),
        ),
      setSSHRightSidebarPanel: (shellKey, panel) =>
        set(
          (s) =>
            void (s.sshRightSidebars[shellKey] = {
              ...(s.sshRightSidebars[shellKey] ?? DEFAULT_SSH_RIGHT_SIDEBAR),
              panel,
            }),
        ),
      setSSHRightSidebarWidth: (shellKey, width) =>
        set(
          (s) =>
            void (s.sshRightSidebars[shellKey] = {
              ...(s.sshRightSidebars[shellKey] ?? DEFAULT_SSH_RIGHT_SIDEBAR),
              width: clampSSHRightSidebarWidth(width),
            }),
        ),
      setGitDiff: (shellKey, target) => set((s) => void (s.gitDiffs[shellKey] = target)),
      clearGitDiff: (shellKey) => set((s) => void delete s.gitDiffs[shellKey]),
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

      openPalette: (wsId, leafId) => set((s) => void (s.palette = { open: true, wsId, leafId })),
      closePalette: () => set((s) => void (s.palette.open = false)),
      openSSHQuickAdd: (wsId, leafId, prefillRaw) =>
        set((s) => void (s.sshQuickAdd = { open: true, wsId, leafId, prefillRaw })),
      closeSSHQuickAdd: () => set((s) => void (s.sshQuickAdd.open = false)),

      openBrowserTab: (wsId, machineId, url) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId] ?? createDefaultTileLayout()
          const tab = createBrowserTab()
          s.workspaceTileLayouts[wsId] = openTileTab(layout, tab)
          s.browserTiles[tab.id] = createBrowserTileState(machineId ?? null, url ?? null)
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
      applyAgentEvents: (threadKey, events) =>
        set((s) => {
          const current = s.agentThreads[threadKey] ?? emptyThreadView()
          const next = reduceAgentEvents(current, events)
          if (next !== current) s.agentThreads[threadKey] = next
        }),
      resetAgentThread: (threadKey) => set((s) => void delete s.agentThreads[threadKey]),
      pushNativeOverlayBlocker: (id, region) => set((s) => void (s.nativeOverlayBlockers[id] = region)),
      popNativeOverlayBlocker: (id) => set((s) => void delete s.nativeOverlayBlockers[id]),
      setTileDragActive: (active) => set((s) => void (s.tileDragActive = active)),
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
            existingWtId: '',
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
      askMachineAction: (action, id, name, extra) =>
        set((s) => void (s.confirmMachineAction = { action, id, name, ...extra })),
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

      openRuntimePin: (machineId, machineName) =>
        set((s) => void (s.runtimePinDialog = { open: true, machineId, machineName })),
      closeRuntimePin: () => set((s) => void (s.runtimePinDialog.open = false)),

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
        shellSidebars: s.shellSidebars,
        sshRightSidebars: s.sshRightSidebars,
        gitDiffs: s.gitDiffs,
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

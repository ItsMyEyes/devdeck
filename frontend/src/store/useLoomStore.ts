import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { toast as sonnerToast } from 'sonner'
import type {
  Priority,
  Project,
  Workspace,
  Worktree,
} from './types'

export type EditKind = 'worktree' | 'project' | 'workspace'
export type TodoFilter = 'all' | 'active' | 'done'
export type NewProjectMode = 'local' | 'clone'
export type BrowseTarget = 'newPath' | 'cloneParent' | 'edit'

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
  spawn: SpawnState
  newProject: NewProjectState
  newWorkspace: { open: boolean; name: string }
  browse: { open: boolean; target: BrowseTarget; path: string[] }
  edit: EditState
  confirmDelete: { kind: EditKind; id: string; name: string } | null
  todoDraft: { text: string; pri: Priority }
  todoFilter: TodoFilter

  // ---- actions ----
  showToast: (msg: string) => void
  setSidebarOpen: (open: boolean) => void
  toggleWsMenu: () => void
  closeWsMenu: () => void

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
  openBrowse: (target: BrowseTarget, initialPath?: string) => void
  closeBrowse: () => void
  enterFolder: (name: string) => void
  browseUp: () => void
  browseTo: (index: number) => void
  useFolder: () => void

  // todos (draft only — mutations live in the module UI)
  setTodoDraft: (patch: Partial<{ text: string; pri: Priority }>) => void
  setTodoFilter: (f: TodoFilter) => void
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
      spawn: { open: false, projectId: null, mode: 'branch', branch: '', base: 'main', model: 'claude-sonnet-5', task: '' },
      newProject: { open: false, mode: 'local', name: '', path: '', repo: '', cloneParent: '~', cloneFolder: '' },
      newWorkspace: { open: false, name: '' },
      browse: { open: false, target: 'newPath', path: [] },
      edit: { kind: null, id: null, a: '', b: '', model: '' },
      confirmDelete: null,
      todoDraft: { text: '', pri: 'normal' },
      todoFilter: 'all',

      // Toasts are fired directly through sonner — no store field, so coalesced
      // calls can no longer drop a message.
      showToast: (msg) => sonnerToast(msg),
      setSidebarOpen: (open) => set((s) => void (s.sidebarOpen = open)),
      toggleWsMenu: () => set((s) => void (s.wsMenuOpen = !s.wsMenuOpen)),
      closeWsMenu: () => set((s) => void (s.wsMenuOpen = false)),

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
          s.newProject = { open: true, mode: 'local', name: '', path: '', repo: '', cloneParent: '~', cloneFolder: '' }
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

      openBrowse: (target, initialPath) =>
        set((s) => void (s.browse = { open: true, target, path: browsePathSegments(initialPath) })),
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
    })),
    {
      name: 'loom-ui-v2',
      version: 2,
      // Persist only a harmless UI preference; no domain data ever touches
      // localStorage now that the backend is the source of truth.
      partialize: (s) => ({ sidebarOpen: s.sidebarOpen }),
    },
  ),
)

export { findWs, findProject, findWorktree, wsOfProject, projectOfWorktree }

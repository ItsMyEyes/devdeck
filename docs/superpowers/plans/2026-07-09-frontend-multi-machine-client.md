# Frontend Multi-Machine Client Layer Implementation Plan (Sub-project #2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Context

Approved spec: `docs/superpowers/specs/2026-07-09-hub-runtime-tauri-design.md`. Sub-project #1
(backend, on branch `multi-runtime-master`) already ships: a `Machine` registry
(`GET/POST /api/machines`, `PATCH/DELETE /api/machines/{id}`, `GET
/api/machines/{id}/health`), a key-based dual-auth hub, key-only runtime auth,
`Project.machineId`, and a reverse-proxy fallback at
`/api/machines/{id}/proxy/{rest...}` (REST + WebSocket, with the runtime's key
injected server-side). This sub-project makes the **frontend** consume all of
that: a Machines management page, a client layer that talks to a runtime
**direct-first** (p2p, since every node shares one Tailscale tailnet per the
spec) and falls back to the hub proxy on failure, and `machineId`-scoped
TanStack Query caching for every runtime-owned resource (worktrees, git,
files, terminal, LSP).

**Scope decisions made during planning (read before objecting to something
that looks missing):**

1. **Agent configuration stays hub-scoped in this sub-project.** The spec
   lists "agents" among resources that gain a `machineId` dimension, but the
   current UI (`AgentManagementModule`, `EditDrawer`, `SpawnDialog`) has zero
   existing machine-selector concept, and building one is a distinct, large
   body of work (which agent CLIs are installed on which machine, a picker in
   three separate surfaces). Migrating it here would roughly double this
   plan's size for a concern that doesn't block anything else working.
   Tracked as an explicit follow-up, not done here.
2. **The Tauri "Connect-to-Hub" screen and desktop mode detection are deferred
   to sub-project #3.** Tauri doesn't exist yet; a screen with no way to
   exercise it end-to-end would be exactly the kind of half-finished feature
   the project's conventions warn against. This sub-project's client layer is
   designed so the hub base can later become configurable without a rewrite,
   but no `window.__TAURI__` code is added here.
3. **`fetchProjectBranches` and `fetchFsList`/`createFsFolder` are treated as
   runtime-scoped**, even though today they sit among "project" functions in
   `api.ts`. Branches come from the actual git repo on disk, and filesystem
   browsing is for picking a path that becomes a project's `path` — both only
   make sense against the specific machine that owns the repo/filesystem.

**Goal:** Machines are manageable in the UI; every worktree-execution surface
(terminal, git panel, file explorer, file editor, LSP) resolves and uses the
correct machine (direct-first with automatic hub-proxy fallback); creating a
project requires picking which machine it lives on.

**Tech stack:** React 19, TanStack Router/Query, zustand, TypeScript
(`verbatimModuleSyntax`), Vite. No frontend unit-test runner exists in this
repo (confirmed: `frontend/package.json` has no `vitest`/`jest` script) —
verification is `npm run typecheck` + `npm run build` per task, plus a full
manual browser walkthrough in the final task, per this project's own
convention ("For UI or frontend changes, start the dev server and use the
feature in a browser before reporting the task as complete").

## Global Constraints

- `@/*` alias for all imports from `src/`; never relative paths into `src/`.
- `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Never hand-edit `frontend/src/routeTree.gen.ts`.
- Route files follow TanStack naming: `w.$wsId.<segment>.tsx`.
- Domain types in `frontend/src/store/types.ts` must stay in sync with
  `backend/internal/domain/models.go` (already in sync as of sub-project #1;
  this plan only adds `'machines'` to `ModuleView`, a frontend-only type).
- Transient UI state → `src/store/useLoomStore.ts` (zustand). Server state →
  `src/features/data/queries.ts` (`@tanstack/react-query`).
- Every data surface renders explicit loading, error, and empty states.
- Mutations invalidate query cache on success; failed mutations show a toast
  (`sonner`) and resync.
- Icons: `lucide-react` only. Design is dark-only, use existing `loom-*` CSS
  custom properties.
- Run `npm run typecheck` after every task; run `npm run build` at least
  after Task 3 and at the end.
- Work happens on a new branch `feat/frontend-multi-machine`, branched from
  `multi-runtime-master` (which already has sub-project #1). Merge back into
  `multi-runtime-master` when done — do not target `main` directly.

---

### Task 1: Machine registry — query layer + Machines page UI

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/features/data/keys.ts`
- Modify: `frontend/src/features/data/queries.ts`
- Modify: `frontend/src/store/types.ts`
- Modify: `frontend/src/store/useLoomStore.ts`
- Modify: `frontend/src/features/SidebarNav.tsx`
- Modify: `frontend/src/features/useScope.ts`
- Modify: `frontend/src/features/overlays/GlobalOverlays.tsx`
- Modify: `frontend/src/features/overlays/ConfirmDeleteDialog.tsx`
- Create: `frontend/src/routes/w.$wsId.machines.tsx`
- Create: `frontend/src/features/machines/MachinesModule.tsx`
- Create: `frontend/src/features/machines/MachineDialog.tsx`

This task is fully self-contained and browser-testable on its own: register,
list, edit, and delete machines, see health status. Nothing else in the app
depends on it yet.

**Interfaces (produced):**
- `frontend/src/lib/api.ts`: `fetchMachines(): Promise<Machine[]>`,
  `createMachine(body: CreateMachineBody): Promise<Machine>`,
  `updateMachine(id: string, patch: UpdateMachineBody): Promise<Machine>`,
  `deleteMachine(id: string): Promise<void>`,
  `fetchMachineHealth(id: string): Promise<MachineHealth>`.
- `frontend/src/features/data/queries.ts`: `useMachines()`,
  `useCreateMachine()`, `useUpdateMachine()`, `useDeleteMachine()`,
  `useMachineHealth(id: string | undefined)`.
- `frontend/src/store/useLoomStore.ts`: new `machineDialog` slice (see below),
  `EditKind` gains `'machine'`.

- [ ] **Step 1: Add Machine CRUD + health functions to `api.ts`.**

  Add `Machine` to the type-only import block at the top of
  `frontend/src/lib/api.ts` (it lists `MCPServer,` then `NewsItem,` around
  line 21 — insert `Machine,` between them; import path is unchanged, just
  add the identifier).

  Add near the end of the file (after the Tools section, or any section — it
  doesn't depend on anything else):

  ```ts
  // ---- Machines (hub registry of runtime machines) ----

  export interface CreateMachineBody {
    name: string
    url: string
    key: string
  }

  export interface UpdateMachineBody {
    name?: string
    url?: string
    key?: string
  }

  export interface MachineHealth {
    status: 'online' | 'offline'
    latencyMs?: number
  }

  export function fetchMachines(): Promise<Machine[]> {
    return request<Machine[]>('GET', '/machines')
  }

  export function createMachine(body: CreateMachineBody): Promise<Machine> {
    return request<Machine>('POST', '/machines', body)
  }

  export function updateMachine(id: string, patch: UpdateMachineBody): Promise<Machine> {
    return request<Machine>('PATCH', `/machines/${id}`, patch)
  }

  export function deleteMachine(id: string): Promise<void> {
    return request<void>('DELETE', `/machines/${id}`)
  }

  export function fetchMachineHealth(id: string): Promise<MachineHealth> {
    return request<MachineHealth>('GET', `/machines/${id}/health`)
  }
  ```

- [ ] **Step 2: Add cache keys.** In `frontend/src/features/data/keys.ts`, add
  to the `qk` object (anywhere, e.g. after `authConfig`):

  ```ts
  machines: ['machines'] as const,
  machineHealth: (id: string) => ['machines', id, 'health'] as const,
  ```

- [ ] **Step 3: Add query/mutation hooks.** In
  `frontend/src/features/data/queries.ts`, add `Machine` to the `import type
  { ... } from '@/store/types'` line (currently `import type { Workspace }
  from '@/store/types'` — change to `import type { Machine, Workspace } from
  '@/store/types'`). Add `fetchMachines, createMachine, updateMachine,
  deleteMachine, fetchMachineHealth` to the existing `import { ... } from
  '@/lib/api'` value-import block (alphabetical position doesn't matter for
  compilation — insert near the other `fetch*`/`create*` entries), and
  `CreateMachineBody, UpdateMachineBody` to the `import type { ... } from
  '@/lib/api'` block. Then add, anywhere after the imports (e.g. right after
  `useSettings`):

  ```ts
  // ---- Machines ----

  export function useMachines() {
    return useQuery({ queryKey: qk.machines, queryFn: fetchMachines, staleTime: 10_000 })
  }

  export function useCreateMachine() {
    const queryClient = useQueryClient()
    return useMutation({
      mutationFn: (body: CreateMachineBody) => createMachine(body),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.machines }),
    })
  }

  export function useUpdateMachine() {
    const queryClient = useQueryClient()
    return useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: UpdateMachineBody }) => updateMachine(id, patch),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.machines }),
    })
  }

  export function useDeleteMachine() {
    const queryClient = useQueryClient()
    return useMutation({
      mutationFn: (id: string) => deleteMachine(id),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.machines }),
    })
  }

  export function useMachineHealth(id: string | undefined) {
    return useQuery({
      queryKey: qk.machineHealth(id ?? ''),
      queryFn: () => fetchMachineHealth(id!),
      enabled: !!id,
      staleTime: 5_000,
      refetchInterval: 15_000,
    })
  }
  ```

- [ ] **Step 4: `ModuleView` + store slice.** In
  `frontend/src/store/types.ts`, change the `ModuleView` type (currently
  `'agents' | 'management' | 'news' | 'todos' | 'invoices' | 'tools' |
  'browser'`) to add `| 'machines'`.

  In `frontend/src/store/useLoomStore.ts`:
  - Change `export type EditKind = 'worktree' | 'project' | 'workspace'` to
    `export type EditKind = 'worktree' | 'project' | 'workspace' | 'machine'`.
  - Add a new interface near the other dialog-state interfaces:
    ```ts
    interface MachineDialogState {
      open: boolean
      editingId: string | null
      name: string
      url: string
      key: string
    }
    ```
  - Add `machineDialog: MachineDialogState` to the `LoomState` interface's
    state fields, and these three actions to its actions block:
    ```ts
    openAddMachine: () => void
    openEditMachine: (id: string, name: string, url: string, key: string) => void
    closeMachineDialog: () => void
    setMachineDialog: (patch: Partial<Omit<MachineDialogState, 'open' | 'editingId'>>) => void
    ```
  - In the store's `create(...)` body, initialize `machineDialog: { open:
    false, editingId: null, name: '', url: '', key: '' }` alongside the other
    initial state (near `newWorkspace: { open: false, name: '' }`), and
    implement the four actions following the exact pattern already used by
    `openNewWorkspace`/`closeNewWorkspace`/`setNewWorkspace`:
    ```ts
    openAddMachine: () =>
      set((s) => void (s.machineDialog = { open: true, editingId: null, name: '', url: '', key: '' })),
    openEditMachine: (id, name, url, key) =>
      set((s) => void (s.machineDialog = { open: true, editingId: id, name, url, key })),
    closeMachineDialog: () => set((s) => void (s.machineDialog.open = false)),
    setMachineDialog: (patch) => set((s) => void Object.assign(s.machineDialog, patch)),
    ```
    (Match whatever `set`/immer call convention the surrounding
    `openNewWorkspace` etc. use exactly — copy their statement shape, not just
    the idea.)

- [ ] **Step 5: Extend delete confirmation for machines.** In
  `frontend/src/features/overlays/ConfirmDeleteDialog.tsx`:
  - Import `useDeleteMachine` from `@/features/data/queries`.
  - In `bodyFor()`, add a branch: `if (kind === 'machine') return \`This
    removes machine "${name}" from the registry. Projects still pointing at
    it will show as unreachable until reassigned.\``
  - In `onDelete()`, add a branch for `kind === 'machine'` that calls
    `deleteMachine.mutate(id, { onSuccess: () => { cancelConfirm(); toast() }
    })` (no navigation needed — machines aren't workspace/project-scoped).
    Add `const deleteMachine = useDeleteMachine()` alongside the other
    delete-mutation hooks at the top of the component.

- [ ] **Step 6: `MachineDialog.tsx`.** Create
  `frontend/src/features/machines/MachineDialog.tsx`:

  ```tsx
  import { Loader2 } from 'lucide-react'
  import { Button } from '@/components/ui/button'
  import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
  import { Input } from '@/components/ui/input'
  import { Label } from '@/components/ui/label'
  import { useCreateMachine, useUpdateMachine } from '@/features/data/queries'
  import { useLoomStore } from '@/store/useLoomStore'

  export function MachineDialog() {
    const dialog = useLoomStore((s) => s.machineDialog)
    const setDialog = useLoomStore((s) => s.setMachineDialog)
    const close = useLoomStore((s) => s.closeMachineDialog)
    const showToast = useLoomStore((s) => s.showToast)
    const createMachine = useCreateMachine()
    const updateMachine = useUpdateMachine()

    const isEdit = dialog.editingId !== null
    const busy = createMachine.isPending || updateMachine.isPending
    const canSubmit = dialog.name.trim().length > 0 && dialog.url.trim().length > 0 && dialog.key.trim().length > 0 && !busy

    function submit() {
      if (!canSubmit) return
      const body = { name: dialog.name.trim(), url: dialog.url.trim(), key: dialog.key.trim() }
      if (isEdit && dialog.editingId) {
        updateMachine.mutate(
          { id: dialog.editingId, patch: body },
          {
            onSuccess: () => {
              close()
              showToast(`Updated machine "${body.name}"`)
            },
            onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to update machine'),
          },
        )
        return
      }
      createMachine.mutate(body, {
        onSuccess: () => {
          close()
          showToast(`Added machine "${body.name}"`)
        },
        onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to add machine'),
      })
    }

    return (
      <Dialog open={dialog.open} onOpenChange={(o) => !o && !busy && close()} width={480}>
        <DialogTitle>{isEdit ? 'Edit machine' : 'Add machine'}</DialogTitle>
        <DialogDescription className="mb-[18px]">
          Runtime machines run worktrees, terminals, and git — reachable over your tailnet.
        </DialogDescription>

        <Label>Name</Label>
        <Input
          value={dialog.name}
          disabled={busy}
          onChange={(e) => setDialog({ name: e.target.value })}
          placeholder="builder"
          className="mb-3 font-mono"
        />

        <Label>URL</Label>
        <Input
          value={dialog.url}
          disabled={busy}
          onChange={(e) => setDialog({ url: e.target.value })}
          placeholder="https://builder.tail-x.ts.net:8989"
          className="mb-3 font-mono"
        />

        <Label>Key</Label>
        <Input
          value={dialog.key}
          disabled={busy}
          type="password"
          onChange={(e) => setDialog({ key: e.target.value })}
          placeholder="runtime --key value"
          className="mb-5 font-mono"
        />

        <div className="flex justify-end gap-2.5">
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {isEdit ? 'Save' : 'Add machine →'}
          </Button>
        </div>
      </Dialog>
    )
  }
  ```

  Adjust import paths for `Dialog`/`Input`/`Label`/`Button` if this repo's
  actual paths differ subtly from `NewProjectDialog.tsx`'s imports (they
  should match exactly — copy from there if unsure).

- [ ] **Step 7: `MachinesModule.tsx`.** Create
  `frontend/src/features/machines/MachinesModule.tsx`:

  ```tsx
  import { Loader2, Plus, Server } from 'lucide-react'
  import { Button } from '@/components/ui/button'
  import type { Machine } from '@/store/types'
  import { useMachineHealth, useMachines } from '@/features/data/queries'
  import { useLoomStore } from '@/store/useLoomStore'

  function HealthBadge({ machineId }: { machineId: string }) {
    const { data, isLoading } = useMachineHealth(machineId)
    if (isLoading || !data) {
      return <span className="font-mono text-[10.5px] text-loom-dim">checking…</span>
    }
    if (data.status === 'online') {
      return (
        <span className="font-mono text-[10.5px] text-loom-green-soft">
          online{data.latencyMs !== undefined ? ` · ${data.latencyMs}ms` : ''}
        </span>
      )
    }
    return <span className="font-mono text-[10.5px] text-loom-red-soft">offline</span>
  }

  function MachineRow({ machine }: { machine: Machine }) {
    const openEditMachine = useLoomStore((s) => s.openEditMachine)
    const askDelete = useLoomStore((s) => s.askDelete)
    return (
      <div className="flex items-center gap-3 border-b border-loom-border px-3 py-2.5">
        <Server size={14} className="flex-none text-loom-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12.5px] text-loom-fg-2">{machine.name}</div>
          <div className="truncate font-mono text-[10.5px] text-loom-dim-2">{machine.url}</div>
        </div>
        <HealthBadge machineId={machine.id} />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => openEditMachine(machine.id, machine.name, machine.url, machine.key)}
        >
          Edit
        </Button>
        <Button variant="destructive" size="sm" onClick={() => askDelete('machine', machine.id, machine.name)}>
          Delete
        </Button>
      </div>
    )
  }

  export function MachinesModule() {
    const { data: machines, isLoading, error, refetch } = useMachines()
    const openAddMachine = useLoomStore((s) => s.openAddMachine)

    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-none items-center gap-2.5 border-b border-loom-border px-4 py-3">
          <h1 className="flex-1 font-mono text-[13px] font-medium text-loom-fg">Machines</h1>
          <Button size="sm" onClick={openAddMachine}>
            <Plus size={13} />
            Add machine
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex h-[120px] items-center justify-center">
              <Loader2 size={22} strokeWidth={1.5} className="animate-spin text-loom-dim-2" />
            </div>
          ) : error ? (
            <div className="flex h-[120px] flex-col items-center justify-center gap-3 px-4">
              <span className="text-center font-mono text-xs text-loom-dim-2">
                {error instanceof Error ? error.message : 'Failed to load machines'}
              </span>
              <Button variant="secondary" size="sm" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          ) : !machines || machines.length === 0 ? (
            <div className="flex h-[120px] items-center justify-center font-mono text-xs text-loom-dim-2">
              No machines registered yet
            </div>
          ) : (
            machines.map((m) => <MachineRow key={m.id} machine={m} />)
          )}
        </div>
      </div>
    )
  }
  ```

- [ ] **Step 8: Route + nav + mounting.** Create
  `frontend/src/routes/w.$wsId.machines.tsx`, following the exact shape of
  the existing `w.$wsId.tools.tsx` (read that file first to copy its
  structure precisely — same `createFileRoute('/w/$wsId/machines')` pattern,
  swapping in `MachinesModule`).

  In `frontend/src/features/useScope.ts`, add a branch: `else if
  (pathname.includes('/machines')) view = 'machines'` (place it among the
  other `else if` branches, before the final `return`).

  In `frontend/src/features/SidebarNav.tsx`: import `Server` from
  `lucide-react` (add to the existing lucide import line), add `{ key:
  'machines', label: 'Machines', Icon: Server, badge: 0 }` to the `items`
  array (the generic `goto()` fallback `navigate({ to: `/w/${key}` })`
  already handles it — no change needed there).

  In `frontend/src/features/overlays/GlobalOverlays.tsx`, import and mount
  `MachineDialog` alongside the other overlays.

- [ ] **Step 9: Verify.**

  ```bash
  cd frontend && npm run typecheck
  ```

  Expected: no errors. Then start the dev server (`npm run dev` from repo
  root, or `cd frontend && npm run dev:web` against an already-running
  backend) and manually: open a workspace, click "Machines" in the sidebar,
  add a machine (any name/url/key — health will show offline unless a real
  runtime is running, that's expected and correct), edit it, delete it,
  confirm loading/error/empty states render correctly (kill the backend
  briefly to see the error state, or check the network tab).

- [ ] **Step 10: Commit.**

  ```bash
  git add frontend/src/lib/api.ts frontend/src/features/data/keys.ts frontend/src/features/data/queries.ts \
    frontend/src/store/types.ts frontend/src/store/useLoomStore.ts frontend/src/features/SidebarNav.tsx \
    frontend/src/features/useScope.ts frontend/src/features/overlays/GlobalOverlays.tsx \
    frontend/src/features/overlays/ConfirmDeleteDialog.tsx frontend/src/routes/w.\$wsId.machines.tsx \
    frontend/src/features/machines/MachinesModule.tsx frontend/src/features/machines/MachineDialog.tsx
  git commit -m "$(cat <<'EOF'
  feat(machines): machine registry query layer and Machines page

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 2: Client layer plumbing — direct-first resolution + WS builders

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Create: `frontend/src/lib/machineClient.ts`
- Modify: `frontend/src/lib/terminalClient.ts`
- Modify: `frontend/src/features/terminal/lspClient.ts`

Pure plumbing, no consumers wired yet (Task 3 wires it in) — this task's
correctness is verified by typecheck/build now, and by the real end-to-end
walkthrough in Task 6.

**Interfaces (produced):**
- `frontend/src/lib/api.ts`: `request<T>()` becomes exported and gains a 4th
  optional `opts?: RequestOpts` param — every existing call site keeps
  compiling unchanged (opts is optional).
- `frontend/src/lib/machineClient.ts`: `resolveMachineMode(machine):
  Promise<'direct'|'proxy'>`, `machineRequest<T>(machine, method, path,
  body?): Promise<T>`, `machineWsUrl(machine, path, params):
  Promise<string>`.
- `frontend/src/lib/terminalClient.ts`: `terminalWsUrl(machine, session,
  cols, rows): Promise<string>` (was synchronous, returning `string`
  directly — now async).
- `frontend/src/features/terminal/lspClient.ts`: `acquireLspClient(machine,
  worktreeId, languageId): Promise<{client: LspClient; release: () =>
  void}>` (was synchronous — now async). `LspClient`'s constructor changes
  from `(worktreeId: string, language: string)` to `(url: string)`.

- [ ] **Step 1: Generalize `request()` in `api.ts`.** Find the current
  implementation:

  ```ts
  async function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = JSON.stringify(body)
    }

    let res: Response
    try {
      res = await fetch(`${API_BASE}${path}`, init)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network request failed'
      throw new ApiError(message, 0)
    }

    if (!res.ok) {
      throw await toApiError(res)
    }

    if (res.status === 204) return undefined as T

    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }
  ```

  Replace it with:

  ```ts
  export interface RequestOpts {
    /** Overrides API_BASE — used by machineClient.ts to target a runtime machine directly or via the hub proxy. */
    base?: string
    /** Extra headers merged in alongside Content-Type (e.g. a runtime's bearer key). */
    headers?: Record<string, string>
  }

  export async function request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    opts?: RequestOpts,
  ): Promise<T> {
    const init: RequestInit = { method }
    const headers: Record<string, string> = { ...opts?.headers }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    if (Object.keys(headers).length > 0) init.headers = headers

    let res: Response
    try {
      res = await fetch(`${opts?.base ?? API_BASE}${path}`, init)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network request failed'
      throw new ApiError(message, 0)
    }

    if (!res.ok) {
      throw await toApiError(res)
    }

    if (res.status === 204) return undefined as T

    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }
  ```

- [ ] **Step 2: Create `machineClient.ts`.**

  ```ts
  // Direct-first client for runtime machines: every node shares one Tailscale
  // tailnet, so REST and WebSocket requests try the machine's own URL first
  // and fall back to the hub's reverse-proxy fallback path on failure.
  // See docs/superpowers/specs/2026-07-09-hub-runtime-tauri-design.md.

  import type { Machine } from '@/store/types'
  import { request, type RequestOpts } from './api'

  const DIRECT_PROBE_TIMEOUT_MS = 1500
  const MODE_TTL_MS = 30_000

  type Mode = 'direct' | 'proxy'

  const modeCache = new Map<string, { mode: Mode; checkedAt: number }>()

  /** ws:// or wss:// + host, matching the page's own protocol (mirrors the pattern in terminalClient.ts). */
  function pageWsOrigin(): string {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${window.location.host}`
  }

  function trimSlash(url: string): string {
    return url.replace(/\/+$/, '')
  }

  function directRestBase(machine: Machine): string {
    return `${trimSlash(machine.url)}/api`
  }

  function directWsBase(machine: Machine): string {
    return `${trimSlash(machine.url).replace(/^http/, 'ws')}/ws`
  }

  function proxyRestBase(machine: Machine): string {
    return `/api/machines/${machine.id}/proxy/api`
  }

  function proxyWsBase(machine: Machine): string {
    return `${pageWsOrigin()}/api/machines/${machine.id}/proxy/ws`
  }

  async function probeDirect(machine: Machine): Promise<boolean> {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), DIRECT_PROBE_TIMEOUT_MS)
      const res = await fetch(`${trimSlash(machine.url)}/api/health`, {
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${machine.key}` },
      })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Resolves whether a machine is reachable direct or needs the hub-proxy
   * fallback, caching the answer briefly so a burst of calls (e.g. opening a
   * worktree, which fires several queries at once) doesn't each re-probe.
   */
  export async function resolveMachineMode(machine: Machine): Promise<Mode> {
    const cached = modeCache.get(machine.id)
    if (cached && Date.now() - cached.checkedAt < MODE_TTL_MS) return cached.mode
    const mode: Mode = (await probeDirect(machine)) ? 'direct' : 'proxy'
    modeCache.set(machine.id, { mode, checkedAt: Date.now() })
    return mode
  }

  async function resolveMachineRest(machine: Machine): Promise<RequestOpts> {
    const mode = await resolveMachineMode(machine)
    return mode === 'direct'
      ? { base: directRestBase(machine), headers: { Authorization: `Bearer ${machine.key}` } }
      : { base: proxyRestBase(machine) }
  }

  /** Issues a request against a machine's runtime, direct-first with hub-proxy fallback. */
  export async function machineRequest<T>(
    machine: Machine,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const opts = await resolveMachineRest(machine)
    return request<T>(method, path, body, opts)
  }

  /**
   * WS URL for a machine's runtime, direct-first with hub-proxy fallback.
   * In direct mode the runtime's key rides the `key` query param (the
   * browser WebSocket API cannot set headers); in proxy mode the page's own
   * hub auth already covers the request and no key is added.
   */
  export async function machineWsUrl(
    machine: Machine,
    path: string,
    params: Record<string, string>,
  ): Promise<string> {
    const mode = await resolveMachineMode(machine)
    const query = new URLSearchParams(params)
    if (mode === 'direct') {
      query.set('key', machine.key)
      return `${directWsBase(machine)}${path}?${query.toString()}`
    }
    return `${proxyWsBase(machine)}${path}?${query.toString()}`
  }
  ```

- [ ] **Step 3: Rewrite `terminalClient.ts`.** Replace the whole file:

  ```ts
  import type { Machine } from '@/store/types'
  import { machineWsUrl } from './machineClient'

  export function terminalWsUrl(machine: Machine, session: string, cols: number, rows: number): Promise<string> {
    return machineWsUrl(machine, '/terminal', { session, cols: String(cols), rows: String(rows) })
  }

  export function inputFrame(data: string): string {
    return JSON.stringify({ type: 'input', data })
  }

  export function resizeFrame(cols: number, rows: number): string {
    return JSON.stringify({ type: 'resize', cols, rows })
  }
  ```

  (Keep `inputFrame`/`resizeFrame` byte-for-byte identical to the current
  file — only `terminalWsUrl` changes. Read the current file first to copy
  their exact bodies if they differ from the placeholder above; do not guess
  the frame format.)

- [ ] **Step 4: Rewrite `lspClient.ts`'s URL/acquire logic.** In
  `frontend/src/features/terminal/lspClient.ts`:

  Add `import type { Machine } from '@/store/types'` and `import {
  machineWsUrl } from '@/lib/machineClient'` near the top.

  Delete the `websocketURL(worktreeId, language)` function entirely (its
  logic moves into `machineWsUrl`, called from the new `createLspClient`
  below).

  Change the `clients` cache and `acquireLspClient` from:

  ```ts
  const clients = new Map<string, { client: LspClient; refs: number }>()
  ...
  export function acquireLspClient(worktreeId: string, languageId: string) {
    const language = serverLanguage(languageId)
    const key = `${worktreeId}:${language}`
    let entry = clients.get(key)
    if (!entry) {
      entry = { client: new LspClient(worktreeId, language), refs: 0 }
      clients.set(key, entry)
    }
    entry.refs += 1
    let released = false

    return {
      client: entry.client,
      release() {
        if (released) return
        released = true
        const current = clients.get(key)
        if (!current) return
        current.refs -= 1
        if (current.refs <= 0) {
          clients.delete(key)
          current.client.dispose()
        }
      },
    }
  }
  ```

  to:

  ```ts
  const clients = new Map<string, { clientPromise: Promise<LspClient>; refs: number }>()

  async function createLspClient(machine: Machine, worktreeId: string, language: string): Promise<LspClient> {
    const url = await machineWsUrl(machine, '/lsp', { worktree: worktreeId, language })
    return new LspClient(url)
  }

  export async function acquireLspClient(machine: Machine, worktreeId: string, languageId: string) {
    const language = serverLanguage(languageId)
    const key = `${machine.id}:${worktreeId}:${language}`
    let entry = clients.get(key)
    if (!entry) {
      entry = { clientPromise: createLspClient(machine, worktreeId, language), refs: 0 }
      clients.set(key, entry)
    }
    entry.refs += 1
    let released = false
    const client = await entry.clientPromise

    return {
      client,
      release() {
        if (released) return
        released = true
        const current = clients.get(key)
        if (!current) return
        current.refs -= 1
        if (current.refs <= 0) {
          clients.delete(key)
          void current.clientPromise.then((c) => c.dispose())
        }
      },
    }
  }
  ```

  Change `LspClient`'s constructor from:

  ```ts
  constructor(worktreeId: string, language: string) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.ready.catch(() => undefined)
    this.socket = new WebSocket(websocketURL(worktreeId, language))
    ...
  ```

  to:

  ```ts
  constructor(url: string) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.ready.catch(() => undefined)
    this.socket = new WebSocket(url)
    ...
  ```

  (Everything else in the constructor body — the two `addEventListener`
  calls — is unchanged; only the two lines above differ.)

- [ ] **Step 5: Verify.**

  ```bash
  cd frontend && npm run typecheck
  ```

  Expected: errors in `CodeFileEditor.tsx` and `Terminal.tsx` (their callers
  of `acquireLspClient`/`terminalWsUrl` haven't been updated for the new
  async signatures yet) — that's expected at this point, since those files
  are Task 3's job. Confirm the errors are ONLY in those two files (and their
  direct callers), not in `api.ts`, `machineClient.ts`, `terminalClient.ts`,
  or `lspClient.ts` themselves — those four must be clean.

- [ ] **Step 6: Commit.**

  ```bash
  git add frontend/src/lib/api.ts frontend/src/lib/machineClient.ts frontend/src/lib/terminalClient.ts \
    frontend/src/features/terminal/lspClient.ts
  git commit -m "$(cat <<'EOF'
  feat(machines): direct-first client layer with hub-proxy fallback

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

  (This commit intentionally leaves `npm run typecheck` failing in two
  not-yet-updated consumer files — Task 3 fixes that. Committing here keeps
  the diff reviewable in logical layers; if your workflow requires a green
  build at every commit, merge Task 2 and Task 3 into one commit instead.)

---

### Task 3: Runtime execution surface migration

**Files:**
- Create: `frontend/src/lib/machineApi.ts`
- Modify: `frontend/src/features/data/keys.ts`
- Modify: `frontend/src/features/data/queries.ts`
- Modify: `frontend/src/features/terminal/ExpandedTerminal.tsx`
- Modify: `frontend/src/features/terminal/GitPanel.tsx`
- Modify: `frontend/src/features/terminal/TerminalExplorer.tsx`
- Modify: `frontend/src/features/terminal/FileEditor.tsx`
- Modify: `frontend/src/features/terminal/FileQuickOpen.tsx`
- Modify: `frontend/src/features/terminal/CodeFileEditor.tsx`
- Modify: `frontend/src/features/terminal/Terminal.tsx`
- Modify: `frontend/src/features/overlays/SpawnDialog.tsx`
- Modify: `frontend/src/features/overlays/ConfirmDeleteDialog.tsx`

This is the large, atomic task: `queries.ts` is a single shared file consumed
by all of these components, so they must change together for `tsc --noEmit`
to pass. There is no way to split it into independently-compiling pieces
without introducing temporary duplicate code paths, which isn't worth it for
a one-time migration.

**Interfaces (produced/changed):** every runtime-scoped function in
`machineApi.ts` takes `machine: Machine` as its first parameter (see exact
signatures in Step 1). Every runtime-scoped hook in `queries.ts`
(`useWorktreeFiles`, `useGitStatus`, `useGitLog`, `useGitDiff`, `useGitStage`,
`useGitUnstage`, `useGitDiscard`, `useGitCommit`, `useGitPush`, `useGitPull`,
`useWorktreeFile`, `useWorktreeFileSearch`, `useWriteWorktreeFile`,
`useDeleteWorktreeFile`, `useInvalidateWorktreeFiles`, `useProjectBranches`,
`useFsList`, `useCreateFsFolder`, `useCreateWorktree`, `useUpdateWorktree`,
`useDeleteWorktree`) gains a `machine: Machine` parameter (as the first
positional arg for query hooks, or inside the mutation-variables object for
mutation hooks, matching how `worktreeId`/`id` are already passed).

- [ ] **Step 1: Create `machineApi.ts`.** This moves the following out of
  `api.ts` verbatim except for the added `machine: Machine` first parameter
  and calling `machineRequest` instead of `request`: `CreateWorktreeBody`,
  `UpdateWorktreeBody`, `createWorktree`, `updateWorktree`, `deleteWorktree`,
  `WorktreeFileEntry`, `WorktreeFileContent`, `fetchWorktreeFiles`,
  `fetchWorktreeFile`, `writeWorktreeFile`, `deleteWorktreeFile`,
  `searchWorktreeFiles`, `GitStatusFile`, `GitStatus`, `GitCommit`,
  `GitDiff`, `fetchGitStatus`, `fetchGitDiff`, `fetchGitLog`, `gitStage`,
  `gitUnstage`, `gitDiscard`, `gitCommit`, `gitPush`, `gitPull`,
  `fetchProjectBranches`, `FsListResponse`, `CreateFsFolderBody`,
  `CreateFsFolderResponse`, `fetchFsList`, `createFsFolder`.

  ```ts
  // Typed client for runtime-machine-scoped resources: worktrees, worktree
  // files, worktree git, project branches, and filesystem browsing. Every
  // function takes the target Machine and resolves direct-vs-proxy through
  // machineClient.ts. Hub-scoped resources (workspaces, todos, invoices, ...)
  // stay in api.ts.

  import type { FsEntry, Machine, TermLine, Worktree } from '@/store/types'
  import { machineRequest } from './machineClient'

  // ---- Worktrees ----

  export interface CreateWorktreeBody {
    mode: 'branch' | 'root'
    branch?: string
    base?: string
    model: string
    agent: string
    task?: string
  }

  export interface UpdateWorktreeBody {
    branch?: string
    base?: string
    model?: string
    task?: string
    state?: Worktree['state']
    pending?: string | null
    ahead?: number
    behind?: number
    tokens?: number
    elapsed?: number
    added?: number
    removed?: number
    files?: number
    appendLine?: TermLine
  }

  export function createWorktree(machine: Machine, projectId: string, body: CreateWorktreeBody): Promise<Worktree> {
    return machineRequest<Worktree>(machine, 'POST', `/projects/${projectId}/worktrees`, body)
  }

  export function updateWorktree(machine: Machine, id: string, patch: UpdateWorktreeBody): Promise<Worktree> {
    return machineRequest<Worktree>(machine, 'PATCH', `/worktrees/${id}`, patch)
  }

  export function deleteWorktree(machine: Machine, id: string): Promise<void> {
    return machineRequest<void>(machine, 'DELETE', `/worktrees/${id}`)
  }

  // ---- Worktree files ----

  export interface WorktreeFileEntry {
    name: string
    path: string
    isDir: boolean
    size: number
  }

  export interface WorktreeFileContent {
    path: string
    content: string
  }

  export function fetchWorktreeFiles(machine: Machine, worktreeId: string, path = ''): Promise<WorktreeFileEntry[]> {
    return machineRequest<WorktreeFileEntry[]>(
      machine,
      'GET',
      `/worktrees/${worktreeId}/files?path=${encodeURIComponent(path)}`,
    )
  }

  export function fetchWorktreeFile(machine: Machine, worktreeId: string, path: string): Promise<WorktreeFileContent> {
    return machineRequest<WorktreeFileContent>(
      machine,
      'GET',
      `/worktrees/${worktreeId}/file?path=${encodeURIComponent(path)}`,
    )
  }

  export function writeWorktreeFile(
    machine: Machine,
    worktreeId: string,
    body: WorktreeFileContent,
  ): Promise<WorktreeFileContent> {
    return machineRequest<WorktreeFileContent>(machine, 'PUT', `/worktrees/${worktreeId}/file`, body)
  }

  export function deleteWorktreeFile(machine: Machine, worktreeId: string, path: string): Promise<void> {
    return machineRequest<void>(machine, 'DELETE', `/worktrees/${worktreeId}/file?path=${encodeURIComponent(path)}`)
  }

  export function searchWorktreeFiles(machine: Machine, worktreeId: string, pattern: string): Promise<string[]> {
    return machineRequest<string[]>(
      machine,
      'GET',
      `/worktrees/${worktreeId}/files/search?pattern=${encodeURIComponent(pattern)}`,
    )
  }

  // ---- Worktree git (source control) ----

  export interface GitStatusFile {
    path: string
    origPath?: string
    index: string
    worktree: string
  }

  export interface GitStatus {
    branch: string
    upstream: string
    ahead: number
    behind: number
    files: GitStatusFile[]
  }

  export interface GitCommit {
    hash: string
    short: string
    author: string
    date: string
    subject: string
    refs: string[]
  }

  export interface GitDiff {
    path: string
    diff: string
  }

  export function fetchGitStatus(machine: Machine, worktreeId: string): Promise<GitStatus> {
    return machineRequest<GitStatus>(machine, 'GET', `/worktrees/${worktreeId}/git/status`)
  }

  export function fetchGitDiff(
    machine: Machine,
    worktreeId: string,
    target: { path: string; staged: boolean; untracked: boolean } | { commit: string },
  ): Promise<GitDiff> {
    const query =
      'commit' in target
        ? `commit=${encodeURIComponent(target.commit)}`
        : `path=${encodeURIComponent(target.path)}&staged=${target.staged}&untracked=${target.untracked}`
    return machineRequest<GitDiff>(machine, 'GET', `/worktrees/${worktreeId}/git/diff?${query}`)
  }

  export function fetchGitLog(machine: Machine, worktreeId: string, limit = 50): Promise<GitCommit[]> {
    return machineRequest<GitCommit[]>(machine, 'GET', `/worktrees/${worktreeId}/git/log?limit=${limit}`)
  }

  export function gitStage(machine: Machine, worktreeId: string, paths: string[]): Promise<void> {
    return machineRequest<void>(machine, 'POST', `/worktrees/${worktreeId}/git/stage`, { paths })
  }

  export function gitUnstage(machine: Machine, worktreeId: string, paths: string[]): Promise<void> {
    return machineRequest<void>(machine, 'POST', `/worktrees/${worktreeId}/git/unstage`, { paths })
  }

  export function gitDiscard(machine: Machine, worktreeId: string, paths: string[]): Promise<void> {
    return machineRequest<void>(machine, 'POST', `/worktrees/${worktreeId}/git/discard`, { paths })
  }

  export function gitCommit(machine: Machine, worktreeId: string, message: string): Promise<void> {
    return machineRequest<void>(machine, 'POST', `/worktrees/${worktreeId}/git/commit`, { message })
  }

  export function gitPush(machine: Machine, worktreeId: string): Promise<void> {
    return machineRequest<void>(machine, 'POST', `/worktrees/${worktreeId}/git/push`)
  }

  export function gitPull(machine: Machine, worktreeId: string): Promise<void> {
    return machineRequest<void>(machine, 'POST', `/worktrees/${worktreeId}/git/pull`)
  }

  // ---- Project branches (the repo lives on this machine's disk) ----

  export function fetchProjectBranches(machine: Machine, projectId: string): Promise<string[]> {
    return machineRequest<string[]>(machine, 'GET', `/projects/${projectId}/branches`)
  }

  // ---- Filesystem (browsing a path on this machine, e.g. for new-project setup) ----

  export interface FsListResponse {
    entries: FsEntry[]
    git: boolean
  }

  export function fetchFsList(machine: Machine, path: string): Promise<FsListResponse> {
    return machineRequest<FsListResponse>(machine, 'GET', `/fs/list?path=${encodeURIComponent(path)}`)
  }

  export interface CreateFsFolderBody {
    path: string
    name: string
  }

  export interface CreateFsFolderResponse {
    path: string
  }

  export function createFsFolder(machine: Machine, body: CreateFsFolderBody): Promise<CreateFsFolderResponse> {
    return machineRequest<CreateFsFolderResponse>(machine, 'POST', '/fs/mkdir', body)
  }
  ```

- [ ] **Step 2: Remove the moved functions/types from `api.ts`.** Delete
  every block moved in Step 1 from `frontend/src/lib/api.ts` (the "Worktrees"
  section including `CreateWorktreeBody`/`UpdateWorktreeBody` and the three
  functions, the "Worktree files" section, the "Worktree git" section,
  `fetchProjectBranches` from the Projects section, and the "Filesystem"
  section). Remove `Worktree` and `FsEntry` from `api.ts`'s top type-only
  import block if nothing else in the file still uses them (check first —
  `Worktree` may still be referenced elsewhere; if so, leave the import).

- [ ] **Step 3: Update `keys.ts`.** Replace:

  ```ts
  worktreeFilesRoot: (id: string) => ['worktrees', id, 'files'] as const,
  worktreeFiles: (id: string, path: string) => ['worktrees', id, 'files', path] as const,
  worktreeFile: (id: string, path: string) => ['worktrees', id, 'file', path] as const,
  worktreeFileSearch: (id: string, pattern: string) =>
    ['worktrees', id, 'file-search', pattern] as const,
  gitRoot: (id: string) => ['worktrees', id, 'git'] as const,
  gitStatus: (id: string) => ['worktrees', id, 'git', 'status'] as const,
  gitLog: (id: string) => ['worktrees', id, 'git', 'log'] as const,
  gitDiff: (id: string, target: string) => ['worktrees', id, 'git', 'diff', target] as const,
  projectBranches: (id: string) => ['projects', id, 'branches'] as const,
  ```

  with:

  ```ts
  worktreeFilesRoot: (machineId: string, id: string) => ['machines', machineId, 'worktrees', id, 'files'] as const,
  worktreeFiles: (machineId: string, id: string, path: string) =>
    ['machines', machineId, 'worktrees', id, 'files', path] as const,
  worktreeFile: (machineId: string, id: string, path: string) =>
    ['machines', machineId, 'worktrees', id, 'file', path] as const,
  worktreeFileSearch: (machineId: string, id: string, pattern: string) =>
    ['machines', machineId, 'worktrees', id, 'file-search', pattern] as const,
  gitRoot: (machineId: string, id: string) => ['machines', machineId, 'worktrees', id, 'git'] as const,
  gitStatus: (machineId: string, id: string) => ['machines', machineId, 'worktrees', id, 'git', 'status'] as const,
  gitLog: (machineId: string, id: string) => ['machines', machineId, 'worktrees', id, 'git', 'log'] as const,
  gitDiff: (machineId: string, id: string, target: string) =>
    ['machines', machineId, 'worktrees', id, 'git', 'diff', target] as const,
  projectBranches: (machineId: string, id: string) =>
    ['machines', machineId, 'projects', id, 'branches'] as const,
  ```

  And replace `fsList: (path: string) => ['fs', 'list', path] as const,` with
  `fsList: (machineId: string, path: string) => ['machines', machineId, 'fs', 'list', path] as const,`.

- [ ] **Step 4: Update `queries.ts` imports.** Remove `createWorktree,
  deleteWorktree, deleteWorktreeFile, fetchFsList, fetchGitDiff,
  fetchGitLog, fetchGitStatus, fetchProjectBranches, fetchWorktreeFile,
  fetchWorktreeFiles, gitCommit, gitDiscard, gitPull, gitPush, gitStage,
  gitUnstage, searchWorktreeFiles, updateWorktree, writeWorktreeFile` from
  the `import { ... } from '@/lib/api'` value block, and `CreateFsFolderBody,
  CreateWorktreeBody, UpdateWorktreeBody` from the `import type { ... } from
  '@/lib/api'` block. Add a new import block:

  ```ts
  import {
    createWorktree,
    deleteWorktree,
    deleteWorktreeFile,
    fetchFsList,
    fetchGitDiff,
    fetchGitLog,
    fetchGitStatus,
    fetchProjectBranches,
    fetchWorktreeFile,
    fetchWorktreeFiles,
    gitCommit,
    gitDiscard,
    gitPull,
    gitPush,
    gitStage,
    gitUnstage,
    searchWorktreeFiles,
    updateWorktree,
    writeWorktreeFile,
    type CreateFsFolderBody,
    type CreateWorktreeBody,
    type UpdateWorktreeBody,
  } from '@/lib/machineApi'
  ```

  Change `import type { Machine, Workspace } from '@/store/types'` (already
  added `Machine` in Task 1) — no change needed here if Task 1 already did
  it; otherwise add `Machine` now.

- [ ] **Step 5: Rewrite the runtime-scoped hooks in `queries.ts`.** Replace
  the `useProjectBranches` through `useDeleteWorktreeFile` block (everything
  from the `// ---- Projects ----` comment through the end of the file) with:

  ```ts
  // ---- Projects (branches live on the machine that owns the repo) ----

  export function useProjectBranches(machine: Machine | undefined, projectId: string | undefined) {
    return useQuery({
      queryKey: qk.projectBranches(machine?.id ?? '', projectId ?? ''),
      queryFn: () => fetchProjectBranches(machine!, projectId!),
      enabled: !!machine && !!projectId,
      staleTime: 30_000,
    })
  }

  // ---- Filesystem (browsing a path on a specific machine) ----

  export function useFsList(machine: Machine | undefined, path: string) {
    return useQuery({
      queryKey: qk.fsList(machine?.id ?? '', path),
      queryFn: () => fetchFsList(machine!, path),
      enabled: !!machine && path.length > 0,
      staleTime: 30_000,
    })
  }

  export function useCreateFsFolder(machine: Machine | undefined) {
    const queryClient = useQueryClient()
    return useMutation({
      mutationFn: (body: CreateFsFolderBody) => createFsFolder(machine!, body),
      onSuccess: (_created, body) => queryClient.invalidateQueries({ queryKey: qk.fsList(machine?.id ?? '', body.path) }),
    })
  }

  export function useWorktreeFiles(machine: Machine, worktreeId: string, path: string) {
    return useQuery({
      queryKey: qk.worktreeFiles(machine.id, worktreeId, path),
      queryFn: () => fetchWorktreeFiles(machine, worktreeId, path),
      enabled: worktreeId.length > 0,
    })
  }

  // ---- Worktree git (source control) ----

  export function useGitStatus(machine: Machine, worktreeId: string, active: boolean) {
    return useQuery({
      queryKey: qk.gitStatus(machine.id, worktreeId),
      queryFn: () => fetchGitStatus(machine, worktreeId),
      enabled: worktreeId.length > 0,
      refetchInterval: active ? 5000 : false,
    })
  }

  export function useGitLog(machine: Machine, worktreeId: string, active: boolean) {
    return useQuery({
      queryKey: qk.gitLog(machine.id, worktreeId),
      queryFn: () => fetchGitLog(machine, worktreeId),
      enabled: worktreeId.length > 0 && active,
    })
  }

  export function useGitDiff(
    machine: Machine,
    worktreeId: string,
    target: { path: string; staged: boolean; untracked: boolean } | { commit: string } | null,
  ) {
    const targetKey =
      target === null
        ? ''
        : 'commit' in target
          ? `commit:${target.commit}`
          : `${target.staged ? 'staged' : 'work'}:${target.untracked ? 'new' : 'mod'}:${target.path}`
    return useQuery({
      queryKey: qk.gitDiff(machine.id, worktreeId, targetKey),
      queryFn: () => fetchGitDiff(machine, worktreeId, target!),
      enabled: worktreeId.length > 0 && target !== null,
      staleTime: 5000,
    })
  }

  /** Mutation over git state; invalidates status + log + cached diffs on settle. */
  function useGitMutation<TVars>(machine: Machine, worktreeId: string, mutationFn: (vars: TVars) => Promise<void>) {
    const queryClient = useQueryClient()
    return useMutation({
      mutationFn,
      onSettled: () => queryClient.invalidateQueries({ queryKey: qk.gitRoot(machine.id, worktreeId) }),
    })
  }

  export function useGitStage(machine: Machine, worktreeId: string) {
    return useGitMutation(machine, worktreeId, (paths: string[]) => gitStage(machine, worktreeId, paths))
  }

  export function useGitUnstage(machine: Machine, worktreeId: string) {
    return useGitMutation(machine, worktreeId, (paths: string[]) => gitUnstage(machine, worktreeId, paths))
  }

  /**
   * Discard reverts files on disk, so beyond git state this also invalidates
   * the file tree and any open file contents under the worktree.
   */
  export function useGitDiscard(machine: Machine, worktreeId: string) {
    const queryClient = useQueryClient()
    return useMutation({
      mutationFn: (paths: string[]) => gitDiscard(machine, worktreeId, paths),
      onSettled: () => queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) }),
    })
  }

  export function useGitCommit(machine: Machine, worktreeId: string) {
    return useGitMutation(machine, worktreeId, (message: string) => gitCommit(machine, worktreeId, message))
  }

  export function useGitPush(machine: Machine, worktreeId: string) {
    return useGitMutation(machine, worktreeId, (_: void) => gitPush(machine, worktreeId))
  }

  export function useGitPull(machine: Machine, worktreeId: string) {
    return useGitMutation(machine, worktreeId, (_: void) => gitPull(machine, worktreeId))
  }

  /** Refetch every loaded folder level of a worktree's file tree. */
  export function useInvalidateWorktreeFiles(machine: Machine, worktreeId: string) {
    const queryClient = useQueryClient()
    return () => queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) })
  }

  export function useWorktreeFile(machine: Machine, worktreeId: string, path: string) {
    return useQuery({
      queryKey: qk.worktreeFile(machine.id, worktreeId, path),
      queryFn: () => fetchWorktreeFile(machine, worktreeId, path),
      enabled: worktreeId.length > 0 && path.length > 0,
      staleTime: 0,
    })
  }

  export function useWorktreeFileSearch(machine: Machine, worktreeId: string, pattern: string, enabled: boolean) {
    return useQuery({
      queryKey: qk.worktreeFileSearch(machine.id, worktreeId, pattern),
      queryFn: () => searchWorktreeFiles(machine, worktreeId, pattern),
      enabled: enabled && worktreeId.length > 0,
      staleTime: 0,
    })
  }

  export function useWriteWorktreeFile(machine: Machine, worktreeId: string) {
    const queryClient = useQueryClient()
    return useMutation({
      mutationFn: (body: { path: string; content: string }) => writeWorktreeFile(machine, worktreeId, body),
      onSuccess: (content) => {
        queryClient.setQueryData(qk.worktreeFile(machine.id, worktreeId, content.path), content)
        return queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) })
      },
    })
  }

  export function useDeleteWorktreeFile(machine: Machine, worktreeId: string) {
    const queryClient = useQueryClient()
    return useMutation({
      mutationFn: (path: string) => deleteWorktreeFile(machine, worktreeId, path),
      onSuccess: (_result, path) => {
        queryClient.removeQueries({ queryKey: qk.worktreeFile(machine.id, worktreeId, path) })
        return queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) })
      },
    })
  }
  ```

  Also update `useCreateWorktree`, `useUpdateWorktree`, `useDeleteWorktree`
  (earlier in the same file, right after `useDeleteProject`) from:

  ```ts
  export function useCreateWorktree() {
    const invalidate = useInvalidateWorkspaces()
    return useMutation({
      mutationFn: ({ projectId, body }: { projectId: string; body: CreateWorktreeBody }) =>
        createWorktree(projectId, body),
      onSuccess: () => invalidate(),
    })
  }

  export function useUpdateWorktree() {
    const invalidate = useInvalidateWorkspaces()
    return useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: UpdateWorktreeBody }) => updateWorktree(id, patch),
      onSuccess: () => invalidate(),
    })
  }

  export function useDeleteWorktree() {
    const invalidate = useInvalidateWorkspaces()
    return useMutation({
      mutationFn: (id: string) => deleteWorktree(id),
      onSuccess: () => invalidate(),
    })
  }
  ```

  to:

  ```ts
  export function useCreateWorktree() {
    const invalidate = useInvalidateWorkspaces()
    return useMutation({
      mutationFn: ({ machine, projectId, body }: { machine: Machine; projectId: string; body: CreateWorktreeBody }) =>
        createWorktree(machine, projectId, body),
      onSuccess: () => invalidate(),
    })
  }

  export function useUpdateWorktree() {
    const invalidate = useInvalidateWorkspaces()
    return useMutation({
      mutationFn: ({ machine, id, patch }: { machine: Machine; id: string; patch: UpdateWorktreeBody }) =>
        updateWorktree(machine, id, patch),
      onSuccess: () => invalidate(),
    })
  }

  export function useDeleteWorktree() {
    const invalidate = useInvalidateWorkspaces()
    return useMutation({
      mutationFn: ({ machine, id }: { machine: Machine; id: string }) => deleteWorktree(machine, id),
      onSuccess: () => invalidate(),
    })
  }
  ```

- [ ] **Step 6: `ExpandedTerminal.tsx` — resolve and fan out `machine`.**
  Add `import { useMachines } from '@/features/data/queries'` (it's likely
  already importing from that module — add to the existing import). Change:

  ```tsx
  const project = useWorkspace(wsId).data?.projects.find(
    (candidate) => candidate.id === projectId,
  )
  ```

  to also resolve the machine:

  ```tsx
  const project = useWorkspace(wsId).data?.projects.find(
    (candidate) => candidate.id === projectId,
  )
  const machines = useMachines().data
  const machine = machines?.find((m) => m.id === project?.machineId)
  ```

  Then thread `machine` to every child that now needs it:
  - `<Terminal key={w.id} ref={termRef} session={w.id} machine={machine} ctrlArmed={ctrlArmed} onCtrlConsumed={...} />`
  - `<GitPanel worktreeId={w.id} machine={machine} active={activeTab === GIT_TAB} />`
  - `<TerminalExplorer key={w.id} worktreeId={w.id} machine={machine} rootLabel={...} onOpenFile={...} onFileDeleted={...} onRequestQuickOpen={...} />`
  - `<FileEditor key={path} worktreeId={w.id} machine={machine} path={path} active={...} onDirtyChange={...} onDeleted={...} onOpenDefinition={...} reveal={...} />`
  - `<FileQuickOpen open={quickOpen} worktreeId={w.id} machine={machine} onClose={...} onOpenFile={openFile} />`

  Since `machine` can be `undefined` (project not yet assigned a machine, the
  registered machine was deleted, or the machines list is still loading), add
  a guard right before the main return: if `!machine`, render a message
  instead of the terminal chrome, matching the existing "worktree not found"
  pattern used one level up in the route component:

  ```tsx
  if (!machine) {
    return (
      <div className="flex flex-1 items-center justify-center font-mono text-sm text-loom-dim">
        no machine assigned to this project — add one from the Machines page
      </div>
    )
  }
  ```

  Place this guard after the existing hooks (React rules of hooks — it must
  come after all `useX()` calls, before the `return (...)` for the main JSX).

  Also update the `approve()` function's `updateWorktree.mutate({ id: w.id,
  patch: ... })` call to `updateWorktree.mutate({ machine, id: w.id, patch:
  ... })`.

- [ ] **Step 7: `GitPanel.tsx` — thread `machine`.** Add `machine: Machine`
  to its props interface (add `import type { Machine } from '@/store/types'`
  if not already imported) and destructure it in the component signature.
  Replace each of these exact call sites with the `machine`-first version:
  - `useGitStatus(worktreeId, active)` → `useGitStatus(machine, worktreeId, active)`
  - `useGitDiff(worktreeId, target)` → `useGitDiff(machine, worktreeId, target)`
  - `useGitLog(worktreeId, active && view === 'history')` → `useGitLog(machine, worktreeId, active && view === 'history')`
  - `useGitStage(worktreeId)` → `useGitStage(machine, worktreeId)`
  - `useGitUnstage(worktreeId)` → `useGitUnstage(machine, worktreeId)`
  - `useGitDiscard(worktreeId)` → `useGitDiscard(machine, worktreeId)`
  - `useGitCommit(worktreeId)` → `useGitCommit(machine, worktreeId)`
  - `useGitPush(worktreeId)` → `useGitPush(machine, worktreeId)`
  - `useGitPull(worktreeId)` → `useGitPull(machine, worktreeId)`

- [ ] **Step 8: `TerminalExplorer.tsx` — thread `machine`.** Add `machine:
  Machine` to its props interface and destructure it. Replace:
  - `useWorktreeFiles(worktreeId, '')` → `useWorktreeFiles(machine, worktreeId, '')`
  - `useWorktreeFiles(worktreeId, path)` → `useWorktreeFiles(machine, worktreeId, path)`
  - `useWriteWorktreeFile(worktreeId)` → `useWriteWorktreeFile(machine, worktreeId)`
  - `useDeleteWorktreeFile(worktreeId)` → `useDeleteWorktreeFile(machine, worktreeId)`
  - `useInvalidateWorktreeFiles(worktreeId)` → `useInvalidateWorktreeFiles(machine, worktreeId)`

- [ ] **Step 9: `FileQuickOpen.tsx` — thread `machine`.** Add `machine:
  Machine` to its props interface and destructure it. Replace:
  - `useWorktreeFileSearch(worktreeId, deferredPattern, open)` → `useWorktreeFileSearch(machine, worktreeId, deferredPattern, open)`

- [ ] **Step 10: `FileEditor.tsx` — thread `machine` (including down to
  `CodeFileEditor`).** Add `machine: Machine` to its props interface and
  destructure it. Replace:
  - `useWorktreeFile(worktreeId, path)` → `useWorktreeFile(machine, worktreeId, path)`
  - `useWriteWorktreeFile(worktreeId)` → `useWriteWorktreeFile(machine, worktreeId)`
  - `useDeleteWorktreeFile(worktreeId)` → `useDeleteWorktreeFile(machine, worktreeId)`

  `FileEditor.tsx` renders `CodeFileEditor` (confirm this by reading the
  file — it imports `CodeFileEditor`-related types per the grep hit in
  `CodeFileEditor.tsx`'s own import list). Add `machine={machine}` to that
  `<CodeFileEditor ... />` call site.

- [ ] **Step 11: `CodeFileEditor.tsx` — async LSP acquisition.** Add
  `machine: Machine` to the destructured props type (the inline `{
  worktreeId, path, value, onChange, onOpenDefinition, reveal }: { ... }`
  signature) — add `machine: Machine` to both the destructuring and the
  inline type. Replace the effect:

  ```tsx
  useEffect(() => {
    setLspClient(null)
    if (!languageId) return
    const acquired = acquireLspClient(worktreeId, languageId)
    setLspClient(acquired.client)
    return acquired.release
  }, [languageId, worktreeId])
  ```

  with:

  ```tsx
  useEffect(() => {
    setLspClient(null)
    if (!languageId) return
    let cancelled = false
    let releaseFn: (() => void) | null = null
    void acquireLspClient(machine, worktreeId, languageId).then((acquired) => {
      if (cancelled) {
        acquired.release()
        return
      }
      releaseFn = acquired.release
      setLspClient(acquired.client)
    })
    return () => {
      cancelled = true
      releaseFn?.()
    }
  }, [languageId, worktreeId, machine])
  ```

  This prevents a race where the effect's dependencies change (or the
  component unmounts) before the async `acquireLspClient` resolves: the
  stale client is released immediately instead of being stored into state
  for a component that no longer wants it.

- [ ] **Step 12: `Terminal.tsx` — resolve the WS URL once per mount, keep the
  reconnect loop synchronous.** Add `machine: Machine` to `TerminalProps`
  and destructure it in the component signature (`{ session, machine,
  ctrlArmed = false, onCtrlConsumed }`). Add `import type { Machine } from
  '@/store/types'`.

  Inside the main `useEffect` (the one with the XTerm setup and `connect`
  closure), the existing `connect` function does:

  ```ts
  const connect = () => {
    if (disposed) return
    const ws = new WebSocket(terminalWsUrl(session, term.cols, term.rows))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    ...
  }
  ```

  Change it to read a URL resolved once, outside the reconnect loop, so the
  careful backoff/mobile-resilience logic in `scheduleReconnect`/`kick`
  (which calls `connect()` synchronously and must keep working exactly as
  before) is untouched:

  ```ts
  let resolvedUrl: string | null = null

  const connect = () => {
    if (disposed || !resolvedUrl) return
    const ws = new WebSocket(resolvedUrl)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    ...
  }
  ```

  (leave the rest of `connect`'s body — `ws.onopen`/`ws.onmessage`/`ws.onclose`/`ws.onerror` — exactly as-is.)

  Then, in place of the existing bare `connect()` call near the bottom of the
  effect (right before `const onData = term.onData(...)`), resolve the URL
  first and kick off the connect/reconnect machinery once it's ready:

  ```ts
  void terminalWsUrl(machine, session, term.cols, term.rows).then((url) => {
    if (disposed) return
    resolvedUrl = url
    connect()
  })
  ```

  Everything else in the effect (the `visibilitychange`/`online` listeners,
  `onData`/`onResize`, the `ResizeObserver`, and the cleanup function) stays
  exactly as it is today — none of it depends on how `connect` obtains its
  URL. Change the effect's dependency array from `[session]` to `[session,
  machine]`.

  Note: `cols`/`rows` are now fixed to whatever they were at the moment the
  effect started, for the lifetime of that effect run (they won't be
  re-read on every reconnect attempt as they technically were before). This
  is harmless: `ws.onopen` already sends a fresh `resizeFrame(term.cols,
  term.rows)` immediately after every connection, which is what actually
  syncs the PTY size — the URL's cols/rows only matter for the PTY's
  very-first spawn size, before that first resize frame arrives a moment
  later.

- [ ] **Step 13: `SpawnDialog.tsx` — resolve `machine` for worktree
  creation.** This file already resolves a `project` object (used for
  `useProjectBranches(project?.id)` — which Task 4 will also touch). Add
  `useMachines` to its imports from `@/features/data/queries`, resolve
  `const machine = useMachines().data?.find((m) => m.id === project?.machineId)`,
  and update its `useCreateWorktree().mutate(...)` call site to include
  `machine` in the mutation variables object (`{ machine, projectId: ...,
  body: ... }`). Guard the submit action so it's disabled/no-ops if
  `!machine` (mirroring how it already gates on other required fields).

- [ ] **Step 14: `ConfirmDeleteDialog.tsx` — resolve `machine` for worktree
  deletion.** Add `useMachines` to its imports. In `onDelete()`'s `kind ===
  'worktree'` branch, which already does `const parent =
  projectOfWorktree(workspaces, id)`, add:

  ```ts
  const machines = useMachines().data
  ```

  (as a hook call at the top of the component, alongside the other hooks —
  not inside `onDelete`, since hooks can't be called conditionally/inside
  callbacks) and inside the `worktree` branch, resolve `const machine =
  machines?.find((m) => m.id === parent?.machineId)`, then change
  `deleteWorktree.mutate(id, { onSuccess: ... })` to
  `deleteWorktree.mutate({ machine: machine!, id }, { onSuccess: ... })` —
  guarded by an early return if `!machine` (show a toast via `showToast`
  instead of attempting the mutation, e.g. `if (!machine) { showToast('Could
  not resolve this worktree's machine'); return }` before calling
  `deleteWorktree.mutate`).

- [ ] **Step 15: Verify.**

  ```bash
  cd frontend && npm run typecheck && npm run build
  ```

  Expected: zero errors. If any consumer file was missed, `tsc` will name it
  exactly — fix and re-run.

  Then, with the dev server running against a real hub + at least one real
  runtime (reuse the binaries from sub-project #1: `--role runtime --key
  rtk` and `--role hub --key hubk` per that plan's Verification section),
  register the runtime as a machine (Task 1's UI), create a project pointing
  at it, open a worktree, and confirm: terminal connects and echoes input,
  Git panel shows status, file explorer lists files, opening a file loads
  its content and (for a `.go`/`.ts` file) shows LSP diagnostics/completion.

- [ ] **Step 16: Commit.**

  ```bash
  git add frontend/src/lib/machineApi.ts frontend/src/lib/api.ts frontend/src/features/data/keys.ts \
    frontend/src/features/data/queries.ts frontend/src/features/terminal/ExpandedTerminal.tsx \
    frontend/src/features/terminal/GitPanel.tsx frontend/src/features/terminal/TerminalExplorer.tsx \
    frontend/src/features/terminal/FileEditor.tsx frontend/src/features/terminal/FileQuickOpen.tsx \
    frontend/src/features/terminal/CodeFileEditor.tsx frontend/src/features/terminal/Terminal.tsx \
    frontend/src/features/overlays/SpawnDialog.tsx frontend/src/features/overlays/ConfirmDeleteDialog.tsx
  git commit -m "$(cat <<'EOF'
  feat(machines): scope worktree/git/file/terminal/LSP surfaces by machine

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 4: Branch list machine resolution (EditDrawer, SpawnDialog)

**Files:**
- Modify: `frontend/src/features/overlays/EditDrawer.tsx`
- Modify: `frontend/src/features/overlays/SpawnDialog.tsx`

`useProjectBranches` now requires a `Machine | undefined` first argument
(Task 3, Step 5). Both call sites already resolve a `project` object; this
task just wires the machine lookup through, the same pattern used in Task
3's Steps 6/13/14.

**Interfaces (changed):** `useProjectBranches(machine, projectId)` call
sites updated in both files; no new exports.

- [ ] **Step 1: `EditDrawer.tsx`.** It already computes `const editProjectId
  = edit.kind === 'worktree' && edit.id ? projectOfWorktree(workspaces,
  edit.id)?.id : undefined` and calls `useProjectBranches(editProjectId)`.
  Add `useMachines` to its imports from `@/features/data/queries`. Resolve
  the project object itself (not just its id) so `machineId` is available:

  ```ts
  const editProject =
    edit.kind === 'worktree' && edit.id
      ? projectOfWorktree(workspaces, edit.id)
      : edit.kind === 'project' && edit.id
        ? findProject(workspaces, edit.id)
        : undefined
  const machines = useMachines().data
  const editMachine = machines?.find((m) => m.id === editProject?.machineId)
  ```

  (Keep the existing `editProjectId` variable if other code in the file
  still uses it for something besides branches — check before removing it;
  if it's now redundant with `editProject?.id`, you may simplify, but that's
  optional polish, not required for this task.)

  Change `const branches = useProjectBranches(editProjectId).data ?? []` to
  `const branches = useProjectBranches(editMachine, editProject?.id).data ?? []`.

- [ ] **Step 2: `SpawnDialog.tsx`.** This file was already touched in Task
  3 Step 13 to resolve `machine` for worktree creation — reuse that same
  `machine` variable here. Change `const branches =
  useProjectBranches(project?.id).data ?? []` to `const branches =
  useProjectBranches(machine, project?.id).data ?? []`.

- [ ] **Step 3: Verify.**

  ```bash
  cd frontend && npm run typecheck
  ```

  Expected: zero errors. Manually: open the Edit drawer for a worktree, and
  the Spawn dialog for a project, confirm the branch dropdown still
  populates against a real runtime.

- [ ] **Step 4: Commit.**

  ```bash
  git add frontend/src/features/overlays/EditDrawer.tsx frontend/src/features/overlays/SpawnDialog.tsx
  git commit -m "$(cat <<'EOF'
  feat(machines): resolve machine for project-branches lookups

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 5: Project creation/clone machine picker + remote folder browsing

**Files:**
- Modify: `frontend/src/store/useLoomStore.ts`
- Modify: `frontend/src/features/overlays/NewProjectDialog.tsx`
- Modify: `frontend/src/features/overlays/FolderBrowser.tsx`
- Modify: `frontend/src/features/overlays/EditDrawer.tsx`
- Modify: `frontend/src/lib/api.ts`

**Interfaces (changed):** `NewProjectState` gains `machineId: string`.
`openBrowse(target, initialPath?, machineId?)` gains a third parameter (the
machine whose filesystem is being browsed). `CloneProjectBody` gains
`machineId?: string`. `CreateProjectBody`/`UpdateProjectBody` already have
`machineId?: string` from sub-project #1.

- [ ] **Step 1: `api.ts` — `CloneProjectBody` gains `machineId`.** Find:

  ```ts
  export interface CloneProjectBody {
    name?: string
    path: string
    repo: string
  }
  ```

  Add `machineId?: string` to it.

- [ ] **Step 2: `useLoomStore.ts` — extend `NewProjectState` and
  `openBrowse`.** Add `machineId: string` to the `NewProjectState`
  interface. Update its two initializers (in `openNewProject` and the
  store's initial state) to include `machineId: ''`.

  Change the `browse` state shape from `{ open: boolean; target:
  BrowseTarget; path: string[] }` to `{ open: boolean; target: BrowseTarget;
  path: string[]; machineId: string }`, and change the `openBrowse` action
  signature from `(target: BrowseTarget, initialPath?: string) => void` to
  `(target: BrowseTarget, initialPath?: string, machineId?: string) =>
  void`. Update its implementation to store `machineId: machineId ?? ''`
  alongside the existing `target`/`path` assignment (match whatever
  statement shape the current `openBrowse` implementation uses — read it
  first, since it likely also resets `path` from `initialPath` in a specific
  way that must be preserved).

- [ ] **Step 3: `NewProjectDialog.tsx` — add the machine picker.** Add
  `useMachines` to its imports from `@/features/data/queries`. Add:

  ```ts
  const machines = useMachines().data ?? []
  ```

  Add a machine `<select>` near the top of the form (right after the
  local/clone mode toggle, before the mode-specific fields), e.g.:

  ```tsx
  <Label>Machine</Label>
  <select
    value={np.machineId}
    disabled={busy}
    onChange={(e) => setNewProject({ machineId: e.target.value })}
    className="mb-3.5 h-9 w-full rounded-lg border border-loom-border-strong bg-loom-bg px-2.5 font-mono text-[12.5px] text-loom-fg-2"
  >
    <option value="">Select a machine…</option>
    {machines.map((m) => (
      <option key={m.id} value={m.id}>
        {m.name}
      </option>
    ))}
  </select>
  ```

  Update `canSubmit` to also require `np.machineId.length > 0`. Update the
  two `openBrowse(...)` call sites to pass the selected machine:
  `openBrowse('newPath', np.path, np.machineId)` and
  `openBrowse('cloneParent', np.cloneParent, np.machineId)`.

  Update the mutation bodies to include `machineId`:
  `createProject.mutate({ wsId, body: { name: np.name, path: np.path,
  machineId: np.machineId } }, ...)` and `cloneProject.mutate({ wsId, body:
  { name: ..., path: cloneTarget, repo: np.repo, machineId: np.machineId }
  }, ...)`.

- [ ] **Step 4: `FolderBrowser.tsx` — browse the selected machine's
  filesystem.** Add `useMachines` to its imports from
  `@/features/data/queries`. Resolve the machine from `browse.machineId`:

  ```ts
  const machines = useMachines().data
  const machine = machines?.find((m) => m.id === browse.machineId)
  ```

  Change `const { data, isLoading, error, refetch } = useFsList(pathLabel)`
  to `useFsList(machine, pathLabel)`, and `const createFolder =
  useCreateFsFolder()` to `useCreateFsFolder(machine)`.

  If `!machine` while `browse.open` is true, render a small inline message
  instead of the folder list (mirroring the existing loading/error branches
  in `renderContent()`) — e.g. add a check at the top of `renderContent()`:
  `if (!machine) return <div className="flex h-[120px] items-center
  justify-center font-mono text-xs text-loom-dim-2">select a machine
  first</div>`.

- [ ] **Step 5: `EditDrawer.tsx` — pass the existing project's machine when
  browsing its path.** Its `openBrowse('edit', edit.b)` call site (used when
  editing a project's path) should become `openBrowse('edit', edit.b,
  editProject?.machineId)`, reusing the `editProject` variable resolved in
  Task 4 Step 1.

- [ ] **Step 6: Verify.**

  ```bash
  cd frontend && npm run typecheck
  ```

  Expected: zero errors. Manually: open "New project", confirm the machine
  dropdown lists registered machines, select one, click "Browse…" and
  confirm it lists that machine's actual filesystem (requires a real running
  runtime — reuse the sub-project #1 verification binaries), create a
  project, confirm it's created with the right `machineId` (check via the
  Machines page or network tab).

- [ ] **Step 7: Commit.**

  ```bash
  git add frontend/src/store/useLoomStore.ts frontend/src/features/overlays/NewProjectDialog.tsx \
    frontend/src/features/overlays/FolderBrowser.tsx frontend/src/features/overlays/EditDrawer.tsx \
    frontend/src/lib/api.ts
  git commit -m "$(cat <<'EOF'
  feat(machines): machine picker for new/cloned projects and remote folder browsing

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 6: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Full build check.**

  ```bash
  cd frontend && npm run typecheck && npm run build
  cd ../backend && go build ./cmd/server
  ```

  Expected: all clean.

- [ ] **Step 2: Two-node walkthrough.** Reusing the pattern from sub-project
  #1's Verification section:

  ```bash
  cd backend
  go build -o /tmp/loom ./cmd/server
  /tmp/loom --role runtime --key rtk --addr 127.0.0.1:9199 --db /tmp/rt.db --open=false &
  /tmp/loom --role hub --key hubk --addr 127.0.0.1:9198 --db /tmp/hub.db --2fa=false --open=false &
  cd ../frontend && npm run dev:web
  ```

  In the browser (against the hub, e.g. `http://localhost:5173` proxying to
  `127.0.0.1:9198`, or whatever the existing dev proxy setup resolves to —
  check `frontend/vite.config.ts` if unsure of the exact dev URL):

  1. Log in (or register, since `--2fa=false`).
  2. Go to Machines, add a machine pointing at `http://127.0.0.1:9199` with
     key `rtk`. Confirm it shows "online".
  3. Create a workspace (if none exists), then "New project" → select the
     machine just added → Browse… → confirm it lists the runtime's real
     filesystem → pick a folder containing a git repo (or create one via
     "New folder" + `git init` on disk first) → create the project.
  4. Spawn a worktree on that project (branch or root mode), confirm the
     branch dropdown populated from the real repo.
  5. Open the worktree: confirm the terminal connects and running `echo
     hello` in it round-trips; confirm the Git panel shows status; confirm
     the file explorer lists real files; open a file and confirm it loads,
     and for a `.go` or `.ts` file confirm LSP diagnostics/completions
     appear (may take a few seconds for the language server to start).
  6. Kill the runtime process (`kill %1` or find its PID) while the worktree
     page is open — confirm the UI surfaces the machine as unreachable
     (health badge on the Machines page flips to offline; the terminal
     reconnect-with-backoff messaging already handles the WS-level drop).
     Restart the runtime and confirm things recover.
  7. Delete the machine from the Machines page; confirm the confirm-dialog
     copy is sensible and the project referencing it doesn't crash the UI
     (Step 6 of Task 3's `ExpandedTerminal.tsx` guard should show the "no
     machine assigned" message instead of erroring).

  Clean up: kill both backend processes, remove `/tmp/loom`, `/tmp/rt.db`,
  `/tmp/hub.db`.

- [ ] **Step 3: Report.** No commit for this task (verification only) unless
  the walkthrough surfaces a bug — if it does, fix it as a new commit
  (`fix: <description>` + the same Co-Authored-By trailer used throughout
  this plan) before considering the sub-project done.

---

## Notes for execution

- Branch: create `feat/frontend-multi-machine` from `multi-runtime-master`
  before Task 1.
- Tasks are strictly ordered: 1 and 2 can technically run in parallel (they
  don't touch each other's files) but 3 depends on both, 4 and 5 depend on
  3, 6 depends on everything.
- No frontend unit-test runner exists in this repo — do not invent one for
  this plan. Verification is `npm run typecheck`, `npm run build`, and the
  manual browser walkthroughs specified per task.
- After this ships, merge `feat/frontend-multi-machine` back into
  `multi-runtime-master`. Sub-project #3 (Tauri shell) starts from there.

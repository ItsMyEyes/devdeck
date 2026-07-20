# Database Management — Phase 4: Frontend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Database module UI — a sidebar-rail module with a connection registry, a lazy object tree, a virtualized editable data grid with server-side filtering and keyset paging, a commit-preview flow, table/index DDL, and a SQL editor — against the fully-implemented backend from Phases 1–3.

**Architecture:** Mirrors the existing SSH module (`frontend/src/features/ssh/`) file-for-file: a thin route renders a module shell component, a zustand slice holds dialog drafts and other transient UI state, `@tanstack/react-query` hooks in the shared `queries.ts`/`api.ts`/`keys.ts` files own all server state, and every data surface renders explicit loading/error/empty states. Two pieces have no existing pattern to mirror and get purpose-built logic: `dbTabs.ts` (per-connection open-object tab state, modeled on `paneTree.ts`'s tab-array-plus-active-id shape) and `DBTableGrid.tsx` (row virtualization, introduced fresh via `@tanstack/react-virtual` — nothing in this codebase virtualizes today).

**Tech Stack:** React 19, TanStack Router 1.170, TanStack Query 5.101, zustand 5.0, Tailwind v4, `@base-ui/react` 1.6, `@tanstack/react-virtual` (new dependency), CodeMirror 6 (already installed; `@codemirror/lang-sql` is a new addition), `class-variance-authority`, `sonner`.

**Spec:** `docs/superpowers/specs/2026-07-19-database-management-design.md` (section "## Frontend / UI").
**Depends on:** Phases 1–3 (backend, fully implemented — connection registry, read execution, row writes, and DDL) and this plan's own Task N depending on Task N-1 through the chain below.

## Starting state (read this before Task 1)

Confirmed by direct inspection — not assumed:

- **Nothing exists yet.** `find frontend/src -iname "*db*"` returns nothing. No route, no components, no hooks, no API client functions.
- **The domain-type mirror is already half-done.** `frontend/src/store/types.ts` already has `ModuleView` including `'database'`, plus `DBEngine`, `DBConnection`, and `DBSavedQuery` interfaces matching `backend/internal/domain/models.go` field-for-field — presumably added during a backend phase's CONTRACTS.md sync step. **This plan does not touch `types.ts`** — everything it adds (caps, tree nodes, rows requests, row edits, table plans) are transient wire shapes for the `port` package's API surface, not persisted domain models, and belong in `lib/api.ts` next to the fetch functions that use them (exactly where `CreateSSHConnectionBody`/`UpdateSSHConnectionBody` already live) — not in the domain-types convergence file.
- **`frontend/src/features/useScope.ts` has no `/database` branch yet** — its `view` derivation `if/else if` chain checks `/management`, `/news`, `/todos`, `/invoices`, `/browser`, `/tools`, `/machines`, `/ssh` but falls through to the `'agents'` default for anything else, including `/database`. Task 3 adds the missing branch.
- **No test runner is configured for the frontend.** `grep -n '"test"\|vitest\|jest' frontend/package.json` finds nothing, and `frontend/src/features/terminal/fileTreeSelection.test.ts`'s own file header states it plainly: *"Plain assertion-based tests, matching paneTree.test.ts's convention (no Vitest/Jest configured in this project yet). Run manually with: npx tsx <file>.test.ts"*. This plan follows that exact existing convention for `dbTabs.ts`'s pure logic (Task 6) rather than introducing a test framework as an unrequested side effect. Every other task verifies via `npm run typecheck` (which regenerates `routeTree.gen.ts` as a side effect of its `pretypecheck` hook — see `.claude/rules/frontend.md`: *"TanStack Router codegens `src/routeTree.gen.ts` — never hand-edit it"*) plus a manual browser check for anything user-visible.
- **No virtualization or table-grid library is installed anywhere in this codebase.** `DBTableGrid.tsx` (Task 7) is the first thing here that needs one; `@tanstack/react-virtual` is added fresh, chosen for being the same maintainer/API family as the already-installed `@tanstack/react-router`/`@tanstack/react-query`.
- **CodeMirror 6 is already a full dependency set** (`@codemirror/autocomplete`, `commands`, `language`, `language-data`, `lint`, `state`, `theme-one-dark`, `view`, plus `@uiw/react-codemirror`) but **`@codemirror/lang-sql` is not installed** — added fresh in Task 10.

## Global Constraints

- Follow `.claude/rules/frontend.md` in full: `@/*` alias only (never relative imports into `src/`), `import type` for type-only imports (`verbatimModuleSyntax`), server state in `queries.ts`, transient UI state in `useDevDeckStore.ts`, domain types in `types.ts` (this plan adds none), `cn()` for class merging, `cva` for variants, one component per file under `src/features/database/`, explicit loading/error/empty states on every data surface, mutations invalidate their query key on success and show a toast on error, dark-only design using the `devdeck-*` tokens in `globals.css`, `lucide-react` icons only, `sonner` toasts, `npm run typecheck` before every commit.
- **Never hand-edit `frontend/src/routeTree.gen.ts`.** It regenerates automatically from `npm run typecheck`'s `pretypecheck` hook (a throwaway `vite build`) whenever a route file under `frontend/src/routes/` changes.
- Backend API base is `/api` (`frontend/src/lib/api.ts`'s `API_BASE`); every DB endpoint below is `/api/db/...`, matching the routes registered in `backend/cmd/server/main.go` by Phases 1–3.
- Scope calibration, stated explicitly: this plan prioritizes correct data flow, state management, and adherence to the mandatory conventions over maximal visual polish — components are built to the same structural/token conventions as the SSH module (verified against its actual source, not guessed) but are not exhaustively decorated to its exact level of finish. Visual refinement is expected as a deliberate follow-up pass, not a gap in this plan.
- Grid scope: `DBTableGrid.tsx` virtualizes **rows only** (vertical). Columns render in a normal horizontally-scrolling flex row rather than being independently virtualized — a second, column-axis virtualizer is a reasonable follow-up for very wide tables but is out of scope here.
- Row/column identity in the grid: every fetched row carries its full `oldValues` (every column from `DBResultSet.rows`, keyed by `DBResultSet.columns[i].name`) plus, when present, the row's cursor tuple — this is what lets a pending edit's commit body carry `oldValues` and (when the resolved identity level needs it) `rowPointer`, matching the backend's `port.RowEdit` shape exactly. The frontend does **not** attempt to resolve which identity level applies — that is resolved server-side, fresh, on every commit (Phase 3's `dbquery.ResolveRowIdentity`), and the grid simply sends everything it has.

**Convergence files — do not edit these from parallel agents:** `frontend/src/store/useDevDeckStore.ts` (Tasks 2 and 6 both add fields/actions to it — serialize those two), `frontend/src/store/types.ts` (untouched by this entire plan), `frontend/src/features/data/queries.ts`, `frontend/src/features/data/keys.ts`, and `frontend/src/lib/api.ts` (Tasks 1, 5, 8, and 9 each append a new `// ---- DB ... ----` section to all three — serialize those four tasks), `frontend/src/routeTree.gen.ts` (never hand-edited by anything, ever).

---

### Task 1: DB domain API types, request bodies, and connection/engine/saved-query hooks

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/features/data/keys.ts`
- Modify: `frontend/src/features/data/queries.ts`

**Interfaces:**
- Consumes: `request<T>()`, `ApiError` (existing, `lib/api.ts`).
- Produces: `DBCaps`, `CreateDBConnectionBody`, `UpdateDBConnectionBody`, `DBTestResult`; `fetchDBConnections`, `createDBConnection`, `updateDBConnection`, `deleteDBConnection`, `setDBSecret`, `testDBConnection`, `fetchDBEngines`, `fetchDBSavedQueries`, `createDBSavedQuery`, `updateDBSavedQuery`, `deleteDBSavedQuery`; `useDBConnections`, `useCreateDBConnection`, `useUpdateDBConnection`, `useDeleteDBConnection`, `useSetDBSecret`, `useTestDBConnection`, `useDBEngines`, `useDBSavedQueries`, `useCreateDBSavedQuery`, `useUpdateDBSavedQuery`, `useDeleteDBSavedQuery`.

- [ ] **Step 1: Add the wire types and request bodies**

In `frontend/src/lib/api.ts`, add a new section immediately after the existing `// ---- SSH connections ...` section:

```ts
// ---- DB connections (hub registry; secrets are write-only) ----

export interface DBCaps {
  schemas: boolean
  matViews: boolean
  functions: boolean
  multiDatabase: boolean
  rowIdentifier: string
  sizeStats: boolean
  quoteChar: string
}

export interface CreateDBConnectionBody {
  name: string
  group?: string
  engine: DBEngine
  host?: string
  port?: number
  username?: string
  database?: string
  sslMode?: string
  executorMachineId?: string | null
  tunnelConnectionId?: string | null
  isProduction?: boolean
  password?: string
  caCert?: string
  clientCert?: string
  clientKey?: string
}

export type UpdateDBConnectionBody = Partial<CreateDBConnectionBody>

export interface DBTestResult {
  ok: boolean
  reason?: string
}

export function fetchDBConnections(): Promise<DBConnection[]> {
  return request<DBConnection[]>('GET', '/db/connections')
}

export function createDBConnection(body: CreateDBConnectionBody): Promise<DBConnection> {
  return request<DBConnection>('POST', '/db/connections', body)
}

export function updateDBConnection(id: string, patch: UpdateDBConnectionBody): Promise<DBConnection> {
  return request<DBConnection>('PATCH', `/db/connections/${id}`, patch)
}

export function deleteDBConnection(id: string): Promise<void> {
  return request<void>('DELETE', `/db/connections/${id}`)
}

/** kind is one of "password" | "ca_cert" | "client_cert" | "client_key"; an
 *  empty value clears the stored credential rather than storing an empty one. */
export function setDBSecret(id: string, kind: string, value: string): Promise<void> {
  return request<void>('POST', `/db/connections/${id}/secret`, { kind, value })
}

/** Always resolves — a connection that cannot be reached is data
 *  ({ok:false, reason}), not a thrown ApiError. */
export function testDBConnection(id: string): Promise<DBTestResult> {
  return request<DBTestResult>('POST', `/db/connections/${id}/test`)
}

export function fetchDBEngines(): Promise<Record<DBEngine, DBCaps>> {
  return request<Record<DBEngine, DBCaps>>('GET', '/db/engines')
}

export function fetchDBSavedQueries(connectionId: string): Promise<DBSavedQuery[]> {
  return request<DBSavedQuery[]>('GET', `/db/connections/${connectionId}/queries`)
}

export function createDBSavedQuery(connectionId: string, name: string, sql: string): Promise<DBSavedQuery> {
  return request<DBSavedQuery>('POST', `/db/connections/${connectionId}/queries`, { name, sql })
}

export function updateDBSavedQuery(id: string, patch: { name?: string; sql?: string }): Promise<DBSavedQuery> {
  return request<DBSavedQuery>('PATCH', `/db/queries/${id}`, patch)
}

export function deleteDBSavedQuery(id: string): Promise<void> {
  return request<void>('DELETE', `/db/queries/${id}`)
}
```

`DBEngine`, `DBConnection`, and `DBSavedQuery` are already imported from `@/store/types` wherever this file imports domain types — confirm the existing `import type { ... } from '@/store/types'` line already includes them (it should, since `types.ts` already defines them); if not, add them to that import.

- [ ] **Step 2: Add the query keys**

In `frontend/src/features/data/keys.ts`, add immediately after the existing `sshConnections`/`sshFilesRoot` entries:

```ts
dbConnections: ['dbConnections'] as const,
dbEngines: ['dbEngines'] as const,
dbSavedQueries: (connectionId: string) => ['db', connectionId, 'queries'] as const,
```

- [ ] **Step 3: Add the hooks**

In `frontend/src/features/data/queries.ts`, add a `// ---- DB connections ----` section immediately after the existing SSH hooks, following the exact `useSSHConnections`/`useCreateSSHConnection`/`useUpdateSSHConnection`/`useDeleteSSHConnection` shape:

```ts
// ---- DB connections ----

export function useDBConnections() {
  return useQuery({ queryKey: qk.dbConnections, queryFn: fetchDBConnections, staleTime: 10_000 })
}

export function useCreateDBConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateDBConnectionBody) => createDBConnection(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.dbConnections }),
  })
}

export function useUpdateDBConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateDBConnectionBody }) => updateDBConnection(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.dbConnections }),
  })
}

export function useDeleteDBConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteDBConnection(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.dbConnections }),
  })
}

export function useSetDBSecret() {
  return useMutation({
    mutationFn: ({ id, kind, value }: { id: string; kind: string; value: string }) => setDBSecret(id, kind, value),
  })
}

export function useTestDBConnection() {
  return useMutation({ mutationFn: (id: string) => testDBConnection(id) })
}

export function useDBEngines() {
  return useQuery({ queryKey: qk.dbEngines, queryFn: fetchDBEngines, staleTime: Infinity })
}

export function useDBSavedQueries(connectionId: string) {
  return useQuery({
    queryKey: qk.dbSavedQueries(connectionId),
    queryFn: () => fetchDBSavedQueries(connectionId),
    enabled: Boolean(connectionId),
  })
}

export function useCreateDBSavedQuery() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ connectionId, name, sql }: { connectionId: string; name: string; sql: string }) =>
      createDBSavedQuery(connectionId, name, sql),
    onSuccess: (_data, vars) => queryClient.invalidateQueries({ queryKey: qk.dbSavedQueries(vars.connectionId) }),
  })
}

export function useUpdateDBSavedQuery() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, connectionId, patch }: { id: string; connectionId: string; patch: { name?: string; sql?: string } }) =>
      updateDBSavedQuery(id, patch),
    onSuccess: (_data, vars) => queryClient.invalidateQueries({ queryKey: qk.dbSavedQueries(vars.connectionId) }),
  })
}

export function useDeleteDBSavedQuery() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string; connectionId: string }) => deleteDBSavedQuery(id),
    onSuccess: (_data, vars) => queryClient.invalidateQueries({ queryKey: qk.dbSavedQueries(vars.connectionId) }),
  })
}
```

Add the new names (`fetchDBConnections`, `createDBConnection`, `updateDBConnection`, `deleteDBConnection`, `setDBSecret`, `testDBConnection`, `fetchDBEngines`, `fetchDBSavedQueries`, `createDBSavedQuery`, `updateDBSavedQuery`, `deleteDBSavedQuery`, and the two body types) to this file's existing `import { ... } from '@/lib/api'` line, matching how the SSH functions are already imported there.

- [ ] **Step 2: Verify**

Run: `cd frontend && npm run typecheck`
Expected: no new errors (these are additive exports; nothing consumes them yet, so no "unused" errors either since they're exported).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/features/data/keys.ts frontend/src/features/data/queries.ts
git commit -m "feat(db): add frontend API client and hooks for the connection registry"
```

---

### Task 2: Zustand store slice for the connection dialog

**Files:**
- Modify: `frontend/src/store/useDevDeckStore.ts`

**Interfaces:**
- Produces: `DBDialogState`, `store.dbDialog`, `store.openAddDBConnection()`, `store.openEditDBConnection(conn)`, `store.closeDBDialog()`, `store.setDBDialog(patch)`, `store.dbActiveGroup`, `store.setDBActiveGroup(group)`.

This mirrors `SSHDialogState`/`openAddSSHConnection`/`openEditSSHConnection`/`closeSSHDialog`/`setSSHDialog` (`useDevDeckStore.ts` lines ~90-109 for the type, ~373-388 for the initial value, ~611-652 for the actions) field-for-field, adapted to `DBConnection`'s shape.

- [ ] **Step 1: Add the state type**

Immediately after the existing `interface SSHDialogState { ... }` block, add:

```ts
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
```

Add `DBEngine` to this file's `import type { ... } from './types'` line if not already present (it should already be there via the pre-stubbed domain types).

- [ ] **Step 2: Add the initial value**

In the store's initial state object, immediately after the existing `sshDialog: { ... }` entry, add:

```ts
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
```

Check the exact name/value of the existing `ALL_SSH_GROUPS` sentinel constant (used by `sshActiveGroup`) before reusing it here — if it is SSH-specific in name only (a plain string sentinel like `'__all__'`), reuse it directly as shown; if it turns out to be scoped in a way that makes reuse awkward (unlikely, but check), define a small local `ALL_DB_GROUPS = '__all__'` constant instead rather than fighting the existing one.

- [ ] **Step 3: Add the actions**

Add both to the store's type interface (alongside the existing `sshDialog: SSHDialogState` / `openAddSSHConnection: () => void` / etc. declarations) and to the store's implementation (alongside the existing SSH dialog actions, ~line 611-652):

Type interface additions:

```ts
  dbDialog: DBDialogState
  openAddDBConnection: () => void
  openEditDBConnection: (conn: DBConnection) => void
  closeDBDialog: () => void
  setDBDialog: (patch: Partial<DBDialogState>) => void
  dbActiveGroup: string
  setDBActiveGroup: (group: string) => void
```

Implementation additions:

```ts
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
```

- [ ] **Step 4: Verify**

Run: `cd frontend && npm run typecheck`
Expected: clean — nothing yet reads `dbDialog`, so no unused-variable errors (it's a store field, not a local).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/useDevDeckStore.ts
git commit -m "feat(db): add zustand slice for the connection dialog"
```

---

### Task 3: Sidebar entry, route, and the DatabaseModule shell (connection list)

**Files:**
- Modify: `frontend/src/features/sidebar/SidebarNav.tsx`
- Modify: `frontend/src/features/useScope.ts`
- Create: `frontend/src/routes/w.$wsId.database.tsx`
- Create: `frontend/src/features/database/DatabaseModule.tsx`

**Interfaces:**
- Consumes: `useDBConnections` (Task 1), `store.dbActiveGroup`/`setDBActiveGroup`/`openAddDBConnection`/`openEditDBConnection` (Task 2).
- Produces: the `/w/$wsId/database` route rendering a connection list — the module's first visible, navigable slice.

- [ ] **Step 1: Add the `/database` branch to `useScope`**

In `frontend/src/features/useScope.ts`, add one line to the `if/else if` chain, immediately after `else if (pathname.includes('/ssh')) view = 'ssh'`:

```ts
  else if (pathname.includes('/database')) view = 'database'
```

- [ ] **Step 2: Add the sidebar rail entry**

In `frontend/src/features/sidebar/SidebarNav.tsx`:
1. Add `Database` to the `lucide-react` import: `import { Cable, Database, LayoutGrid, Receipt, Server, Wrench, type LucideIcon } from 'lucide-react'`.
2. Extend `RailDef['key']`'s `Extract<...>` union: `Extract<ModuleView, 'agents' | 'ssh' | 'database' | 'tools' | 'invoices' | 'machines'>`.
3. Add to the `items` array, after the `ssh` entry: `{ key: 'database', label: 'Database', Icon: Database },`.

No change is needed to `goto()` — its `else navigate({ to: \`/w/$wsId/${key}\`, params: { wsId } })` branch already handles any key that isn't `'agents'`/`'machines'` generically.

- [ ] **Step 3: Create the route**

Create `frontend/src/routes/w.$wsId.database.tsx`:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { DatabaseModule } from '@/features/database/DatabaseModule'

export const Route = createFileRoute('/w/$wsId/database')({
  component: DatabaseRoute,
})

function DatabaseRoute() {
  return <DatabaseModule />
}
```

- [ ] **Step 4: Create the module shell**

Create `frontend/src/features/database/DatabaseModule.tsx`. This first pass renders the connection registry (list + group filter + search), matching `SSHConnectionsModule.tsx`'s header/scroll-body shell shape; the tree/tab area it will eventually host is added in Task 6.

```tsx
import { useMemo, useState } from 'react'
import { Database as DatabaseIcon, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DataLoading } from '@/features/screens/DataLoading'
import { useDBConnections } from '@/features/data/queries'
import { cn } from '@/lib/utils'
import type { DBConnection } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const ALL_GROUPS = '__all__'

function groupLabel(group: string) {
  return group.trim() || 'Ungrouped'
}

function EngineGlyph({ engine }: { engine: DBConnection['engine'] }) {
  const label = engine === 'postgres' ? 'PG' : engine === 'mysql' ? 'My' : 'lite'
  return (
    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[10px] border border-devdeck-border-accent bg-devdeck-accent-tint font-mono text-[10px] font-semibold text-devdeck-accent-soft">
      {label}
    </span>
  )
}

function ConnectionCard({ conn, onEdit }: { conn: DBConnection; onEdit: () => void }) {
  return (
    <button
      type="button"
      onClick={onEdit}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[13px] border p-3 text-left transition-colors',
        conn.isProduction
          ? 'border-devdeck-yellow-tint-border bg-devdeck-yellow-tint hover:bg-devdeck-yellow-tint-hover'
          : 'border-devdeck-border-card bg-devdeck-card hover:bg-devdeck-hover-wash',
      )}
    >
      <EngineGlyph engine={conn.engine} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-devdeck-fg">{conn.name}</div>
        <div className="truncate font-mono text-[11px] text-devdeck-dim">
          {conn.engine === 'sqlite' ? conn.database : `${conn.host}:${conn.port}/${conn.database}`}
        </div>
      </div>
      {conn.isProduction ? (
        <span className="flex-none rounded-full bg-devdeck-yellow-tint-text/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-devdeck-yellow-tint-text">
          prod
        </span>
      ) : null}
    </button>
  )
}

export function DatabaseModule() {
  const { data: connections, isLoading, error, refetch } = useDBConnections()
  const activeGroup = useDevDeckStore((s) => s.dbActiveGroup)
  const setActiveGroup = useDevDeckStore((s) => s.setDBActiveGroup)
  const openAdd = useDevDeckStore((s) => s.openAddDBConnection)
  const openEdit = useDevDeckStore((s) => s.openEditDBConnection)
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    if (!connections) return []
    const set = new Set(connections.map((c) => groupLabel(c.group)))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [connections])

  const visible = useMemo(() => {
    if (!connections) return []
    const needle = query.trim().toLowerCase()
    return connections.filter((c) => {
      if (activeGroup !== ALL_GROUPS && groupLabel(c.group) !== activeGroup) return false
      if (!needle) return true
      return c.name.toLowerCase().includes(needle) || c.host.toLowerCase().includes(needle)
    })
  }, [connections, activeGroup, query])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center gap-2.5 border-b border-devdeck-border-menu px-4 py-3">
        <DatabaseIcon size={16} className="text-devdeck-muted" />
        <h1 className="text-[15px] font-semibold text-devdeck-fg">Database</h1>
        <span className="rounded-full bg-devdeck-popover px-2 py-0.5 font-mono text-[11px] text-devdeck-dim">
          {connections?.length ?? 0}
        </span>
        <div className="flex-1" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search connections…"
          className="w-56 font-mono"
        />
        <Button variant="ghost" size="icon" onClick={() => refetch()} aria-label="Refresh">
          <RefreshCw size={14} />
        </Button>
        <Button onClick={openAdd}>
          <Plus size={14} />
          New connection
        </Button>
      </div>

      {groups.length > 0 ? (
        <div className="flex flex-none items-center gap-1.5 overflow-x-auto border-b border-devdeck-border-menu px-4 py-2">
          <button
            type="button"
            onClick={() => setActiveGroup(ALL_GROUPS)}
            className={cn(
              'h-7 flex-none rounded-full px-3 font-mono text-[11px] transition-colors',
              activeGroup === ALL_GROUPS ? 'bg-devdeck-accent-tint text-devdeck-accent-soft' : 'text-devdeck-muted hover:bg-devdeck-hover-wash',
            )}
          >
            All
          </button>
          {groups.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setActiveGroup(g)}
              className={cn(
                'h-7 flex-none rounded-full px-3 font-mono text-[11px] transition-colors',
                activeGroup === g ? 'bg-devdeck-accent-tint text-devdeck-accent-soft' : 'text-devdeck-muted hover:bg-devdeck-hover-wash',
              )}
            >
              {g}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {isLoading ? (
          <DataLoading compact label="loading connections…" />
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-devdeck-dim">
            <p>{error instanceof Error ? error.message : 'Failed to load connections'}</p>
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-devdeck-dim">
            <DatabaseIcon size={28} className="text-devdeck-dim-2" />
            <p>{connections?.length ? 'No connections match your search.' : 'No database connections yet.'}</p>
            {!connections?.length ? (
              <Button size="sm" onClick={openAdd}>
                <Plus size={13} />
                Add your first connection
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((c) => (
              <ConnectionCard key={c.id} conn={c} onEdit={() => openEdit(c)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Verify**

Run: `cd frontend && npm run typecheck`
Expected: clean (regenerates `routeTree.gen.ts` to include the new route as a side effect).

Start the dev server (`npm run dev` from the repo root, or `npm run dev:web` + the backend separately) and navigate to a workspace's `/database` URL, or click the new "Database" rail icon. Expected: the module renders with an empty state (no connections yet) and the sidebar entry highlights when active.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/sidebar/SidebarNav.tsx frontend/src/features/useScope.ts \
  frontend/src/routes/w.\$wsId.database.tsx frontend/src/features/database/DatabaseModule.tsx
git commit -m "feat(db): add sidebar entry, route, and connection-list module shell"
```

---

### Task 4: DBConnectionDialog (create / edit / delete / test)

**Files:**
- Create: `frontend/src/features/database/DBConnectionDialog.tsx`
- Modify: `frontend/src/features/database/DatabaseModule.tsx`

**Interfaces:**
- Consumes: `store.dbDialog`/`setDBDialog`/`closeDBDialog` (Task 2), `useCreateDBConnection`/`useUpdateDBConnection`/`useDeleteDBConnection`/`useSetDBSecret`/`useTestDBConnection`/`useDBEngines`/`useDBConnections` (Task 1), `Dialog`/`DialogTitle`/`DialogDescription`/`Select`/`Input`/`Label`/`Combobox`/`Button` (existing `@/components/ui/*`).

This mirrors `SSHConnectionDialog.tsx`'s structure closely (secrets split from the base body at submit time, `isEdit`/`busy`/`canSubmit` derivation, `Dialog`/`Select`/`Input`/`Label` usage exactly as that file uses them) — read it (`frontend/src/features/ssh/SSHConnectionDialog.tsx`) alongside this step if anything below is ambiguous.

- [ ] **Step 1: Create the dialog**

Create `frontend/src/features/database/DBConnectionDialog.tsx`:

```tsx
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import {
  useCreateDBConnection,
  useDBConnections,
  useDeleteDBConnection,
  useSSHConnections,
  useSetDBSecret,
  useTestDBConnection,
  useUpdateDBConnection,
} from '@/features/data/queries'
import type { CreateDBConnectionBody, UpdateDBConnectionBody } from '@/lib/api'
import type { DBEngine } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const ENGINE_OPTIONS: { value: DBEngine; label: string }[] = [
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL / MariaDB' },
  { value: 'sqlite', label: 'SQLite' },
]

const PG_SSL_OPTIONS = [
  { value: 'disable', label: 'disable — unencrypted' },
  { value: 'prefer', label: 'prefer — unverified' },
  { value: 'require', label: 'require — encrypted, unverified' },
  { value: 'verify-ca', label: 'verify-ca' },
  { value: 'verify-full', label: 'verify-full (recommended)' },
]

const MYSQL_SSL_OPTIONS = [
  { value: 'false', label: 'false — unencrypted' },
  { value: 'preferred', label: 'preferred — unverified' },
  { value: 'skip-verify', label: 'skip-verify — encrypted, unverified' },
  { value: 'verify-ca', label: 'verify-ca' },
  { value: 'verify-identity', label: 'verify-identity (recommended)' },
]

const NO_EXECUTOR = ''
const NO_TUNNEL = ''

function defaultPort(engine: DBEngine) {
  return engine === 'mysql' ? '3306' : engine === 'postgres' ? '5432' : ''
}

export function DBConnectionDialog() {
  const dialog = useDevDeckStore((s) => s.dbDialog)
  const setDialog = useDevDeckStore((s) => s.setDBDialog)
  const close = useDevDeckStore((s) => s.closeDBDialog)
  const showToast = useDevDeckStore((s) => s.showToast)
  const createConnection = useCreateDBConnection()
  const updateConnection = useUpdateDBConnection()
  const deleteConnection = useDeleteDBConnection()
  const setSecret = useSetDBSecret()
  const testConnection = useTestDBConnection()
  const connections = useDBConnections().data ?? []
  const sshConnections = useSSHConnections().data ?? []
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; reason?: string } | null>(null)

  const isEdit = dialog.editingId !== null
  const isSqlite = dialog.engine === 'sqlite'
  const busy = createConnection.isPending || updateConnection.isPending || deleteConnection.isPending
  const portNum = Number.parseInt(dialog.port, 10)
  const portOK = isSqlite || (Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535)
  const canSubmit =
    dialog.name.trim().length > 0 &&
    (isSqlite ? dialog.database.trim().length > 0 : dialog.host.trim().length > 0) &&
    portOK &&
    !busy

  const groupOptions = Array.from(new Set(connections.map((c) => c.group.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  )
  const tunnelOptions = [
    { value: NO_TUNNEL, label: 'Direct connection' },
    ...sshConnections.map((c) => ({ value: c.id, label: c.name })),
  ]
  const sslOptions = dialog.engine === 'mysql' ? MYSQL_SSL_OPTIONS : PG_SSL_OPTIONS

  function onEngineChange(engine: DBEngine) {
    setDialog({ engine, port: defaultPort(engine), sslMode: engine === 'mysql' ? 'verify-identity' : 'verify-full' })
  }

  async function runTest() {
    if (!dialog.editingId) {
      showToast('Save the connection once before testing it')
      return
    }
    setTestResult(null)
    const result = await testConnection.mutateAsync(dialog.editingId)
    setTestResult(result)
  }

  function submit() {
    if (!canSubmit) return
    const base: CreateDBConnectionBody = {
      name: dialog.name.trim(),
      group: dialog.group.trim(),
      engine: dialog.engine,
      host: isSqlite ? '' : dialog.host.trim(),
      port: isSqlite ? undefined : portNum,
      username: isSqlite ? '' : dialog.username.trim(),
      database: dialog.database.trim(),
      sslMode: isSqlite ? '' : dialog.sslMode,
      executorMachineId: dialog.executorMachineId || null,
      tunnelConnectionId: dialog.tunnelConnectionId || null,
      isProduction: dialog.isProduction,
    }
    const secrets: UpdateDBConnectionBody = {}
    if (dialog.password) secrets.password = dialog.password
    if (dialog.caCert) secrets.caCert = dialog.caCert
    if (dialog.clientCert) secrets.clientCert = dialog.clientCert
    if (dialog.clientKey) secrets.clientKey = dialog.clientKey

    const onError = (err: unknown) => showToast(err instanceof Error ? err.message : 'Failed to save database connection')

    if (dialog.editingId) {
      updateConnection.mutate(
        { id: dialog.editingId, patch: { ...base, ...secrets } },
        { onSuccess: () => { close(); showToast(`Updated connection "${base.name}"`) }, onError },
      )
    } else {
      createConnection.mutate(
        { ...base, ...secrets },
        { onSuccess: () => { close(); showToast(`Added connection "${base.name}"`) }, onError },
      )
    }
  }

  function confirmDelete() {
    if (!dialog.editingId) return
    deleteConnection.mutate(dialog.editingId, {
      onSuccess: () => { close(); showToast(`Deleted connection "${dialog.name}"`) },
      onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to delete connection'),
    })
  }

  return (
    <Dialog open={dialog.open} onOpenChange={(o) => !o && !busy && close()} width={520}>
      <DialogTitle>{isEdit ? 'Edit database connection' : 'New database connection'}</DialogTitle>
      <DialogDescription className="mb-[18px]">
        Credentials are encrypted at rest and never sent back to the browser.
      </DialogDescription>

      <Label>Name</Label>
      <Input value={dialog.name} disabled={busy} onChange={(e) => setDialog({ name: e.target.value })} placeholder="prod-postgres" className="mb-3 font-mono" />

      <Label>Group</Label>
      <Combobox value={dialog.group} onChange={(group) => setDialog({ group })} options={groupOptions} disabled={busy} placeholder="Production" className="mb-3" />

      <Label>Engine</Label>
      <Select value={dialog.engine} onValueChange={(v) => onEngineChange(v as DBEngine)} options={ENGINE_OPTIONS} disabled={busy || isEdit} aria-label="Engine" className="mb-3" />

      {isSqlite ? (
        <>
          <Label>Database file path</Label>
          <Input value={dialog.database} disabled={busy} onChange={(e) => setDialog({ database: e.target.value })} placeholder="/path/to/app.db" className="mb-3 font-mono" />
        </>
      ) : (
        <>
          <div className="mb-3 flex gap-3">
            <div className="min-w-0 flex-1">
              <Label>Host</Label>
              <Input value={dialog.host} disabled={busy} onChange={(e) => setDialog({ host: e.target.value })} placeholder="db.example.com" className="font-mono" />
            </div>
            <div className="w-[90px] flex-none">
              <Label>Port</Label>
              <Input value={dialog.port} disabled={busy} onChange={(e) => setDialog({ port: e.target.value })} className="font-mono" />
            </div>
          </div>
          <Label>Username</Label>
          <Input value={dialog.username} disabled={busy} onChange={(e) => setDialog({ username: e.target.value })} className="mb-3 font-mono" />
          <Label>Database</Label>
          <Input value={dialog.database} disabled={busy} onChange={(e) => setDialog({ database: e.target.value })} className="mb-3 font-mono" />
          <Label>Password</Label>
          <Input
            value={dialog.password}
            disabled={busy}
            type="password"
            onChange={(e) => setDialog({ password: e.target.value })}
            placeholder={isEdit ? 'unchanged' : ''}
            className="mb-3 font-mono"
          />
          <Label>TLS mode</Label>
          <Select value={dialog.sslMode} onValueChange={(v) => setDialog({ sslMode: v })} options={sslOptions} disabled={busy} aria-label="TLS mode" className="mb-3" />
        </>
      )}

      <label className="mb-3 flex items-center gap-2 text-[12px] text-devdeck-fg">
        <input type="checkbox" checked={dialog.isProduction} disabled={busy} onChange={(e) => setDialog({ isProduction: e.target.checked })} />
        Production — colors this connection's tabs, forces extra confirmation on commits and DDL, and (for postgres/mysql) rejects an unverified TLS mode
      </label>

      {!isSqlite ? (
        <div className="mb-5 rounded-[12px] border border-devdeck-border-card bg-devdeck-surface-2 p-3">
          <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-devdeck-dim">SSH tunnel</div>
          <Select value={dialog.tunnelConnectionId} onValueChange={(v) => setDialog({ tunnelConnectionId: v })} options={tunnelOptions} disabled={busy} aria-label="SSH tunnel" />
          <p className="mt-1.5 text-[11px] leading-snug text-devdeck-dim">
            {dialog.tunnelConnectionId ? 'The executor tunnels through this SSH connection to reach the database.' : 'The executor dials the database directly.'}
          </p>
        </div>
      ) : null}

      {isEdit ? (
        <div className="mb-5 flex items-center gap-2.5">
          <Button variant="secondary" size="sm" onClick={runTest} disabled={testConnection.isPending}>
            {testConnection.isPending && <Loader2 size={13} className="animate-spin" />}
            Test connection
          </Button>
          {testResult ? (
            <span className={cn('text-[11.5px]', testResult.ok ? 'text-devdeck-green-soft' : 'text-devdeck-red-soft')}>
              {testResult.ok ? 'Connected' : testResult.reason}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2.5">
        {isEdit ? (
          confirmingDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-[11.5px] text-devdeck-red-soft">Delete "{dialog.name}"?</span>
              <Button variant="destructive-solid" size="sm" onClick={confirmDelete} disabled={busy}>
                Confirm
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="destructive" size="sm" onClick={() => setConfirmingDelete(true)} disabled={busy}>
              Delete
            </Button>
          )
        ) : (
          <span />
        )}
        <div className="flex gap-2.5">
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {isEdit ? 'Save' : 'Add'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
```

Add `import { cn } from '@/lib/utils'` to the top of the file (used by the test-result text color).

`useSSHConnections` already exists (it's the query hook `queries.ts` exports for the SSH module) — this dialog reuses it directly for the tunnel picker, exactly the way `SSHConnectionDialog.tsx` reuses `useMachines` for its executor picker.

- [ ] **Step 2: Wire the dialog into the module**

In `frontend/src/features/database/DatabaseModule.tsx`, import and render `<DBConnectionDialog />` once, at the end of the returned JSX tree (a sibling of the outer `<div className="flex h-full min-h-0 flex-col">`, not nested inside it — matching how `SSHConnectionsModule.tsx` mounts `<SSHConnectionDialog />`):

```tsx
import { DBConnectionDialog } from './DBConnectionDialog'
// ...
  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {/* ...existing content... */}
      </div>
      <DBConnectionDialog />
    </>
  )
```

- [ ] **Step 3: Verify**

Run: `cd frontend && npm run typecheck`
Expected: clean.

In the browser, open the Database module, click "New connection," fill in a SQLite path (simplest to test without a live server — e.g. `/tmp/devdeck-demo.db`, matching Task 11's backend smoke-test fixture from Phase 3 if it still exists on disk), save, and confirm the card appears; click it again to edit, run "Test connection," and confirm delete works.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/database/DBConnectionDialog.tsx frontend/src/features/database/DatabaseModule.tsx
git commit -m "feat(db): add the connection create/edit/delete/test dialog"
```

---

### Task 5: Read-path API additions and `DBObjectTree`

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/features/data/keys.ts`
- Modify: `frontend/src/features/data/queries.ts`
- Create: `frontend/src/features/database/DBObjectTree.tsx`

**Interfaces:**
- Consumes: `useDBEngines` (Task 1).
- Produces: `DBObjectRef`, `DBTreePath`, `DBTreeNode`, `DBColumnMeta`, `DBIndexMeta`, `DBTableStats`; `fetchDBTree`, `fetchDBColumns`, `fetchDBIndexes`, `fetchDBStats`; `useDBTree`, `useDBColumns`, `useDBIndexes`, `useDBStats`; `<DBObjectTree connectionId caps onOpenTable onOpenDDL />`.

- [ ] **Step 1: Add the read-path types and fetch functions**

In `frontend/src/lib/api.ts`, append to the `// ---- DB connections ----` section from Task 1:

```ts
export interface DBObjectRef {
  database: string
  schema: string
  name: string
  kind: string // "table" | "view" | "matview" | "function"
}

export interface DBTreePath {
  database: string
  schema: string
  kind: string // "" | "databases" | "schemas" | "tables" | "views" | "matviews" | "functions"
}

export interface DBTreeNode {
  name: string
  kind: string
  hasChildren: boolean
}

export interface DBColumnMeta {
  name: string
  dataType: string
  nullable: boolean
  default: string | null
  isPrimaryKey: boolean
  ordinalPosition: number
  isLob: boolean
  comparable: boolean
}

export interface DBIndexMeta {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  nullable: boolean
}

export interface DBTableStats {
  estRows: number | null
  totalBytes: number | null
  indexBytes: number | null
  analyzed: boolean
}

export function fetchDBTree(connectionId: string, path: DBTreePath): Promise<DBTreeNode[]> {
  return request<DBTreeNode[]>('POST', `/db/connections/${connectionId}/tree`, path)
}

export function fetchDBColumns(connectionId: string, object: DBObjectRef): Promise<DBColumnMeta[]> {
  return request<DBColumnMeta[]>('POST', `/db/connections/${connectionId}/columns`, { object })
}

export function fetchDBIndexes(connectionId: string, object: DBObjectRef): Promise<DBIndexMeta[]> {
  return request<DBIndexMeta[]>('POST', `/db/connections/${connectionId}/indexes`, { object })
}

export function fetchDBStats(connectionId: string, object: DBObjectRef): Promise<DBTableStats> {
  return request<DBTableStats>('POST', `/db/connections/${connectionId}/stats`, { object })
}
```

- [ ] **Step 2: Add the query keys**

In `frontend/src/features/data/keys.ts`:

```ts
dbTree: (connectionId: string, path: DBTreePath) => ['db', connectionId, 'tree', path] as const,
dbColumns: (connectionId: string, object: DBObjectRef) => ['db', connectionId, 'columns', object] as const,
dbIndexes: (connectionId: string, object: DBObjectRef) => ['db', connectionId, 'indexes', object] as const,
dbStats: (connectionId: string, object: DBObjectRef) => ['db', connectionId, 'stats', object] as const,
```

Add `import type { DBTreePath, DBObjectRef } from '@/lib/api'` to this file if type-only imports from `lib/api.ts` aren't already present there.

- [ ] **Step 3: Add the hooks**

In `frontend/src/features/data/queries.ts`:

```ts
export function useDBTree(connectionId: string, path: DBTreePath, enabled = true) {
  return useQuery({
    queryKey: qk.dbTree(connectionId, path),
    queryFn: () => fetchDBTree(connectionId, path),
    enabled: enabled && Boolean(connectionId),
  })
}

export function useDBColumns(connectionId: string, object: DBObjectRef, enabled = true) {
  return useQuery({
    queryKey: qk.dbColumns(connectionId, object),
    queryFn: () => fetchDBColumns(connectionId, object),
    enabled: enabled && Boolean(connectionId) && Boolean(object.name),
  })
}

export function useDBIndexes(connectionId: string, object: DBObjectRef, enabled = true) {
  return useQuery({
    queryKey: qk.dbIndexes(connectionId, object),
    queryFn: () => fetchDBIndexes(connectionId, object),
    enabled: enabled && Boolean(connectionId) && Boolean(object.name),
  })
}

export function useDBStats(connectionId: string, object: DBObjectRef, enabled = true) {
  return useQuery({
    queryKey: qk.dbStats(connectionId, object),
    queryFn: () => fetchDBStats(connectionId, object),
    enabled: enabled && Boolean(connectionId) && Boolean(object.name),
  })
}
```

- [ ] **Step 4: Build the tree**

Create `frontend/src/features/database/DBObjectTree.tsx`. This adopts `TerminalExplorer.tsx`'s two-piece architecture (recursive lazy-fetching level component; a `path: string` identity key per node) but is single-select (click opens/expands; DB browsing has no bulk multi-object action the file explorer's multi-select existed for) and its node kinds are driven by `DBCaps` rather than a uniform filesystem shape:

```tsx
import { ChevronRight, Database as DatabaseIcon, FileCode, Table2 } from 'lucide-react'
import { useDBTree } from '@/features/data/queries'
import type { DBCaps, DBObjectRef, DBTreeNode, DBTreePath } from '@/lib/api'
import { cn } from '@/lib/utils'

interface DBObjectTreeProps {
  connectionId: string
  caps: DBCaps
  onOpenTable: (object: DBObjectRef) => void
}

/** childKind maps a parent node's kind to the TreePath.kind of its children,
 *  per the engine's capability flags — a schema-less engine (mysql, sqlite)
 *  skips straight from "databases"/root to "tables"/"views". */
function childCollections(caps: DBCaps, parentKind: string): string[] {
  if (parentKind === '') {
    if (caps.multiDatabase) return ['databases']
    if (caps.schemas) return ['schemas']
    return ['tables', 'views']
  }
  if (parentKind === 'databases') return caps.schemas ? ['schemas'] : ['tables', 'views']
  if (parentKind === 'schemas') {
    const kinds = ['tables', 'views']
    if (caps.matViews) kinds.push('matviews')
    if (caps.functions) kinds.push('functions')
    return kinds
  }
  return []
}

function nodeIcon(kind: string) {
  if (kind === 'function') return <FileCode size={13} className="text-devdeck-dim" />
  if (kind === 'database' || kind === 'schema') return <DatabaseIcon size={13} className="text-devdeck-dim" />
  return <Table2 size={13} className="text-devdeck-dim" />
}

interface TreeLevelProps {
  connectionId: string
  caps: DBCaps
  path: DBTreePath
  depth: number
  parentObject: DBObjectRef
  onOpenTable: (object: DBObjectRef) => void
  expanded: ReadonlySet<string>
  onToggle: (key: string) => void
}

function TreeLevel({ connectionId, caps, path, depth, parentObject, onOpenTable, expanded, onToggle }: TreeLevelProps) {
  const { data, isLoading, error } = useDBTree(connectionId, path)

  if (isLoading) {
    return <div style={{ paddingLeft: 8 + depth * 14 }} className="h-[29px] text-[11px] text-devdeck-dim">loading…</div>
  }
  if (error) {
    return (
      <div style={{ paddingLeft: 8 + depth * 14 }} className="h-[29px] text-[11px] text-devdeck-red-soft">
        {error instanceof Error ? error.message : 'failed to load'}
      </div>
    )
  }

  return (
    <>
      {(data ?? []).map((node) => {
        const key = `${path.database}/${path.schema}/${path.kind}/${node.name}`
        const isLeaf = node.kind === 'table' || node.kind === 'view' || node.kind === 'matview' || node.kind === 'function'
        const object: DBObjectRef = {
          database: path.database || (path.kind === 'databases' ? node.name : ''),
          schema: path.schema || (path.kind === 'schemas' ? node.name : parentObject.schema),
          name: isLeaf ? node.name : '',
          kind: node.kind,
        }
        const isOpen = expanded.has(key)
        return (
          <div key={key}>
            <button
              type="button"
              data-row-path={key}
              onClick={() => (isLeaf ? onOpenTable({ ...object, name: node.name }) : onToggle(key))}
              style={{ paddingLeft: 8 + depth * 14 }}
              className="flex h-[29px] w-full items-center gap-1.5 rounded-md text-left text-[12px] text-devdeck-fg-2 hover:bg-white/[0.04] hover:text-devdeck-fg"
            >
              {node.hasChildren && !isLeaf ? (
                <ChevronRight size={12} className={cn('flex-none text-devdeck-dim transition-transform', isOpen && 'rotate-90')} />
              ) : (
                <span className="w-3 flex-none" />
              )}
              {nodeIcon(node.kind)}
              <span className="truncate font-mono">{node.name}</span>
            </button>
            {isOpen && !isLeaf
              ? childCollections(caps, node.kind).map((childKind) => (
                  <TreeLevel
                    key={childKind}
                    connectionId={connectionId}
                    caps={caps}
                    path={{ database: object.database, schema: object.schema, kind: childKind }}
                    depth={depth + 1}
                    parentObject={object}
                    onOpenTable={onOpenTable}
                    expanded={expanded}
                    onToggle={onToggle}
                  />
                ))
              : null}
          </div>
        )
      })}
    </>
  )
}

export function DBObjectTree({ connectionId, caps, onOpenTable }: DBObjectTreeProps) {
  const [expanded, setExpanded] = useDBTreeExpandedState()

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="overflow-auto py-1.5">
      {childCollections(caps, '').map((rootKind) => (
        <TreeLevel
          key={rootKind}
          connectionId={connectionId}
          caps={caps}
          path={{ database: '', schema: '', kind: rootKind }}
          depth={0}
          parentObject={{ database: '', schema: '', name: '', kind: '' }}
          onOpenTable={onOpenTable}
          expanded={expanded}
          onToggle={toggle}
        />
      ))}
    </div>
  )
}
```

Add the small local hook this uses, in the same file, above `DBObjectTree`:

```tsx
import { useState } from 'react'

function useDBTreeExpandedState() {
  return useState<ReadonlySet<string>>(new Set())
}
```

(A one-line local wrapper rather than inlining `useState` directly keeps the component body's `useState` call visually distinct from the query hooks above it — a minor readability choice, not a functional requirement; inlining `const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())` directly is equally correct if preferred.)

- [ ] **Step 5: Verify**

Run: `cd frontend && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/features/data/keys.ts frontend/src/features/data/queries.ts \
  frontend/src/features/database/DBObjectTree.tsx
git commit -m "feat(db): add read-path API hooks and the lazy object tree"
```

---

### Task 6: `dbTabs` state and the tab bar

**Files:**
- Create: `frontend/src/features/database/dbTabs.ts`
- Create: `frontend/src/features/database/dbTabs.test.ts`
- Modify: `frontend/src/store/useDevDeckStore.ts`
- Create: `frontend/src/features/database/DBTabBar.tsx`
- Modify: `frontend/src/features/database/DatabaseModule.tsx`

**Interfaces:**
- Produces: `DBTabContent`, `DBTabState`, `tabId`, `openTab`, `closeTab`, `emptyDBTabState` (pure, `dbTabs.ts`); `store.dbTabs: Record<string, DBTabState>`, `store.openDBTab(connectionId, content)`, `store.closeDBTab(connectionId, tabId)`, `store.setDBActiveTab(connectionId, tabId)`; `<DBTabBar connectionId />`.

This is the one place in the module with no direct existing pattern to copy verbatim — `paneTree.ts`'s `tabs: PaneContent[]` / `activeTabId: string` shape is the model, adapted to per-object-kind content instead of per-pane-container content, and scoped per connection (`Record<connectionId, DBTabState>`) rather than being the app-wide workspace tiling system `paneTree.ts` itself belongs to. **This is deliberately not wired through `store.workspaceTileLayouts`/`openTileTab`** — DB objects open as tabs inside `DatabaseModule.tsx`'s own tab area, not as new panes in the global split-pane canvas.

- [ ] **Step 1: Write the pure logic and its tests**

Create `frontend/src/features/database/dbTabs.ts`:

```ts
import type { DBObjectRef } from '@/lib/api'

export type DBTabContent =
  | { id: string; kind: 'table'; object: DBObjectRef }
  | { id: string; kind: 'ddl'; object: DBObjectRef }
  | { id: string; kind: 'query'; savedQueryId: string | null; label: string }

export interface DBTabState {
  tabs: DBTabContent[]
  activeTabId: string | null
}

export function emptyDBTabState(): DBTabState {
  return { tabs: [], activeTabId: null }
}

function objectKey(object: DBObjectRef) {
  return `${object.database}.${object.schema}.${object.name}`
}

/** Computes the identity a piece of tab content dedupes on — opening the same
 *  table twice (or the same saved query) must focus the existing tab rather
 *  than opening a second one. */
export function tabId(content: Omit<DBTabContent, 'id'>): string {
  if (content.kind === 'table') return `table:${objectKey(content.object)}`
  if (content.kind === 'ddl') return `ddl:${objectKey(content.object)}`
  return `query:${content.savedQueryId ?? 'draft'}`
}

export function openTab(state: DBTabState, content: Omit<DBTabContent, 'id'>): DBTabState {
  const id = tabId(content)
  if (state.tabs.some((t) => t.id === id)) return { ...state, activeTabId: id }
  const tab = { ...content, id } as DBTabContent
  return { tabs: [...state.tabs, tab], activeTabId: id }
}

export function closeTab(state: DBTabState, id: string): DBTabState {
  const closedIndex = state.tabs.findIndex((t) => t.id === id)
  if (closedIndex === -1) return state
  const tabs = state.tabs.filter((t) => t.id !== id)
  if (state.activeTabId !== id) return { tabs, activeTabId: state.activeTabId }
  const fallback = tabs[closedIndex] ?? tabs[closedIndex - 1] ?? null
  return { tabs, activeTabId: fallback ? fallback.id : null }
}

export function setActiveTab(state: DBTabState, id: string): DBTabState {
  return state.tabs.some((t) => t.id === id) ? { ...state, activeTabId: id } : state
}
```

Create `frontend/src/features/database/dbTabs.test.ts`, following `fileTreeSelection.test.ts`'s exact plain-assertion convention:

```ts
/**
 * Plain assertion-based tests, matching fileTreeSelection.test.ts's and
 * paneTree.test.ts's convention (no Vitest/Jest configured in this project).
 * Run manually with:
 *
 *   npx tsx src/features/database/dbTabs.test.ts
 */

import { closeTab, emptyDBTabState, openTab, setActiveTab, tabId } from './dbTabs'

let passed = 0

function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
  }
}

const OBJ = { database: 'd', schema: 's', name: 't', kind: 'table' as const }

check('opening a table adds one tab and activates it', () => {
  const s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  assertEqual(s.tabs.length, 1, 'one tab')
  assertEqual(s.activeTabId, tabId({ kind: 'table', object: OBJ }), 'activated')
})

check('opening the same table twice focuses the existing tab, not a duplicate', () => {
  let s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  s = openTab(s, { kind: 'table', object: OBJ })
  assertEqual(s.tabs.length, 1, 'still one tab')
})

check('table and ddl tabs for the same object are distinct', () => {
  let s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  s = openTab(s, { kind: 'ddl', object: OBJ })
  assertEqual(s.tabs.length, 2, 'two distinct tabs')
})

check('closing the active tab activates its neighbor, not null, when one exists', () => {
  const objB = { ...OBJ, name: 'u' }
  let s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  s = openTab(s, { kind: 'table', object: objB })
  s = closeTab(s, tabId({ kind: 'table', object: objB }))
  assertEqual(s.activeTabId, tabId({ kind: 'table', object: OBJ }), 'falls back to the remaining tab')
})

check('closing the last tab leaves activeTabId null', () => {
  let s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  s = closeTab(s, tabId({ kind: 'table', object: OBJ }))
  assertEqual(s.tabs.length, 0, 'no tabs left')
  assertEqual(s.activeTabId, null, 'no active tab')
})

check('closing a non-active tab leaves the active tab untouched', () => {
  const objB = { ...OBJ, name: 'u' }
  let s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  s = openTab(s, { kind: 'table', object: objB })
  s = setActiveTab(s, tabId({ kind: 'table', object: OBJ }))
  s = closeTab(s, tabId({ kind: 'table', object: objB }))
  assertEqual(s.activeTabId, tabId({ kind: 'table', object: OBJ }), 'unchanged')
})

check('setActiveTab is a no-op for an id that is not open', () => {
  const s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  const s2 = setActiveTab(s, 'not-a-real-id')
  assertEqual(s2, s, 'state unchanged')
})

console.log(`\n${passed} tests passed`)
```

- [ ] **Step 2: Run the tests**

Run: `cd frontend && npx tsx src/features/database/dbTabs.test.ts`
Expected: all 7 checks print `ok - ...` and the final line reads `7 tests passed`.

- [ ] **Step 3: Wire tabs into the store**

In `frontend/src/store/useDevDeckStore.ts`, add `dbTabs: Record<string, DBTabState>` to both the type interface and the initial state (`dbTabs: {},`), plus these actions:

```ts
      openDBTab: (connectionId, content) =>
        set((s) => void (s.dbTabs[connectionId] = openTab(s.dbTabs[connectionId] ?? emptyDBTabState(), content))),
      closeDBTab: (connectionId, id) =>
        set((s) => void (s.dbTabs[connectionId] = closeTab(s.dbTabs[connectionId] ?? emptyDBTabState(), id))),
      setDBActiveTab: (connectionId, id) =>
        set((s) => void (s.dbTabs[connectionId] = setActiveTab(s.dbTabs[connectionId] ?? emptyDBTabState(), id))),
```

Type interface additions:

```ts
  dbTabs: Record<string, DBTabState>
  openDBTab: (connectionId: string, content: Omit<DBTabContent, 'id'>) => void
  closeDBTab: (connectionId: string, tabId: string) => void
  setDBActiveTab: (connectionId: string, tabId: string) => void
```

Add `import { closeTab, emptyDBTabState, openTab, setActiveTab, type DBTabContent, type DBTabState } from '@/features/database/dbTabs'` to this file's imports.

- [ ] **Step 4: Build the tab bar**

Create `frontend/src/features/database/DBTabBar.tsx`:

```tsx
import { Table2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { emptyDBTabState } from './dbTabs'

export function DBTabBar({ connectionId, isProduction }: { connectionId: string; isProduction: boolean }) {
  const state = useDevDeckStore((s) => s.dbTabs[connectionId]) ?? emptyDBTabState()
  const setActive = useDevDeckStore((s) => s.setDBActiveTab)
  const close = useDevDeckStore((s) => s.closeDBTab)

  if (state.tabs.length === 0) return null

  return (
    <div className="flex flex-none items-center gap-1 overflow-x-auto border-b border-devdeck-border-menu bg-devdeck-surface-2 px-2">
      {state.tabs.map((tab) => {
        const active = tab.id === state.activeTabId
        const label = tab.kind === 'query' ? tab.label : tab.kind === 'ddl' ? `${tab.object.name} · DDL` : tab.object.name
        return (
          <div
            key={tab.id}
            onClick={() => setActive(connectionId, tab.id)}
            className={cn(
              'group flex h-8 flex-none cursor-pointer items-center gap-1.5 rounded-t-md border-b-2 px-2.5 font-mono text-[11.5px] transition-colors',
              active
                ? isProduction
                  ? 'border-devdeck-yellow-tint-text bg-devdeck-yellow-tint text-devdeck-yellow-tint-text'
                  : 'border-devdeck-accent text-devdeck-fg'
                : 'border-transparent text-devdeck-dim hover:text-devdeck-fg-2',
            )}
          >
            <Table2 size={11} />
            <span className="max-w-[140px] truncate">{label}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); close(connectionId, tab.id) }}
              className="opacity-0 hover:text-devdeck-red-soft group-hover:opacity-100"
              aria-label={`Close ${label}`}
            >
              <X size={11} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 5: Wire the tree + tab bar into the module**

`DatabaseModule.tsx` needs a per-connection "workspace" view distinct from the connection-list view built in Task 3. Replace the module's top-level render with a branch: no `activeConnectionId` selected → the existing list; one selected → tree + tab bar + (for now) an empty tab-content placeholder, which Task 7 fills in.

Add local state for which connection is open (`useState<string | null>`, not store state — this is page-local navigation, not cross-session-worth-persisting, matching `SSHConnectionsModule.tsx`'s own `view`/`query` local-`useState` convention noted in this plan's research). Clicking a `ConnectionCard` now opens the connection instead of the edit dialog (edit moves to a small pencil affordance on the card, or a right-click/long-press — simplest: add a second small "Edit" icon button to `ConnectionCard` alongside the existing content, and make the card's main click area open the connection):

```tsx
// DatabaseModule.tsx — add near the top of the component body
const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null)
const activeConnection = connections?.find((c) => c.id === activeConnectionId) ?? null
const { data: engines } = useDBEngines()
```

Add the workspace branch, rendered instead of the existing list body when `activeConnection` is set:

```tsx
{activeConnection ? (
  <div className="flex min-h-0 flex-1">
    <div className="w-64 flex-none overflow-auto border-r border-devdeck-border-menu">
      <div className="flex h-9 items-center justify-between border-b border-devdeck-border-menu px-2.5">
        <button type="button" onClick={() => setActiveConnectionId(null)} className="text-[11px] text-devdeck-dim hover:text-devdeck-fg">
          ← Connections
        </button>
      </div>
      {engines?.[activeConnection.engine] ? (
        <DBObjectTree
          connectionId={activeConnection.id}
          caps={engines[activeConnection.engine]}
          onOpenTable={(object) => openDBTab(activeConnection.id, { kind: 'table', object })}
        />
      ) : (
        <DataLoading compact label="loading capabilities…" />
      )}
    </div>
    <div className="flex min-h-0 flex-1 flex-col">
      <DBTabBar connectionId={activeConnection.id} isProduction={activeConnection.isProduction} />
      <div className="min-h-0 flex-1 overflow-auto p-4 text-[12px] text-devdeck-dim">
        {/* Task 7 replaces this placeholder with <DBTableGrid> for the active tab. */}
        Select a table from the tree to browse it.
      </div>
    </div>
  </div>
) : (
  /* ...existing header/group-filter/list body from Task 3, unchanged... */
)}
```

Import `useDBEngines`, `DBObjectTree`, `DBTabBar`, and the store's `openDBTab` action at the top of the file. Change `ConnectionCard`'s `onClick` in the list body to `() => setActiveConnectionId(conn.id)` and add a small edit affordance (a second `onClick`-stopping icon button inside the card) calling `openEdit(conn)`.

- [ ] **Step 6: Verify**

Run: `cd frontend && npm run typecheck`
Expected: clean.

In the browser: open a saved connection, confirm the tree pane appears and lazily expands (tables/views list on click), click a table and confirm a tab opens in the tab bar with the placeholder text, open a second table and confirm two tabs exist, close one and confirm the other stays active.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/database/dbTabs.ts frontend/src/features/database/dbTabs.test.ts \
  frontend/src/store/useDevDeckStore.ts frontend/src/features/database/DBTabBar.tsx \
  frontend/src/features/database/DatabaseModule.tsx
git commit -m "feat(db): add per-connection tab state and the tab bar"
```

---

### Task 7: `DBTableGrid` (virtualized, read-only), `DBFilterBar`, `DBTableInfo`

**Files:**
- Modify: `frontend/package.json` (add `@tanstack/react-virtual`)
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/features/data/keys.ts`
- Modify: `frontend/src/features/data/queries.ts`
- Create: `frontend/src/features/database/DBTableGrid.tsx`
- Create: `frontend/src/features/database/DBFilterBar.tsx`
- Create: `frontend/src/features/database/DBTableInfo.tsx`
- Modify: `frontend/src/features/database/DatabaseModule.tsx`

**Interfaces:**
- Consumes: `useDBColumns`, `useDBStats` (Task 5), `useVirtualizer` (`@tanstack/react-virtual`).
- Produces: `DBFilter`, `DBSortKey`, `DBRowsRequest`, `DBResultSet`; `fetchDBRows`; `useDBRows`; `<DBTableGrid connectionId object />` (renders its own filter bar and info panel internally, per this task).

- [ ] **Step 1: Install the virtualizer**

```bash
cd frontend && npm install @tanstack/react-virtual
```

- [ ] **Step 2: Add the rows types, fetch function, key, and hook**

In `frontend/src/lib/api.ts`:

```ts
export interface DBFilter {
  column: string
  op: string // eq ne lt gt le ge between in isnull isnotnull like ilike
  values: unknown[]
}

export interface DBSortKey {
  column: string
  desc: boolean
}

export interface DBRowsRequest {
  object: DBObjectRef
  filters: DBFilter[]
  sort: DBSortKey[]
  cursor: unknown[] | null
  offset: number
  limit: number
  globalSearch: string
}

export interface DBResultSet {
  columns: DBColumnMeta[]
  rows: unknown[][]
  truncated: boolean
  nextCursor: unknown[] | null
  usedOffsetPaging: boolean
  elapsedMs: number
}

export function fetchDBRows(connectionId: string, req: DBRowsRequest): Promise<DBResultSet> {
  return request<DBResultSet>('POST', `/db/connections/${connectionId}/rows`, req)
}
```

In `frontend/src/features/data/keys.ts`:

```ts
dbRows: (connectionId: string, req: DBRowsRequest) => ['db', connectionId, 'rows', req] as const,
```

In `frontend/src/features/data/queries.ts`:

```ts
export function useDBRows(connectionId: string, req: DBRowsRequest, enabled = true) {
  return useQuery({
    queryKey: qk.dbRows(connectionId, req),
    queryFn: () => fetchDBRows(connectionId, req),
    enabled: enabled && Boolean(connectionId) && Boolean(req.object.name),
    placeholderData: (prev) => prev, // keep the old page's rows visible while the next page loads
  })
}
```

- [ ] **Step 3: Build the filter bar**

Create `frontend/src/features/database/DBFilterBar.tsx`:

```tsx
import { Plus, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import type { DBColumnMeta, DBFilter } from '@/lib/api'

const OPS = [
  { value: 'eq', label: '=' },
  { value: 'ne', label: '≠' },
  { value: 'lt', label: '<' },
  { value: 'gt', label: '>' },
  { value: 'le', label: '≤' },
  { value: 'ge', label: '≥' },
  { value: 'like', label: 'contains' },
  { value: 'isnull', label: 'is null' },
  { value: 'isnotnull', label: 'is not null' },
]

const NO_VALUE_OPS = new Set(['isnull', 'isnotnull'])

interface DBFilterBarProps {
  columns: DBColumnMeta[]
  filters: DBFilter[]
  onFiltersChange: (filters: DBFilter[]) => void
  globalSearch: string
  onGlobalSearchChange: (value: string) => void
}

export function DBFilterBar({ columns, filters, onFiltersChange, globalSearch, onGlobalSearchChange }: DBFilterBarProps) {
  function addFilter() {
    const first = columns[0]
    if (!first) return
    onFiltersChange([...filters, { column: first.name, op: 'eq', values: [''] }])
  }
  function updateFilter(index: number, patch: Partial<DBFilter>) {
    onFiltersChange(filters.map((f, i) => (i === index ? { ...f, ...patch } : f)))
  }
  function removeFilter(index: number) {
    onFiltersChange(filters.filter((_, i) => i !== index))
  }

  const columnOptions = columns.map((c) => ({ value: c.name, label: c.name }))

  return (
    <div className="flex flex-none flex-col gap-1.5 border-b border-devdeck-border-menu px-3 py-2">
      <div className="flex items-center gap-2">
        <Search size={13} className="flex-none text-devdeck-dim" />
        <Input
          value={globalSearch}
          onChange={(e) => onGlobalSearchChange(e.target.value)}
          placeholder="Find in all columns (slow — sequential scan)…"
          className="h-7 font-mono text-[11.5px]"
        />
        <Button variant="ghost" size="sm" onClick={addFilter}>
          <Plus size={13} />
          Filter
        </Button>
      </div>
      {filters.map((f, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Select value={f.column} onValueChange={(v) => updateFilter(i, { column: v })} options={columnOptions} className="h-7 w-40" aria-label="Column" />
          <Select value={f.op} onValueChange={(v) => updateFilter(i, { op: v, values: NO_VALUE_OPS.has(v) ? [] : [''] })} options={OPS} className="h-7 w-32" aria-label="Operator" />
          {!NO_VALUE_OPS.has(f.op) ? (
            <Input
              value={String(f.values[0] ?? '')}
              onChange={(e) => updateFilter(i, { values: [e.target.value] })}
              className="h-7 flex-1 font-mono text-[11.5px]"
            />
          ) : (
            <div className="flex-1" />
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => removeFilter(i)} aria-label="Remove filter">
            <X size={12} />
          </Button>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Build the table info panel**

Create `frontend/src/features/database/DBTableInfo.tsx`:

```tsx
import { useDBStats } from '@/features/data/queries'
import type { DBObjectRef } from '@/lib/api'

function formatBytes(n: number | null) {
  if (n === null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function DBTableInfo({ connectionId, object }: { connectionId: string; object: DBObjectRef }) {
  const { data, isLoading } = useDBStats(connectionId, object)
  if (isLoading) return <span className="text-[11px] text-devdeck-dim">loading stats…</span>
  if (!data) return null
  return (
    <div className="flex items-center gap-3 font-mono text-[11px] text-devdeck-dim">
      <span>
        ~{data.estRows === null ? '—' : data.estRows.toLocaleString()} rows{data.analyzed ? '' : ' (unanalyzed)'}
      </span>
      <span>{formatBytes(data.totalBytes)} total</span>
      {data.indexBytes !== null ? <span>{formatBytes(data.indexBytes)} indexes</span> : null}
    </div>
  )
}
```

Per the design spec, exact counts are an explicit user action, not fetched here (`GET .../count` exists but this panel deliberately never calls it automatically) — that's out of scope for this task; a "Count rows" button wiring `useMutation(() => fetchDBCount(...))` is a natural small follow-up but is not required for the grid to function.

- [ ] **Step 5: Build the grid**

Create `frontend/src/features/database/DBTableGrid.tsx`:

```tsx
import { useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { DataLoading } from '@/features/screens/DataLoading'
import { useDBColumns, useDBRows } from '@/features/data/queries'
import type { DBFilter, DBObjectRef, DBSortKey } from '@/lib/api'
import { cn } from '@/lib/utils'
import { DBFilterBar } from './DBFilterBar'
import { DBTableInfo } from './DBTableInfo'

const ROW_HEIGHT = 30
const PAGE_LIMIT = 200

export function DBTableGrid({ connectionId, object }: { connectionId: string; object: DBObjectRef }) {
  const { data: columns, isLoading: columnsLoading, error: columnsError } = useDBColumns(connectionId, object)
  const [filters, setFilters] = useState<DBFilter[]>([])
  const [sort, setSort] = useState<DBSortKey[]>([])
  const [globalSearch, setGlobalSearch] = useState('')
  const [cursorStack, setCursorStack] = useState<(unknown[] | null)[]>([null])
  const pageIndex = cursorStack.length - 1

  const { data: page, isLoading: rowsLoading, error: rowsError } = useDBRows(connectionId, {
    object,
    filters,
    sort,
    cursor: cursorStack[pageIndex],
    offset: 0,
    limit: PAGE_LIMIT,
    globalSearch,
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: page?.rows.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })

  function resetPaging() {
    setCursorStack([null])
  }

  function toggleSort(column: string) {
    setSort((prev) => {
      const existing = prev.find((s) => s.column === column)
      if (!existing) return [{ column, desc: false }]
      if (!existing.desc) return [{ column, desc: true }]
      return []
    })
    resetPaging()
  }

  function nextPage() {
    if (!page?.nextCursor) return
    setCursorStack((prev) => [...prev, page.nextCursor])
  }
  function prevPage() {
    setCursorStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
  }

  if (columnsLoading) return <DataLoading compact label="loading columns…" />
  if (columnsError || !columns) {
    return <div className="p-4 text-[12px] text-devdeck-red-soft">{columnsError instanceof Error ? columnsError.message : 'Failed to load columns'}</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DBFilterBar
        columns={columns}
        filters={filters}
        onFiltersChange={(f) => { setFilters(f); resetPaging() }}
        globalSearch={globalSearch}
        onGlobalSearchChange={(v) => { setGlobalSearch(v); resetPaging() }}
      />
      <div className="flex flex-none items-center justify-between border-b border-devdeck-border-menu px-3 py-1.5">
        <DBTableInfo connectionId={connectionId} object={object} />
        <div className="flex items-center gap-2 font-mono text-[11px] text-devdeck-dim">
          {page?.usedOffsetPaging ? <span className="text-devdeck-yellow-tint-text">offset paging — no usable row identity</span> : null}
          {page?.truncated ? <span>showing first {page.rows.length} rows</span> : null}
          <button type="button" onClick={prevPage} disabled={pageIndex === 0} className="disabled:opacity-30">
            ‹ prev
          </button>
          <button type="button" onClick={nextPage} disabled={!page?.nextCursor} className="disabled:opacity-30">
            next ›
          </button>
        </div>
      </div>

      {rowsError ? (
        <div className="p-4 text-[12px] text-devdeck-red-soft">{rowsError instanceof Error ? rowsError.message : 'Failed to load rows'}</div>
      ) : rowsLoading && !page ? (
        <DataLoading compact label="loading rows…" />
      ) : page && page.rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-devdeck-dim">No rows match the current filters.</div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div className="sticky top-0 z-10 flex border-b border-devdeck-border-menu bg-devdeck-surface-2">
            {columns.map((col) => {
              const sortEntry = sort.find((s) => s.column === col.name)
              return (
                <button
                  key={col.name}
                  type="button"
                  onClick={() => toggleSort(col.name)}
                  style={{ minWidth: 140 }}
                  className="flex h-8 flex-1 items-center gap-1 border-r border-devdeck-border-menu px-2.5 text-left font-mono text-[11px] font-medium text-devdeck-muted hover:text-devdeck-fg"
                >
                  <span className="truncate">{col.name}</span>
                  {sortEntry ? <span className="text-devdeck-accent-soft">{sortEntry.desc ? '↓' : '↑'}</span> : null}
                </button>
              )
            })}
          </div>
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = page!.rows[virtualRow.index]
              return (
                <div
                  key={virtualRow.key}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                  className={cn('flex border-b border-devdeck-border-menu/50', virtualRow.index % 2 === 1 && 'bg-white/[0.015]')}
                >
                  {columns.map((col, colIndex) => (
                    <div
                      key={col.name}
                      style={{ minWidth: 140 }}
                      className="flex flex-1 items-center truncate border-r border-devdeck-border-menu/50 px-2.5 font-mono text-[11.5px] text-devdeck-fg-2"
                    >
                      {col.isLob ? `⟨${String(row[colIndex])} bytes⟩` : row[colIndex] === null ? <span className="text-devdeck-dim-2 italic">null</span> : String(row[colIndex])}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Wire the grid into the tab area**

In `frontend/src/features/database/DatabaseModule.tsx`, replace Task 6's placeholder tab body with the active tab's real content:

```tsx
const activeTabState = activeConnection ? (useDevDeckStore((s) => s.dbTabs[activeConnection.id]) ?? emptyDBTabState()) : emptyDBTabState()
const activeTab = activeTabState.tabs.find((t) => t.id === activeTabState.activeTabId) ?? null
```

```tsx
<div className="min-h-0 flex-1 overflow-auto">
  {!activeTab ? (
    <div className="flex h-full items-center justify-center text-[12px] text-devdeck-dim">Select a table from the tree to browse it.</div>
  ) : activeTab.kind === 'table' ? (
    <DBTableGrid connectionId={activeConnection!.id} object={activeTab.object} />
  ) : (
    <div className="flex h-full items-center justify-center text-[12px] text-devdeck-dim">
      {activeTab.kind === 'ddl' ? 'DDL view — added in Task 9.' : 'SQL editor — added in Task 10.'}
    </div>
  )}
</div>
```

Note this changes the tab body's wrapper from a plain `<div className="p-4 ...">` (Task 6) to one without padding, since `DBTableGrid` manages its own internal layout — remove the `p-4` class from that wrapper.

Import `DBTableGrid` and `emptyDBTabState` (from `./dbTabs`) at the top of the file.

- [ ] **Step 7: Verify**

Run: `cd frontend && npm run typecheck`
Expected: clean.

In the browser: open a table with a handful of rows, confirm columns render with sortable headers, click a header to sort ascending then descending then off, add a filter and confirm the row set narrows, type into "Find in all columns" and confirm results update, and — if the table has more than 200 rows — click "next" and "prev" and confirm the page changes without duplicating or skipping rows.

- [ ] **Step 8: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/lib/api.ts frontend/src/features/data/keys.ts \
  frontend/src/features/data/queries.ts frontend/src/features/database/DBTableGrid.tsx \
  frontend/src/features/database/DBFilterBar.tsx frontend/src/features/database/DBTableInfo.tsx \
  frontend/src/features/database/DatabaseModule.tsx
git commit -m "feat(db): add the virtualized table grid, filter bar, and info panel"
```

---

### Task 8: Write-path API additions, editable grid, and `DBCommitDialog`

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/features/data/keys.ts`
- Modify: `frontend/src/features/data/queries.ts`
- Modify: `frontend/src/features/database/DBTableGrid.tsx`
- Create: `frontend/src/features/database/DBCommitDialog.tsx`

**Interfaces:**
- Produces: `DBRowEdit`, `DBExecResult`, `DBCommitResult`; `commitDBEdits`; `useCommitDBEdits`; pending-edit state inside `DBTableGrid`; `<DBCommitDialog />`.

- [ ] **Step 1: Add the commit types, fetch function, and hook**

In `frontend/src/lib/api.ts`:

```ts
export interface DBRowEdit {
  object: DBObjectRef
  kind: 'insert' | 'update' | 'delete'
  oldValues?: Record<string, unknown>
  newValues?: Record<string, unknown>
  rowPointer?: unknown
}

export interface DBExecResult {
  rowsAffected: number
  elapsedMs: number
}

export interface DBCommitResult {
  results: DBExecResult[]
  elapsedMs: number
}

export function commitDBEdits(connectionId: string, edits: DBRowEdit[]): Promise<DBCommitResult> {
  return request<DBCommitResult>('POST', `/db/connections/${connectionId}/commit`, { edits })
}
```

In `frontend/src/features/data/queries.ts`:

```ts
export function useCommitDBEdits() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ connectionId, edits }: { connectionId: string; edits: DBRowEdit[] }) => commitDBEdits(connectionId, edits),
    onSuccess: (_data, vars) =>
      queryClient.invalidateQueries({ queryKey: ['db', vars.connectionId, 'rows'], exact: false }),
  })
}
```

`ApiError`'s `status` field (already on the existing `ApiError` class from `lib/api.ts`) is how the UI tells a 409 rows-affected conflict apart from any other failure — `err instanceof ApiError && err.status === 409`.

- [ ] **Step 2: Add pending-edit state to the grid**

In `frontend/src/features/database/DBTableGrid.tsx`:

Add local state for pending cell edits, keyed by `${rowIndexInPage}:${columnName}` (page-scoped is sufficient — a commit clears pending edits and the grid re-fetches, so edits never need to survive a page change):

```tsx
const [pendingEdits, setPendingEdits] = useState<Map<string, unknown>>(new Map())

function cellKey(rowIndex: number, column: string) {
  return `${rowIndex}:${column}`
}

function setPendingValue(rowIndex: number, column: string, value: string) {
  setPendingEdits((prev) => {
    const next = new Map(prev)
    next.set(cellKey(rowIndex, column), value)
    return next
  })
}

function buildRowEdits(): DBRowEdit[] {
  if (!page) return []
  const byRow = new Map<number, Record<string, unknown>>()
  for (const [key, value] of pendingEdits) {
    const [rowIndexStr, column] = key.split(':')
    const rowIndex = Number(rowIndexStr)
    if (!byRow.has(rowIndex)) byRow.set(rowIndex, {})
    byRow.get(rowIndex)![column] = value
  }
  const edits: DBRowEdit[] = []
  for (const [rowIndex, newValues] of byRow) {
    const oldValues: Record<string, unknown> = {}
    page.columns.forEach((col, i) => { oldValues[col.name] = page.rows[rowIndex][i] })
    edits.push({ object, kind: 'update', oldValues, newValues })
  }
  return edits
}
```

Make each non-LOB cell editable in place — replace the read-only cell `<div>` in the virtualized row's column map with an editable one, using the cell's pending value when present:

```tsx
{columns.map((col, colIndex) => {
  const key = cellKey(virtualRow.index, col.name)
  const isPending = pendingEdits.has(key)
  const display = isPending ? String(pendingEdits.get(key)) : row[colIndex]
  return col.isLob ? (
    <div key={col.name} style={{ minWidth: 140 }} className="flex flex-1 items-center truncate border-r border-devdeck-border-menu/50 px-2.5 font-mono text-[11.5px] text-devdeck-fg-2">
      ⟨{String(row[colIndex])} bytes⟩
    </div>
  ) : (
    <input
      key={col.name}
      defaultValue={display === null ? '' : String(display)}
      onBlur={(e) => { if (e.target.value !== String(display ?? '')) setPendingValue(virtualRow.index, col.name, e.target.value) }}
      style={{ minWidth: 140 }}
      className={cn(
        'flex-1 border-r border-devdeck-border-menu/50 bg-transparent px-2.5 font-mono text-[11.5px] text-devdeck-fg-2 outline-none focus:bg-devdeck-accent-tint/30',
        isPending && 'bg-devdeck-yellow-tint text-devdeck-yellow-tint-text',
      )}
    />
  )
})}
```

Add a pending-changes bar above the grid, shown only when `pendingEdits.size > 0`, with "Discard" and "Review & commit" actions — the latter opens `DBCommitDialog` (Task 8's own component) via the store:

```tsx
{pendingEdits.size > 0 ? (
  <div className="flex flex-none items-center justify-between border-b border-devdeck-yellow-tint-border bg-devdeck-yellow-tint px-3 py-1.5">
    <span className="font-mono text-[11px] text-devdeck-yellow-tint-text">{pendingEdits.size} pending change{pendingEdits.size === 1 ? '' : 's'}</span>
    <div className="flex gap-2">
      <button type="button" onClick={() => setPendingEdits(new Map())} className="text-[11px] text-devdeck-dim hover:text-devdeck-fg">
        Discard
      </button>
      <button
        type="button"
        onClick={() => openCommitDialog(connectionId, buildRowEdits(), () => setPendingEdits(new Map()))}
        className="text-[11px] font-medium text-devdeck-accent-soft hover:text-devdeck-accent"
      >
        Review &amp; commit
      </button>
    </div>
  </div>
) : null}
```

This references a new store action `openCommitDialog(connectionId, edits, onCommitted)` — add it now (a small addition, not a new zustand *slice* the way `dbDialog`/`dbTabs` are, so it does not need its own Task-2-style plumbing; a single `commitDialog: { open: boolean; connectionId: string; edits: DBRowEdit[]; onCommitted: (() => void) | null }` field plus `openCommitDialog`/`closeCommitDialog` actions, following the exact same `open`/patch pattern as every other dialog in this store):

```ts
// type interface
  commitDialog: { open: boolean; connectionId: string; edits: DBRowEdit[]; onCommitted: (() => void) | null }
  openCommitDialog: (connectionId: string, edits: DBRowEdit[], onCommitted: () => void) => void
  closeCommitDialog: () => void

// initial state
      commitDialog: { open: false, connectionId: '', edits: [], onCommitted: null },

// actions
      openCommitDialog: (connectionId, edits, onCommitted) =>
        set((s) => void (s.commitDialog = { open: true, connectionId, edits, onCommitted })),
      closeCommitDialog: () => set((s) => void (s.commitDialog.open = false)),
```

Import `openCommitDialog` from the store into `DBTableGrid.tsx`, and add `import type { DBRowEdit } from '@/lib/api'`.

- [ ] **Step 3: Build the commit dialog**

Create `frontend/src/features/database/DBCommitDialog.tsx`:

```tsx
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useCommitDBEdits, useDBConnections } from '@/features/data/queries'
import { ApiError } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'

export function DBCommitDialog() {
  const dialog = useDevDeckStore((s) => s.commitDialog)
  const close = useDevDeckStore((s) => s.closeCommitDialog)
  const showToast = useDevDeckStore((s) => s.showToast)
  const commit = useCommitDBEdits()
  const connections = useDBConnections().data ?? []
  const connection = connections.find((c) => c.id === dialog.connectionId)
  const [confirmedProduction, setConfirmedProduction] = useState(false)

  const needsProductionConfirm = connection?.isProduction && !confirmedProduction
  const busy = commit.isPending

  function run() {
    commit.mutate(
      { connectionId: dialog.connectionId, edits: dialog.edits },
      {
        onSuccess: (result) => {
          dialog.onCommitted?.()
          setConfirmedProduction(false)
          close()
          showToast(`Committed ${result.results.length} statement${result.results.length === 1 ? '' : 's'}`)
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) {
            showToast('Another session changed one of these rows — reload the table and try again')
          } else {
            showToast(err instanceof Error ? err.message : 'Commit failed')
          }
        },
      },
    )
  }

  return (
    <Dialog open={dialog.open} onOpenChange={(o) => !o && !busy && close()} width={560}>
      <DialogTitle>Commit {dialog.edits.length} change{dialog.edits.length === 1 ? '' : 's'}</DialogTitle>
      <DialogDescription className="mb-3">
        Every row is matched against its current identity server-side before writing — this cannot be a stale write.
      </DialogDescription>

      <div className="mb-4 max-h-[280px] overflow-auto rounded-lg border border-devdeck-border-strong bg-devdeck-bg p-2.5">
        {dialog.edits.map((edit, i) => (
          <div key={i} className="mb-2 border-b border-devdeck-border-menu/50 pb-2 font-mono text-[11px] text-devdeck-fg-2 last:mb-0 last:border-0 last:pb-0">
            <div className="text-devdeck-dim">
              {edit.kind.toUpperCase()} {edit.object.name}
            </div>
            {edit.newValues
              ? Object.entries(edit.newValues).map(([col, val]) => (
                  <div key={col}>
                    {col}: <span className="text-devdeck-yellow-tint-text">{String(val)}</span>
                  </div>
                ))
              : null}
          </div>
        ))}
      </div>

      {connection?.isProduction ? (
        <label className="mb-4 flex items-center gap-2 rounded-lg border border-devdeck-yellow-tint-border bg-devdeck-yellow-tint p-2.5 text-[11.5px] text-devdeck-yellow-tint-text">
          <input type="checkbox" checked={confirmedProduction} onChange={(e) => setConfirmedProduction(e.target.checked)} />
          This connection is marked production — I want to apply this commit.
        </label>
      ) : null}

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={run} disabled={busy || needsProductionConfirm}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          Commit
        </Button>
      </div>
    </Dialog>
  )
}
```

Mount `<DBCommitDialog />` in `DatabaseModule.tsx` alongside `<DBConnectionDialog />`.

- [ ] **Step 4: Verify**

Run: `cd frontend && npm run typecheck`
Expected: clean.

In the browser: open a table, edit a cell (tab or click away to blur), confirm the pending-changes bar appears and the cell highlights, click "Review & commit," confirm the preview lists the change, commit, and confirm the grid refetches showing the new value. Edit a cell, then edit the *same* row in a second browser tab/session and commit there first, then try to commit the first tab's stale edit — confirm it surfaces the 409 conflict toast rather than silently succeeding or crashing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/features/data/keys.ts frontend/src/features/data/queries.ts \
  frontend/src/features/database/DBTableGrid.tsx frontend/src/features/database/DBCommitDialog.tsx \
  frontend/src/features/database/DatabaseModule.tsx frontend/src/store/useDevDeckStore.ts
git commit -m "feat(db): add editable grid cells, pending-change tracking, and the commit dialog"
```

---

### Task 9: DDL-path API additions, `DBTableDesigner`, `DBDDLView`

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/features/data/keys.ts`
- Modify: `frontend/src/features/data/queries.ts`
- Create: `frontend/src/features/database/DBTableDesigner.tsx`
- Create: `frontend/src/features/database/DBDDLView.tsx`
- Modify: `frontend/src/features/database/DatabaseModule.tsx`
- Modify: `frontend/src/features/database/DBObjectTree.tsx`

**Interfaces:**
- Produces: `DBColumnPlan`, `DBIndexPlan`, `DBTablePlan`; `fetchDBDDLPreview`, `applyDBDDL`, `fetchDBShowCreate`; `useDBDDLPreview`, `useApplyDBDDL`, `useDBShowCreate`; `<DBTableDesigner connectionId object onApplied />`; `<DBDDLView connectionId object />`.

- [ ] **Step 1: Add the DDL types, fetch functions, keys, and hooks**

In `frontend/src/lib/api.ts`:

```ts
export interface DBColumnPlan {
  name: string
  dataType: string
  nullable: boolean
  default: string | null
  isPrimaryKey: boolean
}

export interface DBIndexPlan {
  name: string
  columns: string[]
  unique: boolean
}

export interface DBTablePlan {
  object: DBObjectRef
  kind: 'create' | 'alter' | 'drop'
  columns?: DBColumnPlan[]
  indexes?: DBIndexPlan[]
}

export function fetchDBDDLPreview(connectionId: string, plan: DBTablePlan): Promise<{ statements: string[] }> {
  return request<{ statements: string[] }>('POST', `/db/connections/${connectionId}/ddl/preview`, { plan })
}

export function applyDBDDL(connectionId: string, plan: DBTablePlan): Promise<DBCommitResult> {
  return request<DBCommitResult>('POST', `/db/connections/${connectionId}/ddl/apply`, { plan })
}

export function fetchDBShowCreate(connectionId: string, object: DBObjectRef): Promise<{ ddl: string }> {
  return request<{ ddl: string }>('POST', `/db/connections/${connectionId}/show-create`, { object })
}
```

In `frontend/src/features/data/keys.ts`:

```ts
dbShowCreate: (connectionId: string, object: DBObjectRef) => ['db', connectionId, 'showCreate', object] as const,
```

In `frontend/src/features/data/queries.ts`:

```ts
export function useDBDDLPreview() {
  return useMutation({
    mutationFn: ({ connectionId, plan }: { connectionId: string; plan: DBTablePlan }) => fetchDBDDLPreview(connectionId, plan),
  })
}

export function useApplyDBDDL() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ connectionId, plan }: { connectionId: string; plan: DBTablePlan }) => applyDBDDL(connectionId, plan),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: qk.dbTree(vars.connectionId, { database: vars.plan.object.database, schema: vars.plan.object.schema, kind: 'tables' }) })
      queryClient.invalidateQueries({ queryKey: qk.dbColumns(vars.connectionId, vars.plan.object) })
      queryClient.invalidateQueries({ queryKey: qk.dbIndexes(vars.connectionId, vars.plan.object) })
    },
  })
}

export function useDBShowCreate(connectionId: string, object: DBObjectRef, enabled = true) {
  return useQuery({
    queryKey: qk.dbShowCreate(connectionId, object),
    queryFn: () => fetchDBShowCreate(connectionId, object),
    enabled: enabled && Boolean(connectionId) && Boolean(object.name),
  })
}
```

- [ ] **Step 2: Build the DDL view**

Create `frontend/src/features/database/DBDDLView.tsx`:

```tsx
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataLoading } from '@/features/screens/DataLoading'
import { useDBShowCreate } from '@/features/data/queries'
import type { DBObjectRef } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'

export function DBDDLView({ connectionId, object }: { connectionId: string; object: DBObjectRef }) {
  const { data, isLoading, error } = useDBShowCreate(connectionId, object)
  const showToast = useDevDeckStore((s) => s.showToast)

  if (isLoading) return <DataLoading compact label="generating DDL…" />
  if (error || !data) {
    return <div className="p-4 text-[12px] text-devdeck-red-soft">{error instanceof Error ? error.message : 'Failed to generate DDL'}</div>
  }

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-devdeck-dim">Generated DDL</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { void navigator.clipboard.writeText(data.ddl); showToast('Copied DDL') }}
        >
          <Copy size={12} />
          Copy
        </Button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto rounded-lg border border-devdeck-border-strong bg-devdeck-bg p-3 font-mono text-[11.5px] leading-relaxed text-devdeck-fg-2">
        {data.ddl}
      </pre>
    </div>
  )
}
```

- [ ] **Step 3: Build the table designer**

Create `frontend/src/features/database/DBTableDesigner.tsx`. Scope, matching Phase 3's own explicit ALTER limitation: this UI supports **creating a new table** and **adding/dropping columns and indexes** on an existing one — not column type changes, not constraints beyond primary key.

```tsx
import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useApplyDBDDL, useDBColumns, useDBDDLPreview, useDBIndexes } from '@/features/data/queries'
import type { DBColumnPlan, DBIndexPlan, DBObjectRef } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'

interface DBTableDesignerProps {
  connectionId: string
  /** null means "designing a new table" (kind: create); otherwise "alter". */
  object: DBObjectRef | null
  onApplied: (object: DBObjectRef) => void
}

function emptyColumn(): DBColumnPlan {
  return { name: '', dataType: '', nullable: true, default: null, isPrimaryKey: false }
}

export function DBTableDesigner({ connectionId, object, onApplied }: DBTableDesignerProps) {
  const isAlter = object !== null
  const { data: currentColumns } = useDBColumns(connectionId, object ?? { database: '', schema: '', name: '', kind: '' }, isAlter)
  const { data: currentIndexes } = useDBIndexes(connectionId, object ?? { database: '', schema: '', name: '', kind: '' }, isAlter)
  const [tableName, setTableName] = useState(object?.name ?? '')
  const [columns, setColumns] = useState<DBColumnPlan[]>([emptyColumn()])
  const [indexes, setIndexes] = useState<DBIndexPlan[]>([])
  const [preview, setPreview] = useState<string[] | null>(null)
  const previewMutation = useDBDDLPreview()
  const applyMutation = useApplyDBDDL()
  const showToast = useDevDeckStore((s) => s.showToast)

  useEffect(() => {
    if (isAlter && currentColumns) {
      setColumns(currentColumns.map((c) => ({ name: c.name, dataType: c.dataType, nullable: c.nullable, default: c.default, isPrimaryKey: c.isPrimaryKey })))
    }
    if (isAlter && currentIndexes) {
      setIndexes(currentIndexes.filter((i) => !i.primary).map((i) => ({ name: i.name, columns: i.columns, unique: i.unique })))
    }
  }, [isAlter, currentColumns, currentIndexes])

  const targetObject: DBObjectRef = { database: object?.database ?? '', schema: object?.schema ?? '', name: tableName.trim(), kind: 'table' }

  function updateColumn(i: number, patch: Partial<DBColumnPlan>) {
    setColumns((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }
  function addColumn() {
    setColumns((prev) => [...prev, emptyColumn()])
  }
  function removeColumn(i: number) {
    setColumns((prev) => prev.filter((_, idx) => idx !== i))
  }

  async function runPreview() {
    setPreview(null)
    const plan = { object: targetObject, kind: (isAlter ? 'alter' : 'create') as const, columns, indexes }
    try {
      const result = await previewMutation.mutateAsync({ connectionId, plan })
      setPreview(result.statements)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to build preview')
    }
  }

  function apply() {
    const plan = { object: targetObject, kind: (isAlter ? 'alter' : 'create') as const, columns, indexes }
    applyMutation.mutate(
      { connectionId, plan },
      {
        onSuccess: () => { showToast(`Applied ${isAlter ? 'ALTER' : 'CREATE'} TABLE ${targetObject.name}`); onApplied(targetObject) },
        onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to apply DDL'),
      },
    )
  }

  const canApply = targetObject.name.length > 0 && columns.every((c) => c.name.trim() && c.dataType.trim())

  return (
    <div className="flex h-full flex-col overflow-auto p-3">
      {!isAlter ? (
        <>
          <Label>Table name</Label>
          <Input value={tableName} onChange={(e) => setTableName(e.target.value)} placeholder="widgets" className="mb-3 font-mono" />
        </>
      ) : (
        <div className="mb-3 font-mono text-[13px] text-devdeck-fg">Altering {object!.name}</div>
      )}

      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-devdeck-dim">Columns</span>
        <Button variant="ghost" size="sm" onClick={addColumn}>
          <Plus size={12} />
          Add column
        </Button>
      </div>
      {columns.map((col, i) => (
        <div key={i} className="mb-1.5 flex items-center gap-1.5">
          <Input value={col.name} onChange={(e) => updateColumn(i, { name: e.target.value })} placeholder="name" className="w-36 font-mono text-[11.5px]" />
          <Input value={col.dataType} onChange={(e) => updateColumn(i, { dataType: e.target.value })} placeholder="text / integer / varchar(255)" className="flex-1 font-mono text-[11.5px]" />
          <label className="flex items-center gap-1 text-[10.5px] text-devdeck-dim">
            <input type="checkbox" checked={!col.nullable} onChange={(e) => updateColumn(i, { nullable: !e.target.checked })} />
            not null
          </label>
          <label className="flex items-center gap-1 text-[10.5px] text-devdeck-dim">
            <input type="checkbox" checked={col.isPrimaryKey} onChange={(e) => updateColumn(i, { isPrimaryKey: e.target.checked })} />
            PK
          </label>
          <Button variant="ghost" size="icon-sm" onClick={() => removeColumn(i)} aria-label="Remove column">
            <Trash2 size={12} />
          </Button>
        </div>
      ))}

      <div className="mt-4 flex items-center gap-2.5">
        <Button variant="secondary" size="sm" onClick={runPreview} disabled={!canApply || previewMutation.isPending}>
          Preview SQL
        </Button>
        <Button size="sm" onClick={apply} disabled={!canApply || applyMutation.isPending}>
          Apply
        </Button>
      </div>

      {preview ? (
        <pre className="mt-3 rounded-lg border border-devdeck-border-strong bg-devdeck-bg p-3 font-mono text-[11px] leading-relaxed text-devdeck-fg-2">
          {preview.join(';\n\n')};
        </pre>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 4: Wire `ddl` tabs and a designer entry point**

In `frontend/src/features/database/DatabaseModule.tsx`, extend the tab-body switch (from Task 7) to render `DBDDLView` for `kind === 'ddl'`:

```tsx
) : activeTab.kind === 'ddl' ? (
  <DBDDLView connectionId={activeConnection!.id} object={activeTab.object} />
) : (
```

In `frontend/src/features/database/DBObjectTree.tsx`, add a `onOpenDDL: (object: DBObjectRef) => void` prop and a small per-row "view DDL" affordance (a secondary icon button next to the row, shown on hover, calling `onOpenDDL(object)` — mirroring `TerminalExplorer.tsx`'s general "row has a couple of hover actions" convention referenced in this plan's research) for leaf table/view nodes; wire `DatabaseModule.tsx`'s tree usage to pass `onOpenDDL={(object) => openDBTab(activeConnection.id, { kind: 'ddl', object })}`.

A dedicated "new table" entry point (opening `DBTableDesigner` with `object={null}`) can be a small button in the tree pane header — add `<Button variant="ghost" size="sm" onClick={() => openDBTab(activeConnection.id, { kind: 'designer-new', ... })}>` style wiring if desired; given `DBTabContent`'s union doesn't yet have a `'designer'`/`'designer-new'` variant, extending `dbTabs.ts`'s union with `{ id: string; kind: 'designer'; object: DBObjectRef | null }` (and updating `tabId` to give the create-new case a stable id like `'designer:new'`) is a small, self-contained addition — make it here rather than leaving table/index DDL creation with no way to open the designer at all.

- [ ] **Step 5: Verify**

Run: `cd frontend && npm run typecheck`
Expected: clean.

In the browser: open the DDL view for an existing table and confirm it shows a real `CREATE TABLE` statement; open the designer against that same table (alter mode), add a new column, preview, confirm the statement is an `ALTER TABLE ... ADD COLUMN`, apply, and confirm the table's column list (re-open its DDL view) now includes it.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/features/data/keys.ts frontend/src/features/data/queries.ts \
  frontend/src/features/database/DBTableDesigner.tsx frontend/src/features/database/DBDDLView.tsx \
  frontend/src/features/database/DatabaseModule.tsx frontend/src/features/database/DBObjectTree.tsx \
  frontend/src/features/database/dbTabs.ts frontend/src/features/database/dbTabs.test.ts
git commit -m "feat(db): add DDL preview/apply, the table designer, and the generated-DDL view"
```

---

### Task 10: `DBSqlEditor`, saved queries, and final integration

**Files:**
- Modify: `frontend/package.json` (add `@codemirror/lang-sql`)
- Create: `frontend/src/features/database/DBSqlEditor.tsx`
- Modify: `frontend/src/features/database/DatabaseModule.tsx`

**Interfaces:**
- Consumes: `useDBSavedQueries`/`useCreateDBSavedQuery`/`useUpdateDBSavedQuery`/`useDeleteDBSavedQuery` (Task 1), `useDBRows`-shaped ad-hoc query execution (new `fetchDBQuery`/`useDBQuery` added in this task, mirroring `useDBRows`'s POST-as-query pattern).
- Produces: `<DBSqlEditor connectionId />`.

- [ ] **Step 1: Install the SQL language package**

```bash
cd frontend && npm install @codemirror/lang-sql
```

- [ ] **Step 2: Add the ad-hoc query fetch function and hook**

In `frontend/src/lib/api.ts`, next to `fetchDBRows`:

```ts
export function fetchDBQuery(connectionId: string, sql: string): Promise<DBResultSet> {
  return request<DBResultSet>('POST', `/db/connections/${connectionId}/query`, { sql, args: [] })
}
```

In `frontend/src/features/data/queries.ts`:

```ts
export function useRunDBQuery() {
  return useMutation({
    mutationFn: ({ connectionId, sql }: { connectionId: string; sql: string }) => fetchDBQuery(connectionId, sql),
  })
}
```

A mutation, not a query — an ad-hoc SQL run is an explicit "Run" click, not something that should silently re-fire on an unrelated re-render the way a `useQuery` would.

- [ ] **Step 3: Build the editor**

Create `frontend/src/features/database/DBSqlEditor.tsx`:

```tsx
import { useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { Play, Plus, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  useCreateDBSavedQuery,
  useDBSavedQueries,
  useDeleteDBSavedQuery,
  useRunDBQuery,
  useUpdateDBSavedQuery,
} from '@/features/data/queries'
import { ApiError } from '@/lib/api'
import { useDevDeckStore } from '@/store/useDevDeckStore'

export function DBSqlEditor({ connectionId }: { connectionId: string }) {
  const { data: savedQueries } = useDBSavedQueries(connectionId)
  const createSaved = useCreateDBSavedQuery()
  const updateSaved = useUpdateDBSavedQuery()
  const deleteSaved = useDeleteDBSavedQuery()
  const runQuery = useRunDBQuery()
  const showToast = useDevDeckStore((s) => s.showToast)

  const [text, setText] = useState('SELECT 1;')
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function run() {
    setError(null)
    runQuery.mutate(
      { connectionId, sql: text },
      { onError: (err) => setError(err instanceof ApiError ? err.message : 'Query failed') },
    )
  }

  function save() {
    const name = window.prompt('Query name')
    if (!name) return
    createSaved.mutate(
      { connectionId, name, sql: text },
      { onSuccess: (q) => { setActiveSavedId(q.id); showToast(`Saved "${name}"`) } },
    )
  }

  function updateActiveSaved() {
    if (!activeSavedId) return
    updateSaved.mutate({ id: activeSavedId, connectionId, patch: { sql: text } }, { onSuccess: () => showToast('Updated saved query') })
  }

  const result = runQuery.data

  return (
    <div className="flex h-full min-h-0">
      <div className="w-52 flex-none overflow-auto border-r border-devdeck-border-menu p-2">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-devdeck-dim">Saved queries</span>
        </div>
        {(savedQueries ?? []).map((q) => (
          <div key={q.id} className="group mb-0.5 flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-white/[0.04]">
            <button
              type="button"
              onClick={() => { setText(q.sql); setActiveSavedId(q.id) }}
              className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-devdeck-fg-2"
            >
              {q.name}
            </button>
            <button
              type="button"
              onClick={() => deleteSaved.mutate({ id: q.id, connectionId })}
              className="opacity-0 hover:text-devdeck-red-soft group-hover:opacity-100"
              aria-label={`Delete ${q.name}`}
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-none items-center gap-1.5 border-b border-devdeck-border-menu px-2 py-1.5">
          <Button size="sm" onClick={run} disabled={runQuery.isPending}>
            <Play size={12} />
            Run
          </Button>
          <Button variant="secondary" size="sm" onClick={activeSavedId ? updateActiveSaved : save}>
            <Save size={12} />
            {activeSavedId ? 'Update' : 'Save'}
          </Button>
          {activeSavedId ? (
            <Button variant="ghost" size="sm" onClick={() => { setActiveSavedId(null); setText('') }}>
              <Plus size={12} />
              New
            </Button>
          ) : null}
        </div>

        <div className="flex-none border-b border-devdeck-border-menu">
          <CodeMirror value={text} height="140px" theme={oneDark} extensions={[sql()]} onChange={setText} />
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {error ? (
            <div className="text-[12px] text-devdeck-red-soft">{error}</div>
          ) : !result ? (
            <div className="text-[12px] text-devdeck-dim">Run a query to see results.</div>
          ) : (
            <div className="overflow-auto">
              <table className="w-full border-collapse font-mono text-[11.5px]">
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c.name} className="border-b border-devdeck-border-menu px-2 py-1 text-left text-devdeck-muted">
                        {c.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((v, j) => (
                        <td key={j} className="border-b border-devdeck-border-menu/50 px-2 py-1 text-devdeck-fg-2">
                          {v === null ? <span className="italic text-devdeck-dim-2">null</span> : String(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.truncated ? <p className="mt-2 text-[11px] text-devdeck-dim">Showing first {result.rows.length} rows.</p> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
```

Confirm `@uiw/react-codemirror`'s default export accepts `value`/`height`/`theme`/`extensions`/`onChange` props exactly as used above — it is already a dependency used somewhere else in this codebase (per this plan's research into `package.json`); if another file already renders `<CodeMirror>`, grep for it (`grep -rn "from '@uiw/react-codemirror'" frontend/src`) and match that usage's prop names exactly rather than trusting this snippet blindly, since this plan's research confirmed the package is installed but did not confirm an exact existing call site to copy from.

- [ ] **Step 4: Add a `query` tab entry point and wire the editor into the tab body**

In `DatabaseModule.tsx`'s tree pane header (or a small toolbar above it), add a button to open a fresh SQL editor tab: `<Button variant="ghost" size="sm" onClick={() => openDBTab(activeConnection.id, { kind: 'query', savedQueryId: null, label: 'New query' })}>`. Extend the tab-body switch's final branch (currently the Task 9 placeholder) to render the editor:

```tsx
) : (
  <DBSqlEditor connectionId={activeConnection!.id} />
)
```

(This is now the `kind === 'query'` branch, reached by the `else` after the `'table'` and `'ddl'` checks — no `.kind === 'query'` condition needed since it's the only remaining variant.)

- [ ] **Step 5: Final verification**

Run: `cd frontend && npm run typecheck`
Expected: clean — this regenerates `routeTree.gen.ts` one last time and typechecks the entire module together.

Full manual walkthrough in the browser, backend running against a real SQLite/Postgres/MySQL instance (the Phase 3 plan's own smoke-test fixture — `/tmp/devdeck-phase3-demo.db` — still works for this if it's still on disk, or create a fresh one):
1. Add a connection, test it, confirm it appears in the list.
2. Open it, expand the tree, open a table — confirm the grid loads, sorts, filters, and pages.
3. Edit a cell, commit, confirm the change persists after a refetch.
4. Open the DDL view for a table, confirm it shows real `CREATE TABLE` SQL.
5. Open the table designer, add a column via ALTER, apply, confirm it lands (re-check DDL view).
6. Open the SQL editor, run an ad-hoc `SELECT`, save it, reload the page, confirm the saved query is still listed and re-runnable.
7. Mark a connection production, confirm its tabs render with the yellow warning treatment and its commit dialog requires the extra checkbox.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/features/database/DBSqlEditor.tsx \
  frontend/src/features/database/DatabaseModule.tsx
git commit -m "feat(db): add the SQL editor with saved queries and complete the module"
```

---

## Phase 4 Self-Review

Checked against `docs/superpowers/specs/2026-07-19-database-management-design.md`'s "Frontend / UI" section and this plan's own Starting State.

**Spec coverage.** All 11 named files exist under a name matching the spec's table, with one deliberate consolidation: `DBFilterBar.tsx` and `DBTableInfo.tsx` are built as standalone components (Task 7) but mounted *by* `DBTableGrid.tsx` rather than being wired in separately by `DatabaseModule.tsx` — this matches the spec's intent (a filter bar and info panel belong to a specific open table, not the module shell) more closely than a literal reading of the file list would suggest. Sidebar rail entry, route, `ModuleView` → Task 3 (the type already existed; the rail entry, route file, and the missing `useScope` branch did not). Connection registry CRUD + TLS/executor/tunnel fields → Task 4. Lazy tree driven by `DBCaps` → Task 5. Virtualized grid, keyset paging, server-side filter/sort, LOB deferral (values never fetched inline, shown as a byte-count placeholder) → Task 7. Pending-change marking + commit-preview-before-execute + production extra-confirmation → Task 8. DDL plan/apply + generated-DDL view → Task 9. SQL editor + saved queries → Task 10. Production tab treatment via the `devdeck-yellow*` tokens → Task 6 (tab bar) and Task 8 (commit dialog).

**Two things this plan found that the spec didn't know about, fixed rather than inherited silently.** First, `useScope.ts`'s view-derivation chain has no `/database` branch despite `ModuleView` already listing `'database'` — without Task 3's one-line fix, the sidebar rail would never highlight as active on the database route. Second, no virtualization or SQL-editor-language dependency exists in this codebase yet, despite the spec describing both a "virtualized editable grid" and a "SQL editor" as if the tooling were a given — Tasks 7 and 10 each add exactly one new dependency, named explicitly rather than assumed.

**Scope cuts, stated explicitly** (matching this project's own convention from the backend phases' self-reviews):
- The grid virtualizes rows only, not columns — acceptable for the common case, a real limitation for very wide tables.
- `DBTableGrid`'s pending-edit tracking is update-only in this plan (insert/delete UI affordances — an "add row" button, a per-row delete action — are not built here, even though the backend's `commit` endpoint and `port.RowEdit.kind` already support `insert`/`delete`). Extending the pending-edit map's key scheme to cover a synthetic "new row" and a per-row delete toggle is a natural, contained follow-up that doesn't touch the backend at all.
- `DBTableDesigner` covers create-table and add/drop column/index — matching Phase 3's own explicitly-scoped ALTER support (no type changes, no constraints beyond primary key) exactly, not a frontend limitation beyond what the backend can do.
- `DBTableInfo` shows the lazy estimate only; the explicit "Count rows" action the design spec calls for (hitting the already-built `POST .../count` endpoint) is not wired to a button in this plan — a one-hook, one-button addition left for a follow-up rather than bloating Task 7 further.
- Visual polish is deliberately calibrated below the SSH module's exact finish level, per this plan's Global Constraints — every token, component API, and structural pattern used is verified against real source (not guessed), but decoration (micro-animations, empty-state illustrations, etc.) is left thinner than the most-polished existing screens.

**API-primitive verification, not guesswork.** Every shared UI primitive this plan's JSX calls (`Dialog`, `DialogTitle`, `DialogDescription`, `Select`, `Combobox`, `Button`, `Input`, `Label`, `DataLoading`) was read in full from its actual source file before being used in a code block, and `@tanstack/react-virtual`'s `useVirtualizer`/`getVirtualItems`/`getTotalSize` API (Task 7) was confirmed against its current documentation rather than assumed from general TanStack-family familiarity. The one exception, flagged inline at its use site (Task 10, Step 3): `@uiw/react-codemirror`'s exact prop names are asserted from its typical API rather than a confirmed in-repo call site, with an explicit instruction to grep for and match any existing usage first.

**Type consistency.** `DBObjectRef`, `DBTreeNode`, `DBColumnMeta`, `DBIndexMeta`, `DBRowsRequest`, `DBResultSet`, `DBRowEdit`, `DBTablePlan` are each defined exactly once (Tasks 1/5/7/8/9 respectively) and field-for-field match their Go `port` package counterparts (verified against Phase 3's own `port/dbdriver.go`, itself re-read for this plan) — camelCase JSON keys, `*string` ↔ `string | null`, `[]any` ↔ `unknown[]`. `dbTabs.ts`'s `DBTabContent` union and `useDevDeckStore.ts`'s `dbTabs`/`commitDialog` fields are defined once (Tasks 6 and 8) and consumed identically by every later task that opens a tab or a commit.

**Convergence-file discipline.** `useDevDeckStore.ts` is touched by Tasks 2, 6, and 8 — each adding a self-contained field/action group (`dbDialog`, `dbTabs`, `commitDialog`) that does not conflict with the others structurally, but the Global Constraints section calls out serializing them regardless, since simultaneous edits to the same file by parallel agents would still conflict at the file level even with non-overlapping logical additions. `api.ts`/`keys.ts`/`queries.ts` are touched by Tasks 1, 5, 8, and 9, each appending a new, clearly-delimited section — same serialization note applies. `types.ts` and `routeTree.gen.ts` are untouched by every task in this plan, as stated in the Starting State.

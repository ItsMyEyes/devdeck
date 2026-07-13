# Desktop Chrome-Style Tab Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a window-wide, Chrome-style tab bar to the Tauri desktop app — a pinned "Agents" home tab plus one closable tab per opened worktree/agent — so multiple agent terminals can stay open and be switched between without losing place.

**Architecture:** Pure frontend change. A new `openTabs` slice in the existing zustand store (`useLoomStore.ts`) tracks which worktrees are open per workspace, persisted the same way `worktreeLayouts` already is. A new `TabBar` component reads that state plus the existing `useWorkspace` query (no new fetching) and renders the strip; it is mounted in `WorkspaceLayout` (`w.$wsId.tsx`) gated behind a `useIsTauri()` feature-detect, so the web app is untouched. `WorktreeCard.tsx`'s existing `expand()` handler registers the tab before navigating.

**Tech Stack:** React 19, TanStack Router (file-based routes, typed `navigate`), zustand + immer + persist, Tailwind v4 (loom design tokens), lucide-react icons.

## Global Constraints

- Desktop (Tauri) only — detect via `'__TAURI_INTERNALS__' in window`. The web app's layout must not change at all.
- No backend/API changes — this is 100% frontend.
- `frontend/src/store/useLoomStore.ts` and `frontend/src/routes/w.$wsId.tsx` are project convergence files (see root `CLAUDE.md`) — edit them once, serially, not from parallel agents.
- Use `@/*` import alias, never relative paths into `src/` (`.claude/rules/frontend.md`).
- `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Closing a tab must never touch the backend session/PTY — detach only.
- No test runner exists in `frontend/` (no vitest/jest, no `.test.ts` files, no `test` script in `package.json`) — this codebase's established verification for frontend work is `npm run typecheck` + `npm run build` + manual verification in the running app, not automated unit tests. Every task below follows that pattern instead of red/green unit tests.
- Keyboard shortcuts use `event.metaKey` (Mac `Cmd`), never `event.ctrlKey` — `Ctrl+T`/`Ctrl+W` are already bound inside `ExpandedTerminal.tsx`'s own keydown handler (lines 393-416) and must not be double-triggered.

---

### Task 1: `openTabs` state slice in the store

**Files:**
- Modify: `frontend/src/store/useLoomStore.ts`

**Interfaces:**
- Consumes: nothing new (existing `create`/`persist`/`immer` setup already in the file).
- Produces (used by Task 2 and Task 3):
  - `export interface WorktreeTabRef { projectId: string; wtId: string }`
  - `openTabs: Record<string, WorktreeTabRef[]>` (keyed by `wsId`) on `LoomState`.
  - `openWorktreeTab: (wsId: string, projectId: string, wtId: string) => void` — appends `{ projectId, wtId }` if not already present (dedupe by `wtId`). State-only, no navigation.
  - `closeWorktreeTab: (wsId: string, wtId: string) => void` — removes the entry. State-only, no navigation.
  - `pruneWorktreeTabs: (wsId: string, liveWtIds: Set<string>) => void` — filters `openTabs[wsId]` down to entries whose `wtId` is in `liveWtIds`.

- [x] **Step 1: Add the `WorktreeTabRef` type and extend `LoomState`**

Add this new exported interface right after the existing `EditKind`/`TodoFilter`/`NewProjectMode`/`BrowseTarget` type aliases (after line 16, before `interface SpawnState`):

```ts
export interface WorktreeTabRef {
  projectId: string
  wtId: string
}
```

Then, in the `LoomState` interface, add the new field right after `railExpanded` (after line 86, still inside the "persisted UI preference" group):

```ts
  /** Chrome-style desktop tab bar (Tauri only): worktrees currently open as
   *  tabs, per workspace, in open order. Unused by the web app. */
  openTabs: Record<string, WorktreeTabRef[]>
```

And add the three new action signatures right after `removeWorktreeLayout: (worktreeId: string) => void` (line 96):

```ts
  openWorktreeTab: (wsId: string, projectId: string, wtId: string) => void
  closeWorktreeTab: (wsId: string, wtId: string) => void
  pruneWorktreeTabs: (wsId: string, liveWtIds: Set<string>) => void
```

- [x] **Step 2: Run typecheck to confirm it fails**

Run: `cd frontend && npm run typecheck`
Expected: FAIL — `Property 'openTabs' is missing in type ...` (the store's implementation object below hasn't been updated yet, so it no longer satisfies `LoomState`).

- [x] **Step 3: Add initial state and the three action implementations**

In the store implementation (inside `create<LoomState>()(persist(immer((set) => ({ ... }))))`), add the initial value right after `railExpanded: false,` (line 193):

```ts
      openTabs: {},
```

Then add the three action implementations right after `removeWorktreeLayout: (worktreeId) => set((s) => void delete s.worktreeLayouts[worktreeId]),` (line 204):

```ts
      openWorktreeTab: (wsId, projectId, wtId) =>
        set((s) => {
          if (!s.openTabs[wsId]) s.openTabs[wsId] = []
          const tabs = s.openTabs[wsId]
          if (!tabs.some((t) => t.wtId === wtId)) tabs.push({ projectId, wtId })
        }),
      closeWorktreeTab: (wsId, wtId) =>
        set((s) => void (s.openTabs[wsId] = (s.openTabs[wsId] ?? []).filter((t) => t.wtId !== wtId))),
      pruneWorktreeTabs: (wsId, liveWtIds) =>
        set((s) => void (s.openTabs[wsId] = (s.openTabs[wsId] ?? []).filter((t) => liveWtIds.has(t.wtId)))),
```

- [x] **Step 4: Add `openTabs` to `partialize`**

Change the `partialize` line (line 300) from:

```ts
      partialize: (s) => ({ sidebarOpen: s.sidebarOpen, worktreeLayouts: s.worktreeLayouts, railExpanded: s.railExpanded }),
```

to:

```ts
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        worktreeLayouts: s.worktreeLayouts,
        railExpanded: s.railExpanded,
        openTabs: s.openTabs,
      }),
```

- [x] **Step 5: Run typecheck to confirm it passes**

Run: `cd frontend && npm run typecheck`
Expected: PASS, no errors.

- [x] **Step 6: Commit**

```bash
git add frontend/src/store/useLoomStore.ts
git commit -m "feat(store): add openTabs slice for desktop tab bar"
```

---

### Task 2: `useIsTauri` hook and `TabBar` component

**Files:**
- Create: `frontend/src/features/tabs/useIsTauri.ts`
- Create: `frontend/src/features/tabs/TabBar.tsx`

**Interfaces:**
- Consumes: `useLoomStore` (`openTabs`, `closeWorktreeTab`, `pruneWorktreeTabs` from Task 1), `useWorkspace` (`frontend/src/features/data/queries.ts`), `STATE` (`frontend/src/lib/constants.ts`), `StatusDot` (`frontend/src/components/ui/status-dot.tsx`), `cn` (`frontend/src/lib/utils.ts`), TanStack Router's `useNavigate`/`useParams`.
- Produces (used by Task 3):
  - `export function useIsTauri(): boolean`
  - `export function TabBar({ wsId }: { wsId: string }): JSX.Element`

- [x] **Step 1: Create `useIsTauri.ts`**

```ts
/** True only inside the Tauri desktop shell — `__TAURI_INTERNALS__` is a
 *  global injected by Tauri v2's webview at load time. Always false on the
 *  web, where no tab bar should render. */
export function useIsTauri(): boolean {
  return '__TAURI_INTERNALS__' in window
}
```

- [x] **Step 2: Create `TabBar.tsx`**

```tsx
import { useEffect } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { LayoutGrid, X } from 'lucide-react'
import { STATE } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'
import { StatusDot } from '@/components/ui/status-dot'

interface TabBarProps {
  wsId: string
}

/** Chrome-style window-wide tab bar, Tauri desktop only: a pinned "Agents"
 *  home tab plus one closable tab per opened worktree. Mounted above
 *  Header/Sidebar/ExpandedTerminal in WorkspaceLayout, on every workspace
 *  route (not just the worktree terminal). */
export function TabBar({ wsId }: TabBarProps) {
  const navigate = useNavigate()
  const { wtId: activeWtId } = useParams({ strict: false }) as { wtId?: string }
  const openTabs = useLoomStore((s) => s.openTabs[wsId] ?? [])
  const closeWorktreeTab = useLoomStore((s) => s.closeWorktreeTab)
  const pruneWorktreeTabs = useLoomStore((s) => s.pruneWorktreeTabs)
  const workspace = useWorkspace(wsId).data
  const worktrees = workspace ? workspace.projects.flatMap((p) => p.worktrees) : []

  // Drop tabs for worktrees deleted while the app was closed (or by another tab).
  useEffect(() => {
    if (!workspace) return
    pruneWorktreeTabs(
      wsId,
      new Set(worktrees.map((w) => w.id)),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, wsId])

  function closeTab(wtId: string) {
    const idx = openTabs.findIndex((t) => t.wtId === wtId)
    const wasActive = wtId === activeWtId
    closeWorktreeTab(wsId, wtId)
    if (!wasActive) return
    const remaining = openTabs.filter((t) => t.wtId !== wtId)
    const next = remaining[idx] ?? remaining[idx - 1]
    if (next) {
      navigate({
        to: '/w/$wsId/p/$projectId/wt/$wtId',
        params: { wsId, projectId: next.projectId, wtId: next.wtId },
      })
    } else {
      navigate({ to: '/w/$wsId', params: { wsId } })
    }
  }

  // Cmd+W closes the active worktree tab; Cmd+Shift+[ / ] cycles tabs
  // (including the pinned Agents tab as position 0). metaKey only — Ctrl+W
  // and Ctrl+T are already bound inside ExpandedTerminal's own handler.
  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (!event.metaKey) return
      if (event.key.toLowerCase() === 'w') {
        if (!activeWtId) return
        event.preventDefault()
        closeTab(activeWtId)
        return
      }
      if (event.key === '[' || event.key === ']') {
        event.preventDefault()
        const order: (string | undefined)[] = [undefined, ...openTabs.map((t) => t.wtId)]
        const from = order.indexOf(activeWtId)
        const delta = event.key === ']' ? 1 : -1
        const to = order[(from + delta + order.length) % order.length]
        if (!to) {
          navigate({ to: '/w/$wsId', params: { wsId } })
          return
        }
        const tab = openTabs.find((t) => t.wtId === to)
        if (tab) {
          navigate({
            to: '/w/$wsId/p/$projectId/wt/$wtId',
            params: { wsId, projectId: tab.projectId, wtId: tab.wtId },
          })
        }
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTabs, activeWtId, wsId])

  return (
    <div className="flex h-9 flex-none items-center gap-1 overflow-x-auto border-b border-loom-border bg-loom-surface px-1.5">
      <button
        type="button"
        onClick={() => navigate({ to: '/w/$wsId', params: { wsId } })}
        className={cn(
          'flex h-7 flex-none items-center gap-1.5 rounded-t-md px-2.5 font-mono text-[11.5px]',
          !activeWtId ? 'bg-loom-bg text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
        )}
      >
        <LayoutGrid size={12} />
        Agents
      </button>

      {openTabs.map((t) => {
        const worktree = worktrees.find((w) => w.id === t.wtId)
        if (!worktree) return null
        const st = STATE[worktree.state]
        const label = worktree.root ? 'project root' : worktree.branch
        const active = t.wtId === activeWtId
        return (
          <div
            key={t.wtId}
            className={cn(
              'group flex h-7 max-w-[180px] flex-none items-center gap-1.5 rounded-t-md pl-2.5 pr-1.5 font-mono text-[11.5px]',
              active ? 'bg-loom-bg text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
            )}
          >
            <button
              type="button"
              onClick={() =>
                navigate({
                  to: '/w/$wsId/p/$projectId/wt/$wtId',
                  params: { wsId, projectId: t.projectId, wtId: t.wtId },
                })
              }
              className="flex min-w-0 flex-1 items-center gap-1.5"
            >
              <StatusDot color={st.color} pulse={worktree.state === 'running' || worktree.state === 'waiting'} />
              <span className="truncate">{label}</span>
            </button>
            <button
              type="button"
              onClick={() => closeTab(t.wtId)}
              aria-label={`Close ${label}`}
              className="flex-none rounded p-0.5 text-loom-dim opacity-0 hover:bg-loom-hover-wash hover:text-loom-fg group-hover:opacity-100"
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

- [x] **Step 3: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS. (The component isn't imported anywhere yet, so this only validates its own types — `useParams({ strict: false })`'s return shape, the `navigate({...})` call shapes against the generated route tree, and the `WorktreeTabRef`/`STATE`/`StatusDot` usages.)

- [x] **Step 4: Commit**

```bash
git add frontend/src/features/tabs/useIsTauri.ts frontend/src/features/tabs/TabBar.tsx
git commit -m "feat(tabs): add TabBar component and useIsTauri hook"
```

---

### Task 3: Wire `TabBar` into the workspace layout and worktree cards

**Files:**
- Modify: `frontend/src/routes/w.$wsId.tsx`
- Modify: `frontend/src/features/agents/WorktreeCard.tsx`

**Interfaces:**
- Consumes: `TabBar`, `useIsTauri` (Task 2), `openWorktreeTab` (Task 1).
- Produces: nothing further downstream — this is the integration task.

- [x] **Step 1: Import `TabBar` and `useIsTauri` in `w.$wsId.tsx`**

Add these two imports to `frontend/src/routes/w.$wsId.tsx`, alongside the existing feature imports (after the `GlobalOverlays` import on line 8):

```ts
import { TabBar } from '@/features/tabs/TabBar'
import { useIsTauri } from '@/features/tabs/useIsTauri'
```

- [x] **Step 2: Render `TabBar` above the existing chrome**

Inside `WorkspaceLayout`, add the `isTauri` flag next to the other hooks (after `const workspaceMode = WORKSPACE_MODE_PATTERN.test(pathname)` on line 37):

```ts
  const isTauri = useIsTauri()
```

Then change the render (lines 72-83) from:

```tsx
  return (
    <div className="flex h-[var(--app-height)] w-full flex-col overflow-hidden bg-loom-bg text-loom-fg">
      {!workspaceMode && <Header />}
      <div className="relative flex min-h-0 flex-1">
        <Sidebar compact={workspaceMode} />
        <section className="flex min-w-0 flex-1 flex-col bg-loom-bg">
          <Outlet />
        </section>
      </div>
      <GlobalOverlays />
    </div>
  )
```

to:

```tsx
  return (
    <div className="flex h-[var(--app-height)] w-full flex-col overflow-hidden bg-loom-bg text-loom-fg">
      {isTauri && <TabBar wsId={wsId} />}
      {!workspaceMode && <Header />}
      <div className="relative flex min-h-0 flex-1">
        <Sidebar compact={workspaceMode} />
        <section className="flex min-w-0 flex-1 flex-col bg-loom-bg">
          <Outlet />
        </section>
      </div>
      <GlobalOverlays />
    </div>
  )
```

- [x] **Step 3: Register the tab from `WorktreeCard`'s `expand()`**

In `frontend/src/features/agents/WorktreeCard.tsx`, add the `useIsTauri` import (alongside the existing `@/store/useLoomStore` import on line 11):

```ts
import { useIsTauri } from '@/features/tabs/useIsTauri'
```

Add two hook calls inside `WorktreeCard`, next to the existing `openEdit`/`askDelete`/`showToast` selectors (lines 22-24):

```ts
  const openWorktreeTab = useLoomStore((s) => s.openWorktreeTab)
  const isTauri = useIsTauri()
```

Change `expand()` (lines 71-73) from:

```ts
  function expand() {
    navigate({ to: '/w/$wsId/p/$projectId/wt/$wtId', params: { wsId, projectId, wtId: w.id } })
  }
```

to:

```ts
  function expand() {
    if (isTauri) openWorktreeTab(wsId, projectId, w.id)
    navigate({ to: '/w/$wsId/p/$projectId/wt/$wtId', params: { wsId, projectId, wtId: w.id } })
  }
```

- [x] **Step 4: Run typecheck and production build**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: both PASS with no errors.

- [ ] **Step 5: Manual verification in the desktop app**

Run: `make dev-tauri` (from the repo root, in a separate terminal — this builds the host-triple sidecar and opens the native window against the Vite dev server; see `COMMANDS.md`'s "Desktop app (Tauri)" section).

Walk through, confirming each behavior from the design spec (`docs/superpowers/specs/2026-07-13-desktop-chrome-style-tabs-design.md`):
1. On launch, only the pinned "Agents" tab is visible, highlighted active, showing the Agents grid.
2. Click a `WorktreeCard` (in a project with at least one worktree — spawn one via the "Worktree" button if needed) → a new tab appears with the worktree's branch name and a colored status dot; it becomes active; the terminal view renders.
3. Switch to a different project via the sidebar, open one of its worktrees too → its tab appears alongside the first, in the same strip (tabs span projects). Confirm the pinned Agents tab, when clicked while a different project was last browsed, returns to whichever project's grid you were on.
4. Click back and forth between the two worktree tabs and the pinned tab → each switch navigates correctly and highlights the right tab active.
5. Close the currently active tab via its `×` → focus falls to the adjacent tab (or the pinned tab if it was the only one), per the fallback order; the backend terminal keeps running (its output tail still updates on the Agents grid card).
6. Re-click the `WorktreeCard` for a worktree whose tab you just closed → it reopens a tab reattached to the same session (no restart), and doesn't create a duplicate if you click it again while already open.
7. Press `Cmd+W` while a worktree tab is active → it closes, same as clicking `×`. Press `Cmd+W` while on the pinned tab → no-op.
8. Open 2-3 worktree tabs, press `Cmd+Shift+]` and `Cmd+Shift+[` repeatedly → cycles through pinned tab + all open tabs in order, wrapping around both ends.
9. Quit the app (`Cmd+Q`) and relaunch via `make dev-tauri` → the same tabs you had open are restored.
10. Delete one of those worktrees from the Agents grid, quit, relaunch → its stale tab is gone (pruned), the rest remain.
11. Navigate to Machines / Tools / any other sidebar module page → the tab bar stays visible (it's mounted once in `WorkspaceLayout`, above every child route), with the pinned Agents tab shown active since the current route doesn't match any open worktree tab; clicking it returns to the Agents grid.
12. Run `make dev` (the web app) in a browser → confirm no tab bar renders at all and the layout is unchanged from before this feature.

- [x] **Step 6: Commit**

```bash
git add frontend/src/routes/w.$wsId.tsx frontend/src/features/agents/WorktreeCard.tsx
git commit -m "feat(tabs): wire Chrome-style tab bar into the desktop workspace layout"
```

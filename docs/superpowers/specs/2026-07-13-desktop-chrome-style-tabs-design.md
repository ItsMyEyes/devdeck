# Loom Desktop Chrome-Style Tabs — Design

**Date:** 2026-07-13
**Status:** Approved — ready for implementation plan.

## Goal

Add a browser-style (Chrome-like) top-level tab bar to the **Tauri desktop
app only**. Today, opening a worktree's terminal navigates in place inside
the single window — there is no way to have multiple agents' terminal views
open side by side and switch between them without losing your place. This
design adds a window-wide tab strip where each tab is a whole worktree/agent,
plus a pinned "Agents" tab that acts as home. It confirms — but does not
change — that the app's default/home view is already the Agents grid: the
router's redirect chain (`/` → `/w/$wsId` → `/w/$wsId/p/$projectId`) and
`useScope()`'s `view` default already resolve there whenever a workspace and
project exist.

This is a frontend-only change. No backend/API changes. The existing
pane-level tab strip inside `ExpandedTerminal` (`PaneCanvas`, per-worktree
Terminal/Git/File/Explorer tabs) is untouched — this new tab bar is a
*separate, higher* layer: one level up, at the window-chrome level, above
the existing `Header`/`Sidebar`/`ExpandedTerminal` layout entirely.

## Decisions (from brainstorming)

1. **Desktop-only.** The tab bar renders only when the app is running inside
   the Tauri shell, detected via `'__TAURI_INTERNALS__' in window` (Tauri v2's
   injected global — no new dependency needed; `@tauri-apps/api` is not
   currently installed and does not need to be). The web app's layout is
   unchanged.

2. **Tab model — pinned home tab + one tab per opened worktree:**
   - **Pinned "Agents" tab** (tab #1, always present, not closable): shows
     the Agents grid (`WorktreeCardsGrid`) for whichever project is
     currently selected via the sidebar, i.e. it's bound to whatever
     `/w/$wsId/p/$projectId` currently resolves to — switching the selected
     project via the sidebar changes what this one tab shows; it does not
     spawn additional tabs.
   - **Worktree tabs** (closable): one per opened worktree/agent, mapped
     1:1 to route `/w/$wsId/p/$projectId/wt/$wtId`. Clicking a
     `WorktreeCard` opens (or, if already open, focuses) that worktree's
     tab instead of just navigating in place.
   - Tabs can span multiple projects within the same workspace — e.g. a tab
     for a worktree in Project A next to a tab for a worktree in Project B.
     There is one tab strip per workspace, not per project.

3. **Tab bar is always visible while inside a workspace**, i.e. on every
   route under `/w/$wsId/...` — the Agents grid, a worktree terminal, and
   every other module page (Machines, Tools, News, Todos, Invoices,
   Management, Browser). On any page that isn't a worktree tab, the pinned
   Agents tab renders as the active tab; clicking it navigates back to the
   Agents grid. It is not rendered on `/login`, `/register`, `/2fa-setup`,
   `/access-denied`, or the bare `/` redirect route.

4. **Active tab is derived from the URL, not stored separately.** No
   `activeTabId` state. Whichever tab's route matches the current pathname
   is the active one (the pinned tab matches by exclusion — active whenever
   the pathname isn't a `/wt/$wtId` route for a currently-open tab). This
   keeps the router as the single source of truth and avoids state/route
   desync.

5. **Closing a tab detaches only — it never kills the session.** The
   backend terminal/agent process is already independent of the frontend
   connection (same as how switching pane-tabs inside `ExpandedTerminal`
   today never tears down other mounted sessions). Removing a tab just
   removes it from the open-tabs list and the visible strip; reopening that
   worktree later (from the Agents grid) reattaches to the same live
   session.

6. **Closing the active tab** switches focus to: the tab immediately to its
   right, else the tab immediately to its left, else the pinned Agents tab
   (standard browser fallback order).

7. **Open tabs persist across app restarts**, per workspace, the same way
   `worktreeLayouts` already persists today (zustand `persist` middleware's
   `partialize`). On workspace data load, any persisted tab referencing a
   worktree that no longer exists (deleted while the app was closed) is
   silently dropped.

8. **No blank "new tab" affordance.** Unlike Chrome's "+" opening an empty
   New Tab Page, there's no equivalent empty state here — tabs are always
   opened contextually by clicking a worktree card. The pinned Agents tab
   already serves as the "new tab page" equivalent (browse there, click a
   card to open a tab).

9. **Keyboard shortcuts:** `Cmd+W` (`event.metaKey`, not `event.ctrlKey`)
   closes the active worktree tab (no-op on the pinned tab, which isn't
   closable). `Cmd+Shift+[` / `Cmd+Shift+]` cycle to the previous/next tab.
   `metaKey` is used deliberately instead of `ctrlKey` for these: `Ctrl+T`
   is already bound to "new terminal pane-tab" and `Ctrl+W` is already
   bound (narrowly, only when the focused pane's active tab is a `file`
   kind) to "close file tab," both inside `ExpandedTerminal`'s keydown
   handler (`frontend/src/features/terminal/ExpandedTerminal.tsx:393-416`).
   Reusing `ctrlKey` combos at this new window level would double-fire
   alongside those existing handlers on Windows/Linux, where `ctrlKey` is
   the primary modifier. This makes the new shortcuts Mac-only in practice
   (`metaKey` is the rarely-pressed Windows/Super key elsewhere), which is
   an accepted tradeoff — the desktop app's tooling so far (this session's
   `.app`/`pgrep`-based verification, sidecar signal handling) has been
   macOS-first. Tabs remain fully usable by mouse on every platform
   regardless.

10. **Out of scope for this iteration:** drag-to-reorder tabs, dragging a
    tab out into a separate OS-level window, and a tab context-menu (e.g.
    "close others", "close to the right"). Tabs render in the order they
    were opened; closing and reopening a worktree puts its tab at the end
    again.

## Architecture

### New state: `frontend/src/store/useLoomStore.ts` (convergence file)

```
openTabs: Record<string, { projectId: string; wtId: string }[]>  // keyed by wsId
```

New actions:
- `openWorktreeTab(wsId, projectId, wtId)` — appends `{ projectId, wtId }` to
  `openTabs[wsId]` if not already present (dedupe by `wtId`), then navigates
  to `/w/$wsId/p/$projectId/wt/$wtId`. If already present, just navigates
  (focuses the existing tab).
- `closeWorktreeTab(wsId, wtId)` — removes the entry from `openTabs[wsId]`.
  Does not touch any backend session/PTY. Caller (the `TabBar` component)
  is responsible for the focus-switch navigation described in decision 6,
  since that requires router state the store action doesn't have.
- `pruneWorktreeTabs(wsId, liveWtIds: Set<string>)` — filters
  `openTabs[wsId]` down to entries whose `wtId` is in `liveWtIds`. Called
  from `TabBar` in a `useEffect` once workspace data has loaded.

`partialize` gains `openTabs: s.openTabs` alongside the existing
`sidebarOpen`, `worktreeLayouts`, `railExpanded` fields.

### New files

- **`frontend/src/features/tabs/useIsTauri.ts`** — one-line hook:
  `export function useIsTauri() { return '__TAURI_INTERNALS__' in window }`

- **`frontend/src/features/tabs/TabBar.tsx`** — the tab strip component.
  Reads `openTabs[wsId]` from the store, resolves each entry's live
  `Worktree` via the existing `useWorkspace(wsId)` query (same query
  `WorktreeCard` already uses — no new fetching), and renders:
  - The pinned Agents tab first (icon + "Agents" label, no close button,
    active when the current pathname doesn't match any open worktree tab's
    route).
  - One tab per `openTabs[wsId]` entry: `StatusDot` (colored by
    `worktree.state`, reusing `STATE` from `@/lib/constants` exactly like
    `WorktreeCard`) + truncated title (`worktree.root ? 'project root' :
    worktree.branch`, same label logic as `WorktreeCard`) + close `×`
    button. Active tab (pathname matches its route) is visually
    highlighted. Horizontal scroll (`overflow-x-auto`) when tabs overflow
    the window width — no shrinking/drag-reorder in v1.
  - Click anywhere on a tab (not the × ) navigates to its route.
  - Click × calls `closeWorktreeTab`, then if that tab was active, navigates
    per decision 6's fallback order.
  - `useEffect` on workspace-data load calls `pruneWorktreeTabs`.
  - Global `keydown` listener (scoped to this component's lifetime,
    `window.addEventListener('keydown', ...)`) checking `event.metaKey`
    for `w` / `[` / `]`. No focus guard against inputs/xterm — this
    matches the existing precedent in `ExpandedTerminal`'s own keydown
    listener (`Ctrl+P`/`Ctrl+T`/`Ctrl+W`), which has no such guard either
    and relies on these being modifier combinations uncommon in normal
    typing/terminal use.

### Modified files

- **`frontend/src/routes/w.$wsId.tsx`** (`WorkspaceLayout`): render
  `{isTauri && <TabBar wsId={wsId} />}` as the first child inside the
  outermost flex column, above the existing
  `{!workspaceMode && <Header />}` line — so it sits above both the
  Header+Sidebar layout and the chrome-collapsed `ExpandedTerminal` workspace
  mode, matching Chrome's tab-bar-above-everything placement.

- **`frontend/src/features/agents/WorktreeCard.tsx`**: `expand()` changes
  from calling `navigate(...)` directly to calling the new
  `openWorktreeTab(wsId, projectId, w.id)` store action when `useIsTauri()`
  is true; falls back to the existing direct `navigate(...)` on web (where
  there are no tabs to register).

## Data flow / lifecycle summary

1. App launches → `WorkspaceLayout` renders → if Tauri, `TabBar` mounts,
   reads persisted `openTabs[wsId]` (restored by zustand's `persist`
   middleware) → renders pinned tab + any restored worktree tabs.
2. User clicks a `WorktreeCard` → `openWorktreeTab` adds/dedupes the tab
   entry and navigates → `TabBar` re-renders with the new tab highlighted
   active (URL now matches its route).
3. User clicks a different tab in the strip → plain navigation, no store
   mutation (tab already exists in `openTabs`).
4. User closes a tab → `closeWorktreeTab` removes the entry; if it was
   active, `TabBar` navigates to the fallback tab per decision 6. Backend
   session is untouched — reopening the same worktree later reattaches to
   whatever state it's in.
5. App restarts → `openTabs` rehydrates from persisted storage → `TabBar`
   mounts with the previous tab set → once `useWorkspace` data loads, any
   tab referencing a deleted worktree is pruned.

## Testing

Frontend-only change; verify via:
- `npm run typecheck` and `npm run build` (production build).
- Manual verification in `make dev-tauri`: open several worktree tabs
  across two different projects in the same workspace, confirm the pinned
  Agents tab always reflects the currently-selected project, close a
  non-active and then the active tab and confirm the fallback-focus order,
  restart the app and confirm tabs are restored, delete a worktree from
  another tab's Agents grid and confirm its stale tab is pruned on reload.
- Confirm the web app (`make dev`) is visually and behaviorally unchanged
  (no tab bar renders).

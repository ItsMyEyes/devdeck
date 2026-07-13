# Loom Workspace Tile Splitting — Design

**Date:** 2026-07-13
**Status:** Approved — ready for implementation plan.

## Goal

Extend the desktop tab bar (`docs/superpowers/specs/2026-07-13-desktop-chrome-style-tabs-design.md`)
into a full recursive tiling system: any tab can be dragged to split the
content area, so two or more worktrees' terminal views are visible and
usable simultaneously — "watch several agents at once" — instead of one
worktree fully replacing another when you switch tabs. This mirrors the
power of the existing *per-worktree* pane system (`ExpandedTerminal` /
`PaneCanvas` / `paneTree.ts`, which tiles Terminal/Git/File/Explorer content
**within** one worktree) but one level up, tiling **whole worktrees within a
workspace**.

This supersedes the flat tab bar shipped in the prior iteration: today's
single-row `TabBar` (pinned Agents tab + one tab per opened worktree, no
splitting) becomes the *default, unsplit* state of this new system — a
single pane with a tab strip. Nothing already built is thrown away
conceptually; `useIsTauri.ts` is reused as-is, and the three call sites that
open a worktree tab (`WorktreeCard.tsx`, `SpawnDialog.tsx`,
`ProjectTree.tsx`) keep calling the same `openWorktreeTab(wsId, projectId,
wtId)` action — only its internal implementation and the rendering
(`TabBar.tsx` → a new tiling component) change.

## Why a separate engine, not a generalized one

A research pass confirmed the existing `paneTree.ts`/`PaneCanvas.tsx`
engine cannot be reused directly: `PaneContent` (its leaf content type) has
no worktree-identity field — worktree scoping today lives in closures
inside `TerminalWorkspace`, not in the tree's data model — and its
drag-and-drop payloads assume one shared `WorktreeLayout`. Two paths were
considered:

1. **Genericize the shared engine** so it can tile either
   content-within-one-worktree (today's job) or whole-worktrees (the new
   job). Less total code, but it's a change to a component every worktree
   terminal view already depends on — a regression there has app-wide
   blast radius for a change that's really about a different axis (which
   worktree, not which content within a worktree).
2. **Build a separate, parallel module** — new files, closely modeled on
   the existing engine's UX (same split/resize/5-zone-drag pattern,
   copy-adapted rather than shared) but scoped to exactly one leaf-content
   kind: a tab reference. More code, but fully isolated from the existing,
   heavily-relied-upon per-worktree system.

**Chosen: option 2.** Isolation was prioritized over code reuse given how
central the existing engine already is.

## Decisions

1. **Data model** — a new `WorkspaceTileLayout`, persisted per-workspace,
   structurally mirroring `WorktreeLayout`/`PaneNode` but with exactly one
   leaf-content kind, a `TileTab`:
   - `{ id: 'agents'; kind: 'agents' }` — the pinned home tab. Exactly one
     of these can exist anywhere in a given workspace's tree at a time (it
     is never duplicated — only ever moved, since it isn't closable).
   - `{ id: string; kind: 'worktree'; projectId: string; wtId: string }` —
     `id` is the worktree's `wtId`, reused as the stable identity so a
     given worktree can never appear as a tab in two places in the tree at
     once.
   - `TileLeaf { type: 'leaf'; id: string; tabs: TileTab[]; activeTabId: string }`
     — a pane's own small flat tab strip, exactly like today's `TabBar` row,
     just scoped to one pane instead of the whole window.
   - `TileSplit { type: 'split'; id: string; direction: 'row' | 'column'; children: TileNode[]; sizes: number[] }`.
   - `TileNode = TileLeaf | TileSplit`.
   - `WorkspaceTileLayout { version: 1; root: TileNode; focusedLeafId: string }`.
   - This **replaces** the previously-shipped `openTabs: Record<string,
     WorktreeTabRef[]>` slice entirely. The store's zustand `persist`
     version bumps, **with an explicit `migrate` function** — verified via
     zustand's docs that a bare version bump with no `migrate` discards the
     *entire* persisted blob by default, which would also wipe the
     unrelated, already-shipped `worktreeLayouts` (per-worktree pane
     splits) and `railExpanded` for anyone who already has those. The
     `migrate` function carries `sidebarOpen`/`worktreeLayouts`/
     `railExpanded` forward unchanged and drops only the old `openTabs`
     key, replacing it with a fresh `workspaceTileLayouts: {}`.
   - Default/initial layout for a workspace with no prior state: a single
     leaf containing just the pinned Agents tab, active — i.e. exactly
     what a fresh install of the previous flat-tab-bar iteration looked
     like.

2. **Rendering** — a new `WorkspaceTileCanvas` component (Tauri-only)
   replaces the combination of today's `TabBar` + `<Outlet/>` inside
   `WorkspaceLayout` (`frontend/src/routes/w.$wsId.tsx`). It recursively
   renders `TileSplit` nodes as resizable split containers and `TileLeaf`
   nodes as a pill-style tab strip (visually matching what's already
   shipped) over whichever tab is active:
   - The `agents` tab renders the Agents grid (`WorktreeCardsGrid`) for
     whichever project is currently browsed — same as before.
   - A `worktree` tab renders `<ExpandedTerminal worktree={...} wsId={...}
     projectId={...} />` **directly as a prop-driven component call**, not
     via router `<Outlet/>`. A research pass confirmed this is safe:
     `ExpandedTerminal`/`TerminalWorkspace` take their worktree entirely as
     props (no internal route-param coupling), and `Terminal.tsx` session
     keys are namespaced by worktree id, so mounting several
     `ExpandedTerminal` instances at once has no session/WebSocket
     collision risk.
   - The macOS traffic-light gutter (`tauri.macos.conf.json`'s overlay
     title bar) stays fused into whichever leaf currently occupies the
     top-left corner of the grid — that leaf's tab strip is the one
     rendered at literal screen-top. Other leaves get the identical pill
     tab-strip styling, just without that reserved left gutter, positioned
     wherever they land in the resizable grid.

3. **Coexisting with non-tiled routes** (Machines, Tools, News, Todos,
   Invoices, Management, Browser, Issues). The prior spec's decision 3
   requires the tab strip to stay visible on every workspace route, not
   just the Agents grid/worktree terminal — this still holds, but only for
   the **top-left leaf's** tab strip (the one fused with the traffic-light
   gutter), which is effectively the persistent chrome row. Its content
   area, and every other leaf (strip and content both, if a split exists),
   swap out for the plain routed page: navigating to a non-tiled route
   replaces the whole tiling canvas below that one persistent strip with
   `<Outlet/>`'s page, while the full tile tree (including any splits)
   stays intact in the store, unmounted/hidden rather than destroyed — so
   navigating back to the Agents grid or a worktree restores exactly the
   layout you left, splits included.

4. **Routing** — the URL continues to track the *focused* leaf's active
   worktree (`/w/$wsId/p/$projectId/wt/$wtId`), updated whenever focus
   moves to a different leaf or a different tab within one (clicking a
   tab, clicking inside a pane's terminal content, etc.). The full
   multi-pane structure itself is **not** reflected in the URL — same
   precedent as the existing per-worktree system, whose internal pane tree
   isn't reflected in the URL either, purely store-driven.

5. **Opening a worktree tab** (`openWorktreeTab(wsId, projectId, wtId)` —
   same public signature as today, called from `WorktreeCard.tsx`,
   `SpawnDialog.tsx`, `ProjectTree.tsx` unchanged): if that `wtId` already
   exists as a tab anywhere in the tree, focus its leaf and make it active
   there (no duplicate tab is ever created) — otherwise add it as a new tab
   in the **focused** leaf and make it active. This is a straightforward
   generalization of today's "dedupe by `wtId`, no-op if already open."

6. **Splitting via drag-and-drop** — dragging a tab (from any leaf's strip,
   including the one holding the pinned Agents tab) onto another leaf's
   5-zone drop target (same edge/center zone computation the existing
   per-worktree `PaneCanvas` uses, reimplemented for this module) either:
   - drops on an edge → turns the target leaf into a `TileSplit` in that
     direction, with the target leaf and a new leaf (holding just the
     dragged tab) as its two children;
   - drops center → moves the dragged tab into the target leaf's existing
     tab strip;
   - drops back onto its own leaf's strip → reorders it there (this falls
     out of implementing the drop-zone logic, so it's included rather than
     separately built, even though pure reordering wasn't originally in
     scope).
   In every case, **only the dragged tab moves** — every other tab stays in
   its originating leaf, including the pinned Agents tab if it wasn't the
   one dragged. This matches the existing per-worktree pane system's
   drag-a-single-tab behavior exactly.

7. **Closing** — closing a leaf's last tab removes that leaf from the tree
   and collapses its parent `TileSplit` (if the split is left with one
   child, the split node is replaced by that child directly — same
   collapse rule the existing per-worktree engine uses). A leaf holding
   only the pinned Agents tab can never become empty this way, since that
   tab isn't closable — it can only be *moved* out via drag, at which point
   the now-tabless leaf collapses normally. Closing a **worktree** tab
   still only detaches — per the original spec's decision 5, the backend
   terminal/agent session is never touched by closing its tab, in this
   tree or the old flat list.

8. **Focus** — clicking anywhere in a leaf (its tab strip or its content)
   sets `focusedLeafId` to that leaf and, if the leaf's active tab is a
   worktree, updates the URL to match. `Cmd+W` / `Cmd+Shift+[` / `Cmd+Shift+]`
   (from the previous spec's decision 9) now operate on the **focused
   leaf's** tab strip specifically, not a single global strip.

9. **Persistence** — `WorkspaceTileLayout` persists per-workspace via the
   same zustand `persist`/`partialize` mechanism `worktreeLayouts` already
   uses, so the full split arrangement (not just which worktrees were open)
   survives an app restart.

10. **Pruning** — on workspace data load, any tab referencing a worktree
    that no longer exists is removed from wherever it lives in the tree,
    with the same leaf/split collapse rule as closing a tab manually.

11. **Out of scope for this iteration**: dragging a pane out into a
    separate OS-level window, a tab/pane context-menu ("close others",
    "close this pane"), and any cross-workspace tiling (a workspace's tree
    only ever contains that workspace's own worktrees — Workspaces remain
    fully separate tenant contexts, never mixed in one tiling tree).

## Testing

Frontend-only change, same verification pattern as the rest of the desktop
tab work (no test runner in this codebase):
- `npm run typecheck` and `npm run build`.
- Manual verification in `make dev-tauri`: open several worktree tabs,
  drag one onto another to create a split (each of the 4 edges + center),
  confirm both worktrees' terminals are live and independently usable at
  once; drag the pinned Agents tab into a split pane and confirm it moves
  without duplicating; close tabs until a split collapses back to a single
  pane; restart the app and confirm the full split arrangement (not just
  which worktrees were open) is restored; delete a worktree that's part of
  a split from the Agents grid and confirm its tab and, if it was that
  leaf's last tab, the leaf itself are pruned correctly.

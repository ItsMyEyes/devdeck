# Loom Terminal Workspace Tiling — Design

**Date:** 2026-07-09
**Status:** Approved (brainstorming complete)

## Goal

Redesign `ExpandedTerminal` (route `/w/$wsId/p/$projectId/wt/$wtId`) from a
single-panel-with-tabs layout into a Wave-Terminal-style **tiling workspace**:
a recursive split-tree of resizable panes, each capable of holding several
tab-like content items (Terminal / Git / File / Explorer), splittable and
rearrangeable via drag-and-drop. The global chrome (top `Header`, 298px
`Sidebar`) collapses out of the way while a worktree is open so the tiling
canvas gets the full viewport, and reappears unchanged everywhere else. All
of `ExpandedTerminal`'s existing behavior (dirty-file guard, quick-open,
jump-to-definition, Approve, mobile key toolbar) must survive the rewrite.
This is a 100%-frontend change — no Go files, no new panel content types, no
server-side layout persistence.

## Decisions (from brainstorming)

1. **Trigger scope:** the new chrome-collapsed "workspace mode" applies only
   while the matched route has a `wtId` param (i.e. `ExpandedTerminal` is
   rendered). Every other route keeps today's `Header` + full `Sidebar`
   layout untouched. Detected via `useScope().wtId` in `WorkspaceLayout`
   (`frontend/src/routes/w.$wsId.tsx`) — no new store flag needed, it's
   purely route-derived.
2. **Header hidden:** `Header` is conditionally omitted (not just visually
   hidden) from `WorkspaceLayout`'s tree while in workspace mode.
3. **Sidebar collapses to an icon rail:** `Sidebar` renders a ~44px
   icon-only rail instead of its normal 298px body while in workspace mode,
   on both desktop and mobile — this rail is the only way to navigate back
   once the `Header`'s mobile hamburger is gone, so it stays permanently
   visible (it does not use the existing mobile drawer/`sidebarOpen`
   show-hide mechanism at all; that mechanism is scoped to the full-width
   sidebar on non-workspace routes only).
4. **Local toolbar/tab-strip removed as dedicated bars:** `ExpandedTerminal`'s
   old 44px toolbar and 36px tab strip disappear entirely. Their pieces
   relocate: Back → rail's back-arrow; status dot/branch/pill/model+cost →
   the title area of any pane whose active tab is Terminal content;
   Details/Delete/Approve → a "..." overflow menu, rendered only in the
   currently-focused pane's header; Find file stays a pure `Cmd/Ctrl+P`
   shortcut with no dedicated button.
5. **Tiling split-tree replaces the single content area:** a recursive
   `PaneNode` tree (`LeafPane` | `SplitPane`) renders Terminal / Git / File /
   Explorer content. A `LeafPane` can hold multiple content items as its own
   small tab strip, so stacking files in one pane without splitting still
   works exactly like today's tab strip did.
6. **Splitting and drag-and-drop via dnd-kit:** every pane header has
   "split right" / "split down" buttons (always create a same-content-type
   sibling). Dragging a pane's tab over another pane computes 5 zones from
   pointer position (outer 25% strip per edge = new split in that direction,
   inner 50% = merge as a new tab); implemented with the `@dnd-kit/core`
   primitives already used in `frontend/src/features/issues/` (no new DnD
   library). Removing a leaf's last tab collapses a now-single-child split
   into that child, recursively — the tree never holds degenerate nodes.
7. **Terminal panes are independent PTYs:** the primary pane in every
   worktree keeps `session = worktree.id` (unchanged, so existing sessions
   reattach exactly as before); every additional Terminal content item gets
   a distinct `sessionKey` (`${worktreeId}::term-${n}`), which the existing
   PTY `registry.spawn` (`backend/internal/terminal/registry.go`) accepts
   with zero registry changes — confirmed by reading the spawn path. A real,
   accepted limitation of doing this with *zero* backend changes at all is
   documented under "Known limitation" below.
8. **Client-side persistence, one new store key:** each worktree's pane tree
   (structure, split sizes, open tabs, active tab) persists via
   `useLoomStore`'s existing `zustand/persist` `partialize` allowlist, keyed
   by worktree id, alongside the current `sidebarOpen` entry. Live terminal
   scrollback is not part of this (already server-side). Deleting a worktree
   removes its layout entry too.
9. **Preserve all existing `ExpandedTerminal` behavior** through the
   rewrite: dirty-file `window.confirm`, `beforeunload` guard, `Cmd/Ctrl+P`,
   `Ctrl+W` (file tabs only), Approve gating, "no machine assigned" empty
   state, jump-to-definition reveal, and `MobileKeyToolbar`'s sticky-ctrl
   wired to whichever Terminal pane has focus. See "Preserved behaviors"
   below for the explicit old-control → new-location mapping.
10. **`TerminalExplorer` stops being pinned:** today it's an always-visible
    300px `lg:flex` column; in the tiling model it's an ordinary
    closable/splittable pane like any other. On mobile (`max-md:`), the
    canvas stacks one leaf full-bleed at a time instead of showing splits
    side by side (reusing the same `translate-x`/drawer collapse pattern
    `Sidebar` already uses for mobile) — there's no room for tiling on a
    phone-width screen.

## Architecture

```
w.$wsId.tsx (WorkspaceLayout)
  workspaceMode = Boolean(useScope().wtId)

  ┌───────────────────────────────────────────────────────────────┐
  │ {!workspaceMode && <Header/>}                                  │
  ├───────────┬─────────────────────────────────────────────────── ┤
  │ <Sidebar  │ <Outlet/>                                           │
  │  collapsed│   └─ w.$wsId.p.$projectId.wt.$wtId.tsx               │
  │  ={mode}/>│       └─ ExpandedTerminal                            │
  │           │            ├─ PaneTree(root: WorktreeLayout.root)    │
  │ collapsed │            │    ├─ SplitPaneView (direction, sizes)  │
  │ = 44px    │            │    │    ├─ LeafPaneView                 │
  │  rail:    │            │    │    │    ├─ PanelHeader             │
  │  - back   │            │    │    │    │   (tabs, split l/r/d,    │
  │    arrow  │            │    │    │    │    "..." if focused)     │
  │  - Ws     │            │    │    │    │    (title chrome if      │
  │    badge  │            │    │    │    │     active tab=Terminal) │
  │  - nav    │            │    │    │    └─ active tab's content:   │
  │    icons  │            │    │    │        Terminal | GitPanel |  │
  │           │            │    │    │        FileEditor |            │
  │  not      │            │    │    │        TerminalExplorer        │
  │  collapsed│            │    │    └─ ResizeHandle (drag sizes[])   │
  │  = today's│            │    ├─ LeafPaneView ...                   │
  │  298px    │            │    └─ ...                                │
  │  Sidebar  │            ├─ FileQuickOpen (single instance, modal)  │
  │  (WsSwit- │            └─ MobileKeyToolbar (bound to focused      │
  │  cher +   │                 Terminal pane's TerminalHandle)       │
  │  Nav +    │                                                       │
  │  body)    │                                                       │
  └───────────┴───────────────────────────────────────────────────────┘
```

### File layout

New files, all under `frontend/src/features/terminal/`:

- `paneTypes.ts` — `PaneNode`/`PaneContent`/`WorktreeLayout` types + pure
  tree helpers (`findPane`, `findContent`, `insertSplit`, `removeContent`,
  `collapseIfSingleChild`, `resizeSplit`).
- `PaneTree.tsx` — recursive dispatcher: `SplitPane` → `SplitPaneView`,
  `LeafPane` → `LeafPaneView`. Owns the `DndContext` for the whole tree.
- `SplitPaneView.tsx` — lays out `children` in a flex row/column per
  `direction`, with a `ResizeHandle` between each pair.
- `LeafPaneView.tsx` — renders `PanelHeader` plus every tab's content kept
  mounted (`active` toggled via CSS visibility, same "mount all, hide
  inactive" approach `ExpandedTerminal` already uses for `FileEditor`).
- `PanelHeader.tsx` — the per-pane header described below.
- `ResizeHandle.tsx` — thin draggable divider; plain pointer events
  (`onPointerDown` + `setPointerCapture` + `pointermove`/`pointerup`), not
  dnd-kit — dnd-kit is reserved for pane/tab rearrangement, resizing is a
  simpler concern with no existing precedent to follow in this codebase.

New file under `frontend/src/features/sidebar/`:

- `SidebarRail.tsx` — the collapsed 44px rail (see "Chrome collapse"
  below).

Modified: `ExpandedTerminal.tsx` (now a thin shell around `PaneTree`),
`Sidebar.tsx`, `SidebarNav.tsx`, `WorkspaceSwitcher.tsx`, `w.$wsId.tsx`,
`useLoomStore.ts` (new persisted slice), `ConfirmDeleteDialog.tsx` (layout
cleanup hook), `Terminal.tsx`'s only caller changes its `session` prop
source (component itself is untouched).

### PaneNode / PaneContent data model

```ts
// frontend/src/features/terminal/paneTypes.ts

export type PaneContentKind = 'terminal' | 'git' | 'file' | 'explorer'

interface BasePaneContent {
  /** Globally unique within one worktree's tree — see id rules below. */
  id: string
  kind: PaneContentKind
  label: string
}

export interface TerminalContent extends BasePaneContent {
  kind: 'terminal'
  /** Also this content's `id`. Primary pane uses the bare worktree id
   *  (`w.id`); every other Terminal content uses `${worktreeId}::term-${n}`.
   *  See "Terminal session-id scheme". */
  sessionKey: string
}

export interface GitContent extends BasePaneContent {
  kind: 'git'
}

export interface FileContent extends BasePaneContent {
  kind: 'file'
  /** Also this content's `id` — enforces "one instance per open path"
   *  across the whole tree (see openFile dedup rule below). */
  path: string
}

export interface ExplorerContent extends BasePaneContent {
  kind: 'explorer'
}

export type PaneContent = TerminalContent | GitContent | FileContent | ExplorerContent

export interface LeafPane {
  type: 'leaf'
  id: string // crypto.randomUUID()
  tabs: PaneContent[] // length >= 1 always; 0 tabs ⇒ leaf is removed (see below)
  activeTabId: string // === one tabs[].id
}

export type SplitDirection = 'row' | 'column' // row = side-by-side ("split right"), column = stacked ("split down")

export interface SplitPane {
  type: 'split'
  id: string // crypto.randomUUID()
  direction: SplitDirection
  children: PaneNode[] // length >= 2 always — see collapse invariant
  sizes: number[] // same length as children, fractions summing to 1
}

export type PaneNode = LeafPane | SplitPane

export interface WorktreeLayout {
  version: 1
  root: PaneNode
  /** Drives which pane's header shows the "..." menu and which Terminal
   *  pane MobileKeyToolbar/ctrlArmed targets. */
  focusedPaneId: string
  /** Monotonic, never reused even after a Terminal pane closes, so
   *  sessionKeys stay collision-free for the life of the layout. Starts
   *  at 1; the primary pane (bare worktree id) doesn't consume a slot. */
  nextTerminalSeq: number
}
```

**Id rules:** every `PaneNode.id` and every `PaneContent.id` is
`crypto.randomUUID()` (matching the existing fallback-safe pattern in
`frontend/src/features/modules/BrowserModule.tsx`), **except**: `TerminalContent.id`
always equals its `sessionKey`, and `FileContent.id` always equals its
`path`. Those two exceptions are load-bearing — the sessionKey doubles as
the `Terminal` component's React `key` (no separate bookkeeping needed to
find "the pane with this PTY"), and the path-as-id lets `openFile`/
`openDefinition` do a single tree walk to detect "this file is already
open somewhere" and focus it instead of duplicating it. `GitContent`/
`ExplorerContent` ids are plain random ids — a user can split to create a
second Git or Explorer pane (allowed, since "split" always starts a new
sibling of the same content *type*, not the same content *instance*), so
their ids must not collide by being fixed constants.

**Collapse invariant:** a `SplitPane.children` array never drops below 2
elements. When `removeContent(paneId, contentId)` empties a `LeafPane`'s
`tabs`, that leaf is deleted from its parent's `children`; if that leaves
the parent with exactly 1 child, the parent `SplitPane` is replaced in
*its* parent by that one remaining child (recursively, in case removal
cascades up multiple levels) — implemented by `collapseIfSingleChild`,
called after every `removeContent`.

**Default layout** (no persisted entry for this worktree yet) mirrors
today's default view exactly:

```ts
const rootId = crypto.randomUUID()
const layout: WorktreeLayout = {
  version: 1,
  nextTerminalSeq: 1,
  focusedPaneId: rootId,
  root: {
    type: 'leaf',
    id: rootId,
    tabs: [{ kind: 'terminal', id: worktree.id, sessionKey: worktree.id, label: 'Terminal' }],
    activeTabId: worktree.id,
  },
}
```

### PanelHeader

One header per `LeafPane`, fixed height 32px (down from the old 44px
toolbar + 36px tab strip = 80px combined, freeing real vertical space for
the canvas), single row:

```ts
interface PanelHeaderProps {
  pane: LeafPane
  worktree: Worktree
  machine: Machine
  isFocused: boolean
  onFocus: () => void
  onSelectTab: (contentId: string) => void
  onCloseTab: (contentId: string) => void
  onSplit: (direction: SplitDirection) => void
}
```

Layout, left to right: (1) the pane's own tab strip — reuses the exact
classes from today's `ExpandedTerminal` tab strip (`flex h-9 ... border-r
border-loom-border px-3 font-mono text-[11px]`, active/inactive color
pair, `MaterialFileIcon` for file tabs, `TerminalSquare`/`GitBranch` icons
for terminal/git tabs, yellow `*` dirty marker, per-tab `X` close button
gated the same way `closeFile` is today); (2) if the pane's *active* tab
is Terminal content, a title-chrome block — `StatusDot` + `WorktreeGlyph`
+ branch/root label + `Pill` (state) + the `model · elapsed · tokens ·
cost` string — ported verbatim from the old toolbar, rendered in every
Terminal-active pane (not just "the first" — the worktree-level status
data is identical regardless of which PTY is focused, so uniform
rendering avoids "which pane is special" ambiguity); (3) a flexible
spacer; (4) "split right" (`PanelRight`-ish icon, direction `'row'`) and
"split down" (rotated variant, direction `'column'`) icon buttons, always
enabled; (5) a "..." overflow button (`MoreHorizontal`), rendered **only
when `isFocused`** — opens a `@base-ui/react/popover` menu (same
`Popover.Root/Trigger/Portal/Positioner/Popup` pattern as
`WorkspaceSwitcher.tsx`, not a new menu primitive) with: "Approve" (only
when `worktree.state === 'waiting'`, calls the existing `approve(true)`
mutation, same patch shape as today), "Details" (calls `openEdit`, same
as today), "Delete" (calls `askDelete`, same as today).

### Drag-and-drop interaction model

Built on the same `@dnd-kit/core` primitives already used in
`frontend/src/features/issues/` (`DndContext`, `PointerSensor` with a
5px `activationConstraint`, `DragOverlay`) — no new package. Unlike the
issues board (which delegates collision detection entirely to
`pointerWithin` for column-level drops), this feature needs edge-relative
geometry that has no existing precedent in the codebase, so it's computed
by hand:

- **Drag source:** each tab button in a `LeafPane`'s header is a
  `useDraggable({ id: content.id, data: { contentId: content.id, sourcePaneId: pane.id } })`.
- **Drop target:** each `LeafPaneView`'s content body (the area below the
  header) is a `useDroppable({ id: pane.id, data: { paneId: pane.id } })`.
- **Zone math**, run in `onDragMove` (for the live highlight) and
  `onDragEnd` (to commit): take the dragged item's translated rect center
  (`active.rect.current.translated`) and the target's measured rect
  (`over.rect`), normalize to `dx, dy ∈ [0, 1]` within that rect. Bucket:
  `dx < 0.25` → left, `dx > 0.75` → right, `dy < 0.25` → top, `dy > 0.75`
  → bottom, otherwise → center. If a corner satisfies two edge conditions
  at once, the axis whose value is closer to its edge wins (compare
  `min(dx, 1-dx)` vs `min(dy, 1-dy)`; smaller distance's axis decides).
- **Live feedback:** the currently-hovered pane renders an absolutely
  positioned highlight rectangle sized to the winning zone
  (`bg-loom-accent/15` with a `border-loom-accent` edge), and `DragOverlay`
  renders a small floating chip (icon + label) cloned from the dragged
  tab, matching `IssueCardOverlay`'s role in the issues board.
- **Commit on drop — edge zones (left/right/top/bottom):** remove the
  dragged content from its source pane (`removeContent`, triggering
  collapse if that empties the source leaf), determine `direction` (`row`
  for left/right, `column` for top/bottom). If the target leaf's parent
  `SplitPane` already has that same `direction`, insert a new `LeafPane`
  (holding only the dragged content) as a new sibling in that parent's
  `children` — immediately before the target for left/top, immediately
  after for right/bottom. Otherwise, wrap the target leaf in a brand-new
  2-child `SplitPane` of the new `direction`, replacing the target leaf at
  its old position in its own parent, with the dragged content as the
  other child (before/after per the same rule). Either way, `sizes` on
  the affected split are **reset to equal shares** (`1 / children.length`
  each) — structural changes always redistribute evenly; only a manual
  `ResizeHandle` drag produces uneven `sizes`.
- **Commit on drop — center zone:** merge as a new tab into the target
  leaf (`target.tabs.push(content); target.activeTabId = content.id`),
  removing it from the source pane the same way. No structural split. If
  source and target are the same single-tab pane, this is a no-op
  (short-circuited before any mutation).
- **No valid target:** `onDragEnd` with `over === null` (dropped outside
  any pane) leaves the tree unchanged — dnd-kit already reports this
  case directly, no extra guard logic needed beyond an early return.
- **Mobile:** drag-and-drop is disabled below the `md` breakpoint (the
  `DndContext`'s sensors are simply not attached) — there's no
  side-by-side splitting to drag into once the canvas is stacking one
  leaf full-bleed at a time (decision 10).

### Chrome collapse (Header + Sidebar rail)

`w.$wsId.tsx` (`WorkspaceLayout`) computes
`const { wtId } = useScope(); const workspaceMode = Boolean(wtId)` and
renders `{!workspaceMode && <Header />}` plus `<Sidebar collapsed={workspaceMode} />`.

`Sidebar.tsx` gains `interface SidebarProps { collapsed?: boolean }`. When
`collapsed` is true it renders `<SidebarRail />` instead of its existing
JSX tree — a fully separate render branch, not a variation of the
existing `max-md:translate-x`/`sidebarOpen` drawer logic (that logic
stays exactly as-is for the non-collapsed case).

`SidebarRail.tsx` (new): a static `w-11 flex-none flex-col items-center
border-r border-loom-border bg-loom-surface py-2 gap-1` column, always
visible (desktop and mobile alike, no drawer/overlay), containing:

1. A back-arrow button (`ArrowLeft`, `lucide-react`) at the top — calls
   `useScope()` for `wsId`/`projectId` and `navigate({ to: '/w/$wsId/p/$projectId', params: { wsId, projectId } })`, i.e. exactly `ExpandedTerminal`'s old `back()` target, still gated behind the same "unsaved files" `window.confirm` (that dirty-check now lives in the rail's click handler, sourced from `ExpandedTerminal`'s dirty-file state via the store or a lifted callback — see "Preserved behaviors").
2. `WorkspaceSwitcher` gains a `compact?: boolean` prop; when true it
   renders only the existing (now-`export`ed) `WorkspaceBadge` at 22px,
   non-interactive (no `Popover.Trigger`, no text block) — switching
   workspaces mid-worktree isn't a supported interaction here, so the
   compact badge is display-only, keeping the rail's scope tight.
3. `SidebarNav` gains a `compact?: boolean` prop; when true each nav
   button drops its label `<span>` and its numeric badge, becomes
   `h-9 w-9` icon-only, and wraps in the existing `Tooltip` component
   (`frontend/src/components/ui/tooltip.tsx`, `side="right"`) showing
   the item's label. A non-zero badge still renders, but as a small
   `bg-loom-accent` dot (no number) in the button's corner instead of the
   full numeric pill — numbers don't fit a 36px button.

The full (non-collapsed) `Sidebar` — `WorkspaceSwitcher`, `SidebarNav`,
`ModuleAside`/`ProjectTree` body — is completely unchanged in both markup
and behavior on every other route.

### Terminal session-id scheme

- **Primary pane** (the one every worktree's default layout starts with):
  `sessionKey = worktree.id`, exactly like today's `session={w.id}`. No
  behavior change — existing PTYs reattach exactly as before.
- **Every additional Terminal content item** (created via "split" or via
  drag-creating a new Terminal sibling): `sessionKey =
  `${worktreeId}::term-${n}``, where `n` comes from
  `WorktreeLayout.nextTerminalSeq`, incremented and persisted every time
  one is created, never reused (even if that pane later closes) — so two
  Terminal panes can never collide on the same PTY.
- `Terminal.tsx`'s `session` prop and React `key` both read
  `content.sessionKey` (was hardcoded to `w.id`); no change to
  `Terminal.tsx` itself.
- Backend-side: `registry.spawn(id, ...)` (`backend/internal/terminal/registry.go:172-224`)
  is keyed purely by the session-id string it's given — any
  never-before-seen id gets a brand-new `ptySession` with its own ring
  buffer and pump goroutine, confirmed by reading the spawn path. **No
  registry/PTY-layer change is required** for independent PTYs to exist.
  What the registry does *not* give an unseen id is the right working
  directory or agent command — see "Known limitation" immediately below,
  which is the one real wrinkle in an otherwise zero-backend-change
  design.

### Persistence schema

`useLoomStore.ts` (`frontend/src/store/useLoomStore.ts`) gains exactly one
new field, following the existing `sidebarOpen` pattern precisely:

```ts
interface LoomState {
  // ...existing fields
  worktreeLayouts: Record<string, WorktreeLayout> // keyed by worktree id
  setWorktreeLayout: (worktreeId: string, layout: WorktreeLayout) => void
  removeWorktreeLayout: (worktreeId: string) => void
}
```

Initialized as `worktreeLayouts: {}` alongside `sidebarOpen: false` in the
`immer((set) => ({...}))` state object. `setWorktreeLayout` replaces the
whole entry for that worktree id (the `PaneTree`/`ExpandedTerminal` layer
debounces its own writes — every structural change or resize commit calls
it, not every render). `partialize` extends to:

```ts
partialize: (s) => ({ sidebarOpen: s.sidebarOpen, worktreeLayouts: s.worktreeLayouts }),
```

No `version` bump needed — this is a purely additive key; clients with an
existing `loom-ui-v2` blob simply start with `worktreeLayouts: {}` (the
state object's own default) until they visit a worktree.

**Cleanup on worktree delete:** `ConfirmDeleteDialog.tsx`'s `onDelete`,
`kind === 'worktree'` branch, already calls
`deleteWorktree.mutate({ machine, id }, { onSuccess: () => {...} })`. That
`onSuccess` callback gains one line: `removeWorktreeLayout(id)`. This is
the single hook point for cleanup — no separate reconciliation pass is
needed.

**Reading a layout:** `ExpandedTerminal` looks up
`worktreeLayouts[worktree.id]`; if absent, or if it fails a light shape
check (`layout.version !== 1` or `!layout.root`), it falls back to
building the default single-terminal-leaf layout described above rather
than crashing on stale/corrupted localStorage data.

### Component reuse map

Reused with **no prop changes**: `Terminal` (per-instance `session` now
reads `content.sessionKey` instead of the always-`w.id` literal, but the
prop's type and the component itself are untouched), `GitPanel`
(`{worktreeId, machine, active}` — `active` becomes "this pane's
`activeTabId === content.id` and this pane is the visible one on
mobile"), `FileEditor` (`{worktreeId, machine, path, active,
onDirtyChange, onDeleted, onOpenDefinition, reveal}`, same visibility
rule as `GitPanel`), `TerminalExplorer` (`{worktreeId, machine, rootLabel,
onOpenFile, onFileDeleted, onRequestQuickOpen}` — the callbacks now call
into the tree helpers instead of the old flat-array setters, same
signatures), `FileQuickOpen` (unchanged, one instance total for the whole
`ExpandedTerminal`, still parent-controlled via `open`), `MobileKeyToolbar`
(unchanged, one instance, `sendKey` looks up the focused Terminal pane's
`TerminalHandle` from a `Map<string, TerminalHandle>` ref keyed by
`sessionKey` instead of the single `termRef` used today).

New wrapper layer (no existing equivalent): `PaneTree`, `SplitPaneView`,
`LeafPaneView`, `PanelHeader`, `ResizeHandle`, `SidebarRail` — all listed
under "File layout" above.

## Preserved behaviors (must not regress)

| Behavior | Today | After this redesign |
|---|---|---|
| Dirty-file confirm before closing a file tab | `closeFile()` gates on `window.confirm` if `dirtyFiles.has(path)` | Same gate, now called from `PanelHeader`'s per-tab close button |
| Dirty-file confirm before navigating back | `back()` gates on `window.confirm` if `dirtyFiles.size > 0` | Same gate, now in `SidebarRail`'s back-arrow click handler |
| `beforeunload` guard while any file is dirty | effect keyed on `dirtyFiles.size`, worktree-scoped `Set<string>` | Same `Set<string>` of dirty paths (a property of the path, not of any one pane) and the same effect, unmoved |
| `Cmd/Ctrl+P` opens `FileQuickOpen` | global `keydown` listener in `ExpandedTerminal` | Same listener; `onOpenFile` now calls the tree's dedup-aware `openFile` |
| `Ctrl+W` closes the active file tab | skipped when active tab is `'terminal'`/`GIT_TAB` | Skipped unless the *focused pane's* active tab `kind === 'file'` |
| Approve button | shown only when `worktree.state === 'waiting'`, calls `updateWorktree.mutate({...})` with the existing patch shape | Same condition, same mutation call, now inside the focused pane's "..." menu |
| "no machine assigned" empty state | early return before rendering toolbar/tabs | Same early return, before any `PaneTree` rendering |
| Jump-to-definition (`openDefinition`/`definitionReveals`) | records a reveal keyed by path, then calls `openFile` | Identical logic; `openFile` now walks the tree to find-or-create the target `FileContent` instead of pushing onto a flat array |
| `MobileKeyToolbar` sticky-ctrl (`ctrlArmed`) | one `ctrlArmed` boolean + one `termRef`, toolbar hidden unless `activeTab === 'terminal'` | One `ctrlArmed` boolean, reset to `false` whenever `focusedPaneId` changes; toolbar hidden unless the focused pane's active tab `kind === 'terminal'` (same visibility rule, generalized to "the focused pane" instead of "the one panel") |

## Error handling

- Corrupted/stale persisted layout (wrong `version`, missing `root`, or a
  malformed shape) → fall back to the default single-terminal-leaf layout
  instead of throwing; never trust persisted client JSON blindly.
- A `SplitPane` somehow has fewer than 2 `children` (should be impossible
  given the collapse invariant, but handled defensively) → render its
  single remaining child in the split's place, same as the normal
  collapse path, rather than indexing into a short `sizes` array.
- A `LeafPane` somehow has an empty `tabs` array → treated as "already
  collapsed, skip rendering" rather than rendering a headerless blank
  pane; `collapseIfSingleChild` is the only code path that should ever
  produce this, and it removes the leaf immediately, so this is a
  belt-and-suspenders guard, not an expected path.
- Drag ends with `over === null` (dropped outside any pane) → tree
  unchanged, no error surfaced (this is a normal, frequent user action —
  "I changed my mind mid-drag" — not a failure).
- Terminal WS reconnect behavior is entirely unaffected — each pane's
  `Terminal` instance owns its own reconnect/backoff logic exactly as it
  does today; nothing in this feature touches that.

## Known limitation (accepted, not solved now)

`backend/internal/terminal/server.go`'s `resolveCommand` (used to pick the
agent binary/cwd for a new PTY) does `strings.HasPrefix(session, "w-")`
then an **exact-match** SQL lookup, `store.WorktreeByID(session)`. A
suffixed session id like `w-abc123::term-2` passes the prefix check but
fails that exact lookup, so `resolveCommand` returns `("", nil, "")`, and
`pty.go`'s `resolveWorkDir("")` falls back to the backend process's home
directory. Net effect: the **primary** Terminal pane (`sessionKey ===
worktree.id`) behaves exactly as it does today — correct cwd, agent
resumes — but **every additional** Terminal pane opens a plain shell in
the backend host's home directory, not the worktree path, and never
launches the configured agent. Separately, `WorktreeService.Delete` only
calls `terminal.KillSession(id)` with the bare worktree id, so
extra-pane sessions aren't explicitly killed on worktree deletion; they
idle out via the existing 10-minute grace TTL, same as any other orphaned
session today. Both are one-line Go fixes (strip everything from the
first `::` before the `WorktreeByID` lookup; pass the same stripped id
list to `KillSession`), but **any** Go change is out of scope for this
pass per the explicit "100% frontend" decision, so this is accepted as-is:
a user who wants a second shell actually rooted in the worktree can `cd`
there manually after the pane opens. Tracked as a fast-follow, not part
of this design's execution.

## Testing

- `npm run typecheck` after each sub-project stage below.
- Manual: open a worktree, confirm the primary Terminal pane behaves
  identically to today (agent resumes, correct cwd — the one thing that
  must not regress).
- Manual: split right into a second Terminal pane, type in each, confirm
  they're independent (no shared echo) and confirm the known cwd/agent
  limitation above (documented, not a bug).
- Manual: split down with a file open, drag that file tab onto the
  Terminal pane's right-edge zone (creates a new split) and then onto its
  center zone (merges as a tab); confirm the 5-zone highlight matches
  where it lands.
- Manual: close tabs down to a single leaf in a split, confirm the split
  collapses (no residual empty/degenerate nodes); close a worktree's last
  file tab and confirm dirty-confirm still fires.
- Manual: resize a split via `ResizeHandle`, refresh the page, confirm the
  same tree, tabs, and sizes reopen (persistence round-trip).
- Manual: delete a worktree, confirm its `worktreeLayouts` entry is gone
  (inspect `localStorage['loom-ui-v2']`).
- Manual: confirm `Header` is absent and `Sidebar` is the 44px rail only
  on `/w/$wsId/p/$projectId/wt/$wtId`; confirm every other route still
  shows the unchanged full `Header` + 298px `Sidebar`.
- Manual: shrink the viewport below `md`, confirm the canvas stacks one
  leaf full-bleed at a time (no side-by-side splits) with the rail still
  visible and drag-and-drop disabled.
- Manual: `Cmd/Ctrl+P`, `Ctrl+W`, jump-to-definition, and Approve all
  re-verified against the "Preserved behaviors" table above.

## Sub-projects (build order)

1. **Data model + persistence:** `paneTypes.ts` (types + pure tree
   helpers: insert/remove/collapse/resize/find), the `worktreeLayouts`
   store slice + `partialize` extension in `useLoomStore.ts`, and the
   cleanup line in `ConfirmDeleteDialog.tsx`. Fully unit-testable as pure
   functions before any UI exists.
2. **Chrome collapse + tiling render:** `workspaceMode` detection in
   `w.$wsId.tsx`, `Sidebar`/`SidebarNav`/`WorkspaceSwitcher` `compact`
   props + new `SidebarRail`, and `PaneTree`/`SplitPaneView`/
   `LeafPaneView`/`PanelHeader`/`ResizeHandle` wiring the existing
   `Terminal`/`GitPanel`/`FileEditor`/`TerminalExplorer`/`FileQuickOpen`/
   `MobileKeyToolbar` into leaves, plus the split-right/split-down
   buttons (no drag yet — splitting alone already exercises the whole
   tree engine end-to-end). This alone is a fully usable, if drag-less,
   tiling workspace.
3. **Drag-and-drop:** `DndContext` wiring in `PaneTree`, the 5-zone edge
   detection + tie-break rule, `DragOverlay` tab preview, the hover
   highlight rectangle, and the `md`-and-up gate that disables it on
   mobile.

Each stage independently typechecks and builds; #1 carries no UI risk,
#2 is the core deliverable, #3 is additive polish on top of it.

## Out of scope

- Backend fix for the multi-pane session cwd/agent-resolution limitation
  (stripping `::term-N` before the `WorktreeByID` lookup in
  `resolveCommand`, and passing the same stripped id to `KillSession`) —
  a trivial Go change, but any Go file change is explicitly excluded from
  this pass. See "Known limitation" above.
- New panel content types beyond Terminal/Git/File/Explorer (CPU graph,
  web preview, AI chat panes, etc.) — not part of Loom's feature set.
- Server-side/database persistence of layout — client-only via
  `zustand/persist`/`localStorage`; this is a UI preference, not domain
  data, and never touches `port.Store`.
- Touch drag-to-split on mobile — the mobile canvas stacks one leaf
  full-bleed at a time instead; there's no side-by-side geometry to drag
  into.
- Cross-worktree pane drag (dragging a tab from one worktree's
  `ExpandedTerminal` into a different worktree's) — each worktree's
  `DndContext` and pane tree are fully independent; not requested.
- Tab renaming, custom pane colors, named/saved layout presets — no such
  affordance was requested.
- Changing the terminal WebSocket protocol, framing, or compression
  negotiation — untouched, and required to stay untouched for the
  production tunnel setup.

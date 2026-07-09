# Loom Terminal Workspace Tiling — Design

**Date:** 2026-07-09
**Status:** Implemented — this revision reconciles the doc against the
actual shipped code (file names, prop names, route-detection mechanism,
and the two backend fixes) after an adversarial self-review of the
original draft found several contradictions and underspecified operations.

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
This is primarily a frontend change — no new panel content types, no
server-side layout persistence. Two small, targeted Go fixes were required
for independent multi-pane terminal sessions to actually work (correct
working directory/agent resolution, and cleanup on worktree delete); see
"Terminal session-id scheme" below — everything else is frontend-only.

## Decisions (from brainstorming)

1. **Trigger scope:** the new chrome-collapsed "workspace mode" applies only
   on the worktree-terminal route (`ExpandedTerminal`). Every other route
   keeps today's `Header` + full `Sidebar` layout untouched. Detected by
   matching the current pathname against a module-level regex in
   `WorkspaceLayout` (`frontend/src/routes/w.$wsId.tsx`) — no new store
   flag needed, it's purely a function of the URL.
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
   "split right" / "split down" buttons (see "Split semantics per content
   kind" below for what each content kind actually does). Dragging a
   pane's tab over another pane computes 5 zones from pointer position —
   the outer 25% strip along each edge (`dx`/`dy` outside `[0.25, 0.75]`)
   is a new split in that direction; the remaining central 50%×50% box
   (`dx` **and** `dy` both inside `[0.25, 0.75]` — 25% of the pane's
   *area*, not "inner 50%" of a linear dimension) merges as a new tab; see
   "Zone math" below for the exact tie-break rule at corners. Implemented
   with the `@dnd-kit/core`
   primitives already used in `frontend/src/features/issues/` (no new DnD
   library). Removing a leaf's last tab collapses a now-single-child split
   into that child, recursively — the tree never holds degenerate nodes.
7. **Terminal panes are independent PTYs:** the primary pane in every
   worktree keeps `session = worktree.id` (unchanged, so existing sessions
   reattach exactly as before); every additional Terminal content item gets
   a distinct `sessionKey` (`${worktreeId}::term-${n}`), which the existing
   PTY `registry.spawn` (`backend/internal/terminal/registry.go`) accepts
   with zero registry changes — confirmed by reading the spawn path. Getting
   the right working directory/agent for those extra panes did need two
   small Go fixes elsewhere (`resolveCommand`'s worktree lookup, and
   session cleanup on delete) — see "Backend fixes required" below.
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
    side by side — a distinct technique from `Sidebar`'s drawer (see
    decision 3; the rail never uses `sidebarOpen`/translate-x at all): each
    split renders as a vertically scroll-snapped column
    (`flex-col overflow-y-auto snap-y snap-mandatory`, each child
    `snap-start`, resize handles hidden) instead of the side-by-side
    resizable row/column layout — there's no room for tiling on a
    phone-width screen.

## Architecture

```
w.$wsId.tsx (WorkspaceLayout)
  workspaceMode = WORKSPACE_MODE_PATTERN.test(pathname)

  ┌───────────────────────────────────────────────────────────────┐
  │ {!workspaceMode && <Header/>}                                  │
  ├───────────┬─────────────────────────────────────────────────── ┤
  │ <Sidebar  │ <Outlet/>                                           │
  │  compact  │   └─ w.$wsId.p.$projectId.wt.$wtId.tsx               │
  │  ={mode}/>│       └─ ExpandedTerminal                            │
  │           │            └─ TerminalWorkspace (key=worktree.id)    │
  │ compact   │                 ├─ PaneCanvas(root: layout.root)     │
  │ = 44px    │                 │    ├─ SplitPaneView (recursive,    │
  │  rail:    │                 │    │    resize divider between     │
  │  - back   │                 │    │    each pair of children)     │
  │    arrow  │                 │    ├─ LeafPaneView                 │
  │  - Ws     │                 │    │    ├─ PanelHeader             │
  │    badge  │                 │    │    │   (tabs, split l/r/d,    │
  │  - nav    │                 │    │    │    "..." if focused)     │
  │    icons  │                 │    │    │    (title chrome if      │
  │           │                 │    │    │     active tab=Terminal) │
  │  not      │                 │    │    └─ active tab's content:   │
  │  compact  │                 │    │        Terminal | GitPanel |  │
  │  = today's│                 │    │        FileEditor |            │
  │  298px    │                 │    │        TerminalExplorer        │
  │  Sidebar  │                 │    └─ ...                          │
  │  (WsSwit- │                 ├─ FileQuickOpen (single instance,    │
  │  cher +   │                 │    modal)                          │
  │  Nav +    │                 └─ MobileKeyToolbar (bound to focused │
  │  body)    │                      Terminal pane's TerminalHandle)  │
  └───────────┴───────────────────────────────────────────────────────┘
```

### File layout

New files, all under `frontend/src/features/terminal/`:

- `paneTree.ts` — `PaneNode`/`PaneContent`/`WorktreeLayout` types + pure
  tree helpers (`findPane`, `findContent`, `findLeafForContent`,
  `splitPane`/`splitLeaf`, `removeContent`/`closeTab`, `moveTab` (drag-drop
  commit), `resizeSplit`, `focusPane`, `serializeLayout`/`deserializeLayout`).
  Every mutation is pure and structurally-shares untouched subtrees.
- `PanelHeader.tsx` — the generic, content-agnostic per-pane header
  described below (tab strip, split buttons, overflow menu, drag handles).
- `PaneCanvas.tsx` — the tiling renderer: a recursive dispatcher
  (`PaneNodeView` → `SplitPaneView` | `LeafPaneView`) that owns the
  `DndContext` for the whole tree, lays out `SplitPane.children` in a flex
  row/column per `direction` with a plain-pointer-events resize divider
  between each pair (`onPointerDown` + `setPointerCapture` +
  `pointermove`/`pointerup`, not dnd-kit — dnd-kit is reserved for
  pane/tab rearrangement), and renders each `LeafPane` via `PanelHeader`
  plus every tab's content kept mounted (`active` toggled via CSS
  visibility/`absolute inset-0` + `hidden`, same "mount all, hide
  inactive" approach `ExpandedTerminal` already used for `FileEditor`).
  Everything specific to what a "terminal" or "file" actually renders as
  is injected via a `renderers: PaneContentRendererMap` prop, so this file
  stays agnostic of `Terminal`/`GitPanel`/`FileEditor`/`TerminalExplorer`.

New file under `frontend/src/features/sidebar/`:

- `SidebarRail`, a component inside `Sidebar.tsx` (not a separate file) —
  the collapsed 44px rail (see "Chrome collapse" below).

Modified: `ExpandedTerminal.tsx` (split into a thin outer component that
resolves `machine`/`project` plus an inner `TerminalWorkspace` mounted with
`key={worktree.id}`, which owns the layout state and renders `PaneCanvas`),
`Sidebar.tsx`, `SidebarNav.tsx`, `WorkspaceSwitcher.tsx`, `w.$wsId.tsx`,
`useLoomStore.ts` (new persisted slice), `ConfirmDeleteDialog.tsx` (layout
cleanup hook, all three delete kinds), `Terminal.tsx`'s only caller changes
its `session` prop source (component itself is untouched by this feature —
note it separately gained search/WebGL/clipboard-serialize addons in the
same working session, unrelated to tiling).

### PaneNode / PaneContent data model

```ts
// frontend/src/features/terminal/paneTree.ts

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
elements. When `removeContentFromNode(paneId, contentId)` empties a
`LeafPane`'s `tabs`, that leaf is dropped from its parent's `children`
(the recursive walk returns `null` for an emptied leaf, which the parent
filters out); if that leaves the parent with exactly 1 remaining child,
the parent `SplitPane` is replaced *in its own parent* by that one
remaining child — the same single recursive pass handles this at every
level, so a removal that cascades through several nested splits collapses
all of them in one call, not one level at a time.

**Root-of-tree handling:** `WorktreeLayout.root` has no parent node — it's
referenced from the layout wrapper, not from within the tree itself. Two
operations need an explicit root case and both have one: (1) inserting a
new sibling next to the root (the very first split a worktree ever makes)
— `insertLeafAdjacent` checks `root.id === targetPaneId` first and, if so,
wraps the *entire* current root and the new leaf in a brand-new top-level
`SplitPane`, rather than trying to find a "parent" that doesn't exist; (2)
removing the tree down to nothing — see "last-tab removal" below.

**Last-tab removal (including at the root):** closing a tab whose leaf
would become empty is handled by the same `removeContentFromNode`/
`closeTab` path regardless of where in the tree it happens. If the empty
leaf *is* the root (the very last tab of the very last pane), the whole
tree would become empty; `closeTab` treats this as a defensive no-op —
`layout` is returned unchanged — rather than producing a `WorktreeLayout`
with no root. The UI layer never actually needs to rely on this in
practice (a worktree's primary Terminal pane is never the target of a
"close" action from `PanelHeader`'s per-tab or whole-pane close buttons in
normal use), but the pure function itself is total: it cannot crash or
return an invalid tree no matter what's closed in what order.

**Default layout** (no persisted entry for this worktree yet) is a single
leaf holding only the primary Terminal tab — this is *not* a reconstruction
of "everything that happened to be open" in the old tab strip (which had
no persisted state of its own to reconstruct from), it's simply the
narrowest starting point a worktree can have:

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

Git and Explorer panes are reachable from this starting point via the
"..." overflow menu's "Open Git panel"/"Open file explorer" actions (see
`PanelHeader`), which add-or-focus that content kind in the currently
focused pane — this exists specifically because "split" always duplicates
the *active tab's own kind* (decision 6), so a fresh single-Terminal-leaf
worktree could otherwise never reach a Git or Explorer pane at all.

### PanelHeader

One header per `LeafPane`, fixed height ~32px (down from the old 44px
toolbar + 36px tab strip = 80px combined, freeing real vertical space for
the canvas), single row. `PanelHeader` itself is fully generic/presentational
— it knows nothing about Terminal/Git/File/Explorer specifically, only the
abstract shape below; `ExpandedTerminal` supplies everything content-specific
(icons, title chrome, overflow actions) via props/callbacks:

```ts
interface PanelHeaderTab {
  id: string
  label: string
  icon?: ReactNode // caller supplies TerminalSquare / GitBranch / FolderTree / MaterialFileIcon
  dirty?: boolean
}

interface PanelHeaderProps {
  paneId: string // threaded into dnd-kit drag data as sourcePaneId
  tabs: PanelHeaderTab[]
  activeTabId: string
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onSplitRight: () => void
  onSplitDown: () => void
  onClose: () => void // closes the whole pane (all its tabs)
  isFocused?: boolean // gates the "..." overflow button; default true
  titleContent?: ReactNode // e.g. worktree status/branch/cost chrome
  overflowActions?: ReactNode // e.g. Approve/Details/Delete; omit to hide the "..." button
  className?: string
}
```

Layout, left to right: (1) the pane's own tab strip, each tab a dnd-kit
`useDraggable` drag source, `TerminalSquare`/`GitBranch`/`FolderTree`/
`MaterialFileIcon` per kind, yellow `*` dirty marker, per-tab `X` close
button; (2) `titleContent`, rendered by `ExpandedTerminal` only when the
pane's *active* tab is Terminal content — `StatusDot` + `WorktreeGlyph` +
branch/root label + `Pill` (state) + the `model · elapsed · tokens · cost`
string, ported verbatim from the old toolbar, shown uniformly in every
Terminal-active pane (the worktree-level status data is identical
regardless of which PTY is focused — there is no "the primary/special
pane" distinction here); (3) a flexible spacer; (4) "split right" and
"split down" icon buttons, always enabled — see "Split semantics" below
for what each content kind actually does when split; (5) a "..." overflow
button, rendered **only when `isFocused`**, popping open
`overflowActions` — `ExpandedTerminal` supplies "Approve" (only when
`worktree.state === 'waiting'`), "Open Git panel" / "Open file explorer"
(add-or-focus that kind in this pane — see "Default layout" above),
"Details", "Delete", using the same `@base-ui/react/popover` pattern as
`WorkspaceSwitcher.tsx`.

**Focus lifecycle:** `focusedPaneId` is set by a `onPointerDownCapture` on
each `LeafPane`'s whole body (header *and* content area) — clicking or
typing anywhere inside a pane focuses it, not just its header. It's
reconciled automatically whenever a structural change (close, collapse,
or a drag-drop commit) would leave it pointing at a pane that no longer
exists: both `closeTab` and `moveTabInLayout` check `findPane(nextRoot,
focusedPaneId)` and fall back to the tree's first leaf (a stable, always-
resolvable deterministic default) if the previously-focused pane is gone.
`ctrlArmed` (the `MobileKeyToolbar` sticky-Ctrl flag) resets to `false`
whenever `focusedPaneId` changes, so an armed Ctrl never silently applies
to a keystroke in a different pane than the one the user armed it in.

**Split semantics per content kind** (what "split right"/"split down"
actually creates, since a `LeafPane`'s new sibling must always start as a
*same-kind* leaf, per decision 6):
- **Terminal:** allocates a brand-new `TerminalContent` via
  `allocateTerminalContent` (bumps `nextTerminalSeq`) — always creates a
  genuinely new, independent PTY pane.
- **Git / Explorer:** creates a fresh `GitContent`/`ExplorerContent` (new
  random id) — a worktree can have multiple simultaneous Git or Explorer
  panes, each independent.
- **File:** `FileContent.id === path` (the "one instance per open path"
  invariant), so a second `FileContent` for the same path cannot be
  created — it would collide on id with the tab being split. Instead,
  "split" on a file-active pane **relocates** that tab into the new
  sibling pane (via the same `moveTab` primitive drag-and-drop commits
  use, with the split's implied direction/position as the drop zone) —
  it does not duplicate the file, it moves it out into its own pane. A
  no-op if the pane's only tab is the file being split (nothing left in
  the original pane to split away from).

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
  source and target are the same pane, this is always a no-op regardless
  of tab count — dropping onto your own pane's center can never change
  anything (either it's the same single tab, or it's already a tab there).
- **Same-pane edge-zone drop (self-split):** dragging a tab onto an edge
  zone of *its own* pane is allowed when that pane has more than one tab —
  it "pops" the dragged tab out into a brand-new sibling leaf beside its
  former pane, same as dragging it onto a different pane's edge. This is
  intentional (a quick way to pull one tab out of a stack into its own
  split without dragging across the canvas), not an error case. It's only
  suppressed when the pane has exactly one tab (dragging a pane's only tab
  onto its own edge would be a no-op split-of-nothing).
- **No valid target:** `onDragEnd` with `over === null` (dropped outside
  any pane) leaves the tree unchanged — dnd-kit already reports this
  case directly, no extra guard logic needed beyond an early return.
- **Resize minimum:** dragging a divider clamps each affected pane to a
  minimum 8% share of the split's axis (`MIN_PANE_SIZE = 0.08`), enforced
  where the drag delta is computed (in `PaneCanvas`'s pointer-move
  handler), not in `resizeSplit` itself — the pure data function only
  rejects non-positive sizes, since a resize coming from anywhere other
  than that one interactive divider (e.g. a future programmatic resize)
  may have different constraints. This prevents a pane from being dragged
  down to an invisible sliver outside the collapse invariant (collapse
  only triggers on *closing* a tab, never from resizing alone).
- **Mobile:** drag-and-drop is disabled below the `md` breakpoint (the
  `DndContext`'s sensors are simply not attached) — there's no
  side-by-side splitting to drag into once the canvas is stacking one
  leaf full-bleed at a time (decision 10).

### Chrome collapse (Header + Sidebar rail)

`w.$wsId.tsx` (`WorkspaceLayout`) derives workspace mode from the current
pathname via a module-level regex —
`const WORKSPACE_MODE_PATTERN = /^\/w\/[^/]+\/p\/[^/]+\/wt\/[^/]+/` and
`const workspaceMode = WORKSPACE_MODE_PATTERN.test(pathname)` (the existing
`useLocation` hook already used there) — rather than `useScope().wtId`, so
it stays purely a function of the URL with no dependency on route-param
parsing helpers. Renders `{!workspaceMode && <Header />}` plus
`<Sidebar compact={workspaceMode} />`.

`Sidebar.tsx` gains `interface SidebarProps { compact?: boolean }`. When
`compact` is true it short-circuits to a `SidebarRail` component (defined
in the same file, not split out) instead of its existing JSX tree — a
fully separate render branch, so the non-compact path (drawer,
`sidebarOpen`, 298px width) is byte-for-byte unchanged.

`SidebarRail` (in `Sidebar.tsx`): a static `w-11 flex-none flex-col
items-center border-r border-loom-border bg-loom-surface py-2 gap-1`
column, always visible (desktop and mobile alike, no drawer/overlay),
containing:

1. A back-arrow button (`ArrowLeft`, `lucide-react`, wrapped in the
   existing `Tooltip` component, `side="right"`) at the top — reads
   `wsId`/`projectId` from `useScope()` and calls
   `navigate({ to: '/w/$wsId/p/$projectId', params: { wsId, projectId } })`,
   i.e. exactly `ExpandedTerminal`'s old `back()` target. Gated behind the
   same "unsaved files" `window.confirm`, sourced from a new
   `dirtyFileCount: number` field on `useLoomStore` — `ExpandedTerminal`
   (which owns the actual `dirtyFiles: Set<string>`) syncs its size into
   that store field via an effect, reset to `0` on unmount, so `SidebarRail`
   (which lives outside `ExpandedTerminal`'s subtree entirely) can read it
   without prop-drilling across the route boundary.
2. `WorkspaceSwitcher` gains a `compact?: boolean` prop; when true it
   renders only the existing `WorkspaceBadge` at a smaller size,
   non-interactive (no `Popover.Trigger`, no text block) — switching
   workspaces mid-worktree isn't a supported interaction here, so the
   compact badge is display-only, keeping the rail's scope tight.
3. `SidebarNav` gains a `compact?: boolean` prop; when true each nav
   button drops its label `<span>` and its numeric badge, becomes
   icon-only, and wraps in the existing `Tooltip` component
   (`side="right"`) showing the item's label.

The full (non-compact) `Sidebar` — `WorkspaceSwitcher`, `SidebarNav`,
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
  registry/PTY-layer change was required** for independent PTYs to exist.
  What the registry does *not* give an unseen id on its own is the right
  working directory or agent command, since `resolveCommand`
  (`backend/internal/terminal/server.go`) originally did an **exact-match**
  `store.WorktreeByID(session)` lookup — a suffixed id like
  `w-abc123::term-2` failed that lookup and silently fell back to a plain
  shell in the backend host's home directory. Fixed with two small,
  targeted Go changes (the only Go changes in this feature): (1)
  `resolveCommand` now strips everything from the first `::` before both
  the `WorktreeByID` lookup and the `.wt/<worktreeId>` working-directory
  join, so every pane resolves the same worktree row and cwd as the
  primary pane; (2) a new `registry.killByWorktree(worktreeID)` /
  `terminal.KillWorktreeSessions(worktreeID)` kills the primary session
  *and* every `<worktreeID>::term-N` pane session together, wired in place
  of the old bare `terminal.KillSession` in `WorktreeService`'s delete
  path (`cmd/server/main.go`), so extra panes no longer leak until the
  10-minute idle-grace TTL.

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

**Cleanup on delete:** `ConfirmDeleteDialog.tsx`'s `onDelete` calls
`removeWorktreeLayout` in its `onSuccess` callback for all three delete
kinds that can remove a worktree, not just the `'worktree'` branch:
`'worktree'` calls it once for the deleted id; `'project'` and
`'workspace'` cascade-delete every worktree under them, so their branches
capture the full list of affected worktree ids (via `findProject`/`findWs`,
read *before* the mutation removes them from the query cache) and call
`removeWorktreeLayout` once per id. Without the project/workspace cases,
cascade-deleted worktrees would orphan their persisted layout blobs in
`localStorage['loom-ui-v2']` forever, since nothing else ever revisits a
deleted worktree id.

**Reading a layout:** `ExpandedTerminal` looks up
`worktreeLayouts[worktree.id]`; if absent, or if it fails a light shape
check (`layout.version !== 1` or `!layout.root`), it falls back to
building the default single-terminal-leaf layout described above rather
than crashing on stale/corrupted localStorage data.

### Component reuse map

Reused with **no prop-type changes**: `Terminal` (per-instance `session`
now reads `content.sessionKey` instead of the always-`w.id` literal, but
the prop's type and the component itself are untouched by this feature),
`GitPanel` (`{worktreeId, machine, active}` — `active` is simply
`this pane's activeTabId === content.id`, i.e. "is this the pane's
currently-selected tab"; every split leaf is simultaneously mounted and
visible on desktop, so `active` here is purely a tab-selection concern,
not a viewport-visibility one — there is no separate mobile-only
visibility rule layered on top), `FileEditor` (`{worktreeId, machine,
path, active, onDirtyChange, onDeleted, onOpenDefinition, reveal}`, same
`active` meaning as `GitPanel`), `TerminalExplorer` (`{worktreeId,
machine, rootLabel, onOpenFile, onFileDeleted, onRequestQuickOpen}` — the
callbacks now call into the tree helpers instead of the old flat-array
setters, same signatures), `FileQuickOpen` (unchanged, one instance total
for the whole `ExpandedTerminal`, still parent-controlled via `open`),
`MobileKeyToolbar` (unchanged, one instance, `sendKey` looks up the
focused Terminal pane's `TerminalHandle` from a `Map<string,
TerminalHandle>` ref keyed by `sessionKey` instead of the single `termRef`
used today).

New wrapper layer (no existing equivalent): `paneTree.ts`, `PanelHeader`,
`PaneCanvas`, `SidebarRail` — all listed under "File layout" above.

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

## Backend fixes required (discovered during implementation)

Research during implementation found that the original "100%-frontend,
zero Go changes" plan for the terminal session-id scheme (decision 7) was
not actually achievable without a real functional gap: `resolveCommand`'s
exact-match `WorktreeByID` lookup would silently give every non-primary
Terminal pane the wrong cwd and no agent (see "Terminal session-id scheme"
above for the exact mechanism). Rather than ship that gap as an accepted
limitation, two small, targeted Go fixes were made — both strictly
additive, no protocol/behavior change for the primary pane or any
existing session:

1. `backend/internal/terminal/server.go`, `resolveCommand`: strips
   everything from the first `::` off `session` before the
   `WorktreeByID` lookup and the `.wt/<worktreeId>` working-directory
   join.
2. `backend/internal/terminal/registry.go` / `kill.go`: new
   `registry.killByWorktree(worktreeID)` and exported
   `terminal.KillWorktreeSessions(worktreeID)`, which kill the primary
   session plus every `<worktreeID>::term-N` pane session in one call;
   wired into `WorktreeService`'s delete path in `cmd/server/main.go` in
   place of the old bare `terminal.KillSession`.

Both are covered by the existing `go vet`/`go build`/`go test
./internal/terminal/... ./internal/service/...` verification and change
nothing about the WebSocket protocol, framing, or compression.

## Testing

- `npm run typecheck` after each sub-project stage below.
- Manual: open a worktree, confirm the primary Terminal pane behaves
  identically to today (agent resumes, correct cwd — the one thing that
  must not regress).
- Manual: split right into a second Terminal pane, type in each, confirm
  they're independent (no shared echo) and confirm the second pane opens
  in the worktree's own directory with its configured agent (not a plain
  $HOME shell) now that the backend fixes above have landed.
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

1. **Data model + persistence:** `paneTree.ts` (types + pure tree
   helpers: split/close/move/resize/find), the `worktreeLayouts` store
   slice + `partialize` extension in `useLoomStore.ts`, and the cleanup
   hook in `ConfirmDeleteDialog.tsx` (all three delete kinds). Fully
   unit-testable as pure functions before any UI exists.
2. **Chrome collapse + tiling render:** `workspaceMode` detection in
   `w.$wsId.tsx`, `Sidebar`/`SidebarNav`/`WorkspaceSwitcher` `compact`
   props + `SidebarRail`, and `PanelHeader`/`PaneCanvas` wiring the
   existing `Terminal`/`GitPanel`/`FileEditor`/`TerminalExplorer`/
   `FileQuickOpen`/`MobileKeyToolbar` into leaves, plus the split-right/
   split-down buttons (no drag yet — splitting alone already exercises
   the whole tree engine end-to-end). This alone is a fully usable, if
   drag-less, tiling workspace.
3. **Drag-and-drop:** `DndContext` wiring in `PaneCanvas`, the 5-zone
   edge detection + tie-break rule, `DragOverlay` tab preview, the hover
   highlight rectangle, and the `md`-and-up gate that disables it on
   mobile.
4. **Backend fixes:** `resolveCommand`'s worktree-id stripping and
   `KillWorktreeSessions` (see "Backend fixes required" above) — done
   last since they only matter once multi-pane Terminal splitting exists
   to exercise them.

Each stage independently typechecks and builds; #1 carries no UI risk,
#2 is the core deliverable, #3 is additive polish on top of it.

## Out of scope

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

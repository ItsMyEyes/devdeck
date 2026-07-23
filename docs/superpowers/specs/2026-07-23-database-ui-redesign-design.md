# Database Management UI/UX Redesign (Navicat-style) — Design

Status: approved (brainstorming 2026-07-23)
Scope: **Frontend only.** Full visual/interaction pass over the existing,
already-shipped Database module (`docs/superpowers/specs/2026-07-19-database-management-design.md`).
No backend, driver, or API changes. No new domain types.

## Goal

Give the Database module a Navicat-class look and feel: a colorful, systematic
tab strip for open objects, a persistent inspector panel, and consistent
color/icon coding for engines, object kinds, and data types — while keeping
the rest of DevDeck's restrained, teal-only visual language untouched.

Success: opening a connection feels like Navicat (colorful, information-dense,
tabs that carry identity at a glance) without the rest of the app absorbing
any of that decoration — Terminal, SSH, Runtimes, Explorer stay exactly as
calm as they are today.

## Decisions (from brainstorming)

1. **Full DB-module pass**, not just the tab strip — tree, gallery, dialogs,
   grid, and a new inspector pane are all in scope, so nothing added later
   feels bolted on.
2. **Full Navicat-style color richness, scoped to this module only.** Chosen
   over a semantic-only palette or a per-engine-accent-bleed palette (see
   "Approaches considered"). Requires a documented, explicit exception in
   `PRODUCT.md` — the app's general "teal is the only accent" rule is
   otherwise unchanged everywhere else.
3. **Match the terminal tab strip's visual language and reuse its popover
   shell, but give DB tabs their own local drag-reorder.** Investigated during
   planning: `PanelHeader.tsx`'s drag (`useDraggable`) is entangled with
   cross-pane split-view drop zones owned by `PaneCanvas.tsx` (a `DndContext`
   living above `PanelHeader`, with per-pane droppable zones for dragging tabs
   *between* split panes) — infrastructure the DB module, which has no split
   panes, would never use. `DBTabStrip` is therefore a new, self-contained
   component: same active/hover/close/dirty-dot visual language as
   `PanelHeader`, its own single-list reorder via `@dnd-kit/sortable`'s
   `SortableContext` (already a dependency, no cross-pane `DndContext`
   needed). Only the small, genuinely-duplicated overflow/new-tab popover
   shell (`Popover.Root`/`Trigger`/`Positioner`/`Popup` with identical
   styling, already used twice inside `PanelHeader` itself) is extracted into
   a shared `TabStripPopoverMenu` — real DRY win where it actually applies,
   zero risk to the terminal's working split-drag system.
4. **Add a persistent right-side inspector pane** (three-pane layout: tree |
   tabs+content | inspector), matching the Navicat reference images, rather
   than keeping metadata as an inline strip above the grid.
5. **Inspector mirrors the active tab's object** — no separate "selected but
   not opened" tree state. One source of truth; tree clicks still open/focus
   a tab exactly as today.
6. **Lift `activeConnectionId` into the store** so the redesigned tab
   experience actually persists across navigation/reload, instead of
   resetting every time (today: local `useState` in `DatabaseModule`).
7. **Connection-status dot reflects the last explicit "Test" result only** —
   the backend has no live health-check endpoint (confirmed against
   `handler/db.go` / `service/dbexec.go`), so this is not presented as
   real-time monitoring. Labeled on hover to avoid implying a guarantee it
   can't back up.

## Approaches considered

**Color richness — three options weighed:**

- *Semantic color only*: color strictly encodes meaning (data-type badges,
  object-kind icons, a small engine dot, amber-for-production), teal stays
  the only "real" accent. Cheapest, zero `PRODUCT.md` change needed. Rejected
  as the sole approach — too timid relative to the Navicat reference and the
  explicit ask for "colourful."
- *Expanded palette per engine*: each engine's color bleeds into that
  connection's whole tab strip / sidebar entry / dialogs, not just a dot.
  Rejected as the primary approach — coloring entire surfaces by engine
  competes with the kind/type color coding for visual attention, and two
  independent color axes (engine likeness vs. object kind) fighting for the
  same saturated real estate reads as noisier, not clearer.
- **Full Navicat-style richness (chosen).** Colorful icons across toolbar,
  tree, tabs, and type badges — closest to the reference material, biggest
  visual departure from the rest of DevDeck. Cost: requires a documented,
  scoped exception in `PRODUCT.md` (not a rewrite of it) and the largest
  design-token surface of the three options. Mitigated by keeping color
  *role-based* (Section "Color & Icon System") rather than decorative, so it
  reads as a systematic language rather than gloss.

**Tab-strip implementation — three options weighed:**

- *Fully separate DB-specific tab strip, no shared code at all*: avoids
  pulling in `PanelHeader`'s concepts entirely. Rejected — the overflow/new-tab
  popover shell is real, already-duplicated-twice boilerplate inside
  `PanelHeader.tsx` itself; not sharing it just duplicates it a third time for
  no benefit, since that piece has zero dependency on the cross-pane drag
  system.
- *Full shared `TabStrip` primitive covering drag too*: extract `PanelHeader`'s
  `useDraggable`-based tab-button rendering into a shared primitive, and give
  `DatabaseModule` its own `DndContext` + droppable zones to use it. Rejected
  after investigation (see Decision 3) — `PanelHeader`'s drag is entangled
  with `PaneCanvas.tsx`'s cross-pane split-view drop zones, which the DB
  module (one pane, never splits) has no use for; forcing it through adds a
  cross-pane-capable drag system for a module that will never move a tab
  between panes, and risks regressing the terminal's working split-drag
  feature for no payoff.
- **Own reorder, shared popover shell (chosen).** `DBTabStrip` is a new,
  self-contained component matching `PanelHeader`'s visual language, with its
  own single-list drag-reorder via `@dnd-kit/sortable`'s `SortableContext`
  (self-contained, no cross-pane concerns). The overflow-menu and new-tab
  popover shell — identical `Popover.Root`/`Trigger`/`Positioner`/`Popup`
  JSX already appearing twice in `PanelHeader.tsx` — is extracted into a
  shared, purely presentational `TabStripPopoverMenu` component that both
  `PanelHeader` and `DBTabStrip` render. Cost: `DBTabStrip`'s reorder logic
  is not literally shared with `PanelHeader`'s, so the two could in principle
  drift in reorder-specific behavior (e.g. keyboard nav) over time — accepted
  because the two reorder problems (single-list vs. cross-pane) are genuinely
  different, and forcing one shape onto both is the greater long-term cost.

## Color & Icon System

Three color groups, kept in different visual contexts (connection identity,
tree/tab object kind, grid-header data type) so they never compete for the
same pixels. Exact hex values below are starting points — finalized during
implementation against WCAG AA contrast. The commitment that matters is the
**role mapping**: a given kind always means the same hue, everywhere it
appears.

**Storage mechanism**: a plain constants module,
`frontend/src/features/database/dbColors.ts`, exporting hex-string maps —
matching this codebase's *existing* convention for per-entity colors (worktree
status dots, workspace tile colors in `WorkspaceTileCanvas.tsx`/`WorktreeCard.tsx`,
consumed via `components/ui/status-dot.tsx`'s and `components/ui/pill.tsx`'s
`color: string` props, and lucide-react icons' native `color` prop) rather
than new global CSS custom properties in `globals.css`. Simpler, no Tailwind
`@theme` plumbing, and these colors are never needed as arbitrary Tailwind
utility classes — every consumer already takes a raw color value.

**Reserved app-wide (unchanged, not reassigned by this design — still CSS
tokens, still consumed via `text-devdeck-*`/`bg-devdeck-*` Tailwind classes
as today):**

| Token | Meaning |
|---|---|
| `devdeck-accent` (teal) | focus / selection / primary action |
| `devdeck-yellow*` | production / pending-change / warning |
| `devdeck-red*` | destructive / error |
| `devdeck-green*` | success |

**New, DB-module-scoped — engine identity** (`DB_ENGINE_COLOR` in
`dbColors.ts`; connection cards' `EngineGlyph`, tree root, tab-strip corner
chip):

| Engine | Constant key | Starting hex |
|---|---|---|
| Postgres | `postgres` | `#5b8def` |
| MySQL / MariaDB | `mysql` | `#e0894a` |
| SQLite | `sqlite` | `#a385e0` |

**New, DB-module-scoped — object-kind identity** (`DB_KIND_COLOR` in
`dbColors.ts`; tree row icons *and* tab icons — same hue in both, so a tab
visually matches its tree row):

| Kind | Constant key | Starting hex | Icon (`lucide-react`) |
|---|---|---|---|
| Table | `table` | `#5aa9e6` | `Table2` |
| View | `view` | `#b28ce0` | `Eye` |
| Materialized view | `matview` | `#e07fb0` | `Layers` |
| Function | `function` | `#1f9d6b` | `Sigma` |
| Schema / Database (folder) | `folder` | `#c9a06a` | `FolderTree` |
| SQL query tab | *(reuses `devdeck-accent` CSS token)* | — | `Terminal` |
| DDL / Designer tab | *(reuses `devdeck-dim`/`devdeck-muted` CSS tokens)* | — | `Code2` / `Wrench` |

Query and DDL/Designer tabs deliberately reuse existing neutral/accent CSS
tokens (via Tailwind classes, unchanged) rather than getting a `dbColors.ts`
entry — they're actions/utilities, not object kinds, so giving them a "kind
color" would blur the system's meaning.

`function`'s `#1f9d6b` is a deliberately darker, more saturated emerald than
`devdeck-green` (`#56d58a`, a light mint) — separated by lightness/saturation
rather than hue alone, so it reads as distinct even placed next to a
success-state green, rather than as a near-duplicate.

**New, DB-module-scoped — data-type badges** (`DB_TYPE_BADGE` in
`dbColors.ts`; tiny colored abbreviation next to each column name in the grid
header; a separate visual context from the tree/tabs, so reusing some hues
here is fine):

| Data type | Constant key | Color | Badge text |
|---|---|---|---|
| uuid | `uuid` | cyan `#4fb8c9` | `uuid` |
| integer / numeric | `number` | orange-red `#e0713f` | `#` |
| varchar / text | `text` | violet `#b28ce0` | `abc` |
| boolean | `boolean` | pink `#e07fb0` | `bool` |
| date / time / timestamp | `datetime` | blue `#5b8def` | `date` |
| json / jsonb | `json` | green `#56d58a` (reuses `devdeck-green`'s hex) | `{}` |
| bytea / blob / binary | `binary` | gray `#6b7280` (reuses `devdeck-gray`'s hex) | `hex` |

`json`/`binary` intentionally reuse the existing `devdeck-green`/`devdeck-gray`
hex values rather than inventing new ones — grid-header badges are a distinct
visual context from where those tokens carry success/neutral meaning, so no
role collision, and it keeps the total palette smaller.

**Accessibility guardrail**: color is never the *only* signal. Kind icons
differ in shape as well as hue (a colorblind operator distinguishes table vs.
view by icon, not color alone); the connection-status dot is paired with a
tooltip stating what it means and when it was last checked.

## PRODUCT.md amendment

Add one new subsection (exact text, applied in the implementation's first
build step):

> ## Module Exceptions
>
> The Database module (`features/database/`) is a deliberate, scoped
> exception to "accent color as state, not decoration." Dense per-kind object
> identification (table vs. view vs. function, engine identity, data type) is
> the primary usability need there, mirroring established database-client
> conventions (Navicat, DataGrip). Color there is role-based, not decorative —
> see `docs/superpowers/specs/2026-07-23-database-ui-redesign-design.md`. No
> other module gains new accent colors under this exception.

## Layout & Tab Strip

Three-pane workspace shell, replacing today's two-pane tree+tabs layout in
`DatabaseModule.tsx`:

```
┌─ ← Connections   [+Table] [+Query]        ─┐
│ Tree (264px) │  Tab strip                  │ Inspector (280px,
│  · colorful  │  ──────────────────────     │  collapsible)
│    kind      │  [content: grid / SQL       │  · metadata for the
│    icons     │   editor / DDL / designer]  │    ACTIVE TAB's object
│  · status    │                             │  · extends today's
│    dot       │                             │    DBTableInfo stats
└──────────────┴─────────────────────────────┴──────────────────┘
```

- **Inspector content by active-tab kind**: table/view/matview → estimated
  rows, total/index bytes, PK, column count (today's `DBTableInfo.tsx`,
  relocated into the inspector); query → connection/database/schema context,
  last-run duration + row count; ddl/designer → object identity + "copy DDL" /
  "open table" quick actions.
- Collapse toggle lives in the tab strip's trailing chrome; collapsed state
  persisted in the store (`dbInspectorCollapsed: boolean`).

**Tab strip** (`DBTabStrip`, self-contained with its own `@dnd-kit/sortable`
reorder, sharing only the `TabStripPopoverMenu` shell with `PanelHeader` —
see "Approaches considered"):

- Each tab renders its kind-colored icon (Section "Color & Icon System")
  instead of today's uniform `Table2` for every tab kind.
- Active-tab indicator: production connections keep the existing amber border
  (the one place "accent as alarm" is already sanctioned by the original
  spec); non-production active tabs get a bottom border in the **tab's kind
  color** instead of a generic accent line.
- Dirty indicator (`PanelHeaderTab.dirty`, already exists as a prop) wires to
  real state: SQL editor tabs with unsaved query text, table tabs with
  pending inserts/edits/deletes.
- The "+" popover (already a `TabStrip` capability via `newTabActions`)
  replaces today's two separate header buttons ("New table" / "New SQL
  query") with a single "+" offering both.
- Middle-click-to-close and keyboard nav come for free from the shared
  primitive — no re-implementation.

**Connection gallery** (unopened state) — structure unchanged (search,
group-pill filter, card grid). `EngineGlyph` gets the per-engine identity
color as background/border instead of the current uniform accent tint, so
Postgres/MySQL/SQLite connections are visually distinguishable in the grid.

## Tree, Grid, Dialogs

**`DBObjectTree.tsx`** — `nodeIcon(kind)` returns the kind-colored icon
instead of one dim-gray icon for every kind. A connection-status dot sits
next to the "← Connections" back button, reflecting the last `Test`
connection result (see Decision 7) — not a live health check.

**`DBTableGrid.tsx`** — column headers gain the tiny data-type badge next to
each column name. Row-action buttons (insert/delete/commit) keep their
*existing* green/red/teal tokens — those roles already exist app-wide, no new
tokens needed there.

**`DBConnectionDialog.tsx`** — the drawer header gains the colored
`EngineGlyph`, matching the gallery card, so identity is visible while
editing. Form fields stay plain — no icon-per-input decoration, which is the
"SaaS gloss" `PRODUCT.md` already warns against.

**`DBCommitDialog.tsx`** — insert rows get the green-soft treatment,
symmetric with the existing delete-row red-soft treatment.

## Store changes

`useDevDeckStore.ts` (convergence file — single-agent step, see
`ORCHESTRATION.md`):

- `dbActiveConnectionId: string | null` + `setDBActiveConnectionId` — replaces
  `DatabaseModule`'s local `useState`, so the open connection (and, via the
  existing per-connection `dbTabs`, its open tabs) survives navigation away
  and page reload.
- `dbInspectorCollapsed: boolean` + `setDBInspectorCollapsed` — inspector
  pane collapse state.

No changes to `store/types.ts` or `backend/internal/domain/models.go` — both
additions are pure UI state, not domain data.

## Accessibility

Target WCAG AA text contrast for every new `dbColors.ts` value against
`devdeck-bg`/`devdeck-terminal`/`devdeck-card`, verified during
implementation. Color is never the sole signal (see guardrail above).
Keyboard access, visible focus states, and reduced-motion-safe transitions
are inherited from `TabStripPopoverMenu` and existing `Button`/form
components; `DBTabStrip`'s own reorder logic gets its own keyboard-nav
verification since it isn't inherited from `PanelHeader`.

## Testing

- **`DBTabStrip`** — unit tests for reorder (via `@dnd-kit/sortable`),
  overflow-popover threshold, close, dirty-dot rendering.
- **`TabStripPopoverMenu`** — unit test confirming it renders identically
  whether invoked from `PanelHeader` or `DBTabStrip` (same shared component,
  two call sites).
- **No `PanelHeader` regression test needed** — this design does not modify
  `PanelHeader.tsx`'s drag/overflow/close logic, only extracts its popover
  JSX into the shared component `PanelHeader` then calls instead of
  inlining.
- **Store tests**: `dbActiveConnectionId` and `dbInspectorCollapsed`
  persistence/resume behavior.
- **`npm run typecheck`** — required before commit per `.claude/rules/frontend.md`.
- No backend tests — this design makes no backend changes.

## Build order (for the implementation plan)

1. New `dbColors.ts` constants module + the `PRODUCT.md` amendment (verbatim
   text above) — foundation everything else reads from.
2. Extract `TabStripPopoverMenu` (the overflow/new-tab popover shell) out of
   `PanelHeader.tsx` into a shared component; update `PanelHeader` to call it
   in place of its two inlined copies.
3. `dbActiveConnectionId` + `dbInspectorCollapsed` in the store (convergence
   file — serialize this step).
4. New `DBTabStrip` component: kind-colored icons, own `@dnd-kit/sortable`
   reorder, dirty-dot wiring, `TabStripPopoverMenu`-based "+" popover.
5. Three-pane shell in `DatabaseModule.tsx`: inspector pane + collapse
   toggle, wired to the active tab's object.
6. `DBObjectTree` kind-colored icons + connection-status dot.
7. Grid column type-badges; `DBCommitDialog` insert-row coloring.
8. Connection gallery / `DBConnectionDialog` engine-glyph coloring.

Steps 1 and 3 touch convergence-adjacent files and must not be edited by
parallel agents — serialize them or fold into a single integration step.

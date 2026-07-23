# Database Management UI/UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Database module's UI/UX toward a Navicat-class, colorful-but-systematic look: a new self-contained tab strip, a persistent right-side inspector pane, and a role-based color/icon system for engines, object kinds, and data types — all scoped to `features/database/`, leaving the rest of DevDeck's restrained visual language untouched.

**Architecture:** A new plain-constants module (`dbColors.ts`) is the single source of truth for every new color/icon role. A new `DBTabStrip` component (self-contained `@dnd-kit/sortable` reorder, sharing only a newly-extracted `TabStripPopoverMenu` shell with the terminal's `PanelHeader`) replaces `DBTabBar`. `DatabaseModule.tsx` grows a third pane (`DBInspectorPanel`, new) and switches from rendering only the active tab's content to rendering all open tabs and hiding inactive ones (matching the terminal's `PaneCanvas` pattern), which is what makes per-tab dirty-dots and pending-edit persistence across tab switches actually work.

**Tech Stack:** React 19, TypeScript (`verbatimModuleSyntax`), Tailwind v4, zustand (immer-style mutable `set`), `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities` (already dependencies), `@base-ui/react` Popover, `lucide-react` icons, `@tanstack/react-query`.

## Global Constraints

- Frontend imports use the `@/*` alias; never relative paths into `src/`. (`.claude/rules/frontend.md`)
- `verbatimModuleSyntax` is on — use `import type` for all type-only imports. (`.claude/rules/frontend.md`)
- Design is dark-only; use the `devdeck-*` CSS custom properties in `globals.css` for anything that needs a Tailwind utility class. New per-entity colors introduced by this plan are plain hex strings (not new CSS tokens) consumed via `StatusDot`/`Pill`'s `color` prop and lucide icons' native `color` prop — matching this codebase's existing convention for per-entity colors (see `WorkspaceTileCanvas.tsx`/`WorktreeCard.tsx`).
- Icons: `lucide-react` only.
- Components live in `src/features/<name>/` — one component per file.
- Run `npm run typecheck` before every commit.
- `frontend/src/store/useDevDeckStore.ts` is a convergence file (`CLAUDE.md`) — do not edit it from a parallel/background agent; this plan touches it in exactly one task (Task 4).
- No backend, driver, or API changes anywhere in this plan (per the approved spec's scope) — no Go files are touched, no `port.Store` methods added.
- No changes to `frontend/src/store/types.ts` or `backend/internal/domain/models.go` — every new piece of state is either a pure UI concern (`dbActiveConnectionId`, `dbInspectorCollapsed`, `dbConnectionTestStatus`) or a local component/hex-constant concern, not domain data.
- This repository has no component-testing framework (no Vitest/Jest/RTL) — automated tests are plain assertion scripts (`.test.ts`, run via `npx tsx`) that exist only for pure-logic modules (see `dbTabs.test.ts`, `dbTree.test.ts`). React components are verified via `npm run typecheck` plus a manual dev-server check, matching how `DBTabBar.tsx`/`DBObjectTree.tsx` have no test file today. Do not invent a component-test framework for this plan.

Full design rationale: `docs/superpowers/specs/2026-07-23-database-ui-redesign-design.md`.

---

### Task 1: `dbColors.ts` — color/icon role map + data-type classifier

**Files:**
- Create: `frontend/src/features/database/dbColors.ts`
- Create: `frontend/src/features/database/dbColors.test.ts`
- Modify: `PRODUCT.md`

**Interfaces:**
- Produces: `DB_ENGINE_COLOR: Record<'postgres' | 'mysql' | 'sqlite', string>`, `DB_KIND_COLOR: Record<'table' | 'view' | 'matview' | 'function' | 'folder', string>`, `DB_TYPE_BADGE: Record<'uuid' | 'number' | 'text' | 'boolean' | 'datetime' | 'json' | 'binary', { color: string; label: string }>`, `classifyDataType(dataType: string): keyof typeof DB_TYPE_BADGE | null`. Every later task in this plan imports from this file.

- [ ] **Step 1: Write `dbColors.ts`**

```typescript
export type DBEngineKey = 'postgres' | 'mysql' | 'sqlite'
export type DBKindKey = 'table' | 'view' | 'matview' | 'function' | 'folder'
export type DBTypeBadgeKey = 'uuid' | 'number' | 'text' | 'boolean' | 'datetime' | 'json' | 'binary'

/** Per-engine identity color — connection gallery cards, the connection
 *  dialog header, and the tree root. */
export const DB_ENGINE_COLOR: Record<DBEngineKey, string> = {
  postgres: '#5b8def',
  mysql: '#e0894a',
  sqlite: '#a385e0',
}

/** Per-object-kind identity color — tree row icons and tab icons share this
 *  map, so a tab visually matches its tree row. */
export const DB_KIND_COLOR: Record<DBKindKey, string> = {
  table: '#5aa9e6',
  view: '#b28ce0',
  matview: '#e07fb0',
  // Deliberately darker/more saturated than devdeck-green (#56d58a, a light
  // mint) — separated by lightness/saturation, not hue alone, so it reads as
  // distinct even placed next to a success-state green.
  function: '#1f9d6b',
  folder: '#c9a06a',
}

/** Tiny colored abbreviation shown next to each column name in the grid
 *  header. json/binary intentionally reuse devdeck-green/devdeck-gray's hex
 *  values — a grid header badge is a different visual context from where
 *  those tokens carry success/neutral meaning elsewhere in the app. */
export const DB_TYPE_BADGE: Record<DBTypeBadgeKey, { color: string; label: string }> = {
  uuid: { color: '#4fb8c9', label: 'uuid' },
  number: { color: '#e0713f', label: '#' },
  text: { color: '#b28ce0', label: 'abc' },
  boolean: { color: '#e07fb0', label: 'bool' },
  datetime: { color: '#5b8def', label: 'date' },
  json: { color: '#56d58a', label: '{}' },
  binary: { color: '#6b7280', label: 'hex' },
}

/** Classifies a raw, engine-specific SQL data-type string (postgres's
 *  "character varying", mysql's "varchar", sqlite's declared "INTEGER")
 *  into a grid-header badge category. Case-insensitive substring match,
 *  since the three engines never agree on exact type names. Returns null
 *  for a type that doesn't map to any badge (grid renders no badge). */
export function classifyDataType(dataType: string): DBTypeBadgeKey | null {
  const t = dataType.toLowerCase()
  if (t.includes('uuid')) return 'uuid'
  if (t.includes('bool')) return 'boolean'
  if (t.includes('json')) return 'json'
  if (t.includes('blob') || t.includes('bytea') || t.includes('binary')) return 'binary'
  if (t.includes('date') || t.includes('time')) return 'datetime'
  if (t.includes('char') || t.includes('text') || t.includes('clob')) return 'text'
  if (
    t.includes('int') ||
    t.includes('numeric') ||
    t.includes('decimal') ||
    t.includes('real') ||
    t.includes('double') ||
    t.includes('float') ||
    t.includes('serial')
  ) {
    return 'number'
  }
  return null
}
```

- [ ] **Step 2: Write `dbColors.test.ts`**

```typescript
/**
 * Plain assertion-based tests, matching dbTabs.test.ts's and dbTree.test.ts's
 * convention (no Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/database/dbColors.test.ts
 */

import { classifyDataType } from './dbColors'

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

check('postgres uuid classifies as uuid', () => {
  assertEqual(classifyDataType('uuid'), 'uuid', 'uuid')
})

check('postgres character varying classifies as text', () => {
  assertEqual(classifyDataType('character varying'), 'text', 'character varying')
})

check('postgres integer classifies as number', () => {
  assertEqual(classifyDataType('integer'), 'number', 'integer')
})

check('postgres bigint classifies as number', () => {
  assertEqual(classifyDataType('bigint'), 'number', 'bigint')
})

check('postgres boolean classifies as boolean', () => {
  assertEqual(classifyDataType('boolean'), 'boolean', 'boolean')
})

check('postgres timestamp without time zone classifies as datetime', () => {
  assertEqual(classifyDataType('timestamp without time zone'), 'datetime', 'timestamp without time zone')
})

check('postgres jsonb classifies as json', () => {
  assertEqual(classifyDataType('jsonb'), 'json', 'jsonb')
})

check('postgres bytea classifies as binary', () => {
  assertEqual(classifyDataType('bytea'), 'binary', 'bytea')
})

check('mysql varchar classifies as text', () => {
  assertEqual(classifyDataType('varchar'), 'text', 'varchar')
})

check('mysql tinyint classifies as number', () => {
  assertEqual(classifyDataType('tinyint'), 'number', 'tinyint')
})

check('mysql datetime classifies as datetime', () => {
  assertEqual(classifyDataType('datetime'), 'datetime', 'datetime')
})

check('mysql blob classifies as binary', () => {
  assertEqual(classifyDataType('blob'), 'binary', 'blob')
})

check('sqlite INTEGER (uppercase) classifies as number', () => {
  assertEqual(classifyDataType('INTEGER'), 'number', 'INTEGER')
})

check('sqlite VARCHAR(255) with a length classifies as text', () => {
  assertEqual(classifyDataType('VARCHAR(255)'), 'text', 'VARCHAR(255)')
})

check('an unrecognized type returns null (no badge)', () => {
  assertEqual(classifyDataType('point'), null, 'point')
})

console.log(`\n${passed} tests passed`)
```

- [ ] **Step 3: Run the test**

Run: `cd frontend && npx tsx src/features/database/dbColors.test.ts`
Expected: 15 lines of `ok - ...` followed by `15 tests passed`, no thrown error.

- [ ] **Step 4: Add the `PRODUCT.md` amendment**

Append this new section to the end of `PRODUCT.md` (after the existing "Accessibility & Inclusion" section):

```markdown

## Module Exceptions

The Database module (`features/database/`) is a deliberate, scoped
exception to "accent color as state, not decoration." Dense per-kind object
identification (table vs. view vs. function, engine identity, data type) is
the primary usability need there, mirroring established database-client
conventions (Navicat, DataGrip). Color there is role-based, not decorative —
see `docs/superpowers/specs/2026-07-23-database-ui-redesign-design.md`. No
other module gains new accent colors under this exception.
```

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/database/dbColors.ts frontend/src/features/database/dbColors.test.ts PRODUCT.md
git commit -m "feat(db): add dbColors role-based color/icon map and PRODUCT.md exception"
```

---

### Task 2: Extract `TabStripPopoverMenu` shared popover shell

**Files:**
- Create: `frontend/src/components/ui/tab-strip-popover-menu.tsx`
- Modify: `frontend/src/features/terminal/PanelHeader.tsx:1-5` (imports), `:86-110` (new-tab popover), `:135-159` (overflow popover)

**Interfaces:**
- Produces: `TabStripPopoverMenu({ trigger, triggerClassName, triggerTitle, triggerAriaLabel, align, children }): JSX.Element` — a purely presentational `@base-ui/react` Popover shell. Consumed by `PanelHeader` (this task) and `DBTabStrip` (Task 5).

- [ ] **Step 1: Write `tab-strip-popover-menu.tsx`**

```tsx
import type { ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { cn } from '@/lib/utils'

export interface TabStripPopoverMenuProps {
  trigger: ReactNode
  triggerClassName?: string
  triggerTitle: string
  triggerAriaLabel: string
  align?: 'start' | 'end'
  children: ReactNode
}

/** Shared popover shell for a tab strip's "..." overflow menu and "+"
 *  new-tab menu — used by both the terminal's PanelHeader and the database
 *  module's DBTabStrip. Purely presentational: the caller owns the trigger
 *  icon and the menu content, this component only owns positioning/styling. */
export function TabStripPopoverMenu({
  trigger,
  triggerClassName,
  triggerTitle,
  triggerAriaLabel,
  align = 'start',
  children,
}: TabStripPopoverMenuProps) {
  return (
    <Popover.Root>
      <Popover.Trigger className={triggerClassName} title={triggerTitle} aria-label={triggerAriaLabel}>
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align={align} sideOffset={6} style={{ zIndex: 60 }} className="outline-none">
          <Popover.Popup
            className={cn(
              'min-w-[150px] origin-[var(--transform-origin)] rounded-[11px] border border-devdeck-border-menu bg-devdeck-popover p-1.5',
              'shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none transition-all duration-150',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            )}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
```

- [ ] **Step 2: Update `PanelHeader.tsx`'s imports**

Modify `frontend/src/features/terminal/PanelHeader.tsx:1-5`, replace:

```typescript
import type { ReactNode } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { Popover } from '@base-ui/react/popover'
import { MoreHorizontal, PanelBottom, PanelRight, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
```

with:

```typescript
import type { ReactNode } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { MoreHorizontal, PanelBottom, PanelRight, Plus, X } from 'lucide-react'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { cn } from '@/lib/utils'
```

- [ ] **Step 3: Replace the new-tab popover block**

Modify `frontend/src/features/terminal/PanelHeader.tsx`, replace:

```tsx
        {newTabActions ? (
          <Popover.Root>
            <Popover.Trigger
              className={cn(iconButtonClass, 'my-1 ml-1 flex-none self-center')}
              title="New tab (Ctrl+T)"
              aria-label="New tab"
            >
              <Plus size={13} />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner side="bottom" align="start" sideOffset={6} style={{ zIndex: 60 }} className="outline-none">
                <Popover.Popup
                  className={cn(
                    'min-w-[150px] origin-[var(--transform-origin)] rounded-[11px] border border-devdeck-border-menu bg-devdeck-popover p-1.5',
                    'shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none transition-all duration-150',
                    'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
                    'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
                  )}
                >
                  {newTabActions}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        ) : null}
```

with:

```tsx
        {newTabActions ? (
          <TabStripPopoverMenu
            trigger={<Plus size={13} />}
            triggerClassName={cn(iconButtonClass, 'my-1 ml-1 flex-none self-center')}
            triggerTitle="New tab (Ctrl+T)"
            triggerAriaLabel="New tab"
          >
            {newTabActions}
          </TabStripPopoverMenu>
        ) : null}
```

- [ ] **Step 4: Replace the overflow popover block**

Modify `frontend/src/features/terminal/PanelHeader.tsx`, replace:

```tsx
        {isFocused && overflowActions ? (
          <Popover.Root>
            <Popover.Trigger
              className={iconButtonClass}
              title="More actions"
              aria-label="More actions"
            >
              <MoreHorizontal size={13} />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner side="bottom" align="end" sideOffset={6} style={{ zIndex: 60 }} className="outline-none">
                <Popover.Popup
                  className={cn(
                    'min-w-[150px] origin-[var(--transform-origin)] rounded-[11px] border border-devdeck-border-menu bg-devdeck-popover p-1.5',
                    'shadow-[0_18px_44px_rgba(0,0,0,0.55)] outline-none transition-all duration-150',
                    'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
                    'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
                  )}
                >
                  {overflowActions}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        ) : null}
```

with:

```tsx
        {isFocused && overflowActions ? (
          <TabStripPopoverMenu
            trigger={<MoreHorizontal size={13} />}
            triggerClassName={iconButtonClass}
            triggerTitle="More actions"
            triggerAriaLabel="More actions"
            align="end"
          >
            {overflowActions}
          </TabStripPopoverMenu>
        ) : null}
```

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: exits 0, no errors (in particular, no "unused import `Popover`" or `cn` — `cn` is still used elsewhere in the file for `iconButtonClass`/tab button classes).

- [ ] **Step 6: Manual verification**

Run: `npm run dev` from the repo root (or `cd frontend && npm run dev:web` alongside the existing API), open a workspace with a terminal pane, and confirm: the "+" new-tab button still opens its menu, the "..." overflow button (visible when the pane is focused) still opens its menu, both close on outside click, and split-right/split-down/close-pane buttons are unaffected (they were never touched). This is a pure refactor — behavior must be pixel-identical to before.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ui/tab-strip-popover-menu.tsx frontend/src/features/terminal/PanelHeader.tsx
git commit -m "refactor(ui): extract TabStripPopoverMenu shell out of PanelHeader"
```

---

### Task 3: `reorderTab` pure function in `dbTabs.ts`

**Files:**
- Modify: `frontend/src/features/database/dbTabs.ts` (add function)
- Modify: `frontend/src/features/database/dbTabs.test.ts` (add tests)

**Interfaces:**
- Consumes: `DBTabState` (existing, from `dbTabs.ts`).
- Produces: `reorderTab(state: DBTabState, fromId: string, toId: string): DBTabState`. Consumed by the store's `reorderDBTab` action (Task 4) and, transitively, `DBTabStrip` (Task 5).

- [ ] **Step 1: Write the failing tests**

Modify `frontend/src/features/database/dbTabs.test.ts`, change the import line from:

```typescript
import { closeTab, emptyDBTabState, openTab, setActiveTab, tabId } from './dbTabs'
```

to:

```typescript
import { closeTab, emptyDBTabState, openTab, reorderTab, setActiveTab, tabId } from './dbTabs'
```

Then insert these three `check(...)` blocks immediately before the final `console.log(`\n${passed} tests passed`)` line:

```typescript
check('reorderTab moves a tab before another', () => {
  const objB = { ...OBJ, name: 'u' }
  const objC = { ...OBJ, name: 'v' }
  let s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  s = openTab(s, { kind: 'table', object: objB })
  s = openTab(s, { kind: 'table', object: objC })
  const idA = tabId({ kind: 'table', object: OBJ })
  const idB = tabId({ kind: 'table', object: objB })
  const idC = tabId({ kind: 'table', object: objC })
  s = reorderTab(s, idC, idA)
  assertEqual(s.tabs.map((t) => t.id), [idC, idA, idB], 'C moved before A')
})

check('reorderTab moves to the end when the target id is not found', () => {
  let s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  const objB = { ...OBJ, name: 'u' }
  s = openTab(s, { kind: 'table', object: objB })
  const idA = tabId({ kind: 'table', object: OBJ })
  s = reorderTab(s, idA, 'not-a-real-id')
  assertEqual(s.tabs.map((t) => t.id), [tabId({ kind: 'table', object: objB }), idA], 'A moved to end')
})

check('reorderTab is a no-op when fromId equals toId', () => {
  const s = openTab(emptyDBTabState(), { kind: 'table', object: OBJ })
  const idA = tabId({ kind: 'table', object: OBJ })
  const s2 = reorderTab(s, idA, idA)
  assertEqual(s2, s, 'state unchanged')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx tsx src/features/database/dbTabs.test.ts`
Expected: fails with a TypeScript/module error — `reorderTab` is not exported from `./dbTabs` yet.

- [ ] **Step 3: Implement `reorderTab`**

Modify `frontend/src/features/database/dbTabs.ts`, add this function after `closeTab` (before `setActiveTab`):

```typescript
/** Moves the tab with id `fromId` to sit immediately before the tab with id
 *  `toId` (or to the end, if `toId` is not found). Used by DBTabStrip's
 *  drag-to-reorder. A no-op (returns the same state) if `fromId` is missing
 *  or the two ids are equal. */
export function reorderTab(state: DBTabState, fromId: string, toId: string): DBTabState {
  if (fromId === toId) return state
  const fromIndex = state.tabs.findIndex((t) => t.id === fromId)
  if (fromIndex === -1) return state
  const tabs = [...state.tabs]
  const [moved] = tabs.splice(fromIndex, 1)
  const toIndex = tabs.findIndex((t) => t.id === toId)
  if (toIndex === -1) tabs.push(moved)
  else tabs.splice(toIndex, 0, moved)
  return { ...state, tabs }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx tsx src/features/database/dbTabs.test.ts`
Expected: 11 lines of `ok - ...` followed by `11 tests passed`.

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/database/dbTabs.ts frontend/src/features/database/dbTabs.test.ts
git commit -m "feat(db): add reorderTab pure function for tab drag-reorder"
```

---

### Task 4: Store additions — active connection, inspector collapse, connection test status, tab reorder action

**Files:**
- Modify: `frontend/src/store/useDevDeckStore.ts:6` (import), `:352-365` (interface), `:470-473` (defaults), `:791-799` (actions)
- Modify: `frontend/src/features/database/DBConnectionDialog.tsx` (wire `runTest` to record status)

**Interfaces:**
- Consumes: `reorderTab` from `./dbTabs` (Task 3).
- Produces on the store: `dbActiveConnectionId: string | null`, `setDBActiveConnectionId(id: string | null): void`, `dbInspectorCollapsed: boolean`, `setDBInspectorCollapsed(collapsed: boolean): void`, `dbConnectionTestStatus: Record<string, { ok: boolean; testedAt: string }>`, `setDBConnectionTestStatus(connectionId: string, ok: boolean): void`, `reorderDBTab(connectionId: string, fromId: string, toId: string): void`. Consumed by `DatabaseModule.tsx` (Task 8) and `DBTabStrip.tsx` (Task 5).

- [ ] **Step 1: Update the `dbTabs` import**

Modify `frontend/src/store/useDevDeckStore.ts:6`, replace:

```typescript
import { closeTab, emptyDBTabState, openTab, setActiveTab, type DBTabDraft, type DBTabState } from '@/features/database/dbTabs'
```

with:

```typescript
import { closeTab, emptyDBTabState, openTab, reorderTab, setActiveTab, type DBTabDraft, type DBTabState } from '@/features/database/dbTabs'
```

- [ ] **Step 2: Add the new interface fields**

Modify `frontend/src/store/useDevDeckStore.ts:361-365`, replace:

```typescript
  // db tabs (per-connection open-object tabs)
  dbTabs: Record<string, DBTabState>
  openDBTab: (connectionId: string, content: DBTabDraft) => void
  closeDBTab: (connectionId: string, tabId: string) => void
  setDBActiveTab: (connectionId: string, tabId: string) => void
```

with:

```typescript
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
```

- [ ] **Step 3: Add the default state**

Modify `frontend/src/store/useDevDeckStore.ts:471-472`, replace:

```typescript
      dbActiveGroup: ALL_SSH_GROUPS, // reuse the existing "all groups" sentinel; see SSHConnectionsModule's identical usage
      dbTabs: {},
```

with:

```typescript
      dbActiveGroup: ALL_SSH_GROUPS, // reuse the existing "all groups" sentinel; see SSHConnectionsModule's identical usage
      dbTabs: {},
      dbActiveConnectionId: null,
      dbInspectorCollapsed: false,
      dbConnectionTestStatus: {},
```

- [ ] **Step 4: Add the new actions**

Modify `frontend/src/store/useDevDeckStore.ts:798-799`, replace:

```typescript
      setDBActiveTab: (connectionId, id) =>
        set((s) => void (s.dbTabs[connectionId] = setActiveTab(s.dbTabs[connectionId] ?? emptyDBTabState(), id))),
```

with:

```typescript
      setDBActiveTab: (connectionId, id) =>
        set((s) => void (s.dbTabs[connectionId] = setActiveTab(s.dbTabs[connectionId] ?? emptyDBTabState(), id))),
      reorderDBTab: (connectionId, fromId, toId) =>
        set((s) => void (s.dbTabs[connectionId] = reorderTab(s.dbTabs[connectionId] ?? emptyDBTabState(), fromId, toId))),

      setDBActiveConnectionId: (id) => set((s) => void (s.dbActiveConnectionId = id)),
      setDBInspectorCollapsed: (collapsed) => set((s) => void (s.dbInspectorCollapsed = collapsed)),
      setDBConnectionTestStatus: (connectionId, ok) =>
        set((s) => void (s.dbConnectionTestStatus[connectionId] = { ok, testedAt: new Date().toISOString() })),
```

- [ ] **Step 5: Wire `DBConnectionDialog`'s test action to record status**

Modify `frontend/src/features/database/DBConnectionDialog.tsx:61`, replace:

```typescript
  const showToast = useDevDeckStore((s) => s.showToast)
```

with:

```typescript
  const showToast = useDevDeckStore((s) => s.showToast)
  const setConnectionTestStatus = useDevDeckStore((s) => s.setDBConnectionTestStatus)
```

Then modify `frontend/src/features/database/DBConnectionDialog.tsx:107-115`, replace:

```typescript
  async function runTest() {
    if (!dialog.editingId) {
      showToast('Save the connection once before testing it')
      return
    }
    setTestResult(null)
    const result = await testConnection.mutateAsync(dialog.editingId)
    setTestResult(result)
  }
```

with:

```typescript
  async function runTest() {
    if (!dialog.editingId) {
      showToast('Save the connection once before testing it')
      return
    }
    setTestResult(null)
    const result = await testConnection.mutateAsync(dialog.editingId)
    setTestResult(result)
    setConnectionTestStatus(dialog.editingId, result.ok)
  }
```

- [ ] **Step 6: Add `dbActiveConnectionId` and `dbTabs` to the persisted-state allowlist**

The store's `persist()` middleware only writes an explicit allowlist to `localStorage` (`partialize`, around line 815) — today it does **not** include `dbTabs` or `dbActiveGroup`, so none of the DB module's tab/connection-selection state currently survives a page reload. For "resume where you left off" (Decision 6 in the spec) to actually work across a full reload — not just in-session navigation, which Zustand already handles for free — both new fields must be added here.

Modify `frontend/src/store/useDevDeckStore.ts` (the `partialize` function, around line 815), replace:

```typescript
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        worktreeLayouts: s.worktreeLayouts,
        sshTileLayouts: s.sshTileLayouts,
        railExpanded: s.railExpanded,
        workspaceTileLayouts: s.workspaceTileLayouts,
      }),
```

with:

```typescript
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        worktreeLayouts: s.worktreeLayouts,
        sshTileLayouts: s.sshTileLayouts,
        railExpanded: s.railExpanded,
        workspaceTileLayouts: s.workspaceTileLayouts,
        dbActiveConnectionId: s.dbActiveConnectionId,
        dbTabs: s.dbTabs,
      }),
```

No `version` bump or `migrate` change is needed — this only *adds* keys to the persisted shape (unlike the existing `openTabs` → `workspaceTileLayouts` rename the `migrate` comment describes); an old `localStorage` blob without these keys simply falls back to the store's initial-state defaults (`null` and `{}` respectively) on rehydration.

- [ ] **Step 7: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: exits 0.

- [ ] **Step 8: Manual verification**

Run the dev server, open a database connection's edit dialog, click "Test connection", and confirm the existing inline "Connected"/error text still appears exactly as before (this step only adds a side-effect write to the store; it does not change `DBConnectionDialog`'s own rendering — the status dot consuming `dbConnectionTestStatus` isn't wired into any UI until Task 8). Separately, open the browser devtools Application/Storage panel, confirm a `devdeck-ui-v2` `localStorage` entry exists, and confirm its JSON now includes `dbActiveConnectionId` and `dbTabs` keys (both `null`/`{}` until Task 8 starts writing to them).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/store/useDevDeckStore.ts frontend/src/features/database/DBConnectionDialog.tsx
git commit -m "feat(db): add store state for active connection, inspector collapse, test status, tab reorder"
```

---

### Task 5: `DBTabStrip` component

**Files:**
- Create: `frontend/src/features/database/DBTabStrip.tsx`

**Interfaces:**
- Consumes: `DB_KIND_COLOR` (Task 1), `TabStripPopoverMenu` (Task 2), `reorderDBTab`/`setDBActiveTab`/`closeDBTab`/`dbTabs` (Task 4), `DBTabContent`/`emptyDBTabState` (existing `dbTabs.ts`).
- Produces: `DBTabStrip(props: DBTabStripProps): JSX.Element | null` where `DBTabStripProps = { connectionId: string; isProduction: boolean; dirtyTabIds: ReadonlySet<string>; onNewTable: () => void; onNewQuery: () => void; inspectorCollapsed: boolean; onToggleInspector: () => void }`. Consumed by `DatabaseModule.tsx` (Task 8), replacing `DBTabBar`.

- [ ] **Step 1: Write `DBTabStrip.tsx`**

```tsx
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Code2, Eye, Layers, PanelRight, Plus, Sigma, Table2, Terminal, Wrench, X } from 'lucide-react'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { cn } from '@/lib/utils'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { DB_KIND_COLOR } from './dbColors'
import { emptyDBTabState, type DBTabContent } from './dbTabs'

export interface DBTabStripProps {
  connectionId: string
  isProduction: boolean
  dirtyTabIds: ReadonlySet<string>
  onNewTable: () => void
  onNewQuery: () => void
  inspectorCollapsed: boolean
  onToggleInspector: () => void
}

const iconButtonClass =
  'flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg'

/** The active-tab accent color: the tab content's object-kind color for
 *  "table" tabs (which cover table/view/matview/function data views — the
 *  DBTabContent kind is always literally "table", the actual object kind
 *  lives on tab.object.kind), or a neutral accent for query/ddl/designer
 *  tabs, which are actions/utilities rather than object kinds. */
function dbTabAccentColor(tab: DBTabContent): string {
  if (tab.kind !== 'table') return 'var(--devdeck-accent)'
  if (tab.object.kind === 'view') return DB_KIND_COLOR.view
  if (tab.object.kind === 'matview') return DB_KIND_COLOR.matview
  if (tab.object.kind === 'function') return DB_KIND_COLOR.function
  return DB_KIND_COLOR.table
}

function tabIcon(tab: DBTabContent) {
  if (tab.kind === 'query') return <Terminal size={11} className="text-devdeck-accent-soft" />
  if (tab.kind === 'ddl') return <Code2 size={11} className="text-devdeck-dim" />
  if (tab.kind === 'designer') return <Wrench size={11} className="text-devdeck-dim" />
  const color = dbTabAccentColor(tab)
  if (tab.object.kind === 'view') return <Eye size={11} color={color} />
  if (tab.object.kind === 'matview') return <Layers size={11} color={color} />
  if (tab.object.kind === 'function') return <Sigma size={11} color={color} />
  return <Table2 size={11} color={color} />
}

function tabLabel(tab: DBTabContent) {
  if (tab.kind === 'query') return tab.label
  if (tab.kind === 'ddl') return `${tab.object.name} · DDL`
  if (tab.kind === 'designer') return tab.object ? `${tab.object.name} · Alter` : 'New table'
  return tab.object.name
}

export function DBTabStrip({
  connectionId,
  isProduction,
  dirtyTabIds,
  onNewTable,
  onNewQuery,
  inspectorCollapsed,
  onToggleInspector,
}: DBTabStripProps) {
  const state = useDevDeckStore((s) => s.dbTabs[connectionId]) ?? emptyDBTabState()
  const setActive = useDevDeckStore((s) => s.setDBActiveTab)
  const close = useDevDeckStore((s) => s.closeDBTab)
  const reorder = useDevDeckStore((s) => s.reorderDBTab)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    reorder(connectionId, String(active.id), String(over.id))
  }

  if (state.tabs.length === 0) return null

  return (
    <div className="flex flex-none items-stretch border-b border-devdeck-border-menu bg-devdeck-surface-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={state.tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          <div className="flex flex-1 items-stretch overflow-x-auto px-2">
            {state.tabs.map((tab) => (
              <DBTabStripTab
                key={tab.id}
                tab={tab}
                active={tab.id === state.activeTabId}
                isProduction={isProduction}
                dirty={dirtyTabIds.has(tab.id)}
                onSelect={() => setActive(connectionId, tab.id)}
                onClose={() => close(connectionId, tab.id)}
              />
            ))}
            <TabStripPopoverMenu
              trigger={<Plus size={13} />}
              triggerClassName={cn(iconButtonClass, 'my-1.5 ml-1 flex-none self-center')}
              triggerTitle="New tab"
              triggerAriaLabel="New tab"
            >
              <button
                type="button"
                onClick={onNewTable}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11.5px] text-devdeck-fg-2 hover:bg-devdeck-hover-wash-menu"
              >
                <Table2 size={12} color={DB_KIND_COLOR.table} />
                New table
              </button>
              <button
                type="button"
                onClick={onNewQuery}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11.5px] text-devdeck-fg-2 hover:bg-devdeck-hover-wash-menu"
              >
                <Terminal size={12} className="text-devdeck-accent-soft" />
                New SQL query
              </button>
            </TabStripPopoverMenu>
          </div>
        </SortableContext>
      </DndContext>
      <button
        type="button"
        onClick={onToggleInspector}
        title={inspectorCollapsed ? 'Show inspector' : 'Hide inspector'}
        aria-label={inspectorCollapsed ? 'Show inspector' : 'Hide inspector'}
        className={cn(iconButtonClass, 'my-1.5 mr-1.5 flex-none self-center')}
      >
        <PanelRight size={13} />
      </button>
    </div>
  )
}

function DBTabStripTab({
  tab,
  active,
  isProduction,
  dirty,
  onSelect,
  onClose,
}: {
  tab: DBTabContent
  active: boolean
  isProduction: boolean
  dirty: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id })
  const label = tabLabel(tab)
  const accentColor = isProduction ? 'var(--devdeck-yellow-tint-text)' : dbTabAccentColor(tab)

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        borderBottomColor: active ? accentColor : 'transparent',
        opacity: isDragging ? 0.4 : 1,
      }}
      onMouseDown={(e) => {
        // Middle-click closes the tab, matching the terminal's PanelHeader
        // convention — a much bigger target than the small "x".
        if (e.button === 1) {
          e.preventDefault()
          onClose()
        }
      }}
      onClick={onSelect}
      className={cn(
        'group flex h-9 flex-none touch-none cursor-grab items-center gap-1.5 border-b-2 px-2.5 font-mono text-[11.5px] transition-colors active:cursor-grabbing',
        active
          ? isProduction
            ? 'bg-devdeck-yellow-tint text-devdeck-yellow-tint-text'
            : 'text-devdeck-fg'
          : 'text-devdeck-dim hover:text-devdeck-fg-2',
      )}
    >
      {tabIcon(tab)}
      <span className="max-w-[140px] truncate">{label}</span>
      {dirty ? <span className="text-devdeck-yellow">•</span> : null}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="opacity-0 hover:text-devdeck-red-soft group-hover:opacity-100"
        aria-label={`Close ${label}`}
      >
        <X size={11} />
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: exits 0. (`DBTabStrip` is not imported anywhere yet, so this only validates the file compiles in isolation — it will be wired into `DatabaseModule.tsx` in Task 8.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/database/DBTabStrip.tsx
git commit -m "feat(db): add DBTabStrip with kind-colored icons and sortable drag-reorder"
```

---

### Task 6: Dirty-tracking wiring in `DBTableGrid` and `DBSqlEditor`

**Files:**
- Modify: `frontend/src/features/database/DBTableGrid.tsx:1,24,126-133` (add `onDirtyChange` prop + effect)
- Modify: `frontend/src/features/database/DBSqlEditor.tsx:1,17,25-27,37-49,63,91` (add `onDirtyChange` prop, baseline tracking)

**Interfaces:**
- Produces: `DBTableGrid` gains an optional prop `onDirtyChange?: (dirty: boolean) => void`; `DBSqlEditor` gains an optional prop `onDirtyChange?: (dirty: boolean) => void`. Both consumed by `DatabaseModule.tsx` (Task 8) to populate its `dirtyTabIds` set, which `DBTabStrip` (Task 5) renders as the dirty-dot.

- [ ] **Step 1: `DBTableGrid` — add the prop and effect**

Modify `frontend/src/features/database/DBTableGrid.tsx:24`, replace:

```typescript
export function DBTableGrid({ connectionId, object }: { connectionId: string; object: DBObjectRef }) {
```

with:

```typescript
export function DBTableGrid({
  connectionId,
  object,
  onDirtyChange,
}: {
  connectionId: string
  object: DBObjectRef
  onDirtyChange?: (dirty: boolean) => void
}) {
```

Modify `frontend/src/features/database/DBTableGrid.tsx:126-132` (the `pendingCount` computation), replace:

```typescript
  const updatedRowCount = new Set(
    Array.from(pendingEdits.keys())
      .map((k) => Number(k.split(':')[0]))
      .filter((rowIndex) => !pendingDeletes.has(rowIndex)),
  ).size
  const filledInsertCount = pendingInserts.filter((r) => Object.keys(r.values).length > 0).length
  const pendingCount = updatedRowCount + pendingDeletes.size + filledInsertCount
```

with:

```typescript
  const updatedRowCount = new Set(
    Array.from(pendingEdits.keys())
      .map((k) => Number(k.split(':')[0]))
      .filter((rowIndex) => !pendingDeletes.has(rowIndex)),
  ).size
  const filledInsertCount = pendingInserts.filter((r) => Object.keys(r.values).length > 0).length
  const pendingCount = updatedRowCount + pendingDeletes.size + filledInsertCount

  useEffect(() => {
    onDirtyChange?.(pendingCount > 0)
  }, [pendingCount, onDirtyChange])
```

`useEffect` is already imported at `frontend/src/features/database/DBTableGrid.tsx:1` — no import change needed here.

- [ ] **Step 2: `DBSqlEditor` — add `useEffect` to the import**

Modify `frontend/src/features/database/DBSqlEditor.tsx:1`, replace:

```typescript
import { useState } from 'react'
```

with:

```typescript
import { useEffect, useState } from 'react'
```

- [ ] **Step 3: `DBSqlEditor` — add the prop, baseline state, and dirty effect**

Modify `frontend/src/features/database/DBSqlEditor.tsx:17`, replace:

```typescript
export function DBSqlEditor({ connectionId }: { connectionId: string }) {
```

with:

```typescript
export function DBSqlEditor({
  connectionId,
  onDirtyChange,
}: {
  connectionId: string
  onDirtyChange?: (dirty: boolean) => void
}) {
```

Modify `frontend/src/features/database/DBSqlEditor.tsx:25-27`, replace:

```typescript
  const [text, setText] = useState('SELECT 1;')
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
```

with:

```typescript
  const [text, setText] = useState('SELECT 1;')
  // The text at last save/load — dirty means the editor's text has diverged
  // from it. Reset on save, on update, and when a saved query is loaded.
  const [baseline, setBaseline] = useState('SELECT 1;')
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    onDirtyChange?.(text !== baseline)
  }, [text, baseline, onDirtyChange])
```

- [ ] **Step 4: `DBSqlEditor` — reset the baseline on save/update**

Modify `frontend/src/features/database/DBSqlEditor.tsx:37-49`, replace:

```typescript
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
```

with:

```typescript
  function save() {
    const name = window.prompt('Query name')
    if (!name) return
    createSaved.mutate(
      { connectionId, name, sql: text },
      { onSuccess: (q) => { setActiveSavedId(q.id); setBaseline(text); showToast(`Saved "${name}"`) } },
    )
  }

  function updateActiveSaved() {
    if (!activeSavedId) return
    updateSaved.mutate(
      { id: activeSavedId, connectionId, patch: { sql: text } },
      { onSuccess: () => { setBaseline(text); showToast('Updated saved query') } },
    )
  }
```

- [ ] **Step 5: `DBSqlEditor` — reset the baseline when a saved query is loaded or cleared**

Modify `frontend/src/features/database/DBSqlEditor.tsx:63`, replace:

```tsx
              onClick={() => { setText(q.sql); setActiveSavedId(q.id) }}
```

with:

```tsx
              onClick={() => { setText(q.sql); setActiveSavedId(q.id); setBaseline(q.sql) }}
```

Modify `frontend/src/features/database/DBSqlEditor.tsx:91`, replace:

```tsx
            <Button variant="ghost" size="sm" onClick={() => { setActiveSavedId(null); setText('') }}>
```

with:

```tsx
            <Button variant="ghost" size="sm" onClick={() => { setActiveSavedId(null); setText(''); setBaseline('') }}>
```

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: exits 0.

- [ ] **Step 7: Manual verification**

Run the dev server, open a table with editable rows and confirm editing a cell / editing then undoing back to the original value still behaves as before (this task adds a side-channel callback, no visible behavior change yet — `onDirtyChange` isn't wired to anything visible until Task 8). Same for the SQL editor: typing, saving, loading a saved query, and clicking "New" should behave exactly as before.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/features/database/DBTableGrid.tsx frontend/src/features/database/DBSqlEditor.tsx
git commit -m "feat(db): add onDirtyChange reporting to DBTableGrid and DBSqlEditor"
```

---

### Task 7: `DBInspectorPanel` component

**Files:**
- Create: `frontend/src/features/database/DBInspectorPanel.tsx`

**Interfaces:**
- Consumes: `useDBStats` (existing, from `@/features/data/queries`), `DB_KIND_COLOR` (Task 1), `DBObjectRef` (existing, `@/lib/api`), `DBTabContent` (existing, `./dbTabs`), `DBConnection` (existing, `@/store/types`).
- Produces: `DBInspectorPanel({ connection, activeTab }): JSX.Element` where `activeTab: DBTabContent | null`. Consumed by `DatabaseModule.tsx` (Task 8).

- [ ] **Step 1: Write `DBInspectorPanel.tsx`**

```tsx
import { useDBStats } from '@/features/data/queries'
import type { DBObjectRef } from '@/lib/api'
import type { DBConnection } from '@/store/types'
import { DB_KIND_COLOR } from './dbColors'
import type { DBTabContent } from './dbTabs'

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

function InspectorRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[11px] text-devdeck-dim">{label}</span>
      <span className="font-mono text-[11.5px] text-devdeck-fg-2">{value}</span>
    </div>
  )
}

/** Read-only estimated-size stats for a table/view/matview, reusing the same
 *  useDBStats hook DBTableGrid's inline DBTableInfo strip uses. Deliberately
 *  does NOT include the exact "Count rows" action — that needs the grid's
 *  current filter set, which lives as DBTableGrid's own local state and
 *  isn't available here; it stays in DBTableGrid's toolbar where it already
 *  works correctly against the active filters. */
function TableStats({ connectionId, object }: { connectionId: string; object: DBObjectRef }) {
  const { data, isLoading } = useDBStats(connectionId, object)
  if (isLoading) return <span className="text-[11px] text-devdeck-dim">loading stats…</span>
  if (!data) return null
  return (
    <>
      <InspectorRow
        label="Est. rows"
        value={data.estRows === null ? '—' : `~${data.estRows.toLocaleString()}${data.analyzed ? '' : ' (unanalyzed)'}`}
      />
      <InspectorRow label="Total size" value={formatBytes(data.totalBytes)} />
      {data.indexBytes !== null ? <InspectorRow label="Index size" value={formatBytes(data.indexBytes)} /> : null}
    </>
  )
}

function kindColor(kind: string): string {
  if (kind === 'view') return DB_KIND_COLOR.view
  if (kind === 'matview') return DB_KIND_COLOR.matview
  if (kind === 'function') return DB_KIND_COLOR.function
  return DB_KIND_COLOR.table
}

export function DBInspectorPanel({ connection, activeTab }: { connection: DBConnection; activeTab: DBTabContent | null }) {
  if (!activeTab) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-[12px] text-devdeck-dim">
        Select an object to see its details here.
      </div>
    )
  }

  if (activeTab.kind === 'table') {
    return (
      <div className="p-3">
        <div className="mb-1 font-mono text-[11px] uppercase tracking-wide" style={{ color: kindColor(activeTab.object.kind) }}>
          {activeTab.object.kind}
        </div>
        <div className="mb-3 truncate text-[13px] font-medium text-devdeck-fg">{activeTab.object.name}</div>
        <div className="divide-y divide-devdeck-border-menu/50">
          <TableStats connectionId={connection.id} object={activeTab.object} />
        </div>
      </div>
    )
  }

  if (activeTab.kind === 'ddl' || activeTab.kind === 'designer') {
    return (
      <div className="p-3">
        <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-devdeck-dim">
          {activeTab.kind === 'ddl' ? 'DDL' : 'Table designer'}
        </div>
        <div className="truncate text-[13px] font-medium text-devdeck-fg">{activeTab.object?.name ?? 'New table'}</div>
      </div>
    )
  }

  return (
    <div className="p-3">
      <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-devdeck-accent-soft">Query</div>
      <div className="mb-3 truncate text-[13px] font-medium text-devdeck-fg">{connection.name}</div>
      <div className="divide-y divide-devdeck-border-menu/50">
        <InspectorRow label="Engine" value={connection.engine} />
        <InspectorRow label="Database" value={connection.database} />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/database/DBInspectorPanel.tsx
git commit -m "feat(db): add DBInspectorPanel showing per-tab-kind object metadata"
```

---

### Task 8: `DatabaseModule.tsx` — three-pane shell, `EngineGlyph`, render-all-tabs

**Files:**
- Create: `frontend/src/features/database/EngineGlyph.tsx`
- Modify: `frontend/src/features/database/DatabaseModule.tsx` (full-file rewrite)
- Delete: `frontend/src/features/database/DBTabBar.tsx` (superseded by `DBTabStrip`)

**Interfaces:**
- Consumes: `DB_ENGINE_COLOR` (Task 1), `DBTabStrip` (Task 5), `DBInspectorPanel` (Task 7), `DBTableGrid`/`DBSqlEditor`'s new `onDirtyChange` prop (Task 6), the store's `dbActiveConnectionId`/`dbInspectorCollapsed`/`dbConnectionTestStatus`/`reorderDBTab` (Task 4).
- Produces: `EngineGlyph({ engine, size? }): JSX.Element`, exported for reuse by `DBConnectionDialog.tsx` (Task 11) — pulled into its own file specifically to avoid a circular import (`DatabaseModule.tsx` already imports `DBConnectionDialog`, so `DBConnectionDialog` cannot import a component defined inside `DatabaseModule.tsx`).

- [ ] **Step 1: Write `EngineGlyph.tsx`**

```tsx
import type { DBEngine } from '@/store/types'
import { DB_ENGINE_COLOR } from './dbColors'

/** Small colored badge identifying a connection's engine — shared between
 *  the connection gallery card and the connection dialog's drawer header. A
 *  standalone file (not inlined in DatabaseModule.tsx) specifically so
 *  DBConnectionDialog can import it without creating a circular import
 *  (DatabaseModule already imports DBConnectionDialog). */
export function EngineGlyph({ engine, size = 32 }: { engine: DBEngine; size?: number }) {
  const label = engine === 'postgres' ? 'PG' : engine === 'mysql' ? 'My' : 'lite'
  const color = DB_ENGINE_COLOR[engine]
  return (
    <span
      className="flex flex-none items-center justify-center rounded-[10px] border font-mono text-[10px] font-semibold"
      style={{ width: size, height: size, color, background: `${color}18`, borderColor: `${color}44` }}
    >
      {label}
    </span>
  )
}
```

- [ ] **Step 2: Rewrite `DatabaseModule.tsx`**

Replace the entire contents of `frontend/src/features/database/DatabaseModule.tsx` with:

```tsx
import { useMemo, useState } from 'react'
import { Database as DatabaseIcon, Pencil, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusDot } from '@/components/ui/status-dot'
import { DataLoading } from '@/features/screens/DataLoading'
import { useDBConnections, useDBEngines } from '@/features/data/queries'
import { cn } from '@/lib/utils'
import { DBCommitDialog } from './DBCommitDialog'
import { DBConnectionDialog } from './DBConnectionDialog'
import { DBDDLView } from './DBDDLView'
import { DBInspectorPanel } from './DBInspectorPanel'
import { DBObjectTree } from './DBObjectTree'
import { DBSqlEditor } from './DBSqlEditor'
import { DBTabStrip } from './DBTabStrip'
import { DBTableDesigner } from './DBTableDesigner'
import { DBTableGrid } from './DBTableGrid'
import { emptyDBTabState } from './dbTabs'
import { EngineGlyph } from './EngineGlyph'
import type { DBConnection } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'

const ALL_GROUPS = '__all__'

function groupLabel(group: string) {
  return group.trim() || 'Ungrouped'
}

function ConnectionCard({ conn, onOpen, onEdit }: { conn: DBConnection; onOpen: () => void; onEdit: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen()
      }}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-[13px] border p-3 text-left transition-colors',
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
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onEdit() }}
        aria-label={`Edit ${conn.name}`}
        className="flex-none rounded-md p-1 text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
      >
        <Pencil size={13} />
      </button>
    </div>
  )
}

export function DatabaseModule() {
  const { data: connections, isLoading, error, refetch } = useDBConnections()
  const activeGroup = useDevDeckStore((s) => s.dbActiveGroup)
  const setActiveGroup = useDevDeckStore((s) => s.setDBActiveGroup)
  const openAdd = useDevDeckStore((s) => s.openAddDBConnection)
  const openEdit = useDevDeckStore((s) => s.openEditDBConnection)
  const openDBTab = useDevDeckStore((s) => s.openDBTab)
  const activeConnectionId = useDevDeckStore((s) => s.dbActiveConnectionId)
  const setActiveConnectionId = useDevDeckStore((s) => s.setDBActiveConnectionId)
  const inspectorCollapsed = useDevDeckStore((s) => s.dbInspectorCollapsed)
  const setInspectorCollapsed = useDevDeckStore((s) => s.setDBInspectorCollapsed)
  const testStatus = useDevDeckStore((s) => s.dbConnectionTestStatus)
  const [query, setQuery] = useState('')
  const [dirtyTabIds, setDirtyTabIds] = useState<ReadonlySet<string>>(new Set())
  const activeConnection = connections?.find((c) => c.id === activeConnectionId) ?? null
  const { data: engines } = useDBEngines()
  // Selector reads conditionally, but the hook call itself is unconditional —
  // calling useDevDeckStore(...) only when activeConnection is truthy would
  // change the number of hooks called between renders of this same
  // component instance (activeConnection toggles within one mount).
  const activeTabState = useDevDeckStore((s) => (activeConnection ? s.dbTabs[activeConnection.id] : undefined)) ?? emptyDBTabState()
  const activeTab = activeTabState.tabs.find((t) => t.id === activeTabState.activeTabId) ?? null

  function setTabDirty(tabId: string, dirty: boolean) {
    setDirtyTabIds((prev) => {
      const next = new Set(prev)
      if (dirty) next.add(tabId)
      else next.delete(tabId)
      return next
    })
  }

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
    <>
      <div className="flex h-full min-h-0 flex-col">
        {activeConnection ? (
          <div className="flex min-h-0 flex-1">
            <div className="flex w-64 flex-none flex-col overflow-hidden border-r border-devdeck-border-menu">
              <div className="flex h-9 flex-none items-center border-b border-devdeck-border-menu px-2.5">
                <button
                  type="button"
                  onClick={() => setActiveConnectionId(null)}
                  className="flex min-w-0 items-center gap-1.5 text-[11px] text-devdeck-dim hover:text-devdeck-fg"
                >
                  {testStatus[activeConnection.id] ? (
                    <StatusDot color={testStatus[activeConnection.id].ok ? '#56d58a' : '#f87171'} size={6} />
                  ) : null}
                  <span className="truncate">← Connections</span>
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {engines?.[activeConnection.engine] ? (
                  <DBObjectTree
                    connectionId={activeConnection.id}
                    caps={engines[activeConnection.engine]}
                    onOpenTable={(object) => openDBTab(activeConnection.id, { kind: 'table', object })}
                    onOpenDDL={(object) => openDBTab(activeConnection.id, { kind: 'ddl', object })}
                  />
                ) : (
                  <DataLoading compact label="loading capabilities…" />
                )}
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <DBTabStrip
                connectionId={activeConnection.id}
                isProduction={activeConnection.isProduction}
                dirtyTabIds={dirtyTabIds}
                onNewTable={() => openDBTab(activeConnection.id, { kind: 'designer', object: null })}
                onNewQuery={() => openDBTab(activeConnection.id, { kind: 'query', savedQueryId: null, label: 'New query' })}
                inspectorCollapsed={inspectorCollapsed}
                onToggleInspector={() => setInspectorCollapsed(!inspectorCollapsed)}
              />
              <div className="relative min-h-0 flex-1 overflow-hidden">
                {activeTabState.tabs.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-[12px] text-devdeck-dim">
                    Select a table from the tree to browse it.
                  </div>
                ) : (
                  // Every open tab stays mounted (hidden via CSS when
                  // inactive) instead of only rendering the active one —
                  // matching the terminal's PaneCanvas pattern. This is what
                  // keeps a table's pending row edits alive when switching
                  // to another tab and back, and what makes per-tab
                  // dirty-dots reflect every tab, not just the visible one.
                  activeTabState.tabs.map((tab) => (
                    <div
                      key={tab.id}
                      className={cn('absolute inset-0 overflow-auto', tab.id === activeTabState.activeTabId ? 'block' : 'hidden')}
                    >
                      {tab.kind === 'table' ? (
                        <DBTableGrid
                          connectionId={activeConnection.id}
                          object={tab.object}
                          onDirtyChange={(d) => setTabDirty(tab.id, d)}
                        />
                      ) : tab.kind === 'ddl' ? (
                        <DBDDLView connectionId={activeConnection.id} object={tab.object} />
                      ) : tab.kind === 'designer' ? (
                        <DBTableDesigner
                          connectionId={activeConnection.id}
                          object={tab.object}
                          onApplied={(object) => openDBTab(activeConnection.id, { kind: 'ddl', object })}
                        />
                      ) : (
                        <DBSqlEditor connectionId={activeConnection.id} onDirtyChange={(d) => setTabDirty(tab.id, d)} />
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
            {!inspectorCollapsed ? (
              <div className="w-72 flex-none overflow-auto border-l border-devdeck-border-menu">
                <DBInspectorPanel connection={activeConnection} activeTab={activeTab} />
              </div>
            ) : null}
          </div>
        ) : (
          <>
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
                    <ConnectionCard key={c.id} conn={c} onOpen={() => setActiveConnectionId(c.id)} onEdit={() => openEdit(c)} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <DBConnectionDialog />
      <DBCommitDialog />
    </>
  )
}
```

- [ ] **Step 3: Delete the superseded `DBTabBar.tsx`**

```bash
git rm frontend/src/features/database/DBTabBar.tsx
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: exits 0. In particular, no "unused" or "not found" errors referencing `DBTabBar`.

- [ ] **Step 5: Manual verification**

Run the dev server and, against a connection with at least one table:
1. Open the connection — confirm the tree, tab strip, and (when not collapsed) inspector pane all render.
2. Open two different tables as tabs, plus a "New SQL query" tab. Confirm the tab strip shows a kind-colored icon per tab, and dragging a tab reorders the strip.
3. Edit a cell in one table's grid (creating a pending change) and switch to a different tab, then switch back — confirm the pending-change banner and edited cell are still there (this is the render-all-tabs-hide-inactive fix; before this task, switching away and back would have silently discarded the edit).
4. While that pending edit exists, confirm the dirty dot (•) appears on that table's tab even while a *different* tab is active.
5. Type into the SQL editor without saving, switch tabs and back — confirm the dirty dot appears and the typed text is preserved.
6. Click the inspector-toggle button in the tab strip's trailing chrome — confirm the inspector pane hides/shows, and reflects the active tab's object (stats for a table tab, connection info for a query tab).
7. Click "← Connections", then reopen the same connection — confirm `dbActiveConnectionId` correctly reset/re-set (tabs persist because `dbTabs` was never tied to `activeConnectionId` reset).
8. Open a connection, open a couple of tabs, then reload the page entirely (full browser refresh, not client-side navigation) — confirm the module resumes on the same connection with the same tabs open. This exercises Task 4 Step 6's `partialize` addition (`dbActiveConnectionId` + `dbTabs` now persist to `localStorage`); without that step this would silently fail (the module would fall back to the empty connection gallery on reload).
9. In the connections gallery (no connection open), confirm each connection card's engine glyph now shows a distinct color per engine (postgres/mysql/sqlite).
10. Test a connection via its edit dialog, then reopen that connection — confirm the status dot next to "← Connections" reflects the last test result.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/database/EngineGlyph.tsx frontend/src/features/database/DatabaseModule.tsx
git commit -m "feat(db): three-pane DatabaseModule shell — inspector pane, DBTabStrip, render-all-tabs"
```

---

### Task 9: `DBObjectTree.tsx` — kind-colored icons

**Files:**
- Modify: `frontend/src/features/database/DBObjectTree.tsx:1,15-19`

**Interfaces:**
- Consumes: `DB_KIND_COLOR` (Task 1).

- [ ] **Step 1: Update the icon imports**

Modify `frontend/src/features/database/DBObjectTree.tsx:1`, replace:

```typescript
import { ChevronRight, Code2, Database as DatabaseIcon, FileCode, Table2 } from 'lucide-react'
```

with:

```typescript
import { ChevronRight, Code2, Eye, FolderTree, Layers, Sigma, Table2 } from 'lucide-react'
```

- [ ] **Step 2: Add the `dbColors` import**

Modify `frontend/src/features/database/DBObjectTree.tsx:4` (immediately after the existing `useDBTree` import), add:

```typescript
import { DB_KIND_COLOR } from './dbColors'
```

- [ ] **Step 3: Recolor `nodeIcon`**

Modify `frontend/src/features/database/DBObjectTree.tsx:15-19`, replace:

```tsx
function nodeIcon(kind: string) {
  if (kind === 'function') return <FileCode size={13} className="text-devdeck-dim" />
  if (kind === 'database' || kind === 'schema') return <DatabaseIcon size={13} className="text-devdeck-dim" />
  return <Table2 size={13} className="text-devdeck-dim" />
}
```

with:

```tsx
function nodeIcon(kind: string) {
  if (kind === 'function') return <Sigma size={13} color={DB_KIND_COLOR.function} />
  if (kind === 'database' || kind === 'schema') return <FolderTree size={13} color={DB_KIND_COLOR.folder} />
  if (kind === 'view') return <Eye size={13} color={DB_KIND_COLOR.view} />
  if (kind === 'matview') return <Layers size={13} color={DB_KIND_COLOR.matview} />
  return <Table2 size={13} color={DB_KIND_COLOR.table} />
}
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Manual verification**

Run the dev server, open a Postgres connection with schemas, tables, views, and functions, and confirm each tree row's icon now shows the correct color (folder/schema = gold, table = blue, view = violet, function = mint-emerald), matching the icons on the corresponding open tabs.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/database/DBObjectTree.tsx
git commit -m "feat(db): kind-colored icons in DBObjectTree"
```

---

### Task 10: Grid column type-badges + commit-dialog insert coloring

**Files:**
- Modify: `frontend/src/features/database/DBTableGrid.tsx:1-9` (imports), `:236-250` (column header)
- Modify: `frontend/src/features/database/DBCommitDialog.tsx:53` (insert-row color)

**Interfaces:**
- Consumes: `classifyDataType`, `DB_TYPE_BADGE` (Task 1), `Pill` (existing, `@/components/ui/pill`).

- [ ] **Step 1: Add imports to `DBTableGrid.tsx`**

Modify `frontend/src/features/database/DBTableGrid.tsx`, add two new import lines (alongside the existing ones, e.g. after the `DataLoading` import at line 4):

```typescript
import { Pill } from '@/components/ui/pill'
```

and after the existing `import { cn } from '@/lib/utils'` line, add:

```typescript
import { classifyDataType, DB_TYPE_BADGE } from './dbColors'
```

- [ ] **Step 2: Add the type badge to the column header**

Modify `frontend/src/features/database/DBTableGrid.tsx:236-250`, replace:

```tsx
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
```

with:

```tsx
            {columns.map((col) => {
              const sortEntry = sort.find((s) => s.column === col.name)
              const badge = classifyDataType(col.dataType)
              return (
                <button
                  key={col.name}
                  type="button"
                  onClick={() => toggleSort(col.name)}
                  style={{ minWidth: 140 }}
                  className="flex h-8 flex-1 items-center gap-1.5 border-r border-devdeck-border-menu px-2.5 text-left font-mono text-[11px] font-medium text-devdeck-muted hover:text-devdeck-fg"
                >
                  {badge ? <Pill color={DB_TYPE_BADGE[badge].color}>{DB_TYPE_BADGE[badge].label}</Pill> : null}
                  <span className="truncate">{col.name}</span>
                  {sortEntry ? <span className="text-devdeck-accent-soft">{sortEntry.desc ? '↓' : '↑'}</span> : null}
                </button>
              )
            })}
```

- [ ] **Step 3: Recolor insert rows in `DBCommitDialog.tsx`**

Modify `frontend/src/features/database/DBCommitDialog.tsx:53`, replace:

```tsx
            <div className={cn('text-devdeck-dim', edit.kind === 'delete' && 'text-devdeck-red-soft')}>
```

with:

```tsx
            <div
              className={cn(
                'text-devdeck-dim',
                edit.kind === 'delete' && 'text-devdeck-red-soft',
                edit.kind === 'insert' && 'text-devdeck-green-soft',
              )}
            >
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Manual verification**

Run the dev server, open a table with a mix of column types (uuid, integer, varchar, timestamp, etc.) and confirm each column header shows the correct colored badge. Then stage an insert (add a row, fill in a value) and a delete, open "Review & commit", and confirm the insert line renders green while the delete line renders red.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/database/DBTableGrid.tsx frontend/src/features/database/DBCommitDialog.tsx
git commit -m "feat(db): data-type badges in grid headers, insert-row coloring in commit dialog"
```

---

### Task 11: `DBConnectionDialog` — drawer header engine glyph

**Files:**
- Modify: `frontend/src/features/database/DBConnectionDialog.tsx:1-20` (imports), `:164-172` (header)

**Interfaces:**
- Consumes: `EngineGlyph` (Task 8).

- [ ] **Step 1: Add the import**

Modify `frontend/src/features/database/DBConnectionDialog.tsx`, add (alongside the existing feature-local imports, e.g. after `import type { DBEngine } from '@/store/types'`):

```typescript
import { EngineGlyph } from './EngineGlyph'
```

- [ ] **Step 2: Add the glyph to the drawer header**

Modify `frontend/src/features/database/DBConnectionDialog.tsx:164-172`, replace:

```tsx
      {/* header */}
      <div className="flex flex-none items-start gap-2.5 border-b border-devdeck-border px-[18px] pb-3.5 pt-[18px]">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-devdeck-fg">
            {isEdit ? 'Edit database connection' : 'New database connection'}
          </div>
          <div className="mt-1 font-mono text-[11px] text-devdeck-dim">
            Credentials are encrypted at rest and never sent back to the browser.
          </div>
        </div>
```

with:

```tsx
      {/* header */}
      <div className="flex flex-none items-start gap-2.5 border-b border-devdeck-border px-[18px] pb-3.5 pt-[18px]">
        <EngineGlyph engine={dialog.engine} size={30} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-devdeck-fg">
            {isEdit ? 'Edit database connection' : 'New database connection'}
          </div>
          <div className="mt-1 font-mono text-[11px] text-devdeck-dim">
            Credentials are encrypted at rest and never sent back to the browser.
          </div>
        </div>
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Full manual smoke test**

Run the dev server and walk through the complete feature end to end:
1. Open "New connection" — confirm the drawer header shows the engine glyph, and it updates color when you switch the Engine select between Postgres/MySQL/SQLite.
2. Save a connection, then edit it and click "Test connection" — confirm the inline result still shows, and that after closing and reopening the connection from the gallery, the tree header's status dot reflects that result.
3. In the open connection view, confirm: tree icons are colorful and match tab icons for the same object kind; the tab strip drag-reorders; the inspector pane shows correct per-kind content and can be collapsed/expanded; the grid shows type badges; an insert/delete staged in the commit dialog is colored correctly.
4. Confirm no regressions in the terminal's tab strip (split-right/split-down/close-pane/new-tab/overflow menu) — this validates Task 2's extraction didn't leak into unrelated features.
5. Spot-check WCAG AA text contrast for the new colors against their backgrounds (`devdeck-bg` `#191a1c`, `devdeck-terminal` `#111214`, `devdeck-card` `#202124`) — every `dbColors.ts` hex is used as an icon/dot/pill color, not body text, but the pill badges in the grid header render the hex as text color directly, so those seven (`DB_TYPE_BADGE`'s `uuid`/`number`/`text`/`boolean`/`datetime`/`json`/`binary`) are the ones to check with a contrast checker. Adjust any that fall below 4.5:1 and re-run this step.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/database/DBConnectionDialog.tsx
git commit -m "feat(db): colored engine glyph in the connection dialog header"
```

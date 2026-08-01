# Global Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the kind-first `NewTabDialog` with a search-first command palette on `Cmd/Ctrl+K` that searches open tabs, entities, bookmarks and URLs, always offers Create as a last resort, and accepts literal commands (`ssh …`, `agent-new …`, `browser …`) with ghost-text autocomplete.

**Architecture:** A new `frontend/src/features/palette/` directory of small, mostly-pure modules. Providers turn already-warm zustand/react-query state into `PaletteItem[]`; a pure ranker orders them into fixed groups; a page-stack hook drives drill-down; one view component renders and owns the keyboard contract. The SSH command path delegates entirely to the existing `parseSSHCommand` / `buildSSHQuickAddPlan`.

**Tech Stack:** React 19, TypeScript 5.7 (`verbatimModuleSyntax`), Vite 8, zustand 5 (persist + immer), TanStack Query, Tailwind v4, lucide-react, Vitest 3 (introduced by this plan).

**Spec:** `docs/superpowers/specs/2026-08-01-global-command-palette-design.md`

## Global Constraints

- Imports from `src/` MUST use the `@/*` alias. Never relative paths into `src/`.
- `verbatimModuleSyntax` is on — type-only imports MUST use `import type`.
- Never hand-edit `frontend/src/routeTree.gen.ts`.
- Icons: `lucide-react` only. Toasts: the store's `showToast`. Class merging: `cn()` from `@/lib/utils`.
- Design is dark-only; use the existing `devdeck-*` CSS custom properties.
- `frontend/src/store/useDevDeckStore.ts` and `frontend/src/store/types.ts` are convergence files per `CLAUDE.md`. Task 11 is the ONLY task that edits them, and it MUST NOT be parallelised with any other task.
- Every data surface renders explicit loading, error and empty states.
- Verification gates for every task: `npm run typecheck` and `npm test` from `frontend/`.
- Performance budget (palette-local): open ≤ 16 ms, filter ≤ 8 ms for 500 items, **zero network requests on open**, max 8 rows per group and 50 rows total.

## Spec Amendment (discovered during planning)

The spec says `sshCommand.test.ts` and `sshQuickAdd.test.ts` must "pass unchanged". **There is no frontend test runner in this repo.** Vitest is not installed, there is no `npm test`, and `make test` runs only Go tests. `COMMANDS.md:375` records this: *"Frontend: no test suite yet; Vitest is the anticipated choice (Vite-native)."*

The five existing `.test.ts` files are hand-rolled `check()`-harnesses run manually with `tsx`. They are therefore **never run in CI or by any gate**.

TDD is impossible without a runner, so Task 1 installs Vitest and mechanically migrates those five files. The spec's claim is amended to: **their assertions carry over unmodified in meaning** — only `check(...)` becomes `it(...)` / `expect(...)`. If a migrated assertion fails, that is a real pre-existing bug and must be reported, not silently fixed.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `frontend/vitest.setup.ts` | jsdom test setup (jest-dom matchers) |
| `frontend/src/lib/fuzzyHighlight.ts` | fuzzy subsequence match + highlight ranges (moved) |
| `frontend/src/lib/fuzzyHighlight.test.ts` | tests for the above |
| `frontend/src/features/palette/paletteTypes.ts` | all palette types |
| `frontend/src/features/palette/paletteRank.ts` | scoring, grouping, ordering, truncation |
| `frontend/src/features/palette/paletteRank.test.ts` | ranking rules |
| `frontend/src/features/palette/paletteFrecency.ts` | frecency persistence, decay, pruning |
| `frontend/src/features/palette/paletteFrecency.test.ts` | frecency rules |
| `frontend/src/features/palette/paletteComplete.ts` | ghost-text completion |
| `frontend/src/features/palette/paletteComplete.test.ts` | completion rules |
| `frontend/src/features/palette/providers/openTabs.ts` | layout tree → items |
| `frontend/src/features/palette/providers/openTabs.test.ts` | tree walk, active marking |
| `frontend/src/features/palette/providers/entities.ts` | worktrees, projects, hosts, machines, pages |
| `frontend/src/features/palette/providers/entities.test.ts` | scoping, offline disabling |
| `frontend/src/features/palette/providers/bookmarks.ts` | bookmarks + raw-URL detection |
| `frontend/src/features/palette/providers/bookmarks.test.ts` | URL detection rules |
| `frontend/src/features/palette/providers/commands.ts` | verb registry + arbitration |
| `frontend/src/features/palette/providers/commands.test.ts` | verb rules |
| `frontend/src/features/palette/providers/createActions.ts` | the three Create rows |
| `frontend/src/features/palette/useCommandPalette.ts` | page-stack state machine + pure item assembly |
| `frontend/src/features/palette/useCommandPalette.test.ts` | empty-query group invariant (Decision 5) |
| `frontend/src/features/palette/CommandPalette.tsx` | overlay, input, ghost, list, keys |
| `frontend/src/features/palette/CommandPalette.test.tsx` | keyboard contract |
| `frontend/src/features/ssh/SSHQuickAddDialog.tsx` | narrowed SSH quick-add form |

**Modified:**

| File | Change |
|---|---|
| `frontend/package.json` | vitest deps + `test` scripts |
| `frontend/vite.config.ts` | vitest `test` block |
| `Makefile:183` | `test` target also runs frontend tests |
| `COMMANDS.md:375` | replace "no test suite yet" with real commands |
| `frontend/src/features/terminal/Terminal.tsx:80-82,164` | `isQuickOpenShortcut` → `isAppShortcut` |
| `frontend/src/features/ssh/sshTerminalRegistry.ts:69` | adopt `isAppShortcut` |
| `frontend/src/features/terminal/FileQuickOpen.tsx:8` | import highlight from `@/lib/fuzzyHighlight` |
| `frontend/src/store/types.ts` + `useDevDeckStore.ts` | replace `newTab` with `palette` + `sshQuickAdd` |
| `frontend/src/features/tabs/WorkspaceTileArea.tsx:196-241,285-292` | `Cmd+K` branch; render `CommandPalette` |

**Deleted:**

| File | Reason |
|---|---|
| `frontend/src/features/terminal/fileMatchHighlight.ts` | moved to `@/lib/fuzzyHighlight.ts` |
| `frontend/src/features/tabs/NewTabDialog.tsx` | narrowed into `SSHQuickAddDialog.tsx` |

---

### Task 1: Vitest harness and migration of existing tests

Without this, no later task can do TDD. This task also proves the existing SSH tests actually pass.

**Files:**
- Create: `frontend/vitest.setup.ts`
- Modify: `frontend/package.json`, `frontend/vite.config.ts`, `Makefile:183`, `COMMANDS.md:375`
- Migrate: `frontend/src/features/ssh/sshCommand.test.ts`, `frontend/src/features/ssh/sshQuickAdd.test.ts`, `frontend/src/features/ssh/jumpHostDraft.test.ts`, `frontend/src/features/tabs/tileTree.ssh.test.ts`, `frontend/src/lib/browserProxy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm test` in `frontend/`, and `describe`/`it`/`expect` available globally in every `*.test.ts(x)`.

- [ ] **Step 1: Install the test dependencies**

```bash
cd frontend
npm install -D vitest@^3 jsdom@^26 @testing-library/react@^16 @testing-library/jest-dom@^6 @testing-library/user-event@^14
```

- [ ] **Step 2: Create the jsdom setup file**

Create `frontend/vitest.setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 3: Add the vitest block to the Vite config**

At the very top of `frontend/vite.config.ts` add the triple-slash reference, then add a `test` property to the exported config object (keep every existing property untouched):

```ts
/// <reference types="vitest/config" />
```

```ts
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // The route tree is generated at build time; excluding it keeps a cold
    // `npm test` from depending on `pretypecheck` having been run.
    exclude: ['node_modules/**', 'dist/**', 'src-tauri/**'],
  },
```

- [ ] **Step 4: Add the test scripts**

In `frontend/package.json` `scripts`, add:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 5: Run the suite to confirm the runner works and the old files fail to collect**

Run: `cd frontend && npm test`
Expected: FAIL. The five hand-rolled files have no `it()` blocks; Vitest reports "No test suite found in file" for each.

- [ ] **Step 6: Migrate the five hand-rolled test files**

Each file currently has this shape:

```ts
let passed = 0
function check(name: string, fn: () => void) { /* ... */ }
check('parses user@host', () => { /* assertions */ })
```

Convert mechanically. Delete the `check`/`passed`/summary scaffolding and the "run manually with tsx" header comment, then wrap each former `check` call:

```ts
import { describe, expect, it } from 'vitest'
import { parseSSHCommand } from './sshCommand'

describe('parseSSHCommand', () => {
  it('parses user@host', () => {
    const parsed = parseSSHCommand('ssh root@10.1.1.4')
    expect(parsed?.target.user).toBe('root')
    expect(parsed?.target.host).toBe('10.1.1.4')
    expect(parsed?.target.port).toBe(22)
  })
})
```

Rules for the migration:
- Every former `check(name, fn)` becomes one `it(name, fn)`.
- Hand-rolled equality assertions become `expect(actual).toBe(expected)` for primitives and `expect(actual).toEqual(expected)` for objects and arrays.
- **Do not change what is asserted.** If a migrated assertion fails, stop and report it as a pre-existing bug — do not adjust the assertion to match the code.
- `browserProxy.test.ts` already uses direct imports and async `check` — its `it` bodies stay `async`.

- [ ] **Step 7: Run the suite and confirm it is green**

Run: `cd frontend && npm test`
Expected: PASS, all five migrated files reporting their tests.

- [ ] **Step 8: Wire the Makefile target**

Replace `Makefile:183-184`:

```makefile
test:
	cd backend && go test ./...
	cd frontend && npm test
```

- [ ] **Step 9: Update the docs**

In `COMMANDS.md`, replace the line `- Frontend: no test suite yet; Vitest is the anticipated choice (Vite-native).` with:

```markdown
- Frontend: `cd frontend && npm test` (Vitest, jsdom). Watch mode: `npm run test:watch`.
  `make test` runs both the Go and frontend suites.
```

- [ ] **Step 10: Verify and commit**

Run: `cd frontend && npm run typecheck && npm test`
Expected: both PASS.

```bash
git add frontend/package.json frontend/package-lock.json frontend/vite.config.ts frontend/vitest.setup.ts frontend/src/features/ssh/sshCommand.test.ts frontend/src/features/ssh/sshQuickAdd.test.ts frontend/src/features/ssh/jumpHostDraft.test.ts frontend/src/features/tabs/tileTree.ssh.test.ts frontend/src/lib/browserProxy.test.ts Makefile COMMANDS.md
git commit -m "test: add Vitest harness and migrate the hand-rolled test files"
```

---

### Task 2: Move the fuzzy highlighter into `lib/`

**Files:**
- Create: `frontend/src/lib/fuzzyHighlight.ts`, `frontend/src/lib/fuzzyHighlight.test.ts`
- Delete: `frontend/src/features/terminal/fileMatchHighlight.ts`
- Modify: `frontend/src/features/terminal/FileQuickOpen.tsx:8`

**Interfaces:**
- Consumes: nothing.
- Produces: `export type HighlightRange = [number, number]` and `export function computeHighlight(text: string, pattern: string): HighlightRange[]` — returns `[]` (never `null`) for both an empty pattern and a genuine non-match; the caller cannot use the return value to distinguish "matched, nothing to emphasise" from "did not match" (confirmed against the real, unchanged algorithm in `fileMatchHighlight.ts` — see Task 3's `scoreOne`, which computes match/no-match independently instead of relying on this return value).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/fuzzyHighlight.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { computeHighlight } from '@/lib/fuzzyHighlight'

describe('computeHighlight', () => {
  it('returns an empty range list for an empty pattern', () => {
    expect(computeHighlight('prod-db', '')).toEqual([])
  })

  it('returns an empty range list when the pattern does not match', () => {
    expect(computeHighlight('prod-db', 'zzz')).toEqual([])
  })

  it('matches a contiguous prefix as one range', () => {
    expect(computeHighlight('prod-db', 'prod')).toEqual([[0, 4]])
  })

  it('matches a subsequence as multiple ranges', () => {
    expect(computeHighlight('prod-db', 'pdb')).toEqual([[0, 1], [5, 7]])
  })

  it('is case-insensitive', () => {
    expect(computeHighlight('Prod-DB', 'prod')).toEqual([[0, 4]])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- fuzzyHighlight`
Expected: FAIL — cannot resolve `@/lib/fuzzyHighlight`.

- [ ] **Step 3: Move the module**

```bash
git mv frontend/src/features/terminal/fileMatchHighlight.ts frontend/src/lib/fuzzyHighlight.ts
```

Read the moved file. It already exports `HighlightRange` and `computeHighlight`. Its real contract is confirmed to be `(text: string, query: string): HighlightRange[]` — it never returns `null`; an empty pattern and a genuine non-match both fall through to `mergeRanges([])`, i.e. `[]`. The test above already reflects this. Do not rewrite the algorithm, and do not add a `null` return to "fix" it — Task 3's ranker is written to determine match/no-match on its own, without relying on this function's return value (see Task 3 Step 4).

- [ ] **Step 4: Update the one existing importer**

In `frontend/src/features/terminal/FileQuickOpen.tsx`, replace:

```ts
import { computeHighlight, type HighlightRange } from './fileMatchHighlight'
```

with:

```ts
import { computeHighlight, type HighlightRange } from '@/lib/fuzzyHighlight'
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd frontend && npm test -- fuzzyHighlight && npm run typecheck`
Expected: both PASS. Typecheck catches any other importer that was missed.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src/lib/fuzzyHighlight.ts frontend/src/lib/fuzzyHighlight.test.ts frontend/src/features/terminal/
git commit -m "refactor: move fileMatchHighlight to lib/fuzzyHighlight for reuse"
```

---

### Task 3: Palette types and the ranker

**Files:**
- Create: `frontend/src/features/palette/paletteTypes.ts`, `frontend/src/features/palette/paletteRank.ts`, `frontend/src/features/palette/paletteRank.test.ts`

**Interfaces:**
- Consumes: `computeHighlight`, `HighlightRange` from `@/lib/fuzzyHighlight`.
- Produces:
  - `PaletteGroup = 'open' | 'recent' | 'results' | 'create'`
  - `PaletteItem` (fields below)
  - `RankedItem = PaletteItem & { score: number; ranges: HighlightRange[] }`
  - `RankedGroup = { group: PaletteGroup; label: string; items: RankedItem[]; truncated: number }`
  - `rankPaletteItems(items: PaletteItem[], query: string, frecency: (id: string) => number, isOpen?: (id: string) => boolean): RankedGroup[]` — `isOpen` defaults to `() => false` so every existing call site (including the tests below) is unaffected; it lets a Results row for an entity that is *also* currently open in another leaf outrank a merely-frecent one, per spec ranking rule 4 ("exact-prefix match > currently-open > frecency > fuzzy score").
  - `flattenRanked(groups: RankedGroup[]): RankedItem[]`
  - `MAX_ROWS_PER_GROUP = 8`, `MAX_ROWS_TOTAL = 50`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/palette/paletteRank.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { flattenRanked, rankPaletteItems } from '@/features/palette/paletteRank'
import type { PaletteItem } from '@/features/palette/paletteTypes'

const noFrecency = () => 0

function item(partial: Partial<PaletteItem> & Pick<PaletteItem, 'id' | 'title' | 'group'>): PaletteItem {
  return { kind: 'worktree', ...partial }
}

describe('rankPaletteItems', () => {
  it('always renders groups in the fixed order', () => {
    const groups = rankPaletteItems(
      [
        item({ id: 'c', title: 'New Browser tab', group: 'create', kind: 'create' }),
        item({ id: 'r', title: 'alpha', group: 'results' }),
        item({ id: 'o', title: 'alpha', group: 'open' }),
        item({ id: 'm', title: 'alpha', group: 'recent' }),
      ],
      '',
      noFrecency,
    )
    expect(groups.map((g) => g.group)).toEqual(['open', 'recent', 'results', 'create'])
  })

  it('keeps the create group even when the query matches nothing else', () => {
    const groups = rankPaletteItems(
      [
        item({ id: 'r', title: 'alpha', group: 'results' }),
        item({ id: 'c', title: 'New SSH', group: 'create', kind: 'create' }),
      ],
      'zzzz',
      noFrecency,
    )
    expect(groups.map((g) => g.group)).toEqual(['create'])
    expect(flattenRanked(groups)[0].id).toBe('c')
  })

  it('never filters the create group by the query', () => {
    const groups = rankPaletteItems(
      [item({ id: 'c', title: 'New SSH host', group: 'create', kind: 'create' })],
      'totally unrelated',
      noFrecency,
    )
    expect(flattenRanked(groups)).toHaveLength(1)
  })

  it('ranks an exact prefix above a mere subsequence', () => {
    const groups = rankPaletteItems(
      [
        item({ id: 'sub', title: 'peer-review-order-daemon', group: 'results' }),
        item({ id: 'pre', title: 'prod-db', group: 'results' }),
      ],
      'prod',
      noFrecency,
    )
    expect(flattenRanked(groups).map((i) => i.id)).toEqual(['pre', 'sub'])
  })

  it('breaks ties by frecency', () => {
    const groups = rankPaletteItems(
      [item({ id: 'cold', title: 'alpha', group: 'results' }), item({ id: 'hot', title: 'alpha', group: 'results' })],
      'alpha',
      (id) => (id === 'hot' ? 100 : 0),
    )
    expect(flattenRanked(groups).map((i) => i.id)).toEqual(['hot', 'cold'])
  })

  it('ranks an open-but-cold entity above a closed-but-hot one', () => {
    const groups = rankPaletteItems(
      [item({ id: 'open-cold', title: 'alpha', group: 'results' }), item({ id: 'closed-hot', title: 'alpha', group: 'results' })],
      'alpha',
      (id) => (id === 'closed-hot' ? 100 : 0),
      (id) => id === 'open-cold',
    )
    expect(flattenRanked(groups).map((i) => i.id)).toEqual(['open-cold', 'closed-hot'])
  })

  it('matches against keywords as well as the title', () => {
    const groups = rankPaletteItems(
      [item({ id: 'k', title: 'prod-db', group: 'results', keywords: ['10.1.1.4'] })],
      '10.1.1',
      noFrecency,
    )
    expect(flattenRanked(groups)).toHaveLength(1)
  })

  it('caps a group at 8 rows and reports the remainder', () => {
    const many = Array.from({ length: 12 }, (_, i) => item({ id: `w${i}`, title: `alpha-${i}`, group: 'results' }))
    const groups = rankPaletteItems(many, 'alpha', noFrecency)
    expect(groups[0].items).toHaveLength(8)
    expect(groups[0].truncated).toBe(4)
  })

  it('attaches highlight ranges to matched items', () => {
    const groups = rankPaletteItems([item({ id: 'p', title: 'prod-db', group: 'results' })], 'prod', noFrecency)
    expect(flattenRanked(groups)[0].ranges).toEqual([[0, 4]])
  })

  it('drops empty non-create groups entirely', () => {
    const groups = rankPaletteItems(
      [item({ id: 'o', title: 'alpha', group: 'open' }), item({ id: 'c', title: 'New SSH', group: 'create', kind: 'create' })],
      'zzz',
      noFrecency,
    )
    expect(groups.map((g) => g.group)).toEqual(['create'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- paletteRank`
Expected: FAIL — cannot resolve `@/features/palette/paletteRank`.

- [ ] **Step 3: Write the types**

Create `frontend/src/features/palette/paletteTypes.ts`:

```ts
import type { LucideIcon } from 'lucide-react'
import type { HighlightRange } from '@/lib/fuzzyHighlight'

export type PaletteGroup = 'open' | 'recent' | 'results' | 'create'

export type PaletteItemKind =
  | 'open-tab'
  | 'worktree'
  | 'ssh-host'
  | 'project'
  | 'machine'
  | 'page'
  | 'bookmark'
  | 'url'
  | 'create'
  | 'command'

/** A single selectable row. `run` performs the action; `drillInto` pushes a
 *  sub-page. An item with neither is inert and must not be produced. */
export interface PaletteItem {
  id: string
  kind: PaletteItemKind
  title: string
  subtitle?: string
  /** Extra text matched alongside `title` — host, IP, project name. */
  keywords?: string[]
  group: PaletteGroup
  icon?: LucideIcon
  /** Rendered greyed out; `run` is refused and the reason is toasted. */
  disabled?: { reason: string }
  /** Ghost text shown in the input while this item is selected. */
  completion?: string
  run?: (ctx: PaletteRunContext) => void | Promise<void>
  drillInto?: () => PalettePage
}

export interface PalettePage {
  id: string
  breadcrumb: string
  placeholder: string
  items: (query: string, ctx: PaletteRunContext) => PaletteItem[]
}

export interface PaletteRunContext {
  wsId: string
  /** The focused leaf — every action targets it. */
  leafId: string
  showToast: (message: string) => void
  close: () => void
}

export type RankedItem = PaletteItem & { score: number; ranges: HighlightRange[] }

export interface RankedGroup {
  group: PaletteGroup
  label: string
  items: RankedItem[]
  /** How many matches were dropped by the per-group cap. */
  truncated: number
}
```

- [ ] **Step 4: Write the ranker**

Create `frontend/src/features/palette/paletteRank.ts`:

```ts
import { computeHighlight } from '@/lib/fuzzyHighlight'
import type { PaletteGroup, PaletteItem, RankedGroup, RankedItem } from '@/features/palette/paletteTypes'

export const MAX_ROWS_PER_GROUP = 8
export const MAX_ROWS_TOTAL = 50

/** Fixed render order. Create is last so it never displaces a real match. */
const GROUP_ORDER: PaletteGroup[] = ['open', 'recent', 'results', 'create']

const GROUP_LABEL: Record<PaletteGroup, string> = {
  open: 'Open tabs',
  recent: 'Recent',
  results: 'Results',
  create: 'Create',
}

/** Exact-prefix beats subsequence by a margin no frecency score can close,
 *  so typing the start of a name always surfaces that name first. */
const PREFIX_BONUS = 10_000
/** Beats any realistic frecency score but never an exact-prefix match — an
 *  entity that is currently open in another leaf outranks a merely-frecent
 *  one, per spec ranking rule 4. Distinct from `OPEN_BONUS` below: that one
 *  rewards the `open` *group* (the "Open tabs" bucket, which the fixed group
 *  order already renders above Results), this one rewards an *entity id*
 *  that also happens to be open, wherever it's currently being scored. */
const ALREADY_OPEN_BONUS = 5_000
const OPEN_BONUS = 1_000

/**
 * `computeHighlight` (see `@/lib/fuzzyHighlight`) never returns `null` — an
 * empty pattern and a genuine non-match both resolve to `[]`, because its
 * job is purely to pick which characters of an *already-matched* string to
 * emphasise, not to decide whether something matched. So match/no-match is
 * decided here, independently, with the same substring-then-subsequence
 * strategy; `computeHighlight` is then called only to derive display ranges
 * for a haystack that already passed this check.
 */
function fuzzyMatches(haystack: string, query: string): boolean {
  const trimmed = query.trim()
  if (trimmed === '') return true
  const lowerHay = haystack.toLowerCase()
  const lowerQuery = trimmed.toLowerCase()
  if (lowerHay.includes(lowerQuery)) return true
  let cursor = 0
  for (const ch of lowerQuery) {
    const idx = lowerHay.indexOf(ch, cursor)
    if (idx < 0) return false
    cursor = idx + 1
  }
  return true
}

function scoreOne(
  item: PaletteItem,
  query: string,
  frecency: (id: string) => number,
  isOpen: (id: string) => boolean,
) {
  const haystacks = [item.title, ...(item.keywords ?? [])]
  if (!haystacks.some((hay) => fuzzyMatches(hay, query))) return null

  // Highlight ranges only make sense against the title, which is what the
  // row renders — a keyword-only match highlights nothing, and this is `[]`
  // whenever the title itself didn't match, since computeHighlight agrees.
  const ranges = computeHighlight(item.title, query)

  const lowerTitle = item.title.toLowerCase()
  const lowerQuery = query.toLowerCase()
  let score = 0
  if (lowerQuery && lowerTitle.startsWith(lowerQuery)) score += PREFIX_BONUS
  if (isOpen(item.id)) score += ALREADY_OPEN_BONUS
  if (item.group === 'open') score += OPEN_BONUS
  score += frecency(item.id)
  // Shorter titles win ties: "prod" should beat "prod-db-replica-2".
  score += Math.max(0, 100 - item.title.length)

  return { ...item, score, ranges } satisfies RankedItem
}

/**
 * Filters, scores and groups items for display.
 *
 * The `create` group bypasses filtering entirely — its rows must stay
 * reachable no matter what is typed, because the query is frequently the
 * *name of the thing being created* and may well collide with an existing
 * entity (see the spec's Decision 2).
 */
export function rankPaletteItems(
  items: PaletteItem[],
  query: string,
  frecency: (id: string) => number,
  isOpen: (id: string) => boolean = () => false,
): RankedGroup[] {
  const buckets = new Map<PaletteGroup, RankedItem[]>()

  for (const item of items) {
    let ranked: RankedItem | null
    if (item.group === 'create') {
      ranked = { ...item, score: 0, ranges: [] }
    } else {
      ranked = scoreOne(item, query, frecency, isOpen)
    }
    if (!ranked) continue
    const bucket = buckets.get(item.group)
    if (bucket) bucket.push(ranked)
    else buckets.set(item.group, [ranked])
  }

  const groups: RankedGroup[] = []
  let budget = MAX_ROWS_TOTAL

  for (const group of GROUP_ORDER) {
    const bucket = buckets.get(group)
    if (!bucket || bucket.length === 0) continue
    if (group !== 'create') bucket.sort((a, b) => b.score - a.score)
    const cap = Math.min(MAX_ROWS_PER_GROUP, budget)
    const shown = bucket.slice(0, cap)
    budget -= shown.length
    groups.push({
      group,
      label: GROUP_LABEL[group],
      items: shown,
      truncated: bucket.length - shown.length,
    })
  }

  return groups
}

/** Row order as rendered — the basis for arrow-key selection. */
export function flattenRanked(groups: RankedGroup[]): RankedItem[] {
  return groups.flatMap((g) => g.items)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npm test -- paletteRank`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/palette/paletteTypes.ts frontend/src/features/palette/paletteRank.ts frontend/src/features/palette/paletteRank.test.ts
git commit -m "feat(palette): add palette types and the pure ranker"
```

---

### Task 4: Frecency store

**Files:**
- Create: `frontend/src/features/palette/paletteFrecency.ts`, `frontend/src/features/palette/paletteFrecency.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `FrecencyEntry = { hits: number; lastUsedAt: number }`
  - `FrecencyMap = Record<string, FrecencyEntry>`
  - `FRECENCY_CAP = 100`
  - `frecencyScore(map: FrecencyMap, id: string, now: number): number`
  - `recordUse(map: FrecencyMap, id: string, now: number): FrecencyMap`
  - `pruneFrecency(map: FrecencyMap, liveIds: Set<string>): FrecencyMap`
  - `loadFrecency(wsId: string): FrecencyMap`
  - `saveFrecency(wsId: string, map: FrecencyMap): void`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/palette/paletteFrecency.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FRECENCY_CAP,
  frecencyScore,
  loadFrecency,
  pruneFrecency,
  recordUse,
  saveFrecency,
} from '@/features/palette/paletteFrecency'
import type { FrecencyMap } from '@/features/palette/paletteFrecency'

const NOW = 1_785_000_000_000
const DAY = 86_400_000

describe('recordUse', () => {
  it('creates an entry on first use', () => {
    expect(recordUse({}, 'a', NOW)).toEqual({ a: { hits: 1, lastUsedAt: NOW } })
  })

  it('increments hits and moves the timestamp forward', () => {
    const once = recordUse({}, 'a', NOW)
    expect(recordUse(once, 'a', NOW + DAY)).toEqual({ a: { hits: 2, lastUsedAt: NOW + DAY } })
  })

  it('does not mutate the input map', () => {
    const original: FrecencyMap = {}
    recordUse(original, 'a', NOW)
    expect(original).toEqual({})
  })

  it('evicts the least recently used entry past the cap', () => {
    let map: FrecencyMap = {}
    for (let i = 0; i < FRECENCY_CAP; i++) map = recordUse(map, `id-${i}`, NOW + i)
    map = recordUse(map, 'newcomer', NOW + FRECENCY_CAP)
    expect(Object.keys(map)).toHaveLength(FRECENCY_CAP)
    expect(map['id-0']).toBeUndefined()
    expect(map.newcomer).toBeDefined()
  })
})

describe('frecencyScore', () => {
  it('is zero for an unknown id', () => {
    expect(frecencyScore({}, 'missing', NOW)).toBe(0)
  })

  it('decays with age', () => {
    const fresh: FrecencyMap = { a: { hits: 1, lastUsedAt: NOW } }
    const stale: FrecencyMap = { a: { hits: 1, lastUsedAt: NOW - 30 * DAY } }
    expect(frecencyScore(fresh, 'a', NOW)).toBeGreaterThan(frecencyScore(stale, 'a', NOW))
  })

  it('rewards repeated hits at equal age', () => {
    const once: FrecencyMap = { a: { hits: 1, lastUsedAt: NOW } }
    const often: FrecencyMap = { a: { hits: 9, lastUsedAt: NOW } }
    expect(frecencyScore(often, 'a', NOW)).toBeGreaterThan(frecencyScore(once, 'a', NOW))
  })

  it('never returns a negative score', () => {
    const ancient: FrecencyMap = { a: { hits: 1, lastUsedAt: NOW - 3650 * DAY } }
    expect(frecencyScore(ancient, 'a', NOW)).toBeGreaterThanOrEqual(0)
  })
})

describe('pruneFrecency', () => {
  it('drops ids that no longer resolve', () => {
    const map: FrecencyMap = { alive: { hits: 1, lastUsedAt: NOW }, dead: { hits: 5, lastUsedAt: NOW } }
    expect(pruneFrecency(map, new Set(['alive']))).toEqual({ alive: { hits: 1, lastUsedAt: NOW } })
  })

  it('returns the same reference when nothing is pruned', () => {
    const map: FrecencyMap = { alive: { hits: 1, lastUsedAt: NOW } }
    expect(pruneFrecency(map, new Set(['alive']))).toBe(map)
  })
})

describe('loadFrecency / saveFrecency', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips through localStorage, scoped per workspace', () => {
    saveFrecency('ws1', { a: { hits: 3, lastUsedAt: NOW } })
    expect(loadFrecency('ws1')).toEqual({ a: { hits: 3, lastUsedAt: NOW } })
    expect(loadFrecency('ws2')).toEqual({})
  })

  it('returns an empty map for corrupt stored data', () => {
    localStorage.setItem('devdeck.palette.frecency.ws1', '{not json')
    expect(loadFrecency('ws1')).toEqual({})
  })

  it('returns an empty map when the stored value is not an object', () => {
    localStorage.setItem('devdeck.palette.frecency.ws1', '"a string"')
    expect(loadFrecency('ws1')).toEqual({})
  })

  it('does not throw when localStorage rejects a write', () => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new DOMException('QuotaExceededError')
    }
    expect(() => saveFrecency('ws1', { a: { hits: 1, lastUsedAt: NOW } })).not.toThrow()
    Storage.prototype.setItem = original
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- paletteFrecency`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/features/palette/paletteFrecency.ts`:

```ts
export interface FrecencyEntry {
  hits: number
  lastUsedAt: number
}

export type FrecencyMap = Record<string, FrecencyEntry>

export const FRECENCY_CAP = 100

const STORAGE_PREFIX = 'devdeck.palette.frecency.'
const HALF_LIFE_MS = 7 * 86_400_000

function storageKey(wsId: string) {
  return `${STORAGE_PREFIX}${wsId}`
}

/**
 * Classic frecency: hit count decayed by age on a one-week half-life, so a
 * thing opened twice today outranks a thing opened ten times last month.
 * `now` is injected rather than read from `Date.now()` so the decay curve is
 * testable.
 */
export function frecencyScore(map: FrecencyMap, id: string, now: number): number {
  const entry = map[id]
  if (!entry) return 0
  const age = Math.max(0, now - entry.lastUsedAt)
  return entry.hits * Math.pow(2, -age / HALF_LIFE_MS)
}

/** Returns a new map. Past `FRECENCY_CAP`, the least recently used entry is
 *  evicted — bounded storage matters because ids include one-off browser
 *  tiles that will never be seen again. */
export function recordUse(map: FrecencyMap, id: string, now: number): FrecencyMap {
  const previous = map[id]
  const next: FrecencyMap = { ...map, [id]: { hits: (previous?.hits ?? 0) + 1, lastUsedAt: now } }

  const ids = Object.keys(next)
  if (ids.length <= FRECENCY_CAP) return next

  const oldest = ids.reduce((a, b) => (next[a].lastUsedAt <= next[b].lastUsedAt ? a : b))
  const { [oldest]: _dropped, ...kept } = next
  return kept
}

/** Drops entries whose id no longer resolves to a live entity. Returns the
 *  same reference when nothing changed, so callers can skip a write. */
export function pruneFrecency(map: FrecencyMap, liveIds: Set<string>): FrecencyMap {
  const ids = Object.keys(map)
  const survivors = ids.filter((id) => liveIds.has(id))
  if (survivors.length === ids.length) return map
  const next: FrecencyMap = {}
  for (const id of survivors) next[id] = map[id]
  return next
}

/** Never throws: private-mode and quota failures degrade to an empty map. */
export function loadFrecency(wsId: string): FrecencyMap {
  try {
    const raw = localStorage.getItem(storageKey(wsId))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as FrecencyMap
  } catch {
    return {}
  }
}

/** Never throws — frecency is a convenience, not data worth failing over. */
export function saveFrecency(wsId: string, map: FrecencyMap): void {
  try {
    localStorage.setItem(storageKey(wsId), JSON.stringify(map))
  } catch {
    // Quota exceeded or storage disabled: the session keeps its in-memory map.
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npm test -- paletteFrecency`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/palette/paletteFrecency.ts frontend/src/features/palette/paletteFrecency.test.ts
git commit -m "feat(palette): add frecency scoring with decay, cap and pruning"
```

---

### Task 5: Ghost-text completion

**Files:**
- Create: `frontend/src/features/palette/paletteComplete.ts`, `frontend/src/features/palette/paletteComplete.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `computeCompletion(query: string, candidate: string | undefined): string` — returns the **suffix only** (never the whole word), or `''` when there is nothing to suggest.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/palette/paletteComplete.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { computeCompletion } from '@/features/palette/paletteComplete'

describe('computeCompletion', () => {
  it('returns the remaining suffix of a prefix match', () => {
    expect(computeCompletion('ag', 'agent-new ')).toBe('ent-new ')
  })

  it('returns nothing when the query is empty', () => {
    expect(computeCompletion('', 'agent-new ')).toBe('')
  })

  it('returns nothing when there is no candidate', () => {
    expect(computeCompletion('ag', undefined)).toBe('')
  })

  it('returns nothing when the candidate is not a prefix match', () => {
    expect(computeCompletion('zz', 'agent-new ')).toBe('')
  })

  it('returns nothing when the query already equals the candidate', () => {
    expect(computeCompletion('agent-new ', 'agent-new ')).toBe('')
  })

  it('matches case-insensitively but preserves the candidate casing', () => {
    expect(computeCompletion('AG', 'agent-new ')).toBe('ent-new ')
  })

  it('completes only the last token, leaving earlier tokens alone', () => {
    expect(computeCompletion('agent-new ac', 'acme/api')).toBe('me/api')
  })

  it('returns nothing when the last token is empty', () => {
    expect(computeCompletion('agent-new ', 'acme/api')).toBe('')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- paletteComplete`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/features/palette/paletteComplete.ts`:

```ts
/**
 * Ghost text for the palette input, Fish-shell style.
 *
 * Returns the *suffix* to render after the caret, never the full candidate —
 * the ghost is a sibling element behind a transparent input, so it must not
 * repeat what the user already typed. Returning a suffix (rather than the
 * whole word) is also what guarantees the ghost can never be submitted: the
 * input's own value is never touched by this function.
 *
 * Completion applies to the last whitespace-delimited token only, so
 * `agent-new ac` completes the project name and leaves the verb intact.
 */
export function computeCompletion(query: string, candidate: string | undefined): string {
  if (!candidate) return ''

  const lastSpace = query.lastIndexOf(' ')
  const token = lastSpace === -1 ? query : query.slice(lastSpace + 1)
  if (!token) return ''

  const lowerToken = token.toLowerCase()
  const lowerCandidate = candidate.toLowerCase()
  if (!lowerCandidate.startsWith(lowerToken)) return ''
  if (lowerCandidate === lowerToken) return ''

  return candidate.slice(token.length)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npm test -- paletteComplete`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/palette/paletteComplete.ts frontend/src/features/palette/paletteComplete.test.ts
git commit -m "feat(palette): add ghost-text completion"
```

---

### Task 6: Open-tabs provider

**Files:**
- Create: `frontend/src/features/palette/providers/openTabs.ts`, `frontend/src/features/palette/providers/openTabs.test.ts`

**Interfaces:**
- Consumes: `WorkspaceTileLayout`, `TileNode`, `TileTab` from `@/features/tabs/tileTree`; `PaletteItem` from `@/features/palette/paletteTypes`.
- Produces:
  - `TabLabel = { title: string; subtitle?: string }`
  - `ResolveTabLabel = (tab: TileTab) => TabLabel`
  - `openTabItems(layout: WorkspaceTileLayout, resolve: ResolveTabLabel, focus: (leafId: string, tabId: string) => void): PaletteItem[]`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/palette/providers/openTabs.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { openTabItems } from '@/features/palette/providers/openTabs'
import type { TileTab, WorkspaceTileLayout } from '@/features/tabs/tileTree'

const resolve = (tab: TileTab) => ({ title: tab.id, subtitle: tab.kind })

function layout(): WorkspaceTileLayout {
  return {
    version: 1,
    focusedLeafId: 'leaf-a',
    root: {
      type: 'split',
      id: 'split-1',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        {
          type: 'leaf',
          id: 'leaf-a',
          activeTabId: 'agents',
          tabs: [
            { kind: 'agents', id: 'agents' },
            { kind: 'browser', id: 'br-1' },
          ],
        },
        {
          type: 'leaf',
          id: 'leaf-b',
          activeTabId: 'ssh-c1',
          tabs: [{ kind: 'ssh-shell', id: 'ssh-c1', connectionId: 'c1' }],
        },
      ],
    },
  }
}

describe('openTabItems', () => {
  it('walks every leaf in the tree', () => {
    const items = openTabItems(layout(), resolve, () => {})
    expect(items.map((i) => i.title)).toEqual(['agents', 'br-1', 'ssh-c1'])
  })

  it('puts every item in the open group with kind open-tab', () => {
    const items = openTabItems(layout(), resolve, () => {})
    expect(items.every((i) => i.group === 'open' && i.kind === 'open-tab')).toBe(true)
  })

  it('marks the active tab of each leaf', () => {
    const items = openTabItems(layout(), resolve, () => {})
    expect(items.find((i) => i.title === 'agents')?.subtitle).toContain('active')
    expect(items.find((i) => i.title === 'br-1')?.subtitle).not.toContain('active')
  })

  it('gives each item an id namespaced by leaf so the same tab in two leaves is distinct', () => {
    const items = openTabItems(layout(), resolve, () => {})
    expect(items.map((i) => i.id)).toEqual(['open:leaf-a:agents', 'open:leaf-a:br-1', 'open:leaf-b:ssh-c1'])
  })

  it('focuses the owning leaf and tab when run', () => {
    const focus = vi.fn()
    const items = openTabItems(layout(), resolve, focus)
    items[2].run?.({ wsId: 'ws1', leafId: 'leaf-a', showToast: () => {}, close: () => {} })
    expect(focus).toHaveBeenCalledWith('leaf-b', 'ssh-c1')
  })

  it('returns an empty list for a layout with no tabs', () => {
    const empty: WorkspaceTileLayout = {
      version: 1,
      focusedLeafId: 'l',
      root: { type: 'leaf', id: 'l', tabs: [], activeTabId: '' },
    }
    expect(openTabItems(empty, resolve, () => {})).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- openTabs`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/features/palette/providers/openTabs.ts`:

```ts
import type { TileNode, TileTab, WorkspaceTileLayout } from '@/features/tabs/tileTree'
import type { PaletteItem } from '@/features/palette/paletteTypes'

export interface TabLabel {
  title: string
  subtitle?: string
}

export type ResolveTabLabel = (tab: TileTab) => TabLabel

/**
 * Every tab currently open anywhere in the layout, in tree order.
 *
 * Ids are namespaced by leaf (`open:<leafId>:<tabId>`) because the same
 * worktree can legitimately be open in two leaves at once, and the palette's
 * selection model requires unique ids.
 *
 * Running an item focuses the leaf that owns it rather than opening anything
 * — that is the "window switcher" half of the palette.
 */
export function openTabItems(
  layout: WorkspaceTileLayout,
  resolve: ResolveTabLabel,
  focus: (leafId: string, tabId: string) => void,
): PaletteItem[] {
  const items: PaletteItem[] = []

  function walk(node: TileNode) {
    if (node.type === 'leaf') {
      for (const tab of node.tabs) {
        const label = resolve(tab)
        const isActive = tab.id === node.activeTabId
        const parts = [label.subtitle, isActive ? 'active' : undefined].filter(Boolean)
        items.push({
          id: `open:${node.id}:${tab.id}`,
          kind: 'open-tab',
          group: 'open',
          title: label.title,
          subtitle: parts.length > 0 ? parts.join(' · ') : undefined,
          keywords: [tab.kind],
          run: () => focus(node.id, tab.id),
        })
      }
      return
    }
    node.children.forEach(walk)
  }

  walk(layout.root)
  return items
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npm test -- openTabs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/palette/providers/openTabs.ts frontend/src/features/palette/providers/openTabs.test.ts
git commit -m "feat(palette): add open-tabs provider"
```

---

### Task 7: Entities provider

**Files:**
- Create: `frontend/src/features/palette/providers/entities.ts`, `frontend/src/features/palette/providers/entities.test.ts`

**Interfaces:**
- Consumes: `PaletteItem` from `@/features/palette/paletteTypes`.
- Produces:
  - `EntitySources` — a plain input bag (below), so the provider stays pure and testable without React.
  - `entityItems(sources: EntitySources, actions: EntityActions): PaletteItem[]`
  - `APP_PAGES` — the route list.

Read `frontend/src/store/types.ts` before writing this. `EntitySources` below is **not** a literal subset of the real domain types — it's a small adapted shape, and two of its fields do not exist verbatim on the domain objects:
- The real `Worktree` (`types.ts:16`) has no `name` and no `projectId` — a worktree only carries `branch` etc.; its project association exists solely via nesting inside `Project.worktrees`. Task 12, which builds `EntitySources` from live data, derives both: `projects.flatMap(p => p.worktrees.map(w => ({ id: w.id, projectId: p.id, branch: w.branch, name: w.branch })))`.
- The real `SSHConnection` (`types.ts:173`) names its field `username`, not `user`. Task 12 derives it: `sshConnections.map(c => ({ ...c, user: c.username }))`.

`Project` and `Machine` are used as-is — `id`, `name`, `machineId` on `Project` and `id`, `name` on `Machine` all exist verbatim.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/palette/providers/entities.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { APP_PAGES, entityItems } from '@/features/palette/providers/entities'
import type { EntityActions, EntitySources } from '@/features/palette/providers/entities'

const actions: EntityActions = {
  openWorktree: vi.fn(),
  openProject: vi.fn(),
  openSSH: vi.fn(),
  openMachine: vi.fn(),
  openPage: vi.fn(),
}

function sources(overrides: Partial<EntitySources> = {}): EntitySources {
  return {
    wsId: 'ws1',
    worktrees: [{ id: 'wt1', projectId: 'p1', branch: 'feat/palette', name: 'feat/palette' }],
    projects: [{ id: 'p1', name: 'acme/api', machineId: 'm1' }],
    sshConnections: [{ id: 'c1', name: 'prod-db', host: '10.1.1.4', user: 'root' }],
    machines: [{ id: 'm1', name: 'mac-studio' }],
    offlineMachineIds: new Set<string>(),
    ...overrides,
  }
}

describe('entityItems', () => {
  it('emits one item per worktree, project, ssh host, machine and page', () => {
    const items = entityItems(sources(), actions)
    const counts = items.reduce<Record<string, number>>((acc, i) => {
      acc[i.kind] = (acc[i.kind] ?? 0) + 1
      return acc
    }, {})
    expect(counts.worktree).toBe(1)
    expect(counts.project).toBe(1)
    expect(counts['ssh-host']).toBe(1)
    expect(counts.machine).toBe(1)
    expect(counts.page).toBe(APP_PAGES.length)
  })

  it('puts everything in the results group', () => {
    expect(entityItems(sources(), actions).every((i) => i.group === 'results')).toBe(true)
  })

  it('exposes host and user as keywords so an IP finds the host', () => {
    const host = entityItems(sources(), actions).find((i) => i.kind === 'ssh-host')
    expect(host?.keywords).toContain('10.1.1.4')
    expect(host?.keywords).toContain('root')
  })

  it('disables projects whose machine is offline', () => {
    const items = entityItems(sources({ offlineMachineIds: new Set(['m1']) }), actions)
    const project = items.find((i) => i.kind === 'project')
    expect(project?.disabled?.reason).toContain('offline')
  })

  it('disables the offline machine itself', () => {
    const items = entityItems(sources({ offlineMachineIds: new Set(['m1']) }), actions)
    expect(items.find((i) => i.kind === 'machine')?.disabled).toBeDefined()
  })

  it('leaves projects enabled when the machine is online', () => {
    const items = entityItems(sources(), actions)
    expect(items.find((i) => i.kind === 'project')?.disabled).toBeUndefined()
  })

  it('namespaces ids by kind so a project and a machine sharing an id do not collide', () => {
    const items = entityItems(sources({ projects: [{ id: 'x', name: 'p', machineId: 'x' }], machines: [{ id: 'x', name: 'm' }] }), actions)
    const ids = items.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('returns only pages when every entity list is empty', () => {
    const items = entityItems(
      sources({ worktrees: [], projects: [], sshConnections: [], machines: [] }),
      actions,
    )
    expect(items.every((i) => i.kind === 'page')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- entities`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/features/palette/providers/entities.ts`:

```ts
import { Boxes, Database, FolderGit2, GitBranch, Globe, ListTodo, Network, Newspaper, Receipt, Server, Settings, Wrench } from 'lucide-react'
import type { PaletteItem } from '@/features/palette/paletteTypes'

/** Structural subsets of the domain types — only the fields this provider
 *  reads, so the tests need no full domain fixtures. */
export interface EntitySources {
  wsId: string
  worktrees: { id: string; projectId: string; branch: string; name?: string }[]
  projects: { id: string; name: string; machineId: string }[]
  sshConnections: { id: string; name: string; host: string; user: string }[]
  machines: { id: string; name: string }[]
  offlineMachineIds: Set<string>
}

export interface EntityActions {
  openWorktree: (projectId: string, wtId: string) => void
  openProject: (projectId: string) => void
  openSSH: (connectionId: string) => void
  openMachine: (machineId: string) => void
  openPage: (path: string) => void
}

/**
 * The workspace-scoped routes that exist under `w.$wsId.*` — every one of
 * the spec's page list (Agents, Machines, Database, SSH, Browser, Tools,
 * Issues, Todos, Invoices, News, Management) except **Issues**, which is
 * intentionally excluded: `w.$wsId.p.$projectId.issues.tsx` is nested under
 * a project id, unlike every other entry here, which is a bare `w.$wsId.*`
 * route with no further required params. A project-scoped "jump to Issues"
 * entry would need its own drill-down (pick a project first) and is left
 * for a future pass rather than bolted on here.
 */
export const APP_PAGES = [
  { path: '', label: 'Agents', icon: Boxes },
  { path: 'machines', label: 'Machines', icon: Server },
  { path: 'database', label: 'Database', icon: Database },
  { path: 'ssh', label: 'SSH', icon: Network },
  { path: 'browser', label: 'Browser', icon: Globe },
  { path: 'tools', label: 'Tools', icon: Wrench },
  { path: 'todos', label: 'Todos', icon: ListTodo },
  { path: 'invoices', label: 'Invoices', icon: Receipt },
  { path: 'news', label: 'News', icon: Newspaper },
  { path: 'management', label: 'Management', icon: Settings },
] as const

const OFFLINE = { reason: 'Machine is offline' }

/**
 * Every searchable entity in the active workspace, flattened into rows.
 *
 * Worktrees and projects are workspace-scoped by the caller (it passes the
 * active workspace's lists). Machines and SSH hosts are deliberately global
 * — they are not workspace-scoped in the domain model.
 */
export function entityItems(sources: EntitySources, actions: EntityActions): PaletteItem[] {
  const { offlineMachineIds } = sources
  const projectMachine = new Map(sources.projects.map((p) => [p.id, p.machineId]))
  const items: PaletteItem[] = []

  for (const wt of sources.worktrees) {
    const machineId = projectMachine.get(wt.projectId)
    const project = sources.projects.find((p) => p.id === wt.projectId)
    items.push({
      id: `worktree:${wt.id}`,
      kind: 'worktree',
      group: 'results',
      title: wt.name ?? wt.branch,
      subtitle: project?.name,
      keywords: [wt.branch, project?.name ?? ''].filter(Boolean),
      icon: GitBranch,
      disabled: machineId && offlineMachineIds.has(machineId) ? OFFLINE : undefined,
      run: () => actions.openWorktree(wt.projectId, wt.id),
    })
  }

  for (const project of sources.projects) {
    items.push({
      id: `project:${project.id}`,
      kind: 'project',
      group: 'results',
      title: project.name,
      subtitle: sources.machines.find((m) => m.id === project.machineId)?.name,
      icon: FolderGit2,
      disabled: offlineMachineIds.has(project.machineId) ? OFFLINE : undefined,
      run: () => actions.openProject(project.id),
    })
  }

  for (const connection of sources.sshConnections) {
    items.push({
      id: `ssh:${connection.id}`,
      kind: 'ssh-host',
      group: 'results',
      title: connection.name,
      subtitle: `${connection.user}@${connection.host}`,
      keywords: [connection.host, connection.user],
      icon: Network,
      run: () => actions.openSSH(connection.id),
    })
  }

  for (const machine of sources.machines) {
    items.push({
      id: `machine:${machine.id}`,
      kind: 'machine',
      group: 'results',
      title: machine.name,
      subtitle: offlineMachineIds.has(machine.id) ? 'offline' : 'online',
      icon: Server,
      disabled: offlineMachineIds.has(machine.id) ? OFFLINE : undefined,
      run: () => actions.openMachine(machine.id),
    })
  }

  for (const page of APP_PAGES) {
    items.push({
      id: `page:${page.path || 'index'}`,
      kind: 'page',
      group: 'results',
      title: page.label,
      subtitle: 'page',
      icon: page.icon,
      run: () => actions.openPage(page.path),
    })
  }

  return items
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npm test -- entities`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/palette/providers/entities.ts frontend/src/features/palette/providers/entities.test.ts
git commit -m "feat(palette): add entities provider"
```

---

### Task 8: Bookmarks and raw-URL provider

**Files:**
- Create: `frontend/src/features/palette/providers/bookmarks.ts`, `frontend/src/features/palette/providers/bookmarks.test.ts`

**Interfaces:**
- Consumes: `PaletteItem` from `@/features/palette/paletteTypes`.
- Produces:
  - `looksLikeUrl(query: string): boolean`
  - `normalizeUrl(query: string): string`
  - `bookmarkItems(bookmarks: { id: string; title: string; url: string }[], query: string, openUrl: (url: string) => void): PaletteItem[]`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/palette/providers/bookmarks.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { bookmarkItems, looksLikeUrl, normalizeUrl } from '@/features/palette/providers/bookmarks'

describe('looksLikeUrl', () => {
  it.each(['github.com', 'https://github.com/acme/api', 'localhost:3000', '10.1.1.4:8080', 'sub.domain.co.uk/path'])(
    'accepts %s',
    (input) => expect(looksLikeUrl(input)).toBe(true),
  )

  it.each(['prod', 'feat/palette', 'ssh root@host', 'agent-new acme', '', '   '])(
    'rejects %s',
    (input) => expect(looksLikeUrl(input)).toBe(false),
  )
})

describe('normalizeUrl', () => {
  it('leaves an explicit scheme alone', () => {
    expect(normalizeUrl('https://github.com')).toBe('https://github.com')
  })

  it('prefixes a bare host with https', () => {
    expect(normalizeUrl('github.com')).toBe('https://github.com')
  })

  it('prefixes localhost with http, not https', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000')
  })

  it('prefixes a bare IPv4 with http', () => {
    expect(normalizeUrl('10.1.1.4:8080')).toBe('http://10.1.1.4:8080')
  })
})

describe('bookmarkItems', () => {
  const bookmarks = [{ id: 'b1', title: 'API repo', url: 'https://github.com/acme/api' }]

  it('emits one item per bookmark', () => {
    const items = bookmarkItems(bookmarks, '', () => {})
    expect(items.filter((i) => i.kind === 'bookmark')).toHaveLength(1)
  })

  it('exposes the url as a keyword so typing the domain finds the bookmark', () => {
    const items = bookmarkItems(bookmarks, '', () => {})
    expect(items[0].keywords).toContain('https://github.com/acme/api')
  })

  it('appends an open-url item when the query looks like a url', () => {
    const items = bookmarkItems(bookmarks, 'example.com', () => {})
    const url = items.find((i) => i.kind === 'url')
    expect(url?.title).toBe('https://example.com')
  })

  it('does not append an open-url item for a plain word', () => {
    expect(bookmarkItems(bookmarks, 'prod', () => {}).some((i) => i.kind === 'url')).toBe(false)
  })

  it('opens the normalized url when run', () => {
    const openUrl = vi.fn()
    const items = bookmarkItems([], 'github.com', openUrl)
    items[0].run?.({ wsId: 'ws1', leafId: 'l', showToast: () => {}, close: () => {} })
    expect(openUrl).toHaveBeenCalledWith('https://github.com')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- bookmarks`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/features/palette/providers/bookmarks.ts`:

```ts
import { Globe, Star } from 'lucide-react'
import type { PaletteItem } from '@/features/palette/paletteTypes'

/** host[:port][/path] with at least one dot, or an explicit scheme, or
 *  localhost with a port. Deliberately strict: `feat/palette` and
 *  `ssh root@host` must NOT be mistaken for URLs. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const HOSTLIKE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i
const LOCALHOST = /^localhost(?::\d+)?(?:\/\S*)?$/i
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/\S*)?$/

export function looksLikeUrl(query: string): boolean {
  const trimmed = query.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  return SCHEME.test(trimmed) || HOSTLIKE.test(trimmed) || LOCALHOST.test(trimmed) || IPV4.test(trimmed)
}

/** Local targets get `http://` — a dev server on localhost or a LAN IP
 *  almost never speaks TLS, and an https guess would just fail. */
export function normalizeUrl(query: string): string {
  const trimmed = query.trim()
  if (SCHEME.test(trimmed)) return trimmed
  const scheme = LOCALHOST.test(trimmed) || IPV4.test(trimmed) ? 'http' : 'https'
  return `${scheme}://${trimmed}`
}

export function bookmarkItems(
  bookmarks: { id: string; title: string; url: string }[],
  query: string,
  openUrl: (url: string) => void,
): PaletteItem[] {
  const items: PaletteItem[] = bookmarks.map((bookmark) => ({
    id: `bookmark:${bookmark.id}`,
    kind: 'bookmark',
    group: 'results',
    title: bookmark.title,
    subtitle: bookmark.url,
    keywords: [bookmark.url],
    icon: Star,
    run: () => openUrl(bookmark.url),
  }))

  if (looksLikeUrl(query)) {
    const url = normalizeUrl(query)
    items.push({
      id: `url:${url}`,
      kind: 'url',
      group: 'results',
      title: url,
      subtitle: 'open in a Browser tile',
      icon: Globe,
      run: () => openUrl(url),
    })
  }

  return items
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npm test -- bookmarks`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/palette/providers/bookmarks.ts frontend/src/features/palette/providers/bookmarks.test.ts
git commit -m "feat(palette): add bookmarks and raw-URL provider"
```

---

### Task 9: Command verb registry

**Files:**
- Create: `frontend/src/features/palette/providers/commands.ts`, `frontend/src/features/palette/providers/commands.test.ts`

**Interfaces:**
- Consumes: `parseSSHCommand` from `@/features/ssh/sshCommand`; `PaletteItem` from `@/features/palette/paletteTypes`.
- Produces:
  - `PaletteVerb = { name: string; aliases: string[]; argHint: string }`
  - `PALETTE_VERBS: PaletteVerb[]`
  - `matchVerb(query: string): { verb: PaletteVerb; arg: string } | null` — returns `null` for a bare verb with no argument.
  - `verbHintItems(query: string): PaletteItem[]` — the template hint rows shown while typing a verb name.
  - `sshCommandPreview(arg: string): { summary: string; ignored: string[] } | null`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/palette/providers/commands.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { matchVerb, sshCommandPreview, verbHintItems } from '@/features/palette/providers/commands'

describe('matchVerb', () => {
  it('returns null for a bare verb with no argument', () => {
    expect(matchVerb('ssh')).toBeNull()
  })

  it('returns null for a verb followed only by whitespace', () => {
    expect(matchVerb('ssh   ')).toBeNull()
  })

  it('matches a verb with an argument', () => {
    expect(matchVerb('ssh root@10.1.1.4')).toEqual({
      verb: expect.objectContaining({ name: 'ssh' }),
      arg: 'root@10.1.1.4',
    })
  })

  it('resolves the agents-new alias to agent-new', () => {
    expect(matchVerb('agents-new acme/api')?.verb.name).toBe('agent-new')
  })

  it('resolves the open alias to browser', () => {
    expect(matchVerb('open github.com')?.verb.name).toBe('browser')
  })

  it('returns null for an unknown leading word', () => {
    expect(matchVerb('deploy everything')).toBeNull()
  })

  it('is case-insensitive on the verb but preserves argument casing', () => {
    expect(matchVerb('SSH Root@Host')).toEqual({
      verb: expect.objectContaining({ name: 'ssh' }),
      arg: 'Root@Host',
    })
  })
})

describe('verbHintItems', () => {
  it('offers the ssh template while the verb name is being typed', () => {
    expect(verbHintItems('ss').map((i) => i.title)).toContain('ssh <ssh command | host>')
  })

  it('offers a completion string so ghost text can render', () => {
    expect(verbHintItems('ag')[0].completion).toBe('agent-new ')
  })

  it('offers nothing for an empty query', () => {
    expect(verbHintItems('')).toEqual([])
  })

  it('offers nothing once an argument has been typed', () => {
    expect(verbHintItems('ssh root@host')).toEqual([])
  })

  it('offers nothing for a word matching no verb', () => {
    expect(verbHintItems('zzz')).toEqual([])
  })
})

describe('sshCommandPreview', () => {
  it('summarises target and jump chain', () => {
    const preview = sshCommandPreview('root@10.10.10.5 -J root@10.10.1.1')
    expect(preview?.summary).toContain('root@10.10.10.5:22')
    expect(preview?.summary).toContain('root@10.10.1.1')
  })

  it('reports unknown flags as ignored rather than failing', () => {
    const preview = sshCommandPreview('root@10.10.10.5 -X -Q cipher')
    expect(preview).not.toBeNull()
    expect(preview?.ignored.length).toBeGreaterThan(0)
  })

  it('returns null for an unparseable argument', () => {
    expect(sshCommandPreview('!!!')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- commands`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/features/palette/providers/commands.ts`:

```ts
import { Terminal } from 'lucide-react'
import { parseSSHCommand } from '@/features/ssh/sshCommand'
import type { PaletteItem } from '@/features/palette/paletteTypes'

export interface PaletteVerb {
  name: string
  aliases: string[]
  argHint: string
}

export const PALETTE_VERBS: PaletteVerb[] = [
  { name: 'ssh', aliases: [], argHint: '<ssh command | host>' },
  { name: 'agent-new', aliases: ['agents-new'], argHint: '<project>' },
  { name: 'browser', aliases: ['open'], argHint: '<url>' },
]

function findVerb(word: string): PaletteVerb | undefined {
  const lower = word.toLowerCase()
  return PALETTE_VERBS.find((v) => v.name === lower || v.aliases.includes(lower))
}

/**
 * Splits `query` into a verb and its argument.
 *
 * Returns `null` when there is no argument — a bare `ssh` must stay an
 * ordinary search term, because "SSH" is also a page name and hosts are
 * routinely named `ssh-*`. Only once the user types something after the verb
 * do we take over the input.
 */
export function matchVerb(query: string): { verb: PaletteVerb; arg: string } | null {
  const trimmed = query.trimStart()
  const space = trimmed.indexOf(' ')
  if (space === -1) return null

  const verb = findVerb(trimmed.slice(0, space))
  if (!verb) return null

  const arg = trimmed.slice(space + 1).trim()
  if (!arg) return null

  return { verb, arg }
}

/** Template rows shown while the user is still typing a verb's name, so the
 *  grammar is discoverable without documentation. */
export function verbHintItems(query: string): PaletteItem[] {
  const trimmed = query.trim()
  if (!trimmed || trimmed.includes(' ')) return []

  const lower = trimmed.toLowerCase()
  return PALETTE_VERBS.filter((verb) => verb.name.startsWith(lower) || verb.aliases.some((a) => a.startsWith(lower)))
    .map((verb) => ({
      id: `verb:${verb.name}`,
      kind: 'command' as const,
      group: 'results' as const,
      title: `${verb.name} ${verb.argHint}`,
      subtitle: 'command',
      icon: Terminal,
      completion: `${verb.name} `,
    }))
}

/** Human-readable echo of what `parseSSHCommand` understood, mirroring the
 *  preview line the SSH quick-add form already shows. */
export function sshCommandPreview(arg: string): { summary: string; ignored: string[] } | null {
  const parsed = parseSSHCommand(`ssh ${arg}`)
  if (!parsed) return null

  const target = `${parsed.target.user || '(no user)'}@${parsed.target.host}:${parsed.target.port}`
  const via = parsed.jumps.length > 0 ? ` · via ${parsed.jumps.map((h) => `${h.user}@${h.host}`).join(' → ')}` : ''

  return { summary: `${target}${via}`, ignored: parsed.ignoredFlags }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npm test -- commands`
Expected: PASS, 15 tests.

If `sshCommandPreview('!!!')` does not return `null`, read `parseSSHCommand` in `frontend/src/features/ssh/sshCommand.ts` and align the test with its real contract — that function is the authority, not this test.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/palette/providers/commands.ts frontend/src/features/palette/providers/commands.test.ts
git commit -m "feat(palette): add command verb registry"
```

---

### Task 10: Create-actions provider

**Files:**
- Create: `frontend/src/features/palette/providers/createActions.ts`

**Interfaces:**
- Consumes: `PaletteItem`, `PalettePage` from `@/features/palette/paletteTypes`.
- Produces: `createActionItems(deps: CreateActionDeps): PaletteItem[]` where — like `EntitySources` in Task 7, `sshConnections` here is an adapted shape, not a literal `SSHConnection`: the real type's field is `username`, not `user`. Task 12 derives it the same way it does for Task 7: `sshConnections.map(c => ({ ...c, user: c.username }))`.

```ts
interface CreateActionDeps {
  query: string
  machines: { id: string; name: string }[]
  projects: { id: string; name: string; machineId: string }[]
  sshConnections: { id: string; name: string; host: string; user: string }[]
  offlineMachineIds: Set<string>
  openBrowser: (machineId: string) => void
  openSSHConnection: (connectionId: string) => void
  openSSHQuickAdd: (prefillRaw: string) => void
  openSpawn: (projectId: string) => void
}
```

This task has no test of its own: it is a thin assembly of already-tested pieces, and its behaviour is covered by the `CommandPalette` component test in Task 13. Per the plan's right-sizing rule, it is folded here rather than given a ceremonial test.

- [ ] **Step 1: Write the implementation**

Create `frontend/src/features/palette/providers/createActions.ts`:

```ts
import { Globe, Network, TerminalSquare } from 'lucide-react'
import type { PaletteItem, PalettePage } from '@/features/palette/paletteTypes'

export interface CreateActionDeps {
  query: string
  machines: { id: string; name: string }[]
  projects: { id: string; name: string; machineId: string }[]
  sshConnections: { id: string; name: string; host: string; user: string }[]
  offlineMachineIds: Set<string>
  openBrowser: (machineId: string) => void
  openSSHConnection: (connectionId: string) => void
  openSSHQuickAdd: (prefillRaw: string) => void
  openSpawn: (projectId: string) => void
}

function machinePage(deps: CreateActionDeps): PalettePage {
  return {
    id: 'create-browser',
    breadcrumb: 'New Browser tab',
    placeholder: 'Choose a machine…',
    items: () =>
      deps.machines.map((machine) => ({
        id: `create-browser:${machine.id}`,
        kind: 'machine',
        group: 'results',
        title: machine.name,
        disabled: deps.offlineMachineIds.has(machine.id) ? { reason: 'Machine is offline' } : undefined,
        run: () => deps.openBrowser(machine.id),
      })),
  }
}

function sshPage(deps: CreateActionDeps): PalettePage {
  return {
    id: 'create-ssh',
    breadcrumb: 'New SSH',
    placeholder: 'Search saved hosts, or paste an ssh command…',
    items: () => [
      ...deps.sshConnections.map<PaletteItem>((connection) => ({
        id: `create-ssh:${connection.id}`,
        kind: 'ssh-host',
        group: 'results',
        title: connection.name,
        subtitle: `${connection.user}@${connection.host}`,
        keywords: [connection.host, connection.user],
        icon: Network,
        run: () => deps.openSSHConnection(connection.id),
      })),
      {
        id: 'create-ssh:new',
        kind: 'create',
        group: 'create',
        title: 'New host from ssh command…',
        icon: Network,
        run: () => deps.openSSHQuickAdd(''),
      },
    ],
  }
}

function spawnPage(deps: CreateActionDeps): PalettePage {
  return {
    id: 'create-agent',
    breadcrumb: 'New Agent',
    placeholder: 'Choose a project…',
    items: () =>
      deps.projects.map((project) => ({
        id: `create-agent:${project.id}`,
        kind: 'project',
        group: 'results',
        title: project.name,
        disabled: deps.offlineMachineIds.has(project.machineId) ? { reason: 'Machine is offline' } : undefined,
        run: () => deps.openSpawn(project.id),
      })),
  }
}

/**
 * The always-present Create rows.
 *
 * These are never filtered by the query (see `rankPaletteItems`) — the query
 * is often the *name of the thing being created*, which by definition may
 * collide with something that already exists.
 */
export function createActionItems(deps: CreateActionDeps): PaletteItem[] {
  return [
    {
      id: 'create:browser',
      kind: 'create',
      group: 'create',
      title: 'New Browser tab',
      icon: Globe,
      drillInto: () => machinePage(deps),
    },
    {
      id: 'create:ssh',
      kind: 'create',
      group: 'create',
      title: 'New SSH…',
      icon: Network,
      drillInto: () => sshPage(deps),
    },
    {
      id: 'create:agent',
      kind: 'create',
      group: 'create',
      title: 'New Agent…',
      icon: TerminalSquare,
      drillInto: () => spawnPage(deps),
    },
  ]
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/palette/providers/createActions.ts
git commit -m "feat(palette): add create-actions provider with drill-down pages"
```

---

### Task 11: Store slice — SERIALIZED, convergence files

**This task edits `store/useDevDeckStore.ts`. Per `CLAUDE.md` it MUST run alone — never in parallel with another task.**

**Files:**
- Modify: `frontend/src/store/useDevDeckStore.ts:52` (the `NewTabState` interface), `:178-185`, `:210`, `:303`, `:306`, `:465`, `:579-582`, `:584-590`

**Interfaces:**
- Consumes: nothing.
- Produces on the store:
  - `palette: { open: boolean; wsId: string | null; leafId: string | null }`
  - `sshQuickAdd: { open: boolean; wsId: string | null; leafId: string | null; prefillRaw: string }`
  - `openPalette: (wsId: string, leafId: string) => void`
  - `closePalette: () => void`
  - `openSSHQuickAdd: (wsId: string, leafId: string, prefillRaw: string) => void`
  - `closeSSHQuickAdd: () => void`
  - `openBrowserTab: (wsId: string, machineId?: string, url?: string) => void` — widened from its current `(wsId, machineId?)`. The palette's `browser`/`open` verb (Task 9) and bookmark rows (Task 8) both need to open a Browser tile already navigated to a resolved URL, and the existing action has no way to do that: it is `void`-returning (no way to learn the new tab/doc id to patch afterward) and takes no URL. The extra `url` param threads straight into `createBrowserDoc`/`createBrowserTileState` instead.

Neither slice is added to `partialize` (`useDevDeckStore.ts:873`) — transient dialog state must not persist, matching how `newTab` behaves today.

- [ ] **Step 1: Replace the state interface**

At `useDevDeckStore.ts:52`, replace the `NewTabState` interface with:

```ts
/** Which leaf the palette will act on. Not persisted — see `partialize`. */
interface PaletteState {
  open: boolean
  wsId: string | null
  leafId: string | null
}

/** The SSH quick-add form, reached from the palette's Create group or from a
 *  typed `ssh …` command that needs credentials the palette cannot supply.
 *  `prefillRaw` seeds the ssh-command field. */
interface SSHQuickAddState {
  open: boolean
  wsId: string | null
  leafId: string | null
  prefillRaw: string
}
```

- [ ] **Step 2: Replace the state fields and action signatures**

At `:210`, replace `newTab: NewTabState` with:

```ts
  palette: PaletteState
  sshQuickAdd: SSHQuickAddState
```

At `:303`, replace the `setNewTab` signature and its neighbouring `openNewTab` / `closeNewTab` declarations with:

```ts
  openPalette: (wsId: string, leafId: string) => void
  closePalette: () => void
  openSSHQuickAdd: (wsId: string, leafId: string, prefillRaw: string) => void
  closeSSHQuickAdd: () => void
```

- [ ] **Step 3: Replace the initial state**

At `:465`, replace the `newTab: { ... }` initialiser with:

```ts
      palette: { open: false, wsId: null, leafId: null },
      sshQuickAdd: { open: false, wsId: null, leafId: null, prefillRaw: '' },
```

- [ ] **Step 4: Replace the actions**

At `:579-582`, replace `openNewTab` / `closeNewTab` / `setNewTab` with:

```ts
      openPalette: (wsId, leafId) => set((s) => void (s.palette = { open: true, wsId, leafId })),
      closePalette: () => set((s) => void (s.palette.open = false)),
      openSSHQuickAdd: (wsId, leafId, prefillRaw) =>
        set((s) => void (s.sshQuickAdd = { open: true, wsId, leafId, prefillRaw })),
      closeSSHQuickAdd: () => set((s) => void (s.sshQuickAdd.open = false)),
```

- [ ] **Step 5: Thread an optional URL through `openBrowserTab`**

At `:178-185`, give the two doc/tile constructors an optional initial `url` (default `null`, same as today):

```ts
function createBrowserDoc(id: string, machineId: string | null = null, url: string | null = null): BrowserDocState {
  return { id, machineId, proxy: null, url, title: 'New Tab', loading: false, history: [], historyIndex: -1 }
}

function createBrowserTileState(machineId: string | null = null, url: string | null = null): BrowserTileState {
  const docId = generateDocId()
  return { fullscreen: false, activeDocId: docId, docs: [createBrowserDoc(docId, machineId, url)] }
}
```

At `:306`, widen the action signature:

```ts
  openBrowserTab: (wsId: string, machineId?: string, url?: string) => void
```

At `:584-590`, thread it through the implementation:

```ts
      openBrowserTab: (wsId, machineId, url) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId] ?? createDefaultTileLayout()
          const tab = createBrowserTab()
          s.workspaceTileLayouts[wsId] = openTileTab(layout, tab)
          s.browserTiles[tab.id] = createBrowserTileState(machineId ?? null, url ?? null)
        }),
```

The one existing caller (`WorkspaceTileArea.tsx`'s `handleCreateBrowser`) keeps compiling unchanged — `url` is optional and it never passes a third argument.

- [ ] **Step 6: Verify the typecheck fails loudly at every old call site**

Run: `cd frontend && npm run typecheck`
Expected: FAIL, listing errors in `features/tabs/NewTabDialog.tsx` and `features/tabs/WorkspaceTileArea.tsx`. This is the intended signal — those are fixed in Tasks 14 and 15. Record the exact error list; it is the checklist for those tasks.

- [ ] **Step 7: Commit the store change on its own**

The tree does not typecheck at this commit. That is deliberate: the store change is isolated so a reviewer can read it without the call-site churn mixed in, and Tasks 14–15 restore green.

```bash
git add frontend/src/store/useDevDeckStore.ts
git commit -m "refactor(store): replace newTab state with palette/sshQuickAdd slices and thread a URL through openBrowserTab"
```

---

### Task 12: The palette hook

**Files:**
- Create: `frontend/src/features/palette/useCommandPalette.ts`, `frontend/src/features/palette/useCommandPalette.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–10, plus `useDevDeckStore`.
- Produces:
  - `PaletteItemSources` (fields below) and `assemblePaletteItems(sources: PaletteItemSources): PaletteItem[]` — pure, exported specifically so the empty-query invariant (spec Decision 5) is unit-testable without mounting the hook.
  - `useCommandPalette(args: { wsId: string; leafId: string; open: boolean }): CommandPaletteModel` where

```ts
interface CommandPaletteModel {
  query: string
  setQuery: (q: string) => void
  groups: RankedGroup[]
  rows: RankedItem[]
  selectedIndex: number
  setSelectedIndex: (i: number) => void
  ghost: string
  breadcrumbs: string[]
  placeholder: string
  sshPreview: { summary: string; ignored: string[] } | null
  moveSelection: (delta: number) => void
  acceptCompletion: () => boolean
  drillIn: () => boolean
  drillOut: () => boolean
  run: (modifiers?: { forceForm?: boolean }) => void
}
```

The hook itself wires already-tested pieces together and its behaviour is exercised through the component test in Task 13, but `assemblePaletteItems` is small and pure enough to earn its own failing-test-first step, same as Tasks 2–9.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/palette/useCommandPalette.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { assemblePaletteItems } from '@/features/palette/useCommandPalette'
import { rankPaletteItems } from '@/features/palette/paletteRank'
import type { PaletteItem } from '@/features/palette/paletteTypes'

function item(partial: Partial<PaletteItem> & Pick<PaletteItem, 'id' | 'title' | 'group'>): PaletteItem {
  return { kind: 'worktree', ...partial }
}

describe('assemblePaletteItems', () => {
  it('shows only open tabs, recent and create for an empty query', () => {
    const items = assemblePaletteItems({
      query: '',
      openTabs: [item({ id: 'open:leaf-a:agents', title: 'agents', group: 'open', kind: 'open-tab' })],
      entities: [item({ id: 'worktree:wt1', title: 'feat/palette', group: 'results' })],
      bookmarks: [item({ id: 'bookmark:b1', title: 'API repo', group: 'results', kind: 'bookmark' })],
      verbHints: [item({ id: 'verb:ssh', title: 'ssh <host>', group: 'results', kind: 'command' })],
      createActions: [item({ id: 'create:ssh', title: 'New SSH…', group: 'create', kind: 'create' })],
      recent: [item({ id: 'worktree:wt2', title: 'main', group: 'recent' })],
    })
    const groups = rankPaletteItems(items, '', () => 0).map((g) => g.group)
    expect(groups).toEqual(['open', 'recent', 'create'])
  })

  it('includes entities, bookmarks and verb hints once the query is non-empty', () => {
    const items = assemblePaletteItems({
      query: 'feat',
      openTabs: [],
      entities: [item({ id: 'worktree:wt1', title: 'feat/palette', group: 'results' })],
      bookmarks: [],
      verbHints: [],
      createActions: [item({ id: 'create:ssh', title: 'New SSH…', group: 'create', kind: 'create' })],
      recent: [],
    })
    const groups = rankPaletteItems(items, 'feat', () => 0).map((g) => g.group)
    expect(groups).toEqual(['results', 'create'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- useCommandPalette`
Expected: FAIL — cannot resolve `assemblePaletteItems` from `@/features/palette/useCommandPalette`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/features/palette/useCommandPalette.ts`. It must:

1. Export the pure item-assembly function first, independently of the hook:

```ts
export interface PaletteItemSources {
  query: string
  openTabs: PaletteItem[]
  entities: PaletteItem[]
  bookmarks: PaletteItem[]
  verbHints: PaletteItem[]
  createActions: PaletteItem[]
  recent: PaletteItem[]
}

/**
 * Combines every provider's rows into the flat list `rankPaletteItems`
 * groups and filters. On an **empty** query, `entities`, `bookmarks` and
 * `verbHints` are omitted entirely (not merely out-scored) — per spec
 * Decision 5, an empty query shows only Open tabs → Recent → Create;
 * feeding every worktree/project/host/machine/page in unconditionally
 * would flood the Results group the instant the palette opens.
 */
export function assemblePaletteItems(sources: PaletteItemSources): PaletteItem[] {
  const { query, openTabs, entities, bookmarks, verbHints, createActions, recent } = sources
  if (query.trim() === '') return [...openTabs, ...recent, ...createActions]
  return [...openTabs, ...recent, ...entities, ...bookmarks, ...verbHints, ...createActions]
}
```

2. Hold `const [pages, setPages] = useState<PalettePage[]>([])` — the drill-down stack. The root page is implicit (empty stack).
3. Hold `query` and derive `deferredQuery` with `useDeferredValue`, matching `FileQuickOpen`.
4. Adapt live data into the shapes the providers expect before building items — `EntitySources`/`CreateActionDeps` are **not** literal domain-type subsets (see Task 7 and Task 10): `sshConnections.map(c => ({ ...c, user: c.username }))`, and `projects.flatMap(p => p.worktrees.map(w => ({ id: w.id, projectId: p.id, branch: w.branch, name: w.branch })))` for worktrees.
5. Build the `EntityActions` passed to `entityItems(...)` so that `openWorktree(projectId, wtId)` calls the store's `openWorktreeTab(wsId, projectId, wtId)` and `openSSH(connectionId)` calls `openSSHShellTab(wsId, connectionId)` directly — **do not** add separate "is this already open, focus it instead" logic here. Both store actions already delegate to `tileTree.ts`'s `openTileTab`, whose documented behaviour is: if the tab already exists anywhere in the layout, focus its leaf and make it active there instead of duplicating it. That is exactly the spec's "Duplicate open" edge case, already satisfied for worktrees and SSH shells with no extra code. Build `openBrowser(machineId)` (used by the Create ▸ New Browser tab picker, Task 10) to call the Task-11-extended `openBrowserTab(wsId, machineId)` with no `url`; build the bookmark/raw-URL `openUrl` callback (Task 8) and the `browser`/`open` verb (point 7 below) to call `openBrowserTab(wsId, defaultMachineId, url)` with the resolved URL instead.
6. Build items with `useMemo` keyed on `[deferredQuery, pages, ...sources]`:
   - When `pages.length > 0`, use `pages[pages.length - 1].items(deferredQuery, ctx)`.
   - Otherwise compute `openTabItems(...)`, `entityItems(...)`, `bookmarkItems(...)`, `verbHintItems(deferredQuery)`, `createActionItems(...)`, and recent items (built by mapping frecency ids back onto entity items with `group: 'recent'`, only for ids not already in the `open` group), then combine them with `assemblePaletteItems` from point 1 — not a flat concatenation, so the empty-query invariant holds.
7. When `matchVerb(deferredQuery)` returns non-null, **replace** the item list with that verb's rows:
   - `ssh` → one row titled `Connect & save "<derived name>"` whose `run` executes `buildSSHQuickAddPlan` (mirroring `NewTabDialog.runPlan`); set `sshPreview` from `sshCommandPreview(arg)`. If `isSSHQuickAddValid` is false, the row's `run` calls `openSSHQuickAdd(wsId, leafId, arg)` instead.
   - `agent-new` → the project list filtered by `arg`, each running `openSpawn(project.id)`.
   - `browser` → one row running `openBrowserTab(wsId, defaultMachineId, normalizeUrl(arg))` (the Task-11-extended action) with the default machine — the first registered machine, same default `NewTabDialog` uses today.
8. Build `isOpen(id)` by walking the current layout once: for every `worktree` tab add `worktree:${tab.wtId}`, for every `ssh-shell` tab add `ssh:${tab.connectionId}` to a `Set<string>` (these are exactly the ids `entityItems` assigns), then `isOpen = (id) => openEntityIds.has(id)`. Call `rankPaletteItems(items, deferredQuery, (id) => frecencyScore(frecencyRef.current, id, Date.now()), isOpen)` and expose `groups` plus `rows = flattenRanked(groups)`.
9. Reset `selectedIndex` to `0` whenever `deferredQuery` or `pages` changes, and clamp it to `rows.length - 1`.
10. Compute `ghost = computeCompletion(query, rows[selectedIndex]?.completion ?? rows[selectedIndex]?.title)`.
11. `moveSelection(delta)` wraps around `rows.length`.
12. `acceptCompletion()` returns `false` when `ghost` is empty; otherwise appends `ghost` to `query` and returns `true`.
13. `drillIn()` returns `false` unless the selected row has `drillInto`; otherwise pushes the page, clears `query`, returns `true`.
14. `drillOut()` returns `false` when `pages` is empty; otherwise pops and returns `true`.
15. `run({ forceForm })` refuses a `disabled` row by calling `showToast(row.disabled.reason)`; otherwise records frecency (`recordUse` + `saveFrecency`), calls `row.run(ctx)`, and closes the palette. `forceForm` routes an `ssh` row to `openSSHQuickAdd` regardless of validity.
16. On open, prune frecency against the live id set and persist the result.

**Critical:** the stale-`wsId` guard from `NewTabDialog.tsx:166-173` must be reproduced around the awaited SSH create chain. Before calling the open callback or closing, re-read `useDevDeckStore.getState().palette.wsId` and compare it against the `wsId` captured when `run` was invoked. If they differ, keep the created connection but do not navigate or close. Copy the existing explanatory comment across.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npm test -- useCommandPalette`
Expected: PASS, 2 tests.

- [ ] **Step 5: Verify it typechecks**

Run: `cd frontend && npm run typecheck`
Expected: still FAIL, but only with the Task 11 call-site errors in `NewTabDialog.tsx` and `WorkspaceTileArea.tsx`. No new errors inside `features/palette/`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/palette/useCommandPalette.ts frontend/src/features/palette/useCommandPalette.test.ts
git commit -m "feat(palette): add the page-stack hook"
```

---

### Task 13: The palette view and keyboard contract

**Files:**
- Create: `frontend/src/features/palette/CommandPalette.tsx`, `frontend/src/features/palette/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: `useCommandPalette`, `useNativeOverlayBlocker` from `@/features/browser/useNativeOverlayBlocker`.
- Produces: `<CommandPalette wsId={string} leafId={string} />`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/palette/CommandPalette.test.tsx`. Mock `useCommandPalette` so the test asserts the **keyboard contract** — which callback each key fires — rather than re-testing ranking:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from '@/features/palette/CommandPalette'

const model = {
  query: '',
  setQuery: vi.fn(),
  groups: [{ group: 'results' as const, label: 'Results', items: [{ id: 'a', kind: 'worktree' as const, group: 'results' as const, title: 'alpha', score: 0, ranges: [] }], truncated: 0 }],
  rows: [{ id: 'a', kind: 'worktree' as const, group: 'results' as const, title: 'alpha', score: 0, ranges: [] }],
  selectedIndex: 0,
  setSelectedIndex: vi.fn(),
  ghost: '',
  breadcrumbs: [],
  placeholder: 'Search or create…',
  sshPreview: null,
  moveSelection: vi.fn(),
  acceptCompletion: vi.fn(() => false),
  drillIn: vi.fn(() => false),
  drillOut: vi.fn(() => false),
  run: vi.fn(),
}

vi.mock('@/features/palette/useCommandPalette', () => ({
  useCommandPalette: () => model,
}))

const closePalette = vi.fn()
vi.mock('@/store/useDevDeckStore', () => ({
  useDevDeckStore: (selector: (s: unknown) => unknown) =>
    selector({ palette: { open: true, wsId: 'ws1', leafId: 'leaf-a' }, closePalette, showToast: vi.fn() }),
}))

vi.mock('@/features/browser/useNativeOverlayBlocker', () => ({ useNativeOverlayBlocker: () => {} }))

describe('CommandPalette keyboard contract', () => {
  beforeEach(() => vi.clearAllMocks())

  it('focuses the input on open', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    expect(await screen.findByRole('combobox')).toHaveFocus()
  })

  it('ArrowDown moves the selection forward', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{ArrowDown}')
    expect(model.moveSelection).toHaveBeenCalledWith(1)
  })

  it('ArrowUp moves the selection backward', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{ArrowUp}')
    expect(model.moveSelection).toHaveBeenCalledWith(-1)
  })

  it('Ctrl+N and Ctrl+P move the selection', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Control>}n{/Control}')
    expect(model.moveSelection).toHaveBeenCalledWith(1)
    await userEvent.keyboard('{Control>}p{/Control}')
    expect(model.moveSelection).toHaveBeenCalledWith(-1)
  })

  it('Enter runs the selected row', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Enter}')
    expect(model.run).toHaveBeenCalledWith({ forceForm: false })
  })

  it('Shift+Enter forces the form', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    expect(model.run).toHaveBeenCalledWith({ forceForm: true })
  })

  it('Tab accepts the completion before attempting to drill in', async () => {
    model.acceptCompletion.mockReturnValueOnce(true)
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Tab}')
    expect(model.acceptCompletion).toHaveBeenCalled()
    expect(model.drillIn).not.toHaveBeenCalled()
  })

  it('Tab drills in when there is no completion to accept', async () => {
    model.acceptCompletion.mockReturnValueOnce(false)
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Tab}')
    expect(model.drillIn).toHaveBeenCalled()
  })

  it('Escape pops a page when one is open', async () => {
    model.drillOut.mockReturnValueOnce(true)
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Escape}')
    expect(closePalette).not.toHaveBeenCalled()
  })

  it('Escape closes the palette at the root', async () => {
    model.drillOut.mockReturnValueOnce(false)
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    await userEvent.keyboard('{Escape}')
    expect(closePalette).toHaveBeenCalled()
  })

  it('never submits the ghost text as part of the value', async () => {
    render(<CommandPalette wsId="ws1" leafId="leaf-a" />)
    expect(await screen.findByRole('combobox')).toHaveValue('')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- CommandPalette`
Expected: FAIL — cannot resolve `@/features/palette/CommandPalette`.

- [ ] **Step 3: Write the component**

Create `frontend/src/features/palette/CommandPalette.tsx`. Requirements:

- Renders nothing when `palette.open` is false.
- Calls `useNativeOverlayBlocker(open)` so it paints above native Browser-tile webviews — the same call `FileQuickOpen` makes.
- The input carries `role="combobox"`, `aria-expanded`, `aria-controls` and `aria-activedescendant` pointing at the selected row's id. Rows carry `role="option"`.
- Ghost text renders as a `<span aria-hidden="true">` absolutely positioned behind the transparent `<input>`, showing `query + ghost`. **The input's `value` is `query` only.**
- Group headers render the group label and, when `truncated > 0`, a `+N more` suffix.
- Disabled rows render at reduced opacity with their `disabled.reason` as the subtitle.
- `sshPreview` renders below the input: the summary in `text-devdeck-accent`, and when `ignored.length > 0`, `· ignored: <flags>` in the amber token.
- Empty state: when `rows.length === 0`, render "No matches" — unreachable in practice because the Create group is never filtered, but required by the project's explicit-empty-state rule.
- One `onKeyDown` on the input implements the contract table exactly:

```tsx
function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
  const ctrl = event.ctrlKey && !event.metaKey && !event.altKey
  if (event.key === 'ArrowDown' || (ctrl && event.key.toLowerCase() === 'n')) {
    event.preventDefault()
    model.moveSelection(1)
    return
  }
  if (event.key === 'ArrowUp' || (ctrl && event.key.toLowerCase() === 'p')) {
    // preventDefault also stops Ctrl+P reaching the global FileQuickOpen binding.
    event.preventDefault()
    model.moveSelection(-1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    model.run({ forceForm: event.shiftKey })
    return
  }
  if (event.key === 'Tab' || event.key === 'ArrowRight') {
    if (event.key === 'ArrowRight' && event.currentTarget.selectionStart !== model.query.length) return
    event.preventDefault()
    if (model.acceptCompletion()) return
    model.drillIn()
    return
  }
  if (event.key === 'Backspace' && model.query === '') {
    if (model.drillOut()) event.preventDefault()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    if (!model.drillOut()) closePalette()
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npm test -- CommandPalette`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/palette/CommandPalette.tsx frontend/src/features/palette/CommandPalette.test.tsx
git commit -m "feat(palette): add the palette view and keyboard contract"
```

---

### Task 14: Wire the palette into the workspace

**Files:**
- Modify: `frontend/src/features/tabs/WorkspaceTileArea.tsx:196-241` and `:285-292`
- Modify: `frontend/src/features/terminal/Terminal.tsx:80-82,164`
- Modify: `frontend/src/features/ssh/sshTerminalRegistry.ts:69`

**Interfaces:**
- Consumes: `openPalette` / `closePalette` from Task 11, `<CommandPalette>` from Task 13.
- Produces: `isAppShortcut(event: KeyboardEvent): boolean` exported from `@/features/terminal/Terminal`.

- [ ] **Step 1: Generalise the xterm escape hatch**

In `frontend/src/features/terminal/Terminal.tsx`, replace `isQuickOpenShortcut` (lines 80-82) with:

```ts
/** Chords the app claims globally, which xterm must therefore not swallow:
 *  Cmd/Ctrl+P (file quick-open) and Cmd/Ctrl+K (command palette). Returning
 *  `false` from `attachCustomKeyEventHandler` lets the event bubble to the
 *  window listeners that implement them. */
export function isAppShortcut(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false
  const key = event.key.toLowerCase()
  return key === 'p' || key === 'k'
}
```

Update the call site at line 164 to `term.attachCustomKeyEventHandler((event) => !isAppShortcut(event))`, and the identical call in `frontend/src/features/ssh/sshTerminalRegistry.ts:69`, adjusting its import.

- [ ] **Step 2: Add the Cmd+K branch**

In `WorkspaceTileArea.tsx`, inside the existing `handleKeydown` (after the `primary` guard and the leaf lookup), add before the `[1-4]` branch:

```ts
      if (key === 'k' && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        openPalette(wsId, leaf.id)
        return
      }
```

Then change the existing `t`/`o` branch body from `handleNewTab(leaf.id)` to `openPalette(wsId, leaf.id)`, keeping its context condition exactly as it is.

- [ ] **Step 3: Render the palette**

Replace the `<NewTabDialog … />` element at `:285-292` with:

```tsx
      <CommandPalette wsId={wsId} leafId={layout.focusedLeafId} />
      <SSHQuickAddDialog />
```

Add the imports, and delete the now-unused `NewTabDialog` import and any handler that becomes orphaned (`handleNewTab` stays — the tab strip's `+` button still calls it, and it now calls `openPalette` too).

- [ ] **Step 4: Verify**

Run: `cd frontend && npm run typecheck && npm test`
Expected: typecheck still FAILS on `NewTabDialog.tsx` only (fixed in Task 15). All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/tabs/WorkspaceTileArea.tsx frontend/src/features/terminal/Terminal.tsx frontend/src/features/ssh/sshTerminalRegistry.ts
git commit -m "feat(palette): bind Cmd+K and route Cmd+T/Cmd+O to the palette"
```

---

### Task 15: Narrow `NewTabDialog` into `SSHQuickAddDialog`

**Files:**
- Create: `frontend/src/features/ssh/SSHQuickAddDialog.tsx`
- Delete: `frontend/src/features/tabs/NewTabDialog.tsx`

**Interfaces:**
- Consumes: `sshQuickAdd` state and `closeSSHQuickAdd` from Task 11.
- Produces: `<SSHQuickAddDialog />` — no props; it reads its own state from the store.

- [ ] **Step 1: Create the narrowed dialog**

```bash
git mv frontend/src/features/tabs/NewTabDialog.tsx frontend/src/features/ssh/SSHQuickAddDialog.tsx
```

Then edit it down. **Delete:** the `KindTab` component and the kind-tab row, the `Globe`/`TerminalSquare` imports, the machine `<Select>`, the `shellProjects`/`shellProject` derivation, the `onCreateBrowser`/`onCreateShell` props, the `NewTabDialogProps` interface, the host `<Select>` and the `NEW_SSH_HOST` sentinel (the palette now owns host selection, so this dialog is always in quick-add mode), and the two `useEffect`s that defaulted `machineId` and `sshConnectionId`.

**Keep, unchanged:** `runPlan`, `handleRawChange`, the parsed-preview paragraph, the executor `<Select>`, `SSHAuthFields`, and the `busy` gating.

**Keep verbatim, including its comment**, the stale-`wsId` guard:

```ts
      const submittedWsId = wsId
      try {
        const connectionId = await runPlan(buildSSHQuickAddPlan(parsed, draft, connections))
        showToast(`Added SSH connection "${draft.name.trim()}"`)
        if (useDevDeckStore.getState().sshQuickAdd.wsId === submittedWsId) {
          closeSSHQuickAdd()
          onCreateSSH(connectionId)
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to add SSH connection')
      }
```

Seed the draft from `sshQuickAdd.prefillRaw` when the dialog opens, by calling `handleRawChange(prefillRaw)` in the existing open-effect so the name and identity file are derived exactly as if the user had typed it.

Autofocus the ssh-command `<Input>` on open and submit on `Enter`, so the dialog stays keyboard-only.

- [ ] **Step 2: Verify the whole tree is green again**

Run: `cd frontend && npm run typecheck && npm test && npm run build`
Expected: all three PASS. This is the first commit since Task 11 where the tree typechecks.

- [ ] **Step 3: Commit**

```bash
git add -A frontend/src/features/ssh/SSHQuickAddDialog.tsx frontend/src/features/tabs/
git commit -m "refactor(ssh): narrow NewTabDialog into SSHQuickAddDialog"
```

---

### Task 16: Final verification and documentation

**Files:**
- Modify: `ARCHITECTURE.md`, `TUTORIAL.md`

- [ ] **Step 1: Run every gate**

```bash
cd frontend && npm run typecheck && npm test && npm run build
cd .. && make test
```

Expected: all PASS. Paste the real output into the completion report — do not summarise it.

- [ ] **Step 2: Confirm the performance budget by measurement, not assertion**

With the dev server running, open the palette in a workspace that has at least 50 entities and record in the completion report:
- React DevTools Profiler commit duration for the palette open (budget: ≤ 16 ms).
- The Network tab request count while opening the palette (budget: **0**).

If either budget is missed, report the number — do not adjust the budget.

- [ ] **Step 3: Update the docs**

In `ARCHITECTURE.md`, add `features/palette/` to the feature list with a one-line description. In `TUTORIAL.md`, replace any description of the `Cmd+T` new-tab dialog with the palette, documenting the keyboard contract table.

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md TUTORIAL.md
git commit -m "docs: document the command palette"
```

## Self-Review

**Spec coverage.** Every spec section maps to a task: search scope → Tasks 6-8; Create-always-last → Tasks 3, 10; hybrid drill-down → Tasks 10, 12, 15; keybindings → Task 14; empty-query groups → Task 12; ranking → Task 3; verb grammar → Task 9; ghost autocomplete → Tasks 5, 13; error handling → Tasks 4 (storage), 7 (offline), 12 (stale `wsId`, deleted entity), 15 (partial chain); testing table → Tasks 2-9, 13; performance budget → Tasks 3 (caps), 12 (`useDeferredValue`), 16 (measurement).

**One spec item is deliberately unimplemented as written:** the spec's "tests pass unchanged" claim is amended at the top of this plan, because no test runner existed.

**Placeholder scan.** No TBD/TODO. Tasks 10, 12 and 13 describe implementations in prose rather than complete code because they are assembly layers whose exact JSX depends on files the implementer will have open; each one names every function it must call and every invariant it must preserve, and each is gated by a concrete test or typecheck run.

**Type consistency.** `PaletteItem`, `PalettePage`, `PaletteRunContext`, `RankedItem` and `RankedGroup` are defined once in Task 3 and referenced unchanged afterwards. `computeHighlight` (Task 2), `computeCompletion` (Task 5), `matchVerb` / `sshCommandPreview` (Task 9), `frecencyScore` / `recordUse` / `pruneFrecency` (Task 4) keep the same signatures at every call site. Store actions `openPalette` / `closePalette` / `openSSHQuickAdd` / `closeSSHQuickAdd` are declared in Task 11 and used with those exact names in Tasks 13-15.

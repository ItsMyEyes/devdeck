# Palette: find agents by path, project name, and machine name

**Date:** 2026-08-03
**Scope:** Command palette only (`frontend/src/features/palette/**`). The Agents
page filter (`WorkspaceHostsView.tsx`) is explicitly **out of scope**.

## Problem

In the Cmd+K palette, agent-related rows can only be found by project name.

| Site | Today | Gap |
|---|---|---|
| `providers/createActions.ts` `spawnPage` — "New Agent…" drill-down | `title: project.name`, no `subtitle`, no `keywords` | path + machine neither searchable nor visible; same-named projects on different machines are indistinguishable |
| `useCommandPalette.ts` `agent-new <arg>` verb | `project.name.toLowerCase().includes(needle)` | name only |
| `providers/entities.ts` worktree rows | `keywords: [branch, projectName]` | no path, no machine |
| `providers/entities.ts` project rows | machine name in `subtitle` | `subtitle` is never matched — ranking reads `title` + `keywords` only |

### Prerequisite defect: the verb grammar is dead

`rankPaletteItems` is called with the **full** query (`"agent-new mabes"`), but
verb rows are titled with the entity name (`"superapps_mabes"`). Nothing matches.
Verified empirically against `rankPaletteItems` — all three verbs return zero rows:

```
"agent-new mabes"      -> []
"ssh root@host"        -> []
"browser example.com"  -> []
```

Only the three Create rows survive, because `group: 'create'` bypasses filtering
entirely. `agent-new` cannot be "made searchable by path" until it renders at all,
so this fix is a prerequisite, not scope creep.

## Decisions

**D1 — Paths match on substring only.** `paletteRank.ts`'s `fuzzyMatches` falls
back to subsequence matching. A path like `~/Documents/freelance/mabes/superapps/core`
is long enough that nearly any query subsequence-matches it, so adding paths as
ordinary `keywords` would make every project match every query. Paths therefore get
a separate match channel with the subsequence fallback disabled. Machine names stay
fuzzy — they are short, so subsequence matching there is useful, not noisy.

**D2 — Machine name falls back to `'local'`** when `machineId` is empty
(`Project.machineId` empty means local/unassigned). This matches what
`resolveTabLabel` in `useCommandPalette.ts` already does.

**D3 — Worktree rows show `project · machine`, not the path.** The palette row's
subtitle is narrow and truncates its *tail*, and the path is already displayed on
the project row. The full path stays searchable on worktree rows regardless.

**D4 — Displayed paths are head-elided** (`…/superapps/core`) because the row
truncates the tail, which is the part that actually disambiguates. The **full**
path is what gets matched.

## Design

### 1. `paletteTypes.ts` — a substring-only match channel

Add to `PaletteItem`:

```ts
  /** Matched like `keywords`, but with the subsequence fallback disabled —
   *  for long haystacks (filesystem paths) where a subsequence match is
   *  near-universal and would make every row match every query. */
  literalKeywords?: string[]
```

### 2. `paletteRank.ts` — honour it

Split the existing matcher, keeping current behaviour for `title`/`keywords`:

```ts
function substringMatches(haystack: string, query: string): boolean {
  const trimmed = query.trim()
  if (trimmed === '') return true
  return haystack.toLowerCase().includes(trimmed.toLowerCase())
}

function fuzzyMatches(haystack: string, query: string): boolean {
  const trimmed = query.trim()
  if (trimmed === '') return true
  if (substringMatches(haystack, trimmed)) return true
  // ... existing subsequence walk, unchanged ...
}
```

In `scoreOne`, replace the single `haystacks.some(...)` guard with:

```ts
  const fuzzyHay = [item.title, ...(item.keywords ?? [])]
  const literalHay = item.literalKeywords ?? []
  const matched =
    fuzzyHay.some((hay) => fuzzyMatches(hay, query)) ||
    literalHay.some((hay) => substringMatches(hay, query))
  if (!matched) return null
```

Everything else in `scoreOne` (highlight ranges, prefix bonus, open bonus,
frecency, length tiebreak) is unchanged. `literalKeywords` never contributes
highlight ranges — ranges are computed against `title` only, as today.

### 3. `providers/projectFacets.ts` — new shared module

One purpose: turn a project + the machine list into the display and match facets
that every agent-related row needs.

```ts
export interface ProjectFacetSource {
  name: string
  path: string
  machineId: string
}

export interface ProjectFacets {
  machineName: string
  /** `home-laptop · …/superapps/core` — machine first, because the row
   *  truncates its subtitle's tail. */
  subtitle: string
  /** Fuzzy-matched. Short values only. */
  keywords: string[]
  /** Substring-matched (see D1). The full, un-elided path. */
  literalKeywords: string[]
}

export function projectFacets(
  project: ProjectFacetSource,
  machines: { id: string; name: string }[],
): ProjectFacets
```

Behaviour:

- `machineName` = `machines.find((m) => m.id === project.machineId)?.name ?? 'local'`.
  An empty `machineId` also yields `'local'`.
- `elidePath(path)`: split on `/`, drop empty segments. If 2 or fewer segments
  remain, return the path unchanged. Otherwise return `…/` + the last two
  segments joined by `/`. An empty path returns `''`.
  - `~/Documents/freelance/mabes/superapps/core` → `…/superapps/core`
  - `~/Documents/deps` → `…/Documents/deps`
  - `/srv` → `/srv`
- `subtitle` = `` `${machineName} · ${elidePath(path)}` `` when `path` is
  non-empty, otherwise just `machineName`.
- `keywords` = `[machineName]`.
- `literalKeywords` = `[path]` when `path` is non-empty, otherwise `[]`.

`elidePath` stays private to this module — it has no other consumer (YAGNI).

### 4. `providers/createActions.ts`

- `CreateActionDeps.projects` gains `path: string`.
- Extract the row builder shared by the drill-down page and the `agent-new` verb:

```ts
/** The project rows behind both "New Agent…" (the drill-down page) and the
 *  `agent-new <arg>` verb. `idPrefix` keeps the two surfaces' row ids — and
 *  therefore their frecency entries and `aria-activedescendant` targets —
 *  distinct. */
export function agentProjectRows(deps: CreateActionDeps, idPrefix: string): PaletteItem[] {
  return deps.projects.map((project) => {
    const facets = projectFacets(project, deps.machines)
    return {
      id: `${idPrefix}:${project.id}`,
      kind: 'project',
      group: 'results',
      title: project.name,
      subtitle: facets.subtitle,
      keywords: facets.keywords,
      literalKeywords: facets.literalKeywords,
      icon: PROJECT_ICON,
      disabled: deps.offlineMachineIds.has(project.machineId) ? { reason: 'Machine is offline' } : undefined,
      run: () => deps.openSpawn(project.id),
    }
  })
}
```

- `spawnPage`'s `items` becomes `() => agentProjectRows(deps, 'create-agent')`.
  Its `id` (`'create-agent'`), `breadcrumb` and `placeholder` are unchanged, so
  existing row ids (`create-agent:<projectId>`) are preserved.

### 5. `providers/entities.ts`

- `EntitySources.projects` gains `path: string`.
- **Project rows**: `subtitle`, `keywords`, `literalKeywords` all come from
  `projectFacets`. This replaces the current inline `machines.find(...)` subtitle.
- **Worktree rows** (D3): resolve the owning project's facets, then
  - `subtitle` = `` `${project.name} · ${facets.machineName}` `` when the project
    resolves, otherwise leave it `undefined` as today;
  - `keywords` = `[wt.branch, project?.name, facets.machineName].filter(Boolean)`;
  - `literalKeywords` = the owning project's `literalKeywords`.
- SSH, machine and page rows are untouched.

### 6. `useCommandPalette.ts`

- `paletteProjects` maps `path: project.path` through (alongside `id`, `name`,
  `machineId`).
- **Rank against the verb's argument.** Export a pure helper so it is testable
  without rendering the hook (the existing tests only exercise exported pure
  functions such as `assemblePaletteItems`):

```ts
/**
 * The string rows are filtered and scored against.
 *
 * When a verb has taken over the input, its rows are titled with the *entity*
 * name (`superapps_mabes`), not the typed text (`agent-new mabes`) — scoring
 * against the full query matches nothing and the verb renders empty. A
 * drill-down page keeps the raw query, because its own input is already
 * reset when the page is pushed.
 */
export function paletteRankQuery(deferredQuery: string, verbArg: string | null, hasActivePage: boolean): string {
  if (hasActivePage) return deferredQuery
  return verbArg ?? deferredQuery
}
```

  and call it at the `rankPaletteItems` site:

```ts
  const rankQuery = paletteRankQuery(deferredQuery, verbMatch?.arg ?? null, activePage !== null)
  const groups = useMemo(
    () => rankPaletteItems(items, rankQuery, frecencyFor, isEntityOpen),
    [items, rankQuery, frecencyFor, isEntityOpen],
  )
```

  This is safe because whenever `verbItems` is active, `items` is only
  `[...verbItems, ...createActions]`, and Create rows bypass filtering anyway.
  It also fixes highlight ranges, which are computed from the same query.

- **`keywords: [arg]` on the synthesized `ssh` and `browser` rows.** Ranking
  against the argument repairs `agent-new` and `browser`, but only the simplest
  `ssh` case — found during review, after the rest of section 6 had landed.
  Unlike `agent-new`, those two verbs emit a *single row that is the typed
  command*, so matching it against that command must be a tautology, and the
  title cannot deliver that: `deriveSSHQuickAddName` names the row after the
  target alone (`root@host`), so `ssh root@host -J bastion` scores
  `root@host -J bastion` against `Connect & save "root@host"` — no substring,
  and the subsequence walk dies at the space after `root@host`. The row would
  vanish exactly when the command is most worth confirming. Verified failing
  cases: `root@host -J bastion` and `-i ~/.ssh/id_rsa root@host`. Giving each
  row its own argument as a keyword makes the match unconditional.

- The `agent-new` branch of `verbItems` becomes
  `return agentProjectRows(createDeps, 'command:agent-new')` — the manual
  `.filter((project) => project.name.toLowerCase().includes(needle))` is deleted,
  because `rankPaletteItems` now filters these rows correctly using every facet.
  Update the `useMemo` dependency array accordingly (`createDeps` replaces
  `paletteProjects` / `offlineMachineIds` / `openSpawn` for this branch), and drop
  any import left unused (e.g. `PROJECT_ICON`).

## Testing

TDD — write the failing test first for each unit, then implement.

- `paletteRank.test.ts`
  - a `literalKeywords` value matches on substring
  - a `literalKeywords` value does **not** match on subsequence (the D1 guarantee)
  - `title` / `keywords` subsequence behaviour is unchanged
- `providers/projectFacets.test.ts`
  - unknown / empty `machineId` → `'local'`
  - path elision for >2, ==2 and empty segment counts
  - `literalKeywords` carries the full, un-elided path
- `providers/createActions.test.ts`
  - `agentProjectRows` emits path + machine facets and honours `idPrefix`
  - `spawnPage` still yields `create-agent:<projectId>` ids and offline disabling
- `providers/entities.test.ts`
  - project rows and worktree rows both carry machine + path facets
- `useCommandPalette.test.ts`
  - `paletteRankQuery` returns the verb arg, the raw query inside a page, and the
    raw query with no verb
  - regression: `agentProjectRows(...)` piped through `rankPaletteItems` with a
    verb arg yields rows at all — and matches by **path fragment** and by
    **machine name**, not just project name
  - a synthesized command row with no `keywords` is filtered out once its
    argument carries a flag, and survives once the argument is its own keyword.
    This pins the `rankPaletteItems` contract that `keywords: [arg]` relies on;
    it does **not** cover the hook's wiring, because this file never renders the
    hook. The rows are reconstructed in the hook's shape instead.

## Verification

Run from `frontend/`:

```
npm run typecheck
npx vitest run
npm run build
```

Baseline before this work: 419 tests passing across 46 files.

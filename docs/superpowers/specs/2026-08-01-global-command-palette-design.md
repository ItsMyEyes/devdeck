# Global Command Palette

**Date:** 2026-08-01
**Status:** Approved for implementation
**Scope:** Frontend only. No backend, no API, no domain-model changes.

## Problem

Opening anything in DevDeck starts with `Cmd/Ctrl+T` (or `Cmd/Ctrl+O` inside a
worktree terminal) which opens `NewTabDialog` — a 403-line dialog whose first
control is a three-way kind switcher (Browser / Spawn shell / SSH), followed by
a chain of `<Select>` dropdowns. Every path through it is built around pointing
and clicking. An operator who knows exactly what they want ("the prod-db SSH
host", "the feat/browser-fix worktree") still has to choose a category first,
then hunt for the item in a dropdown.

The keybinding itself is split-brain: `Cmd+T` opens the chooser everywhere
except inside a visible worktree terminal, where `Cmd+O` does instead — because
`ExpandedTerminal` and `SSHShellPane` already claim `Cmd+T` for "new terminal
pane". There is no single key that always means "get me somewhere".

## Goals

1. One key that always opens one surface: search first, choose a category only
   when search cannot answer.
2. Every routine action reachable without touching the mouse.
3. Typing a literal command (`ssh root@10.10.10.5 -J root@10.10.1.1`,
   `agent-new acme/api`) is a first-class input, not a fallback.
4. The palette itself must never become a new source of jank.

## Non-goals

- File search and file-content search. `FileQuickOpen` (`Cmd+P`) and
  `ContentSearchPanel` already own those and stay untouched.
- Cross-workspace search. Worktrees and projects resolve within the active
  `wsId`; machines and SSH hosts are global because they genuinely are not
  workspace-scoped.
- The app-wide performance pass (tile-canvas memoization, xterm throughput,
  overlay latency, bundle size). That is a separate spec, to be brainstormed
  after this ships, driven by profiling rather than guesswork. Only a
  palette-local performance budget is in scope here.

## Decisions

These were settled during brainstorming; they are recorded here as decisions,
not options.

| # | Decision | Rationale |
|---|---|---|
| 1 | Search covers open tabs, entities (worktrees, projects, SSH hosts, machines, app pages), bookmarks, and raw URLs | All of it is already in the zustand store or a warm react-query cache, so the palette needs no new endpoint and no network call on open |
| 2 | The `Create` group is **always** present and **always** last | A zero-results-only Create is a dead end: with a saved host named `prod`, the query `prod` would make "create a new host called prod" unreachable |
| 3 | Hybrid drill-down: list pickers live in the palette, genuine multi-field forms open a dialog | Reuses the SSH quick-add form and its existing tests instead of reimplementing credential handling in a palette layout |
| 4 | `Cmd/Ctrl+K` opens the palette everywhere; `Cmd+T` / `Cmd+O` keep their current context rules but now open the palette too | One unambiguous key, without breaking existing muscle memory |
| 5 | Empty query shows `Open tabs` → `Recent` → `Create` | Focusing an already-open tab and resuming recent work are the two most common intents |
| 6 | Verb grammar (`ssh`, `agent-new`, `browser`) with ghost-text autocomplete | Delegates to parsers that already exist and are already tested |

## Architecture

New directory `frontend/src/features/palette/`. Files are deliberately small
and mostly pure so each can be tested in isolation — the opposite of the
403-line dialog being replaced.

| File | Responsibility | Pure |
|---|---|---|
| `paletteTypes.ts` | `PaletteItem`, `PaletteGroup`, `PalettePage`, `PaletteRunContext`, `PaletteVerb` | types only |
| `paletteRank.ts` | fuzzy match, scoring, group ordering | yes |
| `paletteFrecency.ts` | MRU/frecency persistence, decay, pruning | yes + storage adapter |
| `paletteComplete.ts` | ghost-text completion from (query, candidates) | yes |
| `providers/openTabs.ts` | enumerate `TileTab`s from the layout tree | yes |
| `providers/entities.ts` | worktrees, projects, SSH hosts, machines, app pages | yes |
| `providers/bookmarks.ts` | saved bookmarks plus raw-URL detection | yes |
| `providers/commands.ts` | verb registry, verb-vs-search arbitration | yes |
| `providers/createActions.ts` | the three Create rows and their drill-in targets | yes |
| `useCommandPalette.ts` | page-stack state machine, query, selection | hook |
| `CommandPalette.tsx` | overlay, input, ghost text, list, key handling | view |

`computeHighlight` moves from `features/terminal/fileMatchHighlight.ts` to
`@/lib/fuzzyHighlight.ts` and is shared with `FileQuickOpen`, so both surfaces
highlight matches identically instead of drifting apart.

### Core contracts

```ts
interface PaletteItem {
  id: string                     // stable and unique across providers
  kind: 'open-tab' | 'worktree' | 'ssh-host' | 'project'
      | 'machine' | 'page' | 'bookmark' | 'url' | 'create' | 'command'
  title: string                  // the text that gets fuzzy-matched
  subtitle?: string              // right-aligned meta ("leaf 2", "root@10.1.1.4")
  keywords?: string[]            // host, IP, project name — also matched
  group: 'open' | 'recent' | 'results' | 'create'
  disabled?: { reason: string }  // e.g. offline machine
  completion?: string            // ghost text when this item is selected
  run?: (ctx: PaletteRunContext) => void | Promise<void>
  drillInto?: () => PalettePage
}

interface PalettePage {
  id: string
  breadcrumb: string             // "New SSH"
  placeholder: string
  items: (query: string, ctx: PaletteRunContext) => PaletteItem[]
}

interface PaletteRunContext {
  wsId: string
  leafId: string                 // the focused leaf — actions target it
  store: DevDeckStoreApi
  navigate: NavigateFn
}
```

The palette holds a **stack** of `PalettePage`. The root page searches
everything; drill-in pushes; `Backspace` on an empty input or `Esc` pops.

### Ranking

`paletteRank.ts` exposes one pure function. Rules, in order:

1. Groups always render in a fixed order: `Open tabs` → `Recent` → `Results` → `Create`.
2. `Create` is always present and always last.
3. When every other group is empty, the first `Create` row becomes the selected row.
4. Within `Results`: exact-prefix match > currently-open > frecency > fuzzy score.
5. Frecency is `hits × recencyWeight(lastUsedAt)`, stored per workspace, capped
   at 100 entries, with unresolvable ids pruned on read.

### Command grammar

The verb registry is data, so adding a verb is adding one entry rather than
extending a conditional:

```ts
interface PaletteVerb {
  name: string
  aliases: string[]
  argHint: string                                     // "<project>"
  parse: (arg: string, ctx: PaletteRunContext) => PaletteItem[]
}
```

| Verb | Aliases | Argument | Behaviour |
|---|---|---|---|
| `ssh` | — | ssh command or host name | delegates to `parseSSHCommand`; builds the create chain with `buildSSHQuickAddPlan` |
| `agent-new` | `agents-new` | project | calls `openSpawn(projectId)` |
| `browser` | `open` | url | opens a Browser tile on the default machine |

A Browser tile requires a machine. `browser <url>` uses the same default
`NewTabDialog` uses today — the first registered machine — and the `Create ›
New Browser tab` row drills into a machine picker for any other choice.

`providers/entities.ts` surfaces exactly the workspace-scoped routes that exist
today: Agents, Machines, Database, SSH, Browser, Tools, Issues, Todos,
Invoices, News, Management.

**Verb-vs-search arbitration:** a verb only activates when a non-empty argument
follows it. A bare `ssh` still performs a normal search (the SSH page, hosts
named `ssh-*`) and additionally shows one hint row offering the template. This
keeps `ssh` usable as an ordinary search term.

**SSH execution path.** When `isSSHQuickAddValid` returns true and credentials
resolve without further input (an identity file), `Enter` creates and opens
directly with no dialog. When the command needs input the palette cannot
supply (a password), `Enter` opens `SSHQuickAddDialog` prefilled. `Shift+Enter`
always forces the form first. Unrecognised flags (`-X`, `-Q`) are reported as
ignored and do not fail the command — matching `NewTabDialog`'s current
behaviour.

### Autocomplete

Ghost text renders as a positioned `<span>` behind a transparent `<input>`.
The palette input is monospace, so no text measurement is required. `Tab` and
`→` accept the completion. Ghost text is never part of the input's value, so it
can never be submitted by `Enter` — this is asserted by a test.

## Keyboard contract

This table is the source of truth and the basis for the keyboard tests.

| Key | Action |
|---|---|
| `Cmd/Ctrl+K` | open the palette — everywhere, no exceptions |
| `Cmd/Ctrl+T` / `Cmd/Ctrl+O` | open the palette, preserving the existing context rules |
| `↑` `↓` / `Ctrl+P` `Ctrl+N` | move selection, skipping group headers |

| `Tab` / `→` | accept ghost completion; with no ghost, drill into the selected item |
| `Enter` | run the selected item |
| `Shift+Enter` | force the form first (for an otherwise-valid `ssh …`) |
| `Backspace` on empty input | pop one page |
| `Esc` | pop a page; at the root, close |

While the palette is open it handles `Ctrl+P` / `Ctrl+N` itself and calls
`preventDefault()`, so neither reaches the global `FileQuickOpen` binding.

`Cmd+K` is currently unbound anywhere in the app, and neither `Terminal.tsx`
nor `sshTerminalRegistry.ts` binds a clear-screen shortcut, so nothing is lost
inside a terminal. Both files already route around xterm via
`attachCustomKeyEventHandler((event) => !isQuickOpenShortcut(event))`.
`isQuickOpenShortcut` is generalised to `isAppShortcut`, covering `Cmd+P` and
`Cmd+K`, and both call sites adopt it.

## Changes to existing code

- **`features/tabs/WorkspaceTileArea.tsx:196–241`** — add a `Cmd+K` branch;
  `Cmd+T` / `Cmd+O` now call `openPalette(leafId)` instead of
  `handleNewTab(leafId)`. The existing context rules are unchanged.
- **`features/tabs/NewTabDialog.tsx` → `features/ssh/SSHQuickAddDialog.tsx`** —
  narrowed to the SSH quick-add form alone. Machine, saved-host and project
  selection now live in the palette as drill-downs, so the kind tabs, the
  machine `<Select>` and the `shellProject` logic are all deleted. Roughly
  403 → 190 lines.
- **`store/types.ts` + `store/useDevDeckStore.ts`** — `newTab: NewTabState` is
  replaced by `palette: { open, leafId }` and
  `sshQuickAdd: { open, wsId, leafId, prefillRaw }`. Both are convergence files
  per `CLAUDE.md`, so this must be a single serialized step, never done from
  parallel agents.
- **`features/terminal/fileMatchHighlight.ts` → `lib/fuzzyHighlight.ts`** —
  moved and shared with `FileQuickOpen`.
- **`features/terminal/Terminal.tsx` + `features/ssh/sshTerminalRegistry.ts`** —
  `isQuickOpenShortcut` generalised to `isAppShortcut`.

## Error handling and edge cases

- **Partial SSH create chain.** Hops created before a failure stay saved on
  purpose — a retry reuse-matches them rather than duplicating them. A toast
  reports the failure and the palette stays open with the input intact.
- **Stale `wsId` after an await.** `NewTabDialog.tsx:166–173` guards against the
  user changing workspace while a create chain is in flight, by re-reading the
  live store before firing the open/close callbacks. This guard must be carried
  into the new path verbatim — it is a previously-fixed bug and must not be
  reintroduced.
- **Offline machine or project.** The row renders disabled with an `(offline)`
  suffix; `Enter` raises a toast rather than failing silently.
- **Entity deleted between render and `Enter`.** `run()` re-resolves the target
  from the live store; if it is gone, a toast is shown and the list refreshes.
- **`localStorage` unavailable or full.** Frecency degrades to in-memory for the
  session. It must not throw.
- **Duplicate open.** Selecting an entity that is already open in another leaf
  moves focus to that leaf instead of creating a second tab.

## Testing

Test-driven: every unit below is written test-first. All are vitest unit tests
over pure functions except where noted.

| Test file | What it locks down |
|---|---|
| `paletteRank.test.ts` | group order; Create always last; all-groups-empty selects Create; exact-prefix wins over fuzzy |
| `paletteFrecency.test.ts` | decay; 100-entry cap; pruning unresolvable ids; no-localStorage fallback |
| `paletteComplete.test.ts` | ghost text derivation; ghost is never submitted by `Enter` |
| `providers/commands.test.ts` | bare verb stays a search; aliases resolve; `-X -Q` reported as ignored, not fatal; verb needs a non-empty argument |
| `providers/openTabs.test.ts` | tree → items; leaf labels; active-tab marking |
| `providers/entities.test.ts` | workspace scoping; offline items disabled |
| `CommandPalette.test.tsx` | keyboard contract table, page push/pop (component test) |

`features/ssh/sshCommand.test.ts` and `features/ssh/sshQuickAdd.test.ts` are
**not** modified. That they still pass unchanged is the evidence that the SSH
path is genuine reuse rather than a parallel reimplementation.

Verification gates: `npm run typecheck`, `npm test`, `npm run build`.

## Performance budget

Palette-local and binding; the app-wide pass is a separate spec.

- Open in ≤ 16 ms (one frame).
- Filter in ≤ 8 ms for 500 items.
- **Zero network requests on open.** Every provider reads the warm react-query
  cache and the zustand store.
- Rendering is capped at 8 rows per group with a `+N more` affordance, 50 rows
  total — which removes any need for virtualization.
- `useDeferredValue` on the query, following the existing `FileQuickOpen`
  pattern.

## Open risks

- Narrowing `NewTabDialog` touches the SSH quick-add path that shipped
  recently. The existing SSH tests are the guard rail; they must pass unchanged.
- The store change is a convergence-file edit and must not be parallelised.

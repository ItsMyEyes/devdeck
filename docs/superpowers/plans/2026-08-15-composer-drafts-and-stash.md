# Plan — Composer Drafts & Prompt Stash

Spec: `docs/superpowers/specs/2026-08-15-composer-drafts-and-stash-design.md`
(subsystem **E**). Follows `2026-08-14-composer-shell-tiptap-editor.md`, which
shipped the shell (**G**) this plan hangs state off — that plan is also the
format model for this one.

Execution: TDD throughout. Every task's tests are written and shown to fail
(red) before the implementation that makes them pass (green).

Frontend only. **No Go file is touched by any task in this plan** — spec's own
"Where this sits" table: E needs no backend.

## A verified trap, up front

`vite.config.ts`'s `test.include` (`vite.config.ts:71-171`) is an **allow-list**,
not a glob over `**/*.test.ts`. Live-probed in this session, not assumed: a test
file whose path is not in that array produces

```
No test files found, exiting with code 1
```

for `npx vitest run <exact path>` — not a vacuous pass, a hard failure, and
identical whether invoked via `npm test -- <path>` or directly. This is stronger
than the spec's own framing ("silently never runs" under a bare `npm test`); an
*individual* task trying to verify its own new test file before the array is
updated cannot do so at all.

**Consequence for task order:** the array is pre-populated with every new test
path this plan will create, in **one task, first**, before any file at those
paths exists. A path with no file behind it yet matches nothing and is silently
skipped by Vitest's glob resolution (same reason `vite.config.ts:71-171`'s
existing entries tolerate being added ahead of migration) — so this is safe, and
it means every other task in this plan gets a real, working `npm test -- <path>`
from the moment its own test file lands. No task after the first ever edits
`vite.config.ts` again.

## Convergence files (CLAUDE.md)

Of the six files CLAUDE.md names as convergence files
(`frontend/src/routeTree.gen.ts`, `frontend/src/store/useDevDeckStore.ts`,
`frontend/src/store/types.ts`, `backend/internal/domain/models.go`,
`backend/cmd/server/main.go`, `backend/internal/port/store.go`), this plan
touches exactly **one**: `frontend/src/store/useDevDeckStore.ts`, in **Task 6**
only. No other task in this plan reads-and-writes that file, and no parallel
agent working on any other subsystem may edit it while Task 6 is in flight.
`store/types.ts` is untouched on purpose — `ComposerDraft` and
`PromptStashEntry` are feature-local UI types, not domain types mirrored from
`backend/internal/domain/models.go` (spec §7: `'draft'` is a socket status, not
a thread status; nothing here is a backend concept).

`vite.config.ts` is not one of the six named files, but this plan gives it the
same discipline for a mechanical reason proven above: it is a single shared
array every new-test-file task would otherwise need to append to. One task
(Task 1) owns it, once, first.

## Dependency shape

```
T1 register test paths (vite.config.ts) — solo, first, blocks every other task's `npm test`
        │
        ├──────────────┬──────────────┬──────────────┬──────────────┐
        ▼              ▼              ▼              ▼              ▼
   T2 composerDrafts T3 promptStash T4 popover ctrl T5 connect gate T7 stash badge
        │  (pure)        │ (pure)      (tab-strip)   (socket+header)  (presentational)
        │                │
        └───────┬────────┘
                ▼
         T6 store slice (CONVERGENCE — useDevDeckStore.ts, solo within this wave)
                │                                    T8 stash menu ◀── T3
                │                                         │
                ├─────────────────────────┬───────────────┘
                ▼                         ▼
         T11 queries.ts            T9 ChatComposer.tsx  ◀── T4, T7, T8
        (clearComposerDraft)              │
                                           ▼
                                  T10 AgentChatPane.tsx  ◀── T5, T9
```

Waves (everything in a wave is safe to dispatch in parallel; a wave only
starts once every task it depends on has landed):

- **Wave 0:** T1 alone.
- **Wave 1** (parallel): T2, T3, T4, T5, T7 — five tasks, zero file overlap,
  none reads another's output.
- **Wave 2** (parallel): T6 (needs T2 + T3), T8 (needs T3 only). Different
  files (`useDevDeckStore.ts` vs `ComposerStashMenu.tsx`), safe together.
- **Wave 3** (parallel): T9 (needs T4, T6, T7, T8), T11 (needs T6 only).
  Different files (`ChatComposer.tsx`/`.test.tsx` vs `queries.ts`).
- **Wave 4:** T10 alone (needs T5 and T9).

## File ownership

No file appears twice.

| Task | Writes |
|---|---|
| T1 | `vite.config.ts` |
| T2 | `features/agent-chat/composerDrafts.ts`, `composerDrafts.test.ts` |
| T3 | `features/agent-chat/promptStash.ts`, `promptStash.test.ts` |
| T4 | `components/ui/tab-strip-popover-menu.tsx`, `tab-strip-popover-menu.test.tsx` |
| T5 | `features/agent-chat/useAgentChatSocket.ts`, `useAgentChatSocket.test.ts`, `features/agent-chat/ChatHeader.tsx` |
| T6 | `store/useDevDeckStore.ts` **(convergence — this task only, see above)** |
| T7 | `features/agent-chat/ComposerStashBadge.tsx`, `ComposerStashBadge.test.tsx` |
| T8 | `features/agent-chat/ComposerStashMenu.tsx`, `ComposerStashMenu.test.tsx` |
| T9 | `features/agent-chat/ChatComposer.tsx`, `ChatComposer.test.tsx` |
| T10 | `features/agent-chat/AgentChatPane.tsx`, `AgentChatPane.test.tsx` |
| T11 | `features/data/queries.ts`, `features/data/queries.deleteAgentThread.test.ts` |

All paths are relative to `frontend/src/` unless already qualified.

**Untouched, and must stay green as regression guards** (spec's "Regression"
list, corrected — see Task 9's note): `ComposerControls.test.tsx`,
`ComposerPromptEditor.test.tsx`, `composerSerialize.test.ts`,
`composerMention.test.ts`, `composerNodes.test.ts`, `MessagesTimeline.test.tsx`,
`eventReducer.test.ts`, `timeline.test.ts`, `adapter.test.ts`,
`SessionsPanel.test.tsx`, `PanelHeader.test.tsx` (uncontrolled consumer of
`TabStripPopoverMenu`, `PanelHeader.test.tsx` per `vite.config.ts`'s existing
allow-list). Also untouched: every Go file; `ComposerPromptEditor.tsx`,
`composerSerialize.ts`, `composerMention.ts`, `composerNodes.ts`,
`ComposerChip.tsx` (G's editor stack); `ComposerControls.tsx`; `paneTree.ts`;
`store/types.ts`; `routeTree.gen.ts`.

**Spec-vs-plan correction, stated once here:** the spec's own "Regression —
must stay green, unmodified" list (design doc, Testing section) includes
`ChatComposer.test.tsx`. That is inherited, uncorrected, from the prior G plan's
closing line, where it was true (T6 there only restructured DOM, no new
behaviour). It is not true here: the same spec's "Component — ChatComposer /
AgentChatPane" bullets two paragraphs above it explicitly demand new cases in
that very file (draft rehydrate, ⌘S stash, restore-swap). Task 9 modifies
`ChatComposer.test.tsx` — green, not unmodified — and this plan treats that as
the correct reading.

## Task 1 — Register new test paths (`vite.config.ts`)

**Solo. First. Nothing else in this plan can verify its own tests until this
lands.**

No tests of its own — this is configuration, not logic. "Verify" is running the
*existing* suite unchanged to prove the array edit alone breaks nothing.

**Implement.** Append these seven paths to `test.include` (`vite.config.ts:71`),
alongside the existing `src/features/agent-chat/*` entries, in the same
one-per-line style:

```
src/features/agent-chat/composerDrafts.test.ts
src/features/agent-chat/promptStash.test.ts
src/components/ui/tab-strip-popover-menu.test.tsx
src/features/agent-chat/useAgentChatSocket.test.ts
src/features/agent-chat/ComposerStashBadge.test.tsx
src/features/agent-chat/ComposerStashMenu.test.tsx
src/features/data/queries.deleteAgentThread.test.ts
```

None of these files exist yet. That is expected and safe — see "A verified
trap, up front".

**Done when:** `npm test` (from `frontend/`) still reports exactly the current
known-good baseline (one pre-existing monaco-guard failure, everything else
green) — the array grew, nothing regressed, because Vitest's glob resolution
skips entries with no file behind them.

**Verify:** `npm test` (full suite; there is nothing narrower to run for a
config-only change).

## Task 2 — `composerDrafts.ts` (pure) — parallelizable (Wave 1)

**Tests first**, in `composerDrafts.test.ts`:
- `setDraft` sets and overwrites; `clearDraft` removes the key.
- `setDraft` with empty (or whitespace-only, per spec §2's "empty text deletes
  the key rather than storing `''`") text **deletes** the key rather than
  storing `''`.
- Past `MAX_COMPOSER_DRAFTS` (50), `setDraft` evicts the least-recently-updated
  entry (`updatedAt`), keeping the map at the cap. `now` is injected as a
  parameter, not read from `Date.now()` — same shape as
  `paletteFrecency.ts:33-43`'s `recordUse`, so the eviction order is testable
  without a clock.

**Then implement.** Mirror `paletteFrecency.ts`'s shape exactly: a plain
`Record<string, ComposerDraft>`, `{...map, [key]: value}` on write, delete via
object destructuring on empty text, and the same "find the oldest, drop it"
reduce `paletteFrecency.ts:40` uses for its own cap.

```ts
export interface ComposerDraft { text: string; updatedAt: number }
export const MAX_COMPOSER_DRAFTS = 50
export function setDraft(map: Record<string, ComposerDraft>, threadKey: string, text: string, now: number): Record<string, ComposerDraft>
export function clearDraft(map: Record<string, ComposerDraft>, threadKey: string): Record<string, ComposerDraft>
```

No localStorage code here — persistence is Task 6's job via `partialize`. This
file is pure map algebra only, same division of labour `paletteFrecency.ts`
does NOT have (it owns its own storage) but `dbTabs.ts`/`tileTree.ts` do (pure
reducers, store owns persistence) — follow the latter, since `composerDrafts`
rides the store's shared blob, not its own key.

**Done when:** `composerDrafts.test.ts` passes.

**Verify:** `npm test -- src/features/agent-chat/composerDrafts.test.ts` and
`npm run typecheck`.

## Task 3 — `promptStash.ts` (pure + storage) — parallelizable (Wave 1)

**Tests first**, in `promptStash.test.ts`. The spec's own test list (design
doc, Testing section) names five groups; the array-mutation ones imply pure
functions the spec's §5 code block didn't name — this task names them, since
"cap 20, evicting the oldest, prepend-newest" and "`takeStashEntry` removes and
returns" have to be pure and testable to satisfy those bullets without a store:

- `addStashEntry`: prepends newest; past `MAX_STASH_ENTRIES` (20) evicts the
  oldest and returns it alongside the new list, so a caller can toast about it.
- `takeStashEntryFrom`: removes and returns the entry by id; an unknown id
  returns `null` for the entry and the **same array reference** back (no
  mutation) — the "mutates nothing" half of the spec's bullet.
- `removeStashEntryFrom`: deletes by id, used by per-row delete in the menu.
- `loadStash` returns `[]` for absent, malformed, or throwing storage — never
  throws out of an import. Same posture and same test technique as
  `paletteFrecency.test.ts:86-91`.
- **A failed `saveStash` leaves nothing committed.** Inject a throwing
  `Storage.prototype.setItem`, exactly `paletteFrecency.test.ts:95-101`'s
  pattern (monkey-patch, call, restore in the same test) — `saveStash` returns
  `false`, and the caller (Task 6's store action) must not have applied the
  in-memory change. This is the test spec §5 calls "the invariant the whole
  own-key decision exists for."
- `stashEntrySnippet`: whitespace collapsed, truncated at 90 chars with an
  ellipsis, `(empty)` for a blank/whitespace-only entry.

**Then implement.**

```ts
export interface PromptStashEntry { id: string; createdAt: string; text: string }
export const MAX_STASH_ENTRIES = 20
export const STASH_STORAGE_KEY = 'devdeck.composer.stash.v1'
export function loadStash(): PromptStashEntry[]                 // never throws
export function saveStash(entries: PromptStashEntry[]): boolean // false = not durable
export function addStashEntry(entries: PromptStashEntry[], text: string, now: () => string): { entries: PromptStashEntry[]; evicted: PromptStashEntry | null }
export function takeStashEntryFrom(entries: PromptStashEntry[], id: string): { entries: PromptStashEntry[]; entry: PromptStashEntry | null }
export function removeStashEntryFrom(entries: PromptStashEntry[], id: string): PromptStashEntry[]
export function stashEntrySnippet(entry: PromptStashEntry): string
```

Own key, **not** part of `useDevDeckStore`'s `partialize` — Task 6 wires the
store's actions to call these plus `loadStash`/`saveStash`, but this file talks
to `localStorage` directly, same as `paletteFrecency.ts` does, for the same
never-throws reason.

**Done when:** `promptStash.test.ts` passes.

**Verify:** `npm test -- src/features/agent-chat/promptStash.test.ts` and
`npm run typecheck`.

## Task 4 — `TabStripPopoverMenu` controlled `open` — parallelizable (Wave 1)

**Tests first**, in a new `tab-strip-popover-menu.test.tsx`:
- **Uncontrolled (regression baseline):** no `open`/`onOpenChange` passed —
  clicking the trigger opens the popup, matching today's behaviour exactly.
  This is the mode `PanelHeader.tsx` and the DB tab strip already use
  (`tab-strip-popover-menu.tsx:19-27`), so it must not change.
- **Controlled:** an `open` prop drives visibility directly (popup renders open
  when `open={true}` without a trigger click); `onOpenChange` fires on trigger
  click and on outside-click/Escape, and the component does not manage its own
  `open` state in this mode (a controlled `open={false}` after the trigger fires
  `onOpenChange` stays closed — the parent, not the popover, owns truth).

**Then implement.** Optional `open?: boolean` / `onOpenChange?: (open: boolean) => void`
props threaded onto `Popover.Root` (`@base-ui/react/popover`'s own
controlled/uncontrolled duality — `Popover.Root`'s `open` prop switches modes
the same way this component's internal `useState` already does today via
`onOpenChange` alone). Existing callers (`PanelHeader.tsx`, the DB tab strip,
and Task 9's uncontrolled usages) pass neither prop and see no behaviour change.

**Done when:** `tab-strip-popover-menu.test.tsx` passes, and
`PanelHeader.test.tsx` (existing, untouched) still passes.

**Verify:** `npm test -- src/components/ui/tab-strip-popover-menu.test.tsx src/features/terminal/PanelHeader.test.tsx` and `npm run typecheck`.

## Task 5 — Draft-thread connect gate — parallelizable (Wave 1)

`useAgentChatSocket.ts` + `ChatHeader.tsx`, landed together because
`ChatHeader.tsx`'s `SOCKET_DOT_COLOR: Record<AgentSocketStatus, string>`
(`ChatHeader.tsx:29-33`) is exhaustive over the type this task extends — split
across two tasks, the first would land red on `typecheck` until the second
arrives. One task, two files it alone writes.

**Tests first**, in a new `useAgentChatSocket.test.ts`. No hook test file
exists yet for this module — `renderHook` from `@testing-library/react` has
precedent in this repo (`features/stats/useRollingSamples.test.ts:2`). Stub the
global `WebSocket` constructor and mock `machineWsUrl` (`@/lib/machineClient`)
to resolve synchronously to a fixed URL, same shape `lspTransport.test.ts:6`'s
"minimal stand-in for the browser WebSocket" uses for the transport layer, one
level up (constructor spy, not an injected instance, since the hook calls
`new WebSocket(...)` itself — `useAgentChatSocket.ts:194`).

- `connect: false` → `status` is `'draft'`, and the `WebSocket` constructor is
  never called (assert the spy has zero calls) — no hello, no row.
- **The outbox trap (spec §4, the highest-severity risk in this spec).** Write
  this test before touching the hook; it must fail against the naive
  "add `connect` to the effect's existing dependency array" edit. Render with
  `connect: false`, call `sendTurn('hi')` (queues into `outboxRef` — dispatch
  doesn't check `connect`, only socket readiness, `useAgentChatSocket.ts:299-304`),
  then `rerender` with `connect: true`. Simulate the stub socket's `onopen`.
  Assert the queued `thread.turn.start` command was sent **exactly once**, after
  hello. The regression this catches: `outboxRef.current = []` currently runs at
  the top of the connect effect (`useAgentChatSocket.ts:183`) and in its cleanup
  (`:278`); if `connect` joins that effect's dependency array
  (`useAgentChatSocket.ts:280-283`) instead of its own, the flip from `false` to
  `true` re-runs the effect and wipes the very command that triggered it.

**Then implement.**

```ts
export type AgentSocketStatus = 'draft' | 'connecting' | 'open' | 'closed'
export interface UseAgentChatSocketOptions { machine: Machine; threadKey: string; connect?: boolean }
```

- `connect` defaults to `true` (every existing call site — none pass it yet —
  keeps today's behaviour).
- **Split the outbox reset out of the connect effect.** A new effect keyed on
  `[machine, threadKey]` **only** owns `outboxRef.current = []`. The existing
  connect effect (`useAgentChatSocket.ts:174-283`) gains `connect` to its own
  dependency array (`[machine, threadKey, connect]`) and, when `connect` is
  `false`, returns early after setting `status('draft')` — it opens no socket
  and touches the outbox only to flush it on `onopen`, never to clear it.
- `ChatHeader.tsx`: `SOCKET_DOT_COLOR` gains `'draft': 'var(--devdeck-fg-2)'`
  (the idle/dim token — spec: "nothing is pending"). `showConnecting`'s owner,
  `AgentChatPane.tsx`, is untouched by this task (Task 10's job) but is
  already correct once `'draft' !== 'connecting'`.

**Done when:** `useAgentChatSocket.test.ts` passes, `npm run typecheck` passes
(the `Record` exhaustiveness check is the enforcement for `ChatHeader.tsx`).

**Verify:** `npm test -- src/features/agent-chat/useAgentChatSocket.test.ts` and `npm run typecheck`.

## Task 6 — Store slice (CONVERGENCE) — Wave 2, needs T2 + T3

**The one task in this plan allowed to touch `store/useDevDeckStore.ts`.** No
other task, and no parallel agent on any other subsystem, may edit that file
while this task is in flight (CLAUDE.md; spec's design §1, stated twice in the
spec for the same reason it's stated here).

**Tests first.** This task has no new test *file* of its own — `useDevDeckStore.ts`
has no dedicated unit-test file in this repo today (its behaviour is exercised
through the features that consume it, e.g. `shellSidebars.test.ts` tests a
reducer module, not the store directly). TDD here means: extend the consuming
tests that Tasks 9 and 11 will write against the new actions — but since those
tasks are downstream (Wave 3), this task's own verification is the type system
plus a scratch assertion. Concretely, before writing the slice, add (and watch
fail to compile) a one-off `it()` in a throwaway local file — not committed —
that calls `useDevDeckStore.getState().setComposerDraft(...)` /
`.stashPrompt(...)` to confirm the shape red/green cycles; the real, permanent
assertions of this behaviour live in Task 9's and Task 11's test files, which
import the real store (not a mock) exactly as `ChatComposer.test.tsx` already
does today (no `vi.mock` of `useDevDeckStore` anywhere in that file).

**Then implement**, all in one commit-sized change:

- Add `composerDrafts: Record<string, ComposerDraft>` and
  `promptStash: PromptStashEntry[]` to `DevDeckState`, imported from Task 2's
  and Task 3's modules (`import type { ComposerDraft } from '@/features/agent-chat/composerDrafts'`,
  same import style as `eventReducer`/`types` at `useDevDeckStore.ts:6-7`).
- Actions:
  ```ts
  setComposerDraft: (threadKey: string, text: string) => void   // wraps composerDrafts.setDraft
  clearComposerDraft: (threadKey: string) => void                // wraps composerDrafts.clearDraft
  stashPrompt: (text: string) => { ok: boolean; evicted: PromptStashEntry | null }
  takeStashEntry: (id: string) => PromptStashEntry | null
  deleteStashEntry: (id: string) => void
  ```
  `stashPrompt`/`takeStashEntry`/`deleteStashEntry` call Task 3's
  `addStashEntry`/`takeStashEntryFrom`/`removeStashEntryFrom` for the array
  math, then `saveStash()` for persistence, and — this is the boolean-return
  contract Task 3's tests already pin down — only call `set(...)` when
  `saveStash()` returns `true`. A rejected write leaves `promptStash` exactly as
  it was.
- Initial state: `composerDrafts: {}` (persisted, so real value comes from
  rehydration), `promptStash: loadStash()` — evaluated once, at store creation
  (spec §5: "hydrate once at module init").
- `partialize` (`useDevDeckStore.ts:1069-1080`) gains one line:
  `composerDrafts: s.composerDrafts`. **`promptStash` does NOT go in
  `partialize`** — it has its own key, on purpose (Task 3's doc comment on why).
- No version bump, no `migrate` change (`useDevDeckStore.ts:1066`, `:1087-1100`):
  a new `partialize` key needs neither, since a persisted blob missing the key
  just falls back to the store's own initial-state default on rehydrate.

**Done when:** `npm run typecheck` passes with the new slice in place, and every
test file that already imports the real store (`ChatComposer.test.tsx` today,
before Task 9 touches it) still passes unmodified.

**Verify:** `npm run typecheck` and `npm test` (full suite — this file has the
widest blast radius of any task here, so its own gate is the whole suite, not
a narrow path).

## Task 7 — `ComposerStashBadge.tsx` — parallelizable (Wave 1)

Not listed with a paired test file in the spec's Files section (only
`ComposerStashMenu.tsx` got one there) — this plan adds one anyway, since every
task here states tests first; the component is small enough that this costs
little and the badge's two behavioural contracts (hidden at zero, no focus
theft) are exactly the kind of thing a snapshot-free assertion catches cheaply.

**Tests first**, in `ComposerStashBadge.test.tsx`:
- renders nothing when `count === 0`.
- renders the count when `count > 0`.
- `pointerdown` on the badge is prevented (`event.defaultPrevented` after
  firing) — spec §6: "opening it does not steal focus from the editor."
- clicking calls the provided `onClick`.

**Then implement.** Port of t3code's `ComposerStashBadge.tsx:14-56`, restyled to
this repo's semantic tokens (`bg-devdeck-*`, not raw values — same instruction
Task 2 of the prior plan followed for `ComposerChip.tsx`). Bookmark icon +
count pill, `onPointerDown={(e) => e.preventDefault()}`, `onClick` prop. No
store or `promptStash.ts` import needed — `count` and `onClick` are plain props,
the parent (Task 9) owns the data.

```ts
export interface ComposerStashBadgeProps { count: number; onClick: () => void; className?: string }
```

**Done when:** `ComposerStashBadge.test.tsx` passes.

**Verify:** `npm test -- src/features/agent-chat/ComposerStashBadge.test.tsx` and `npm run typecheck`.

## Task 8 — `ComposerStashMenu.tsx` — Wave 2, needs T3

**Tests first**, in `ComposerStashMenu.test.tsx`, mirroring t3code's own
`ComposerStashMenu.tsx:32-176` behaviour (ported, not invented — spec §6):
- renders entries newest-first, each showing `stashEntrySnippet(entry)` (Task
  3) and a relative time via `formatDistanceToNow` (`date-fns`, same usage as
  `SessionsPanel.tsx:27`, `:129`).
- per-row delete calls `onDelete(id)` and does not also call `onSelect`.
- Arrow Up/Down moves a highlighted index (wraps or clamps — pick one, test it).
- Enter selects the highlighted entry (`onSelect(entry.id)`).
- Escape calls `onClose()`.
- ⌘⌫ / Ctrl+⌫ on the highlighted row calls `onDelete(id)`.
- All of the above are bound **capture-phase on `window`**
  (`ComposerStashMenu.tsx:50-90` in the reference), not on a local element —
  test this by dispatching the `keydown` on `document.body`, not on a node
  inside the menu, and asserting it still fires.

**Then implement.**

```ts
export interface ComposerStashMenuProps {
  entries: PromptStashEntry[]
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}
```

Own list-rendering + the capture-phase `window` keydown listener (added on
mount, removed on unmount). No popover shell logic here — Task 9 wraps this in
`TabStripPopoverMenu` (Task 4's now-controllable version).

**Done when:** `ComposerStashMenu.test.tsx` passes.

**Verify:** `npm test -- src/features/agent-chat/ComposerStashMenu.test.tsx` and `npm run typecheck`.

## Task 9 — `ChatComposer.tsx` integration — Wave 3, needs T4 + T6 + T7 + T8

**Tests first**, added to the existing `ChatComposer.test.tsx` (see the
File-ownership section's correction: this file is modified and must stay
green, not left unmodified). Use the file's own `type()` helper
(`ChatComposer.test.tsx:64-66`, a `fireEvent.paste` — `userEvent.type` does not
survive ProseMirror's per-transaction DOM rebuild, per that file's comment) for
anything that needs text in the editor. The store is real here (no
`vi.mock('@/store/useDevDeckStore', ...)` in this file today) — reset
`composerDrafts`/`promptStash` between tests (`useDevDeckStore.setState(...)`
in `afterEach`, alongside the existing `cleanup()`) and clear
`localStorage.removeItem(STASH_STORAGE_KEY)` so stash state doesn't leak
between cases.

- Typed text, then unmount, then remount with the same `threadKey` prop:
  the editor rehydrates with the same text (draft hydrate-on-mount, Task 2's
  `composerDrafts` read).
- A successful send (`onSend` fires, `submit()` clears local `text` —
  `ChatComposer.tsx:169-174`) also clears the persisted draft — advance fake
  timers past the 300 ms debounce and assert no stray write resurrects it.
- ⌘S (`metaKey` or `ctrlKey`) with non-empty text: composer empties, and the
  stash badge's count increments (or the entry is queryable via the store).
- ⌘S with empty text: opens the stash menu (Task 8's component becomes
  visible/queryable).
- Escape closes the open menu; Enter restores the highlighted entry's text into
  the composer.
- **The split-pane collision test (spec §6).** Register a bubble-phase
  `keydown` listener on `window` in the test, mirroring `FileEditor.tsx:197-207`'s
  own registration exactly (bubble, no capture flag). Fire ⌘S with the
  composer's editor focused. Assert that spy listener is **never called** —
  proof the composer's capture-phase handler calls `stopPropagation()` before
  the bubble phase, not just `preventDefault()`.
- Restoring a stash entry into a non-empty composer stashes the current text
  first, then swaps in the restored entry — nothing is lost.

**Then implement**, in `ChatComposer.tsx`:

- `threadKey?: string` added to `ChatComposerProps` (optional — defaults to
  drafts-disabled, same pattern `machine`/`NO_MACHINE` already uses,
  `ChatComposer.tsx:70-76`, `:85-86`). `ChatComposer.test.tsx`'s existing cases
  that mount the component with no `threadKey` must keep passing unmodified —
  drafts and stash are dormant, not erroring, when it's absent for drafts (the
  badge/menu/⌘S wiring is not threadKey-gated, since the stash is global per
  spec §5).
- Hydrate `text` from `useDevDeckStore((s) => threadKey ? s.composerDrafts[threadKey] : undefined)?.text ?? ''`
  on mount only (not on every keystroke — the store is a mirror, not the
  source, spec §2).
- A 300 ms trailing debounce writes `text` to `store.setComposerDraft(threadKey, text)`
  on every change once `threadKey` is set; flush the pending write on unmount
  (a `useEffect` cleanup that calls the debounced function's own flush, or
  reads the ref and commits directly — either is fine, tested behaviour, not
  implementation).
- `submit()` (`ChatComposer.tsx:169-174`) also calls
  `store.clearComposerDraft(threadKey)` synchronously, before any pending
  debounce tick can fire.
- `SURFACE` (`ChatComposer.tsx:108-112`) gains `relative` so the badge can
  anchor to it.
- Badge (Task 7) + Menu (Task 8), wired through Task 4's now-controllable
  `TabStripPopoverMenu`. Menu `open` state lives in a local `useState`, driven
  by the badge's `onClick` and by the ⌘S handler.
- ⌘S handler: a `useEffect` that adds a **capture-phase** `keydown` listener on
  `window` (`{capture: true}`), gated on the composer's own editor DOM node
  having focus (`document.activeElement` inside the surface ref), calling
  `preventDefault()` **and** `stopPropagation()`. Empty draft → open the menu.
  Non-empty draft → `store.stashPrompt(text)`; on `{ok: true}`, clear `text`
  (and the draft, same as `submit()`); on `{ok: false}`, leave the composer
  untouched and surface a `sonner` toast (`.claude/rules/frontend.md`: toasts
  use `sonner`).
- Restore: menu `onSelect(id)` calls `store.takeStashEntry(id)`; if current
  `text` is non-empty, `store.stashPrompt(text)` first (swap, not overwrite),
  then `setText(entry.text)`.

**Done when:** `ChatComposer.test.tsx` passes in full (existing + new cases),
and every file in the "must stay green" regression list still passes.

**Verify:** `npm test -- src/features/agent-chat/ChatComposer.test.tsx` and
`npm run typecheck`, then the full regression set:
`npm test -- src/features/agent-chat/ComposerControls.test.tsx src/features/agent-chat/ComposerPromptEditor.test.tsx src/features/agent-chat/composerSerialize.test.ts src/features/agent-chat/composerMention.test.ts src/features/agent-chat/composerNodes.test.ts src/features/agent-chat/MessagesTimeline.test.tsx src/features/agent-chat/eventReducer.test.ts src/features/agent-chat/timeline.test.ts src/features/agent-chat/adapter.test.ts src/features/agent-chat/SessionsPanel.test.tsx`.

## Task 10 — `AgentChatPane.tsx` — Wave 4, needs T5 + T9

**Tests first**, in the existing `AgentChatPane.test.tsx`. Two changes are
needed to the file's own scaffolding before new cases can be written:

- The `vi.mock('@/features/agent-chat/useAgentChatSocket', ...)` at
  `AgentChatPane.test.tsx:8-10` currently ignores its arguments
  (`() => mockSocket()`). Change it to capture them
  (`(opts) => { capturedSocketOpts = opts; return mockSocket() }`) so the
  connect-gate tests below can assert on `connect`.
- The `vi.mock('@/features/data/queries', ...)` at `AgentChatPane.test.tsx:42-45`
  stubs only `useAgents`/`useAgentModels`. `AgentChatPane.tsx` will now also
  call `useAgentThreads` (Task 10's own new dependency, from `@/features/data/queries`)
  to decide the connect gate — add
  `useAgentThreads: () => mockAgentThreads()` (a `vi.fn()`, per-test
  configurable) to that same mock or the suite crashes on the first render with
  "useAgentThreads is not a function". This file is **not** in the spec's
  "must stay green, unmodified" list (verified: the list in the design doc's
  Testing section omits `AgentChatPane.test.tsx` by name), so modifying it is
  expected, not a deviation.

New cases:
- **The hero↔docked remount is lossless (problem 2, spec's own verbatim
  reproduction).** Mount with the mocked socket at `status: 'connecting'`,
  `view.items: []`; type into the composer; flip the mock's return to
  `status: 'open'`, still `view.items: []`; assert the typed text is still in
  the editor. This is the specific defect Task 9's draft-mirroring makes
  survivable without touching `AgentChatPane`'s hero/docked branching itself
  (spec's explicit non-goal: "The remount... is not fixed, it is made
  survivable").
- `connect: false` is passed to `useAgentChatSocket` when `useAgentThreads`'s
  mock returns data with no thread matching the pane's `threadKey`.
- `connect: true` when the matching thread exists, and — fail-open — also
  `true` while the query `isLoading`, and also `true` on `isError`.
- The first `onSend` flips a local "has sent this session" flag that keeps
  `connect: true` on any subsequent render even if `useAgentThreads`'s data
  hasn't caught up yet (avoids a flap back to `connect: false` mid-turn).

**Then implement.**

- `const threadsQuery = useAgentThreads(machine, worktreeId)` (existing hook,
  `features/data/queries.ts:1379-1387` — no change to that hook itself; Task 11
  touches a different export in the same file).
- `const [hasSentThisSession, setHasSentThisSession] = useState(false)`.
- ```ts
  const threadExists = (threadsQuery.data ?? []).some((t) => t.id === threadKey)
  const connect = hasSentThisSession || threadExists || threadsQuery.isLoading || threadsQuery.isError
  ```
  (fail-open: loading or errored both resolve to `true`, spec §4).
- `useAgentChatSocket({ machine, threadKey, connect })`.
- Wrap `onSend` so the first call sets `hasSentThisSession(true)` before
  delegating to `sendTurn`.
- Pass `threadKey` through to `<ChatComposer threadKey={threadKey} ... />`
  (`AgentChatPane.tsx:194-206` already threads `machine`/`worktreeId`/
  `worktree`/`branch` the same way — one more prop, same shape).

**Done when:** `AgentChatPane.test.tsx` passes in full.

**Verify:** `npm test -- src/features/agent-chat/AgentChatPane.test.tsx` and `npm run typecheck`.

## Task 11 — `useDeleteAgentThread` clears the draft — Wave 3, needs T6

**Tests first**, in a new `queries.deleteAgentThread.test.ts`. No file in this
repo unit-tests `queries.ts` directly today (`SessionsPanel.test.tsx:21` mocks
`useDeleteAgentThread` away entirely, so it gives no coverage of the real
mutation). This task adds the first one, scoped narrowly:

- `renderHook(() => useDeleteAgentThread(machine, worktreeId), { wrapper: <QueryClientProvider> })`,
  with `machineRequest` (`@/lib/machineClient`) mocked to resolve `undefined`
  (a successful delete).
- Spy on `useDevDeckStore.getState().clearComposerDraft`.
- Call `.mutate(threadId)`, await settle, assert `clearComposerDraft` was
  called with exactly `threadId`.
- A rejected `machineRequest` (mock rejects) does **not** call
  `clearComposerDraft` — the draft only disappears when the backend confirms
  the erase, matching the mutation's existing `onSuccess`-only invalidation
  (`queries.ts:1400-1401`).

**Then implement.** In `useDeleteAgentThread`'s `onSuccess`
(`queries.ts:1400-1401`), alongside the existing `invalidateQueries` call, add
`useDevDeckStore.getState().clearComposerDraft(threadId)`. `threadId` is
already the mutation's own argument (`mutationFn: (threadId: string) => ...`,
`queries.ts:1399`) — no new parameter threading needed. Spec's reasoning: the
backend already erases the row, transcript and receipts
(`store/agentevent.go:267-284`), so a surviving local draft would be the only
trace left of a conversation the user asked to erase.

**Done when:** `queries.deleteAgentThread.test.ts` passes, and
`SessionsPanel.test.tsx` (which mocks this hook away) still passes unmodified.

**Verify:** `npm test -- src/features/data/queries.deleteAgentThread.test.ts src/features/agent-chat/SessionsPanel.test.tsx` and `npm run typecheck`.

---

## Review, fix, finalize

Review runs once, over the whole change — not per task, same as the G plan.

**Review lenses (parallel):**
- Spec conformance against `2026-08-15-composer-drafts-and-stash-design.md`,
  section by section.
- TDD honesty: do the tests in each task actually constrain the behaviour
  (would they fail against a plausible wrong implementation), or were they
  written to pass?
- The outbox-trap test (Task 5) and the split-pane ⌘S test (Task 9) specifically
  — these are the two risks the spec calls out by name as capable of silent,
  invisible-in-the-UI failure.
- Regression risk in every file on the "must stay green" list.
- The convergence-file rule: confirm `store/useDevDeckStore.ts` was touched by
  exactly one commit/task, and `vite.config.ts` by exactly one.

**Fix:** apply confirmed findings only.

**Finalize:** `npm run typecheck` and `npm test` from `frontend/`.

## Known-good baseline

`npm test` (from `frontend/`) has **exactly one pre-existing failure**, in the
monaco guard test. It predates this work and must not be "fixed" as part of
it. **Any second failure after this plan's tasks land is a real regression**
and blocks finalize — not a pre-existing condition to wave through.

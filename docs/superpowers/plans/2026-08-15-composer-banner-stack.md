# Plan — Composer Banner Stack (subsystem F)

Spec: `docs/superpowers/specs/2026-08-15-composer-banner-stack-design.md`

Execution: TDD throughout. Tests are written before the implementation they
cover, and every task ends with its own tests green.

Frontend only. **No Go file is touched by any task in this plan.**

## Dependency shape

T1, T2 and T3 are independent of each other and of everything else — they
touch disjoint files and none of them reads another task's output. T4 is the
integration point and needs all three landed first.

```
T1 composerBanners ─┐
T2 banner stack    ─┼─▶ T4 shell wiring (ChatComposer + AgentChatPane)
T3 clearError()    ─┘
```

Run T1–T3 in parallel worktrees (per `CLAUDE.md`'s orchestration playbook —
"isolate parallel file-mutating agents in git worktrees"); merge and run T4 in
one integration step once all three are in.

## File ownership

No two tasks write the same file.

| Task | Writes |
|---|---|
| T1 | `composerBanners.ts`, `composerBanners.test.ts` |
| T2 | `ComposerBannerStack.tsx`, `ComposerBannerStack.test.tsx` |
| T3 | `useAgentChatSocket.ts`, `useAgentChatSocket.test.ts` |
| T4 | `ChatComposer.tsx`, `AgentChatPane.tsx`, `AgentChatPane.test.tsx`, `vite.config.ts` |

All under `frontend/src/features/agent-chat/`, except `vite.config.ts`
(`frontend/vite.config.ts`).

**CLAUDE.md convergence files** (`routeTree.gen.ts`, `useDevDeckStore.ts`,
`store/types.ts`, `domain/models.go`, `cmd/server/main.go`, `port/store.go`):
**none are touched by this plan.** `AgentChatPane.tsx` and `ChatComposer.tsx`
are not on that list — but they are still the one shared integration surface
in this plan, which is exactly why they're bundled into the single chained
task T4 instead of being split further. Nothing to serialize beyond that.

## A note on `vite.config.ts` and why it has one owner

`frontend/vite.config.ts`'s `test.include` is an **explicit per-file
allowlist**, not a glob (`vite.config.ts:71` onward — verified: a test file
absent from that array does not run even when named directly on the vitest
CLI, confirmed empirically against this exact repo/vitest version). Every new
test file T1–T3 create must eventually be added there, or `npm test` silently
skips it forever.

If each of T1/T2/T3 edited that array independently, three parallel agents
would be writing the same file — exactly the "no file appearing twice"
problem this table exists to prevent. So: **T4 owns the one edit**, adding all
three new paths in a single pass, after T1–T3 have landed.

Until then, T1–T3 verify their own new test file with a **throwaway,
never-committed** vitest config that overrides `test.include` directly
(not via `mergeConfig`, which concatenates arrays instead of replacing them —
verified: that produces a `mergeConfig`-merged include list that silently runs
the *entire* suite, which is not what a scoped check needs, and can churn out
spurious flakes under jsdom load unrelated to the file under test). From
`frontend/`:

```bash
cat > vite.scratch.config.ts <<'EOF'
import { defineConfig } from 'vite'
import base from './vite.config'
export default defineConfig({
  ...base,
  test: { ...(base as any).test, include: ['src/features/agent-chat/<your-new-file>.test.ts'] },
})
EOF
npx vitest run -c vite.scratch.config.ts
rm vite.scratch.config.ts   # never commit this file
```

---

## T1 — `composerBanners.ts`: the pure decision layer (independent)

No DOM, no React, no lucide import — a pure function over plain data, exactly
the split the spec draws in its data-flow diagram (spec "Data flow"): this
module decides *which* banners exist and in what order; `AgentChatPane`
(T4) is the only place that turns a decision into a `ReactNode` icon or an
`onDismiss` closure.

**Contract to implement against:**

```ts
export type ComposerBannerTone = 'default' | 'warning' | 'error' | 'info'
export type ComposerBannerIconKey = 'connection' | 'transport-error' | 'agent-missing' | 'session-stopped'

export interface ComposerBannerSpec {
  id: string             // 'connection:<threadKey>' | 'thread-error:<threadKey>'
                          // | 'agent-missing:<machineId>:<agentId>' | 'session-stopped:<threadKey>'
  tone: ComposerBannerTone
  iconKey: ComposerBannerIconKey
  title: string
  description?: string
  dismissible: boolean   // false for F1 only
}

export interface ComposerBannersInput {
  threadKey: string
  machineId: string
  machineName: string
  agentId: string
  socketStatus: 'connecting' | 'open' | 'closed'   // useAgentChatSocket's status
  showConnecting: boolean                          // AgentChatPane's existing dedupe flag
  hasTranscript: boolean                           // view.items.length > 0 — picks F1's copy
  threadError: string | null                       // view.error — TRANSPORT ONLY, see spec's Correction
  threadStatus: 'idle' | 'running' | 'waiting' | 'stopped'
  agents: { data: AgentSummary[] | undefined; isLoading: boolean; error: unknown }  // shape of useAgents()'s result
  dismissed: ReadonlySet<string>
}

export function composerBanners(input: ComposerBannersInput): ComposerBannerSpec[]

/** The raw candidate id set with NO dismissal filter applied — i.e. "what
 *  WOULD show right now, ignoring the dismissed set". AgentChatPane (T4)
 *  uses this to prune its local `dismissed` state: any id no longer in this
 *  set is dropped, so a later recurrence of the same condition (same stable
 *  id) shows again instead of staying hidden forever. Same self-healing shape
 *  as ComposerBannerStack's own `exitingItemId ∩ items` (spec Design §1,
 *  "The exiting id self-heals") — a different layer, same idea. */
export function activeBannerIds(input: Omit<ComposerBannersInput, 'dismissed'>): Set<string>
```

`AgentSummary` is imported (type-only) from `@/store/types` — read-only, not a
write to that convergence file.

**Tests first — `composerBanners.test.ts`** (spec "Testing" §Unit, transcribed
against this contract):

1. Open socket (`socketStatus: 'open'`), `threadError: null`, agent installed,
   `threadStatus: 'idle'` → `[]`.
2. `socketStatus: 'closed'`, everything else nominal → exactly one spec, the
   connection banner (`id` starts `connection:`), `dismissible: false`.
3. `socketStatus: 'closed'` **and** `threadError` set → still only the
   connection banner — the F1/F2 fold rule (spec Design §4, "F1 and F2 are
   mutually exclusive, by fold").
4. `socketStatus: 'open'` + `threadError` set → the error banner
   (`id` starts `thread-error:`), `tone: 'error'`, `dismissible: true`.
5. `showConnecting: true` (even with `socketStatus !== 'open'`) → no
   connection banner — the dedupe rule against the blocking "Connecting…"
   message (spec Design §4, "F1 is also suppressed while `showConnecting`…").
6. F1's title: `hasTranscript: false` → copy reads as a fresh connect
   ("Connecting…"-shaped); `hasTranscript: true` → copy names the machine
   ("Reconnecting to `<machineName>`") — assert via `.title`, not a pinned
   full string, so wording can move without breaking the test.
7. `agents.isLoading: true` → no agent-missing banner. `agents.error` set → no
   agent-missing banner. `agents.data` present but does not contain `agentId`
   → no agent-missing banner (spec Design §4, F3's three guards).
8. `agents` settled (`isLoading: false`, `error` falsy) and `agentId`'s entry
   has `installed: false` → warning banner, `id` starts `agent-missing:`.
9. `threadStatus: 'stopped'` → info banner, `id` starts `session-stopped:`,
   and it is **last** in the returned array regardless of what else is
   present.
10. All three of connection-or-error, agent-missing, and session-stopped true
    at once → asserted by **array index** (`[0]` is connection/error,
    `[1]` is agent-missing, `[2]` is stopped), not by presence — this is what
    proves the priority order, not just the membership.
11. Dismissal pruning: dismiss `session-stopped:<key>` while `threadStatus`
    stays `'stopped'` → the id stays out of `composerBanners`'s result on a
    second call with the same `dismissed` set. Then flip `threadStatus` to
    `'running'` and call `activeBannerIds` — the id is absent, proving a
    caller-side prune (`dismissed ∩ activeBannerIds(...)`) would drop it.
    Flip back to `'stopped'` with that pruned `dismissed` — the banner
    reappears. This is the "same id after the condition goes false and
    returns comes back" case (spec Design §4, "Dismissal bookkeeping").

**Then implement.** Straight-line conditionals, no state, no memoization
inside the module — `AgentChatPane` (T4) owns memoization if it needs it.

**Verify:** scratch-config run per the recipe above, scoped to
`composerBanners.test.ts`.

---

## T2 — `ComposerBannerStack.tsx`: the ported stack + `ComposerBanner` row (independent)

Ports `t3code/apps/web/src/components/chat/ComposerBannerStack.tsx`
structurally intact (spec Design §1) and replaces its `Alert` dependency with
a plain three-column `ComposerBanner` row (spec Design §2) built on this
repo's own tokens — no `Alert`, no `alert-glass` class name port.

**Contract to implement against** (naming choice: `tone`, not t3code's
`variant`, matching the vocabulary the spec itself uses throughout Design §4):

```ts
export type ComposerBannerTone = 'default' | 'warning' | 'error' | 'info'  // no 'success' — nothing produces one (spec Design §2)

export interface ComposerBannerStackItem {
  id: string
  tone: ComposerBannerTone
  icon: ReactNode
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode          // dormant in F — spec Design §6
  className?: string
  actionClassName?: string     // dormant in F — spec Design §6
  dismissLabel?: string
  onDismiss?: () => void       // absent ⇒ not dismissible (F1)
}

export function ComposerBannerStack(props: { className?: string; items: readonly ComposerBannerStackItem[] }): JSX.Element | null
```

**Tests first — `ComposerBannerStack.test.tsx`** (spec "Testing" §Component):

1. One item → no `data-composer-banner-stack-expanded-items` in the markup,
   no collapsed-cap element.
2. Two items → the front item's title appears before the stacked item's title
   in DOM order (`flex-col-reverse` visual order is reversed, DOM order is
   priority order — spec Design §1); the expanded container's class list
   contains `grid-rows-[0fr]` and `group-hover/banner-stack:grid-rows-[1fr]`,
   and does **not** contain `absolute` — ported verbatim from
   `t3code/apps/web/src/components/chat/ComposerBannerStack.test.tsx:26`,
   which exists specifically to keep this in layout flow.
3. A resting (non-exiting) item's inline style is `transform: none` with the
   exit transition already attached but no starting offset applied — i.e.
   there is no enter animation to regress (spec Design §1, "Enter is
   instant; only exit is animated").
4. Click a banner's X → `onDismiss` is **not** called synchronously; under
   fake timers, it is called after exactly `220`ms; the X is `disabled`
   between the click and that callback.
5. A second click on the same X during its own exit window is a no-op — no
   second timer, `onDismiss` still fires exactly once.
6. If the item disappears from `items` (parent-side removal) while its exit
   animation is still in flight, the stack is interactive again immediately —
   the `exitingItemId ∩ items` self-heal (spec Design §1, "The exiting id
   self-heals").
7. Unmounting the stack mid-exit does not fire the pending `onDismiss` and
   does not warn (timer cleanup on unmount).
8. `items.length > 1` → the stack root is focusable (`tabIndex={0}`) and
   carries an `aria-label` naming the count — the keyboard-reachability
   deviation from t3code (spec Design §3, "Keyboard reachability"), needed
   because the stacked items are `invisible` until the group is
   hover-or-focus-within.
9. `role` follows tone: an item with `tone: 'error'` renders `role="alert"`;
   every other tone renders `role="status"` — the second deliberate
   deviation from t3code, which hardcodes `role="alert"` on every banner
   (spec Design §3, "`role` follows tone").

**Then implement.**
- Port the layout mechanics from
  `gg/t3code/apps/web/src/components/chat/ComposerBannerStack.tsx` line for
  line where the spec says to (grid-rows expand, `flex-col-reverse`, the
  collapsed cap, `exitTransitionStyle`/`frontExitStyle`/`stackedExitStyle`/
  `restingStyle`, the `DISMISS_TRANSITION_MS = 220` two-phase `requestDismiss`).
- `ComposerBanner` (the row): icon / (title + description) / actions as
  explicit props, not children-sniffing. Tones map to existing tokens, not
  new ones — `error` → `devdeck-red-tint*`, `warning` → `devdeck-yellow-tint*`,
  `info` → `devdeck-accent-tint`, `default` → `devdeck-raised` +
  `devdeck-hairline` (`frontend/src/styles/globals.css:116-131`).
  `alert-glass` becomes `bg-devdeck-glass` + the `--devdeck-glass-filter`
  custom property (`globals.css:42-46`), which already has a
  no-`backdrop-filter` fallback (`globals.css:371-377`) — do not port the
  class name.
- The X button is `<Button variant="ghost" size="icon-sm">` — `icon-xs` does
  not exist in this repo's `button.tsx` (`frontend/src/components/ui/button.tsx:38-45`
  stops at `icon-sm`, `h-7 w-7`). Do not add a new size for one control.
- Keep the dormant `actions`/`actionClassName`/`dismissOnly` layout branch
  (spec Design §6) even though nothing in F populates `actions` — it is what
  the later B/A subsystems queue behind.

**Verify:** scratch-config run per the recipe above, scoped to
`ComposerBannerStack.test.tsx`.

---

## T3 — `useAgentChatSocket.ts`: add `clearError()` (independent)

The one piece of new plumbing in this spec (spec Design §4, F2). Widens
`UseAgentChatSocketResult` by exactly one function; nothing else about the
hook's behavior changes.

No test file for this hook exists yet in this repo (it is otherwise only
exercised through a whole-hook mock in `AgentChatPane.test.tsx`), so this task
adds a small, targeted one rather than skipping TDD for lack of a template.

**Tests first — `useAgentChatSocket.test.ts` (new file):**

Stub `@/lib/machineClient`'s `machineWsUrl` to resolve a fixed fake URL, and
stub the global `WebSocket` with a minimal fake (`onopen`/`onmessage`/
`onclose`/`onerror`/`send`/`close`, tracked instances) — no reconnect timing
needs to be exercised for this change, only the transport-error path:

1. Render the hook. Resolve the stubbed `machineWsUrl` promise, then fire the
   fake socket's `onerror` before it ever opens — mirrors
   `useAgentChatSocket.ts:242-244` ("Could not connect to the agent chat
   socket"). Assert `result.current.view.error` becomes that string.
2. Call `result.current.clearError()`. Assert `result.current.view.error` is
   `null` again, with no other field of `view` disturbed (`items`, `status`,
   `lastSeq` unchanged) and `status` (the socket status) untouched — this is
   `setTransportError(null)`, nothing else.
3. `clearError()` called when `view.error` is already `null` is a no-op (no
   thrown error, no extra render loop).

**Then implement.**

```ts
const clearError = useCallback(() => setTransportError(null), [])
```

Add `clearError: () => void` to `UseAgentChatSocketResult`, with a doc
comment citing what it's for (F2's dismissal, spec Design §4) and the safety
note already verified by the spec: `usePillState`
(`ComposerControls.tsx:227-237`) is the only other reader of this value, and
its effect is a no-op when `error` is `null` (`if (error !== null && pending
!== null)`), so driving `error` to `null` cannot spuriously revert a pending
pill. Return `clearError` from the hook alongside the existing fields.

**Verify:** scratch-config run per the recipe above, scoped to
`useAgentChatSocket.test.ts`.

---

## T4 — Shell wiring (needs T1, T2, T3)

Wires `composerBanners` (T1) and `ComposerBannerStack` (T2) into
`AgentChatPane`, threads the result into `ChatComposer`, and hooks F2's
dismissal to `clearError()` (T3). This is the only task that edits
`AgentChatPane.tsx` / `ChatComposer.tsx` / `AgentChatPane.test.tsx`, and the
only one that touches `vite.config.ts` (see the note above for why).

**Tests first — `AgentChatPane.test.tsx`,** exact disposition per the spec's
"Existing tests" section:

- **Delete** the test at `AgentChatPane.test.tsx:136`
  ("gives the thread-error state the same height") — it pins
  `min-h-[220px]` on the `PaneMessage` this task removes for the error case.
  Its sibling at `:124` ("gives the connecting state a height…") stays; it
  covers the same regression for `showConnecting`, which keeps its
  `PaneMessage` unchanged.
- **Keep unmodified** the test at `:110`
  ("surfaces a thread error instead of rendering an empty timeline") — it
  asserts the error text is on screen; after this task it finds it inside
  the banner instead of the removed `PaneMessage`, so it survives as a
  regression guard with no edit.
- **Add:** `status: 'closed'` with an existing transcript (`view.items` non-
  empty) → the timeline is **still rendered** (this is literally the defect
  in the spec's Problem section — a mid-thread reconnect used to be
  invisible) **and** the connection banner is present.
- **Add:** `view.error` set with an existing transcript → the timeline is
  **still rendered** and the error banner is present (today `view.error`
  replaces the whole pane with `PaneMessage tone="error"` — this proves it no
  longer does).
- **Add:** a brand-new thread (`view.items` empty, `status: 'open'`,
  `view.error` set) → gets the **hero** layout (the heading + centered
  composer) with the banner above it, instead of losing its framing — this
  directly exercises `isEmpty`'s relaxed clause (spec Design §7,
  "`isEmpty` drops its `view.error === null` clause"). Not itemized verbatim
  in the spec's Testing list, but it is the one behavior in §7 with no other
  test covering it, so it is added here rather than left unverified.
- **Add:** dismissing the error banner calls the mocked socket's
  `clearError()` — `AgentChatPane.test.tsx` already mocks the whole
  `useAgentChatSocket` module (`mockSocket`), so this only proves the wiring,
  not the hook's own behavior (T3 owns that). Drive the dismissal under fake
  timers (220ms, per T2's contract) before asserting the call.

**Regression, must stay green and unmodified (spec's explicit list — do not
touch these files' contents in this task):** `ChatComposer.test.tsx`,
`ComposerControls.test.tsx`, `ComposerPromptEditor.test.tsx`,
`composerSerialize.test.ts`, `composerMention.test.ts`, `composerNodes.test.ts`,
`MessagesTimeline.test.tsx`, `eventReducer.test.ts`, `timeline.test.ts`,
`adapter.test.ts`. `ChatComposer.test.tsx` in particular mounts `ChatComposer`
without a `banners` prop (`ChatComposer.test.tsx:75`, `:92`); the new prop
must default to `[]` so that file needs no edit — this is a deliberate spec
choice (spec "Existing tests — exact disposition"), not a gap to fill with a
new ChatComposer-level test for the `pt-3`→`pt-0` ternary. That ternary is
exercised indirectly by the new AgentChatPane integration tests (a banner
present changes the docked form's top padding) but has no test asserting the
class swap directly — noted here so it isn't rediscovered as a missing case
later.

**Then implement.**

`AgentChatPane.tsx`:
- `useAgents(machine)` (already the pattern `ModelPicker.tsx:156-157` uses).
- A local `dismissed: Set<string>` (`useState`), pruned against
  `activeBannerIds(...)` (T1) whenever the raw inputs change — the "same
  self-healing shape as `exitingItemId ∩ items`" the spec calls out.
- `composerBanners(...)` (T1) → `ComposerBannerSpec[]`, mapped here to
  `ComposerBannerStackItem[]`: `iconKey` → a small local
  `Record<ComposerBannerIconKey, LucideIcon>` (this is where lucide enters —
  T1's module stays icon-agnostic on purpose), and `onDismiss` closures:
  F2 → `clearError` (T3); F3/F4 → `(id) => setDismissed(s => new Set(s).add(id))`;
  F1 → omitted (not dismissible).
- Drop `view.error`'s `<PaneMessage tone="error">` branch
  (`AgentChatPane.tsx:226-228`); the transcript renders unconditionally once
  `showConnecting` is false.
- `isEmpty` drops its `view.error === null` clause (`:192`).
- `showConnecting` and `controls.error` (`:167`, `:188`) are unchanged.

`ChatComposer.tsx`:
- New `banners?: ComposerBannerStackItem[]` prop, default `[]`.
- `<ComposerBannerStack items={banners} />` rendered as a sibling immediately
  before the `<form>`, inside the outer wrapper (`ChatComposer.tsx:182-186`),
  carrying its own `mx-auto w-full min-w-0 max-w-3xl` plus the variant's
  horizontal inset (`px-5` docked, none hero) — **do not** hoist `max-w-3xl` /
  `px-5` / `@container/composer` off the `<form>` to share a wrapper; the
  container query is sized off the whole form on purpose (spec Design §7,
  and that file's own doc comment at `:47-52`).
- One ternary: the docked form's `pt-3` becomes `pt-0` when `banners.length >
  0` (the stack owns its own `mb-2`).

`vite.config.ts`: add the three new test file paths from T1/T2/T3 to
`test.include` (`vite.config.ts:71`+, alongside the existing
`src/features/agent-chat/*.test.ts(x)` entries at `:154-170`).

**Verify** (after the `vite.config.ts` edit above — `npm test`'s positional
args are a filter over `test.include`, so these paths only resolve once they
are registered there; verified empirically: `npm test -- <path>` runs exactly
that file, no extra flag needed):
```
npm test -- src/features/agent-chat/AgentChatPane.test.tsx src/features/agent-chat/ChatComposer.test.tsx src/features/agent-chat/ComposerControls.test.tsx src/features/agent-chat/composerBanners.test.ts src/features/agent-chat/ComposerBannerStack.test.tsx src/features/agent-chat/useAgentChatSocket.test.ts
```
then the full suite (below) — this is the first point where a bare `npm test`
picks up T1–T3's files at all.

---

## Review, fix, finalize

Review runs once, over the whole change — not per task.

**Review lenses (parallel):** spec conformance against
`docs/superpowers/specs/2026-08-15-composer-banner-stack-design.md` (especially
the Correction about `view.error` being transport-only, and the non-goals —
no `Alert`, no toast, no manual reconnect button, no navigation); TDD honesty
(do the tests in T1/T2/T3/T4 actually constrain behavior, particularly the
220ms two-phase-dismiss timing and the fold/dedupe rules, or are they written
to pass); regression risk in the untouched-by-contract files listed in T4's
"Regression, must stay green" section and in the spec's "Untouched" list
(`eventReducer.ts`, `MessagesTimeline.tsx`, `ComposerControls.tsx`,
`ComposerPromptEditor.tsx`, `ChatHeader.tsx`, `ChatStatusStrip.tsx`, the
vendored `components/ai-elements/*`).

**Fix:** apply confirmed findings only.

**Finalize:** `npm run typecheck` and `npm test` from `frontend/`.

## Known-good baseline

`npm test` (run from `frontend/`, verified against this exact working tree
before any task in this plan starts) shows **one pre-existing failure**:
`src/features/editor/monacoLspClient.guard.test.ts` — 120 test files pass, 1205
of 1206 individual tests pass. It is not caused by this work and must not be
"fixed" here. **Any second failing test file after this plan lands is a real
regression.**

(Do not diagnose the baseline via a `mergeConfig`-merged scratch vitest
config — concatenating `test.include` arrays runs the *entire* suite at once
and was observed to produce a spurious extra failure in
`AgentChatPane.test.tsx` under that specific merge, unrelated to this plan.
The scratch-config recipe above uses a direct object spread instead, which
does not exhibit this.)

## Commit granularity

The pre-commit hook typechecks the whole project, so this cannot be committed
task-by-task (see `CLAUDE.md`'s `devdeck precommit blocks incremental` note).
T1–T3 can be developed and verified independently in parallel worktrees, but
land as part of one commit once T4 integrates them — matching the spec's own
"Commit granularity" risk note: F lands as one commit.

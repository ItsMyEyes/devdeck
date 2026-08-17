# Composer — Banner Stack

> Spec 1e (subsystem **F**). Follows `2026-08-14-composer-shell-tiptap-editor-design.md`,
> which shipped the shell this mounts against.
>
> Ports t3code's `ComposerBannerStack.tsx` (208 lines) and wires it to the three
> conditions DevDeck can actually observe today. It ships **no new agent
> capability** and **no backend change** — not one Go file is touched.

## Where this sits

The decomposition table in spec G lists seven subsystems. F is the third to be
specified and the second with zero backend dependency:

| | Subsystem | Backend needed | State |
|---|---|---|---|
| **G** | Shell + prompt editor + controls | none | **landed** |
| **A** | Pending user-input & approval panels | approval broker, CLI control protocol | contract exists, unimplemented |
| **F** | Banner stack | none | **this spec** |
| **B/C/D/E** | Plans, attachments, command menu, drafts | various | not started |

G's agreed order was **G → A → F**. F is being specified before A ships, and
that is safe because the two occupy different slots and never collide:

- **A** fills `data-slot="composer-panels"` (`ChatComposer.tsx:191`) — *inside*
  the surface, above the editor, because an approval prompt and the text box
  are one interaction.
- **F** mounts *outside* the surface, above the `<form>` — because a banner is
  ambient. It reports a condition of the world; it does not participate in the
  turn. t3code makes the same split: the stack is a sibling rendered before the
  composer container, never inside it (`ChatView.tsx:6168` and `:6171`, the
  hero and docked mount points).

So F depends on G's shell existing (it does) and on nothing else. A may land
before or after it.

F also inherits G's build gate: agent chat is hidden in production builds via
`agentChatEnabled()` (`enabled.ts:18-23`). No new flag.

## Problem

Three real conditions are currently either invisible or catastrophically
over-rendered.

**A mid-thread reconnect is invisible.** `useAgentChatSocket` tracks
`'connecting' | 'open' | 'closed'` (`useAgentChatSocket.ts:27`) and reconnects
with exponential backoff up to 8s (`:32-34`, `:247-257`). `AgentChatPane`
consumes that status in exactly two places: a blocking "Connecting to the
agent…" message that only fires on the *first* connect
(`AgentChatPane.tsx:186-188` — `status === 'connecting' && view.items.length === 0`),
and a 7px coloured dot in the header (`ChatHeader.tsx:29-33`, `:64`). Once a
transcript exists, the socket can drop and stay down for eight seconds at a
time with no signal anywhere near where the user is typing. Meanwhile the
behaviour that makes this *safe* — commands queue in `outboxRef` and flush
verbatim on the next open (`useAgentChatSocket.ts:288-305`, `:217-218`), and
the engine on the runtime keeps consuming and persisting regardless (that
file's header comment, `:10-14`) — is documented only in source comments. The
user has no way to know their message is not lost.

**An error nukes the transcript.** `view.error` renders as a whole-pane
replacement: `AgentChatPane.tsx:226-228` puts `<PaneMessage tone="error">`
where `<MessagesTimeline>` would go. A single error frame therefore erases an
entire conversation from the screen. It also suppresses the hero layout —
`isEmpty` requires `view.error === null` (`:192`) — so a fresh thread that
cannot reach its socket loses its composer framing too.

> **Correction.** The brief for this spec called `AgentThreadView.error` "the
> thread error". It is not. `reduceAgentEvents` never assigns `error`: the only
> `error:` in `eventReducer.ts` is the `null` initialiser in `emptyThreadView`
> (`:16`), and the reducer's return spreads it through untouched (`:311-318`).
> Agent-reported failures become chat *items* of `kind: 'error'` instead
> (`:195-197`), rendered inline in the transcript. `AgentThreadView.error` is
> populated by exactly one writer — `transportError`, merged into the returned
> view at `useAgentChatSocket.ts:329-332`, set from an `error` frame (`:232`)
> or a socket that never opened (`:243`). It is a *transport* channel wearing a
> thread-shaped name. Every design decision below follows from that fact, and
> getting it wrong would have produced a banner that duplicates the transcript.

**A missing agent is discovered by failing.** `ExpandedTerminal.tsx:1138`
passes the worktree's configured agent (`agentId={worktree.agent || undefined}`)
straight through. `/api/agents` returns the *whole* catalog with an `installed`
flag rather than only what is present — deliberately, per
`backend/internal/service/agent.go:62-66` ("A missing binary is a status … never
an entry the list silently drops") — and the frontend already has that flag on
`AgentSummary` (`store/types.ts:370`) through `useAgents`
(`features/data/queries.ts:1407-1415`). `ModelPicker` uses it to keep its rail
from going empty (`ModelPicker.tsx:157-165`) but says nothing about it, and
`turnModel` only sets `instanceId` once a model is *picked*
(`AgentChatPane.tsx:67-75`), so an untouched composer on a worktree whose agent
is not installed will send a turn that cannot run. The information to warn
first is already in the client.

## Non-goals

- **Any backend change.** No Go file, no new endpoint, no new event type.
- **New agent capability.** After this lands the user can do exactly what they
  can do today; they are merely told what is going on.
- **Approval / user-input panels (A).** Those go inside the surface. A banner is
  not an approval prompt and must never be used as one.
- **A general `Alert` component.** See "Design §2".
- **Toasts.** `sonner` already exists and is the right tool for *transient,
  pane-independent* feedback. Banners are for standing conditions scoped to one
  thread, and they persist while the condition does.
- **A manual "Reconnect" button.** t3code offers one
  (`ChatView.tsx:1955-1968`) because its environments are user-managed
  connections. DevDeck's socket already retries automatically with a 500ms →
  8s backoff (`useAgentChatSocket.ts:32-34`, `:250`), and the hook exposes no
  imperative reconnect. A button would buy at most four seconds and would need
  new hook surface to exist at all.
- **Navigation actions.** No banner navigates. The one that could
  (agent-not-installed → `/w/$wsId/management`, `routes/w.$wsId.management.tsx`)
  would need `wsId` threaded into a component that is deliberately router-free
  and mounted deep inside a pane tree — and the remedy is already 40px below
  the banner, in the model picker. Copy points at it; nothing links.

## Design

### 1. What the stack is

Port `t3code/apps/web/src/components/chat/ComposerBannerStack.tsx` structurally
intact. `items[0]` is the front banner and is always visible; everything behind
it is collapsed to a 12px card edge peeking above it and expands on hover or
focus. The mechanics that matter, and must survive the port:

**Layout flow, never absolute.** The expanded region is a
`grid grid-rows-[0fr]` → `group-hover:grid-rows-[1fr]` over a
`min-h-0 overflow-hidden` child (`ComposerBannerStack.tsx:125-129`) — the only
way to animate to auto height. t3code guards this with a regression test that
asserts the expanded container's class list does **not** contain `absolute`
(`ComposerBannerStack.test.tsx:26`), because surrounding content has to move out
of the way rather than be covered. Port that assertion.

**DOM order is priority order; visual order is reversed.** The container is
`flex flex-col-reverse` (`:89`) with the front item first in the DOM (`:105`)
and the stacked items after (`:121`). Visually the front banner sits at the
*bottom*, nearest the composer, and the stack grows upward. Tab order therefore
follows priority while the eye follows proximity. t3code's test pins the DOM
order explicitly.

**The collapsed cap.** `absolute … -top-3 … h-3 rounded-t-[22px] border-b-0`
at 96% width (`:93-103`) — a sliver of a card behind the front one, faded out on
hover/focus as the real stack expands. Hidden entirely while the front banner
is exiting (`showCollapsedStackCap`, `:69`), so it never floats over nothing.

**Enter is instant; only exit is animated.** This is the detail most likely to
be "improved" by accident. `exitTransitionStyle`
(`transform 220ms ease-in, opacity 220ms ease-in`, `:21-23`) is spread onto
every item *including at rest*, and the resting style is
`{opacity: 1, transform: 'none'}` (`:17-20`). A newly mounted banner is
therefore painted at its resting position with no starting offset to transition
*from* — it appears. Only dismissal moves: the front banner slides
`translate3d(0, 4rem, 0)` and fades (`:9-12`); a stacked banner slides
`7rem` (`:13-16`). The 3rem difference is not decoration — a stacked banner
starts higher on the screen and must travel past the front banner to disappear
behind the composer, and both must arrive at the same place.

**Dismissal is a two-phase commit.** `requestDismiss` (`:71-83`) sets
`exitingItemId`, waits `DISMISS_TRANSITION_MS`, and only then calls
`item.onDismiss()`. So the parent's state — which is what actually removes the
item — changes *after* the animation, not before it. Three guards ride with it:
one dismissal at a time (`if (!item.onDismiss || exitingItemId) return`), the
exiting item is `pointer-events-none` (`:108`, `:141`), and its X button is
`disabled` (`:198`).

**The exiting id self-heals.** `exitingItemId` is not read from state directly;
it is state ∩ `items` (`:46-49`). If the parent removes a banner while it is
mid-exit — because its underlying condition went false on its own — the derived
value falls back to `null` instead of leaving the stack permanently
`pointer-events-none`. Every banner in F is derived from live state, so this
path is not hypothetical; it is the normal race.

### 2. No `Alert`, and no `alert-glass`

t3code's `Alert` (`ui/alert.tsx`) infers icon/content/action slots by walking
`children` and sniffing `displayName` (`:24-41`, `:57-70`). That indirection
earns its keep because `Alert` has many consumers there. Here it would have
exactly one. Build `ComposerBanner` as a plain three-column row —
icon / (title + description) / actions — with those as explicit props. Keep the
prop *names* (`icon`, `title`, `description`, `actions`) so a real `Alert` can
be dropped in later without touching a caller.

Tones map to existing DevDeck tokens (`styles/globals.css:448-457`), not to new
ones: `error` → `devdeck-red-tint*`, `warning` → `devdeck-yellow-tint*`, `info`
→ `devdeck-accent-tint`, `default` → `devdeck-raised` + `devdeck-hairline`.
`success` is **not** in the union: nothing in F produces one, and an unused
variant is a promise the tokens have to keep for no reader.

`alert-glass` (`ComposerBannerStack.tsx:177`) is a t3code class. The DevDeck
equivalent is `bg-devdeck-glass` + `--devdeck-glass-filter`
(`globals.css:42-46`), which already degrades correctly when the platform
cannot do backdrop-filter (`:371-377`). Use the tokens; do not port the class
name.

`Button size="icon-xs"` does not exist here — `button.tsx:38-45` stops at
`icon-sm` (h-7 w-7). Use `icon-sm`; do not add a size for one X.

### 3. Two deliberate deviations from the reference

**Keyboard reachability.** The stack expands on `group-hover` (mouse only) or
`group-focus-within`. Focus-within can only fire from a focusable element the
user can reach — and the stacked items are `invisible`
(`ComposerBannerStack.tsx:132`), i.e. `visibility: hidden`, which removes them
from the a11y tree and makes them unfocusable until the stack is already open.
So the only keyboard entry point is a control on the *front* banner. F's
highest-priority banner (connection) is deliberately not dismissible and has no
action, which would leave the stack behind it unreachable without a mouse — in
an app that also ships as a Tauri webview. Fix: when `items.length > 1`, the
stack root takes `tabIndex={0}` and an `aria-label` naming the count. Focusing
the root matches `:focus-within` on itself, so the existing group classes work
unchanged.

**`role` follows tone.** t3code's `Alert` hardcodes `role="alert"`
(`ui/alert.tsx:76`) — an assertive live region, on every banner. Three of those
appearing at once during a reconnect is a screen-reader interruption storm.
Here: `role="alert"` for the `error` tone only, `role="status"` (polite) for
everything else.

### 4. The banners DevDeck can populate today

Four conditions, three of which can coexist. The decision layer is a **pure
function** in a new `composerBanners.ts` — it returns descriptors carrying an
icon *key*, not a `ReactNode`, so the whole priority/fold/guard policy is
unit-testable with no DOM.

| # | id | Tone | Trigger (verified) | Dismissible |
|---|---|---|---|---|
| **F1** | `connection:<threadKey>` | `warning` | `status !== 'open'` and not already showing the blocking connect message | no |
| **F2** | `thread-error:<threadKey>` | `error` | `status === 'open' && view.error !== null` | yes → `clearError()` |
| **F3** | `agent-missing:<machineId>:<agentId>` | `warning` | agents query settled, `agentId` present in the catalog, `installed === false` | yes (local) |
| **F4** | `session-stopped:<threadKey>` | `info` | `view.status === 'stopped'` | yes (local) |

**F1 — connection.** Title `Reconnecting to <machine.name>` (or `Connecting…`
on the first attempt). Description says the thing the source comments already
know and the UI has never said: *the agent keeps working, and a message sent
now is queued and delivered on reconnect.* Both halves are true and cited —
`outboxRef` queues and replays verbatim without minting a new `commandId`
(`useAgentChatSocket.ts:170-172`, `:288-305`), and the engine outlives the
socket (`:10-14`). Not dismissible: the condition clears itself the moment
`ws.onopen` fires (`:197-199`). **Rule: a banner is dismissible if and only if
its condition does not clear itself.** A dismissible live condition just comes
back and teaches the user the X is broken.

**F2 — transport error.** Title is fixed (`The agent chat connection reported
an error`); `view.error` is the description, because error frames come from the
backend verbatim and can be long. Dismissible, and dismissal must clear the
error at its source — which requires the one piece of new plumbing in this
spec: **`useAgentChatSocket` gains `clearError()`** (`setTransportError(null)`)
on `UseAgentChatSocketResult`. Without it the banner could hide itself but
`view.error` would stay set, and `ComposerControls` — which consumes the same
value for its optimistic-pill revert (`ComposerControls.tsx:187-190`,
`:227-237`) — would keep seeing a rejection that the user has acknowledged.
Verified safe: `usePillState`'s effect re-runs on the `'x' → null` transition
and its body is `if (error !== null && pending !== null)`, a no-op on null.

**F1 and F2 are mutually exclusive, by fold.** When the socket is down, its
error is *about* being down; showing both would be two banners saying one
thing. t3code folds for exactly this reason and says so
(`ChatView.tsx:1920-1931`, `reconnectingThroughVersionSkew`). Nothing is lost
by suppressing F2 during an outage: `onopen` clears `transportError`
unconditionally (`useAgentChatSocket.ts:200`), so any decider rejection from
before the drop was going to vanish on reconnect regardless.

**F1 is also suppressed while `showConnecting` is on screen.** The blocking
"Connecting to the agent…" message (`AgentChatPane.tsx:186-188`, `:225`) is the
loading state `.claude/rules/frontend.md` requires and it already says this.
Same dedupe rule.

**F3 — agent not installed.** Three guards, all load-bearing. The query must be
*settled* (not `isLoading`, not `isError`) — an unreachable machine returns no
agents, and "your agent is not installed" is a lie in that case. The `agentId`
must be *present* in the returned catalog — it always is for a known agent
(`service/agent.go:67-82` decorates the full registry list), so an absent id
means something else is wrong and this banner is not the place to say so. Only
then does `installed === false` speak. Copy names the agent and points at the
model picker; it does not link anywhere (see non-goals).

**F4 — session stopped.** `view.status === 'stopped'` is real, event-derived
state: `thread.session-set` carries it (`eventReducer.ts:268-269`,
`:88-94`) from the backend's `SessionExited` (`orchestration/workers.go:170`).
Today it surfaces only as the word "Stopped" in the header's top-right corner
(`ChatHeader.tsx:22-27`, `:65`), which is nowhere near the box the user is
typing into. The banner says sending a message starts a new session — verified,
not assumed: every `EvtThreadTurnStartRequested` calls `ensureSession` before
`SendTurn`, and the comment at `workers.go:452-466` spells out that a turn can
never assume a live session. This is the direct analogue of t3code's
parked-thread banner, and like it, it is **last** in priority: informational,
must never cover anything (`ChatView.tsx:4374-4376`).

**Dismissal bookkeeping.** F3 and F4 are dismissed to a local `Set<string>` of
ids in `AgentChatPane`, and any id not in the currently-computed list is pruned
from that set. So dismissing a stopped-session notice hides it for that stop,
and a *later* stop shows it again — without inventing an occurrence counter.
This mirrors the component's own `exitingItemId ∩ items` derivation
(`ComposerBannerStack.tsx:46-49`): the same self-healing shape at a different
layer. It is a pure function and is tested as one. F1 needs none (not
dismissible); F2 needs none (dismissal clears the source).

### 5. Excluded — dead UI, and why

Every remaining t3code banner, and the state DevDeck does not have:

- **Server version mismatch / self-update** (`ChatView.tsx:1979-2010`). No
  version-skew or update state reaches this frontend at all — `versionMismatch`,
  `serverVersion`, `hubVersion` return zero hits across `frontend/src`.
- **Background liveness — "N agents working in the background"**
  (`ChatView.tsx:4319-4356`). Superficially derivable from
  `useDevDeckStore.agentThreads` (`useDevDeckStore.ts:371`), and that is the
  trap: that map is written only by `applyAgentEvents` (`:821-826`), which only
  fires for threads whose socket *this browser* has open. It cannot see a thread
  running on the runtime with no pane attached — which is precisely the
  population the banner claims to count. A count that under-reports background
  work is worse than no count, because the user acts on it.
- **Woke-from-snooze / snoozed / settled** (`ChatView.tsx:4360`, `:4377`). No
  snooze, wake, or settle concept exists anywhere in DevDeck — not in
  `domain/models.go`, not in `store/types.ts`.
- **Branch mismatch** (`ChatView.tsx:4425-4470`). Needs a recorded "branch this
  thread last ran on" to compare against the current checkout. DevDeck stores no
  such field; `branch` reaches the composer as a display string for the status
  strip (`ChatComposer.tsx:88`, `:247`) and nothing more. Worktrees are
  per-branch by construction here, which is why it was never recorded.
- **Sequence gaps.** `view.hasGap` (`types.ts:59`) is a genuine DevDeck signal
  and is deliberately *not* a banner: it already has a home, as an inline chip
  at the end of the transcript (`MessagesTimeline.tsx:403-408`). A gap is a
  property of the message log, so it belongs in the log.
- **Interrupt-not-yet-acknowledged.** `abortedAtSeq`
  (`useAgentChatSocket.ts:164`, `:328`) is real, and "Stop sent, waiting for the
  agent to settle" would be a legitimate banner — but the hook does not expose
  it, and the override is designed to expire on the very next event, typically
  in well under the 220ms the banner takes to animate out. A banner that
  flickers is noise. Not now; noted for whoever exposes it.

### 6. Dormant on purpose

The item shape keeps `actions?: ReactNode` and `actionClassName?: string`
(`ComposerBannerStack.tsx:31-35`), and `ComposerBanner` renders them, even
though **no banner in F supplies an action**. It also keeps the
`dismissOnly` action-layout branch (`:172`, `:186-190`), which only matters
once a banner has both an action and an X. B (plan surface) and A are the
callers that will want them, and the alternative — adding the slot later —
means re-opening the component instead of passing a prop.

With today's triggers the stack is at most **three** deep and usually one, so
the hover-expand path is rarely exercised in practice. That is not a reason to
skip it: it is the mechanism the later subsystems queue behind, and building it
now is cheaper than retrofitting priority and collapse onto a naive list.

### 7. Placement in the shell

The stack renders in `ChatComposer` as a sibling immediately *before* the
`<form>`, inside the outer wrapper (`ChatComposer.tsx:182-186`), carrying its
own copy of the measure — `mx-auto w-full min-w-0 max-w-3xl` — plus the
variant's horizontal inset (`px-5` docked, none in hero). It returns `null` when
empty, so an empty stack costs no DOM and no space.

**Do not hoist `max-w-3xl` / `px-5` / `@container/composer` off the `<form>` to
share a wrapper.** They look like duplication and are not: the container query
is sized off the whole form so the `@sm/composer` breakpoint measures the same
box it always has (that file's doc comment, `:47-52`, and `:185`). Moving the
padding to a parent would narrow the form by 40px and silently shift where the
control row collapses into the overflow popup.

The one vertical adjustment: the stack owns an `mb-2`, so the docked form's
`pt-3` becomes `pt-0` when banners are present. One ternary, stated here so it
is not rediscovered as a spacing bug.

`AgentChatPane` also changes:

- `view.error` no longer renders `<PaneMessage tone="error">`
  (`AgentChatPane.tsx:226-228`). The transcript stays on screen; the banner
  carries the error.
- `isEmpty` drops its `view.error === null` clause (`:192`), so a brand-new
  thread that cannot connect gets the hero layout with a banner above it,
  instead of losing its framing.
- `showConnecting` (`:188`) is unchanged. First-connect-with-no-content is a
  loading state and stays one.
- `controls.error` (`:167`) is unchanged. The pill-revert consumer keeps
  reading the same value.

## Data flow

```
useAgentChatSocket ──▶ status  ('connecting' | 'open' | 'closed')
        │              view.error   (transport only — see the Correction)
        │              view.status  ('idle' | 'running' | 'waiting' | 'stopped')
        │
useAgents(machine) ──▶ AgentSummary[].installed
        │
        ▼
  composerBanners({status, error, threadStatus, agents, agentId, showConnecting, dismissed})
        │                                   pure · no DOM · no React
        ▼
  ComposerBannerSpec[]        ordered: connection|error → agent-missing → stopped
        │
        ▼ (AgentChatPane attaches icons + onDismiss closures)
  <ChatComposer banners={…}>
        │
        ▼
  <ComposerBannerStack items={…}>   items[0] front · rest behind hover/focus
        │
        └── dismiss ──▶ 220ms exit ──▶ onDismiss() ──▶ clearError()  (F2)
                                                  └─▶ dismissed.add(id)  (F3/F4)
```

Nothing downstream of `onSend` changes. The socket protocol, the reducer, the
store slice and the backend see exactly what they see today.

## Testing

TDD, and the split follows the model spec: policy is pure and tested without a
DOM; only the animation and the collapse need a renderer.

**Unit — `composerBanners.test.ts` (no DOM):**
- open socket, no error, installed agent, idle thread → `[]`
- `status: 'closed'` with items → connection banner only, `dismissible: false`
- `status: 'closed'` **and** `view.error` set → still only the connection banner
  (the fold rule)
- `status: 'open'` + `view.error` → error banner, dismissible
- `showConnecting` true → no connection banner (the dedupe rule)
- agents query loading → no agent banner; agents query errored → no agent
  banner; `agentId` absent from the catalog → no agent banner
- agents settled + entry with `installed: false` → warning banner
- `view.status: 'stopped'` → info banner, and it is **last** in the array
- all three simultaneously → asserted by array index, not by presence
- dismissal pruning: an id dismissed while its condition holds stays out; the
  same id after the condition goes false and returns comes back

**Component — `ComposerBannerStack.test.tsx`:**
- one item → no `data-composer-banner-stack-expanded-items`, no collapsed cap
- two items → front is first in the DOM; the expanded container has
  `grid-rows-[0fr]` and `group-hover/banner-stack:grid-rows-[1fr]`, and does
  **not** contain `absolute` (ported from `t3code/…/ComposerBannerStack.test.tsx:26`)
- resting item renders `transform: none` and no starting offset — i.e. there is
  no enter animation to regress
- click X → `onDismiss` is **not** called synchronously; called after 220ms
  under fake timers; the X is `disabled` in between
- a second X click during an exit is ignored
- the item disappears from `items` mid-exit → the stack is interactive again
  (the `exitingItemId ∩ items` guard)
- unmount mid-exit → `onDismiss` never fires and nothing warns
- `items.length > 1` → the root is focusable and labelled

**Integration — `AgentChatPane.test.tsx`:**
- `status: 'closed'` with items → the timeline is **still rendered** and the
  connection banner is present (this is the defect being fixed)
- `view.error` with items → the timeline is still rendered, error banner present

**Existing tests — exact disposition.** Two touch the error path, and they do
not fare alike:
- `AgentChatPane.test.tsx:110` *"surfaces a thread error instead of rendering an
  empty timeline"* — **survives unmodified.** It asserts the error text is on
  screen; it now finds it in the banner.
- `AgentChatPane.test.tsx:136` *"gives the thread-error state the same height"*
  — **deleted.** It pins `min-h-[220px]` on the `PaneMessage` this spec removes
  for errors. Its sibling at `:124` guards the same regression for the
  *connecting* state, which keeps its `PaneMessage`, so the underlying lesson
  stays covered.
- `ChatComposer.test.tsx` — **unmodified.** It mounts `ChatComposer` without a
  `banners` prop (`:75`, `:92`); the prop defaults to `[]`.

**Regression, must stay green and unmodified:** `ComposerControls.test.tsx`,
`ComposerPromptEditor.test.tsx`, `composerSerialize.test.ts`,
`composerMention.test.ts`, `composerNodes.test.ts`, `MessagesTimeline.test.tsx`,
`eventReducer.test.ts`, `timeline.test.ts`, `adapter.test.ts`.

`npm test` shows one pre-existing failure in the monaco guard test. It is not a
regression from this work and must not be "fixed" as part of it.

## Risks

**Hover-expand shifts the transcript.** The expanded items are in layout flow by
design (§1), so revealing them shrinks the `Conversation` above
(`AgentChatPane.tsx:222` — `flex-1 min-h-0`) rather than covering it.
`use-stick-to-bottom` should hold the bottom, but a mid-scroll user may see a
jump. Accepted: today the stack is ≥2 deep only in genuinely bad states, and the
alternative (absolute positioning) is the exact thing t3code wrote a regression
test to prevent.

**Widening the hook's surface.** `clearError()` is the only new API. Verified
against its one other consumer (`usePillState`, §4). Nothing else reads
`view.error` — `AgentChatPane.tsx:167` forwards it and `:227` renders it, and
the latter is being removed by this spec.

**An adjacent defect this spec does not fix.** Two identical consecutive error
strings do not re-render: `setTransportError(frame.error)`
(`useAgentChatSocket.ts:232`) bails out when the value is `Object.is`-equal, so
`ComposerControls`' revert effect — keyed on `[error]` (`:237`) — never re-runs
and the optimistic pill stays wrong on the second rejection. Dismissing F2
drives the value to `null` and therefore makes the *next* identical error a real
transition, which incidentally repairs it for that path. That is a side effect,
not a fix, and must not be described as one. The real fix is an error *sequence*
or id, and it belongs with whoever revisits the wire protocol.

**Copy that overclaims.** F1 tells the user their queued message will be
delivered. That is true for the `outboxRef` path (`:302-303`) and false if the
pane unmounts first — the cleanup clears the outbox (`:278`). The copy must say
"queued" and must not promise delivery across a closed pane.

**Commit granularity.** The pre-commit hook typechecks the whole project, so
this cannot be committed file-by-file. F lands as one commit.

## Files

**New:**
- `frontend/src/features/agent-chat/ComposerBannerStack.tsx` — the ported stack
  plus the `ComposerBanner` row (§2)
- `frontend/src/features/agent-chat/ComposerBannerStack.test.tsx`
- `frontend/src/features/agent-chat/composerBanners.ts` — the pure decision
  layer (§4)
- `frontend/src/features/agent-chat/composerBanners.test.ts`

**Changed:**
- `ChatComposer.tsx` — new `banners` prop (default `[]`), stack rendered before
  the `<form>`, docked `pt-3` → `pt-0` when banners are present. The form's
  `max-w-3xl` / `px-5` / `@container/composer` do not move (§7).
- `AgentChatPane.tsx` — computes banners, holds the dismissal set, drops the
  error `PaneMessage`, relaxes `isEmpty`.
- `useAgentChatSocket.ts` — adds `clearError()` to `UseAgentChatSocketResult`.
- `AgentChatPane.test.tsx` — one test deleted, two added (§Testing).

**Untouched:** every Go file; `store/types.ts` and `useDevDeckStore.ts` (both
convergence files under `CLAUDE.md`'s orchestration rule); `eventReducer.ts`;
`MessagesTimeline.tsx`; `ComposerControls.tsx`; `ComposerPromptEditor.tsx` and
the whole `composerMention`/`composerNodes`/`composerSerialize` set;
`ChatHeader.tsx`; `ChatStatusStrip.tsx`; the vendored `components/ai-elements/*`.

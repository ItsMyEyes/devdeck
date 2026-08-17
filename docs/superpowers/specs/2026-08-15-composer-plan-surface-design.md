# Composer — Plan Surface (`ProposedPlanCard` + follow-up)

> Spec 1e / subsystem **B**. Follows `2026-08-14-composer-shell-tiptap-editor-design.md`.
>
> Ports t3code's proposed-plan surface: capture the plan the agent proposes,
> store it on the thread, render it as a card in the transcript, and turn the
> composer into a Refine/Implement control while it is on the table.
>
> **This spec cannot ship before subsystem A.** See "Where this sits".

## Where this sits

The composer decomposition table (`2026-08-14-composer-shell-tiptap-editor-design.md:15-25`)
lists B as *"Plan surface (`ProposedPlanCard`) — backend needed: `ExitPlanMode`
intercept, `thread.proposedPlans`"*, with the agreed order **G → A → F, then
B/C/D/E**. G has landed (`ComposerPromptEditor.tsx`, `composerSerialize.ts`,
and the `data-slot="composer-panels"` slot at `ChatComposer.tsx:189-191`). A has
not.

### The dependency on A is hard, not stylistic

The live CLI capture settles it. Two runs of the same binary (`claude` 2.1.233),
same `--permission-mode plan`, differing only in whether
`--permission-prompt-tool stdio` was passed:

| run | args | `ExitPlanMode` in `system/init` `tools` |
|---|---|---|
| `capture/e8_plan_nostdio` | **exactly DevDeck's `buildArgs`** for `InteractionPlan` (`--print --output-format stream-json --input-format stream-json --verbose --include-partial-messages --permission-mode plan`) | **absent** |
| `capture/m_stdio_plan` | the same, plus `--permission-prompt-tool stdio` | present, with `AskUserQuestion` and `EnterPlanMode` |

In `e8_plan_nostdio` the prompt *explicitly told the model to call
ExitPlanMode*. It called `ToolSearch` three times looking for it (lines 136,
160, 182 of that run's `stdout.ndjson`), never found it, and wrote the plan
into `~/.claude/plans/…md` with an ordinary `Write` instead. There is no plan
to capture, because in DevDeck's current configuration **the tool does not
exist**.

`--permission-prompt-tool stdio` is A's flag: it is what turns the CLI's
auto-denial into a `control_request` DevDeck can answer. B does not get to add
it independently — passing it without A's broker would make every tool call
block forever waiting for a `control_response` nobody sends
(`RespondToRequest` is a documented no-op at `claude/adapter.go:428-430`).

**Ordering: A ships, then B.** B needs exactly two things from A, and A's spec
must reserve them:

1. `--permission-prompt-tool stdio` in `buildArgs` (`claude/adapter.go:142-221`).
2. A branch point in A's `control_request` classifier. The capture shows three
   kinds of `can_use_tool` request arriving on one channel, discriminated by
   two fields:
   - `tool_name:"AskUserQuestion"` + `requires_user_interaction:true` → A's
     user-input path;
   - `tool_name:"ExitPlanMode"` + `requires_user_interaction:true` → **B**;
   - everything else → A's approval path.

   If A ships without that third branch, an ExitPlanMode request renders as a
   generic "allow this tool?" card — the wrong UI for a plan, and the wrong
   semantics (see §1.3 on why B answers it `deny`).

Nothing else in this spec depends on A. The capture path (§1.1), the event, the
projection, the card and the composer banner are all independent of how A
implements its broker.

## Problem

### 1. Plan mode is wired as a flag, and only as a flag

`claude/adapter.go:158-162` appends `--permission-mode plan` when
`in.Interact == provider.InteractionPlan`. That is the whole of DevDeck's plan
support: nothing downstream reads the plan back. `grep -rn "ExitPlanMode"
backend/` returns zero hits.

### 2. In the normal flow that flag never reaches a live process

Worse than "nothing reads it": nothing *sets* it either.

- A session starts on `EvtThreadCreated` (`workers.go:440`), which is dispatched
  by `AgentWSHandler.autoCreateThread` on the WebSocket's hello
  (`agent_ws.go:132-141`) — before the user has touched anything.
- `applyOne` seeds a new thread with `Interact = provider.InteractionDefault`
  (`engine.go:239-241`), and `ensureSession` reads `t.Interact` at
  `workers.go:592-595`. So the CLI is spawned in default mode.
- Flipping the composer's Plan pill dispatches `thread.interaction-mode.set`.
  `EvtThreadInteractionModeSet` **is** in `IntentEvents` (`command.go:139`), so
  the Reactor receives it — and `Reactor.react`'s switch
  (`workers.go:433-548`) has no case for it. It falls through to `return nil`.
- The next turn calls `ensureSession` again, which is a deliberate no-op once
  the thread is bound to a live adapter (`workers.go:574-578`).

Net effect: `--permission-mode plan` is passed only to a session started while
`Thread.Interact` was already `plan` — i.e. after a server restart, or after
the previous CLI died. In the ordinary "open a chat, press Plan, type" flow it
is never passed at all.

### 3. The plan does not arrive where the parser is looking

The obvious place to read the plan is the tool-call stream DevDeck already
parses: `startContentBlock` (`parse.go:311-333`) announces a `tool_use` block
and `stopContentBlock` (`parse.go:363-380`) publishes its accumulated
`input_json_delta` as `ItemCompletedPayload.Detail`.

> **Correction.** An earlier reading of this — including the capability survey
> this spec was briefed with — assumed that path would carry the plan.
> It does not. In `capture/m_stdio_plan/stdout.ndjson`, `ExitPlanMode`'s block
> streams **zero bytes** of `input_json_delta` (`content_block_start` at line
> 139, one delta with `partial_json:""` at line 140, `content_block_stop` at
> line 143 — accumulated length 0), while every other tool in the same run
> streams its full input (`Write` 650 bytes, `ToolSearch` 50, `Bash` 52). So
> `json.Valid("")` is false and `Detail` is nil: today DevDeck renders
> `ExitPlanMode` as a dead, un-expandable tool row (`MessagesTimeline.tsx:202-220`
> disables a row whose `input` is undefined) and drops the plan on the floor.

The plan markdown reaches DevDeck on exactly two lines, both of which the
parser currently discards:

- the `"type":"assistant"` message (line 141), whose `tool_use` block carries
  the complete `input` — `parse.go:175-182` returns nil for `"assistant"` on
  purpose, because it normally duplicates streamed content;
- the `"type":"control_request"` (line 142), which `parse.go:183-191` turns into
  a `RuntimeWarning`.

Both carry identical keys: `{"plan": "...", "planFilePath": "/Users/…/.claude/plans/<slug>.md"}`.
The `assistant` line arrives **first**.

### 4. There is nowhere to put a plan and nothing to render it

`orchestration.Thread` (`engine.go:27-47`) has no plan field; there is no
plan-shaped event to project. `ChatItemKind` (`types.ts:13`) is
`'user' | 'assistant' | 'reasoning' | 'tool' | 'error'`. `buildTimeline`
(`timeline.ts:37-60`) has no plan entry. All four are greenfield.

## Non-goals

- **Anything A owns.** `--permission-prompt-tool stdio`, the approval broker,
  the `control_response` writer, `AskUserQuestion`. B consumes A's plumbing; it
  does not build it.
- **`EnterPlanMode`.** The capture exposes it alongside `ExitPlanMode`, but
  nothing in this surface needs the agent to *enter* plan mode from inside a
  turn — the composer pill is the only entry point here.
- **The plan file on disk.** The CLI writes every plan to
  `~/.claude/plans/<slug>.md` on the *agent's* host and reports the path as
  `planFilePath` (verified in both `m_stdio_plan` and `e8_plan_nostdio`). Store
  it as metadata; do not read it, link it, or offer to open it. DevDeck's file
  APIs are worktree-scoped, and for a remote runtime that path is not on the
  user's machine.
- **`turn.plan.updated` / TodoWrite step lists.** `event.TurnPlanUpdated`
  already exists unused at `event/event.go:41`; t3code's `deriveTurnPlans`
  (`session-logic.ts:604-643`) renders those as a per-turn chip. Different
  feature, different event, not this spec.
- **Plan history.** One plan per thread — the latest. t3code keeps an array
  (`findLatestProposedPlan`, `session-logic.ts:645-676`) because it has a
  thread-level `proposedPlans` table; DevDeck's transcript already holds every
  plan chronologically as an item, so the array is redundant.
- **Drafts and stash (E), attachments (C), command menus (D), banner stack (F).**
- **Provider generality.** `provider.Capabilities.SupportsPlanMode` exists
  (`provider/provider.go:104`, `true` for claude, `false` for pi) and is read by
  nothing — `grep` confirms zero consumers. Gating the Plan pill on it is a
  correct follow-up and is out of scope here.

## Design

### 1. Capture

#### 1.1 The `assistant` path — primary, and A-independent

Narrow `parse.go:175-182`. `"user"` and `"rate_limit_event"` keep returning nil;
`"assistant"` gains one scan: for each content block with
`type == "tool_use"` and `name == "ExitPlanMode"`, read `input.plan`; if it is a
non-empty string after trimming, emit one `event.TurnProposedCompleted`. Any
other assistant line still returns nil, so the "deliberately not mapped"
contract is otherwise untouched.

This mirrors t3code's `ClaudeAdapter.ts:2908-2924` and reuses its extractor's
rule verbatim (`extractExitPlanModePlan`, `ClaudeAdapter.ts:1379-1389`:
non-empty string, trimmed, else undefined).

#### 1.2 The `control_request` path — redundancy inside A

Inside A's `control_request` case, `tool_name == "ExitPlanMode"` emits the same
event from the same extractor (t3code: `ClaudeAdapter.ts:3919-3939`).

**Dedupe by `tool_use_id`.** `parseState` gains
`capturedPlans map[string]bool`, keyed exactly as t3code's
`exitPlanCaptureKey` (`ClaudeAdapter.ts:1391-1399`): `tool:<toolUseId>` when a
tool-use id is present, else `plan:<markdown>`. The capture shows the
`assistant` line arriving *before* the `control_request` with the same
`tool_use_id` (`toolu_01UNeXLedXjsmJ25eWTgfoHr` on both lines 141 and 142), so
in practice §1.1 wins and §1.2 is suppressed. Keeping both is what makes the
capture survive a CLI release that moves the plan from one line to the other.

The map is per-session state on `parseState`, not per-turn, and is never
cleared: a thread proposing a second plan gets a second `tool_use_id`.

#### 1.3 Answering the request: `deny`, with t3code's message

A's broker must not surface ExitPlanMode to the user. It answers immediately:

```json
{"behavior":"deny","message":"The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn."}
```

verbatim from `ClaudeAdapter.ts:3934-3938`.

The alternative is one line away and is wrong here. Answering `allow` makes the
CLI inject *"User has approved your plan. You can now start coding…"* and leave
plan mode inside the same turn — verified live at `m_stdio_plan` line 145. That
would make the Implement button meaningless (the agent is already coding) and
would have it code with `--permission-mode plan` still set on the process. The
user approves a plan in DevDeck by pressing Implement, which starts a new turn
in the mode they chose.

#### 1.4 Suppress the dead tool row

`startContentBlock` returns nil for a `tool_use` block named `ExitPlanMode`,
recording the block kind so `stopContentBlock` skips it too. Otherwise the
transcript shows a disabled "ExitPlanMode" row directly above the plan card
that replaces it.

Keep the `input_json_delta` accumulation and leave a comment naming §1.1 as the
source of truth: if a future CLI starts streaming the plan through the block,
that is where it will appear.

### 2. Canonical event

New in `event/event.go`, matching t3code's `turn.proposed.completed`
(`ClaudeAdapter.ts:2085-2131`) and sitting in the existing turn family beside
`TurnPlanUpdated` / `TurnDiffUpdated`:

```go
TurnProposedCompleted Type = "turn.proposed.completed"

type ProposedPlanPayload struct {
    PlanMarkdown string `json:"planMarkdown"`
    PlanFilePath string `json:"planFilePath,omitempty"` // agent-host path, metadata only
    ToolUseID    string `json:"toolUseId,omitempty"`
}
```

Registered in `payloadRegistry` (`event/event.go:293-306`) — an unregistered
type decodes to a nil payload and the plan would vanish on the first replay
through `Event.UnmarshalJSON`.

### 3. Orchestration

Following the naming rule at `command.go:19-23` (imperative dotted command,
past-tense hyphenated event):

- `CmdThreadPlanPropose CommandType = "thread.plan.propose"` — **server-only**.
  It goes in the reactor-only block at `command.go:42-46` and **must not** be
  added to `ClientDispatchable` (`command.go:51-61`): a client that could
  dispatch it could forge an agent's plan, which is the same class of forgery
  `assistant.delta` is excluded for.
- `EvtThreadPlanProposed EventType = "thread.plan-proposed"`, carrying the
  payload above. Not an `IntentEvent` — it triggers no provider call.
- `Ingestion.handle` (`workers.go:100-187`) gains a case for
  `event.TurnProposedCompleted` before the default branch. Without it the
  default branch forwards the whole envelope as generic activity — which would
  reach the client, but as an opaque blob outside the projection, so
  `Thread.ProposedPlan` would never be set.

**Projector.** `Thread` (`engine.go:27-47`) gains:

```go
// ProposedPlan is the plan currently on the table, or nil. Set by
// EvtThreadPlanProposed; cleared by the next EvtThreadTurnStartRequested,
// because any following turn supersedes it (t3code spells the same rule as an
// implementedAt column — see session-logic.ts:678-682).
ProposedPlan *ProposedPlan
```

Two cases in `applyOne` (`engine.go:227-345`): set on
`EvtThreadPlanProposed`, `nil` on `EvtThreadTurnStartRequested`. That is the
whole rule, and it is the same two events the frontend keys off in §5 — so the
two projections agree by construction rather than by discipline.

### 4. Making plan mode reach a live session

Problem §2 must be fixed here or B has nothing to capture. Three options, in
preference order:

**(a) `set_permission_mode` on the live session.** The CLI's embedded schema
documents a `control_request` subtype `set_permission_mode` alongside
`interrupt` (`capture/strings.txt`). If it works, `Reactor.react` gains an
`EvtThreadInteractionModeSet` case that calls a new
`Adapter.SetInteractionMode`, which writes one control frame — no restart, no
lost conversation.

**This is documented, not verified.** No capture run exercised it. Implementing
(a) is gated on a live-capture run first, in the same harness
(`capture/drive.py`); if the CLI ignores it or errors, fall back to (b).

**(b) Restart the session on mode change — requires plumbing resume first.**
`main.go:474-491` builds `SessionStartInput` with `ThreadID` and `Cwd` only.
`Thread.ResumeCursor` is stored (`engine.go:324-326`) and `buildArgs` will pass
`--resume` when given one (`claude/adapter.go:197-202`), but nothing connects
them, so a restart today silently starts a *new* conversation. (b) therefore
costs a `main.go` change — a convergence file under CLAUDE.md's orchestration
rules — and must be serialized, not done from a parallel agent.

**(c) Do nothing and document it.** Rejected: it makes the Plan pill a lie.

Whichever lands, the ordering matters for the Implement button (§7), which
dispatches `thread.interaction-mode.set` and then `thread.turn.start`. Both go
through the engine's single command loop and the Reactor's single-goroutine
loop in order (`engine.go:440-451`, `workers.go:366-390`), so the mode change
reaches the CLI before the turn. Do not "optimize" that into one command.

### 5. Frontend read model

`ChatItemKind` (`types.ts:13`) gains `'plan'`. `reduceAgentEvents`
(`eventReducer.ts:251-319`) gains a branch on
`event.type === 'thread.plan-proposed'` that appends
`{ id: <toolUseId ?? eventId>, kind: 'plan', text: planMarkdown, … }`. Keying
on `toolUseId` is what makes a replayed tail idempotent — the same guard the
tool path already relies on.

`AgentThreadView` gains **no new field.** "Is there a plan on the table" is a
pure function over `items` in a new `plan.ts`:

```ts
latestProposedPlan(items)   // the last 'plan' item with no 'user' item after it
```

Deriving it beats storing it: it is the same rule the backend projector applies
in §3, it replays exactly, and it cannot go stale the way a second field can.
This is the one place this spec deliberately diverges from t3code, which
carries `implementedAt` on a `ProposedPlan` row and derives
`hasActionableProposedPlan` from it (`session-logic.ts:678-682`).

`buildTimeline` (`timeline.ts:37-60`) emits `{ kind: 'plan', item }` for those
items. That shape is a drop-in: `entryCreatedAt`/`entryCompletedAt`
(`adapter.ts:76-94`), `turnSpans` (`adapter.ts:154-168`) and `entryKey`
(`MessagesTimeline.tsx:53-56`) all read `entry.item` for anything that is not a
`tool-group`, so none of them change. `messageRole('plan')` already returns
`'assistant'` via its default branch.

### 6. `ProposedPlanCard`

New `frontend/src/features/agent-chat/ProposedPlanCard.tsx`, ported from
`t3code/apps/web/src/components/chat/ProposedPlanCard.tsx:148-205`, plus
`planMarkdown.ts` — a direct port of `t3code/apps/web/src/proposedPlan.ts`
(`proposedPlanTitle`, `stripDisplayedPlanMarkdown`,
`buildCollapsedProposedPlanPreviewMarkdown`, `buildProposedPlanMarkdownFilename`,
`normalizePlanMarkdownForExport`, `buildPlanImplementationPrompt`,
`resolvePlanFollowUpSubmission`). Those are pure string functions with a real
test file next to them upstream (`proposedPlan.test.ts`); port the tests too.

Substitutions for DevDeck's component set:

| t3code | here |
|---|---|
| `ChatMarkdown` | `MessageResponse` from `@/components/ai-elements/message` with the `chat-md` class, as `MessagesTimeline.tsx:100` already does |
| `Badge variant="secondary"` | `@/components/ui/pill` |
| `Menu`/`MenuItem` | `TabStripPopoverMenu` (`@/components/ui/tab-strip-popover-menu`), the pattern `ChatComposer.tsx:211-221` already uses |
| `Dialog…` | `@/components/ui/dialog` |
| `toastManager` | `toast` from `sonner`, per `.claude/rules/frontend.md` |
| `writeProjectFile` atom command | `writeWorktreeFile(machine, worktreeId, path, content)` — `lib/machineApi.ts:97` |

Collapse threshold stays t3code's: >900 characters or >20 lines
(`ProposedPlanCard.tsx:71`), preview capped at 10 visible lines
(`:73-75`).

**Call the typed helper, not `fetch`.** Same rule the G spec set for
`searchWorktreeFiles`: `writeWorktreeFile` routes through `machineRequest`, which
is what makes "Save to workspace" work when the worktree lives on a remote
machine.

### 7. The composer's plan follow-up

Port `showPlanFollowUpPrompt` (`t3code ChatView.tsx:2156-2160`). Here:

```
interactionMode === 'plan'  &&  view.status === 'idle'  &&  latestProposedPlan(view.items) !== null
```

t3code also requires `pendingUserInputs.length === 0`; DevDeck has no pending
user inputs until A ships, and `view.status === 'idle'` already excludes
`'waiting'`, so the condition is equivalent today. Add the explicit clause when
A lands.

**Banner.** `ComposerPlanFollowUpBanner.tsx`, ported from the 28-line t3code
original — a "Plan Ready" pill plus the plan title. It mounts in the
`data-slot="composer-panels"` div the G spec reserved at
`ChatComposer.tsx:189-191`. That slot is also where A's approval and
user-input panels go, so the two specs collide there: whichever lands second
owns making the slot a stack rather than a single child. Since A lands first,
**B owns it**.

**Action button.** `ChatComposer.tsx:167` currently decides send-vs-interrupt
from the draft alone. In the follow-up state it becomes three-way
(`ComposerPrimaryActions.tsx:148-170`):

| draft | button | submits |
|---|---|---|
| non-empty | **Refine** | the draft, `interactionMode` stays `plan` |
| empty | **Implement** | `PLEASE IMPLEMENT THIS PLAN:\n<plan>`, `interactionMode` → `default` |

That mapping is `resolvePlanFollowUpSubmission` (`proposedPlan.ts:77-93`) —
ported as a pure function and unit-tested, not re-derived in the component. The
existing steer/interrupt logic is unchanged outside the follow-up state, and its
comment (`ChatComposer.tsx:150-167`) stays.

`AgentChatPane` already owns `interactionMode` (`AgentChatPane.tsx:144`) and the
setter that dispatches it (`:158-161`), so Implement is: set the mode, then send
the text. Both already exist.

### 8. Sessions sidebar badge

`Thread.ProposedPlan` earns its place by being read. `AgentThreadHandler.withLiveStatus`
(`agent_thread.go:56-67`) already overlays engine state onto each row; it gains
one line setting a new `domain.AgentThread.PlanReady bool`
(`domain/agent.go:130-140`), and `SessionsPanel` renders a "Plan" pill beside
the status dot — t3code's `hasActionableProposedPlan` on the thread list
(`Sidebar.logic.ts:641`).

This crosses the domain-sync contract: `domain/agent.go` and the frontend
`AgentThread` interface (`features/data/queries.ts:1359-1369`) must change
together in one commit. No SQL column is added — the flag is overlaid from the
engine, exactly as `Status` already is, and for the reason that comment gives:
a SQL copy of a rule the projector owns is a second implementation to keep in
step.

## Data flow

```
                    ┌─ A: --permission-prompt-tool stdio ─┐
                    ▼                                     │
  claude CLI  ──"assistant" tool_use ExitPlanMode──▶ parse.go §1.1 ─┐
              └─"control_request" can_use_tool ────▶ parse.go §1.2 ─┤ dedupe by tool_use_id
                        ▲                                          ▼
                        └── deny "…captured your plan" ──── event.TurnProposedCompleted
                            (A's broker, §1.3)                     │
                                                                   ▼
                                              Ingestion → CmdThreadPlanPropose
                                                                   │
                                                    engine.Decide → EvtThreadPlanProposed
                                                          ╱                    ╲
                                        applyOne: Thread.ProposedPlan      store.CommitAgentEvents
                                                  │                             │
                                    GET /api/agent/threads                  /ws/agent
                                       (planReady, §8)                          │
                                                                                ▼
                                                          reduceAgentEvents → ChatItem{kind:'plan'}
                                                                    ╱                     ╲
                                              buildTimeline → ProposedPlanCard    latestProposedPlan()
                                                                                          │
                                                                          ComposerPlanFollowUpBanner
                                                                          + Refine / Implement
                                                                                          │
  claude CLI  ◀── thread.turn.start ("PLEASE IMPLEMENT THIS PLAN:…") ◀────────────────────┘
                  preceded by thread.interaction-mode.set → default
```

The plan crosses the wire exactly once, as a durable event. Everything the UI
shows is folded from that event, so a reconnect replays the card and the banner
identically (`agent_ws.go:109-121`).

## Testing

TDD. Most of this is pure.

**Go — unit, no process:**
- `extractPlan` on the real `input` object: present/non-empty, present/blank,
  absent, wrong type.
- `parseLine` over a new `testdata/plan.ndjson`, cut from
  `capture/m_stdio_plan/stdout.ndjson` (paths sanitized): asserts exactly one
  `TurnProposedCompleted` across the whole file even though the plan appears on
  both the `assistant` and the `control_request` line, and asserts **no**
  `ItemStarted`/`ItemCompleted` for the ExitPlanMode block (§1.4).
- A guard asserting the fixture's `assistant` line still carries
  `input.plan` — that is the only thing standing between a CLI recapture and a
  silently lost plan (§1.1). It must fail loudly, not degrade.
- The existing fixture stays: `testdata/turn.ndjson` was captured at CLI
  2.1.224 and the plan fixture is 2.1.233, so `parse.go`'s package comment
  (`parse.go:1-22`) gains a second version note rather than being overwritten.
- Decider/projector table: `EvtThreadPlanProposed` sets `Thread.ProposedPlan`;
  the next `EvtThreadTurnStartRequested` clears it; `CmdThreadPlanPropose` is
  absent from `ClientDispatchable`.
- `AgentWSHandler` rejects a client-sent `thread.plan.propose` with the
  "not client-dispatchable" error (`agent_ws.go:224-227`).

**TypeScript — unit, no DOM:**
- Every function ported from `proposedPlan.ts`, using t3code's own
  `proposedPlan.test.ts` as the starting table.
- `latestProposedPlan`: none; one; two (returns the later); one followed by a
  `user` item (returns null).
- `reduceAgentEvents`: a `thread.plan-proposed` event produces one `plan` item;
  replaying it twice produces one.
- `buildTimeline` emits a `plan` entry and does not fold it into a tool group.

**Component:**
- The card renders collapsed above the threshold and expands on click.
- Copy / Download / Save-to-workspace call the right helper; Save is disabled
  with no worktree.
- The banner appears only when all three follow-up conditions hold; flipping
  the pill to Build hides it.
- Empty draft → Implement submits the `PLEASE IMPLEMENT THIS PLAN:` text and
  sets interaction mode to `default`; non-empty draft → Refine submits the
  draft and leaves the mode alone.

**Regression — must stay green, unmodified:** `ChatComposer.test.tsx`,
`ComposerControls.test.tsx`, `AgentChatPane.test.tsx`,
`MessagesTimeline.test.tsx`, `eventReducer.test.ts`, `timeline.test.ts`,
`adapter.test.ts`, `SessionsPanel.test.tsx`, `parse_test.go`.

`npm test` shows one pre-existing failure in the monaco guard test. Not a
regression from this work; do not "fix" it here.

**Live capture, before implementation, not after:**
1. Deny an `ExitPlanMode` request and record what the CLI does next — no run in
   `capture/` ever denied one, so §1.3's downstream behaviour (does the turn
   emit a final `result`? does the thread settle to idle?) is **unverified**.
2. `set_permission_mode` on a live session (§4a).

Both go through the existing harness (`capture/drive.py`). Live capture beats
vendor docs here: this repo has already been bitten by trusting a provider's
own documentation over its binary.

## Risks

**A slips, or A ships without the ExitPlanMode branch.** Then B has no plan to
capture and no place to answer from. Mitigation is the explicit contract in
"Where this sits" — two named items A's spec must reserve.

**The deny path is unverified.** If denying leaves the turn hanging rather than
settling, the banner never appears (it requires `status === 'idle'`) and the
composer sits on Stop. This is exactly the failure the repo has hit before —
reporting a state without settling the thread (`workers.go:412-431`). Capture
first (see Testing), and if the CLI does not settle, the Ingestion case for
`TurnProposedCompleted` also dispatches the idle status, the same belt-and-braces
`eventReducer.ts:300-302` already applies to errors.

**Two projections of "is a plan on the table."** §3 (Go) and §5 (TS). They key
off the same two events by design, and both are table-tested. Any future rule
that changes one must change the other in the same commit.

**The `composer-panels` slot has two owners.** A's panels and B's banner. B
lands second and owns making it a stack. If A hardcodes a single child, B pays
to undo it.

**CLI drift.** The plan rides the `assistant` line today and the block streams
nothing. Both facts are 2.1.233-specific. The dedupe key means a version that
moves the plan between lines still produces one event; a version that removes it
from both fails the fixture guard loudly.

**Commit granularity.** The pre-commit hook typechecks the whole project, so
this cannot land file-by-file. B lands as one commit — including the
`domain/agent.go` + `queries.ts` pair from §8, which must not be split.

## Files touched

**Backend — new:** `claude/testdata/plan.ndjson`.

**Backend — changed:**
`event/event.go` (event type, `ProposedPlanPayload`, registry),
`claude/parse.go` (§1.1, §1.2 hook, §1.4, `capturedPlans`),
`orchestration/command.go` (command + event constants; **not**
`ClientDispatchable`),
`orchestration/engine.go` (`Thread.ProposedPlan`, two `applyOne` cases,
`clone`),
`orchestration/workers.go` (`Ingestion.handle` case; §4's
`EvtThreadInteractionModeSet` case in `Reactor.react`),
`handler/agent_thread.go` (§8),
`domain/agent.go` (§8 — domain-sync pair).
`cmd/server/main.go` **only if** §4 falls back to (b); serialize that edit.

**Frontend — new:** `ProposedPlanCard.tsx`, `ComposerPlanFollowUpBanner.tsx`,
`planMarkdown.ts` (+ tests), `plan.ts` (+ tests).

**Frontend — changed:** `types.ts` (`'plan'` kind, `ChatItem`),
`eventReducer.ts` (one branch), `timeline.ts` (one entry kind),
`MessagesTimeline.tsx` (render the plan entry),
`ChatComposer.tsx` (banner slot, three-way action button),
`AgentChatPane.tsx` (thread the follow-up submit),
`SessionsPanel.tsx` + `features/data/queries.ts` (§8).

**Untouched:** `useAgentChatSocket.ts`, `adapter.ts`, `composerSerialize.ts`,
`ComposerPromptEditor.tsx`, `ComposerControls.tsx`, `handler/agent_ws.go`,
`store/agentevent.go` (no new column — the flag is overlaid, §8), the vendored
`components/ai-elements/*`.

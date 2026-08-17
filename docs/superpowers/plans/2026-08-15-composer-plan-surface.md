# Plan — Composer Plan Surface (subsystem B)

Spec: `docs/superpowers/specs/2026-08-15-composer-plan-surface-design.md`

Format model: `docs/superpowers/plans/2026-08-14-composer-shell-tiptap-editor.md`
(dependency-shape diagram + file-ownership table).

Execution: TDD throughout. Tests are written before the implementation they
cover, and every task ends with its own tests green.

## Hard prerequisite — read this before starting any task

**Subsystem A must already be merged.** The spec is explicit (`design.md`
"Where this sits"): with DevDeck's current `buildArgs`, `ExitPlanMode` is not
in the CLI's tool list at all — it only appears once `--permission-prompt-tool
stdio` is passed, which is A's flag (`claude/adapter.go:142-221` today, before
A lands). As of this plan's authoring, A has **not** shipped in this working
tree — `grep -rn "ExitPlanMode" backend/` returns zero hits, and
`RespondToRequest` is still the documented no-op at
`claude/adapter.go:428-430` ("no adapter opens a request yet... the real
implementation lands in spec 2"). Do not start T4 or T5 until:

1. A's `--permission-prompt-tool stdio` flag is in `buildArgs`, and
2. A's `control_request` classifier exists with a branch point ready for a
   third case (`tool_name:"ExitPlanMode"`).

If A's actual landed shape differs from what the spec assumes (exact
function/file for the `control_request` classifier), T4 and T5's tasks below
name the current location as a starting point and say explicitly where to
re-verify against A's real diff before editing.

**A second, more concrete gap found while grounding this plan:** the spec
cites a `capture/` directory (`capture/drive.py`, `capture/e8_plan_nostdio`,
`capture/m_stdio_plan`, `capture/strings.txt`) as primary evidence throughout,
including the Testing section's "Live capture, before implementation, not
after." That directory **does not exist anywhere in this repository** —
verified with `find` from the repo root, a search of `git log --all` across
every branch, and a filesystem-wide search for `drive.py`/`m_stdio_plan`, all
empty. Whatever ephemeral session produced those captures was not committed.
T1 below treats capture as a from-scratch task, not "run the existing
harness."

## Dependency shape

```
Wave 1 (fully independent — start immediately, 5-way parallel)
  T1 capture spike ──────────────────────────────────┐
  T2 event.go ──────────────┬─────────────────────┐  │
  T3 command.go+engine.go ──┴──────────────────────┼──┤
  T7 read model (types/eventReducer/plan.ts)  ┐     │  │
  T8 ProposedPlanCard + planMarkdown.ts       ┘     │  │
                                                     ▼  ▼
Wave 2 (each needs ≥1 wave-1 task — 5-way parallel)
  T4 parse.go            ◀── T2 (+ sourced from T1's capture)
  T5 workers.go + provider plumbing ◀── T1, T2, T3
  T6 sidebar plan badge  ◀── T3
  T9 timeline.ts         ◀── T7
  T10 ComposerPlanFollowUpBanner.tsx ◀── T7, T8

Wave 3 (2-way parallel)
  T11 MessagesTimeline.tsx render ◀── T9, T8
  T12 ChatComposer.tsx + AgentChatPane.tsx wiring ◀── T10
```

T11 and T12 do not depend on each other — disjoint files (transcript render
vs. composer shell) — so they run in parallel in wave 3 even though both
descend from the same wave-1/2 lineage.

## File ownership

No two tasks write the same file.

| Task | Writes |
|---|---|
| T1 | *(no `src`/`internal` files — writes to a new `capture/` dir outside the app trees; see task)* |
| T2 | `backend/internal/agentcore/event/event.go`, `event/event_test.go` |
| T3 | `backend/internal/agentcore/orchestration/command.go`, `orchestration/engine.go`, `orchestration/decider_test.go`, `backend/internal/handler/agent_ws_test.go` |
| T4 | `backend/internal/agentcore/provider/claude/parse.go`, `claude/parse_test.go`, `claude/testdata/plan.ndjson` (new) |
| T5 | `backend/internal/agentcore/orchestration/workers.go`, `orchestration/workers_test.go`, `orchestration/workers_reactor_test.go`, `backend/internal/agentcore/provider/provider.go`, `provider/provider_test.go`, `provider/claude/adapter.go`, `provider/pi/adapter.go`, `backend/internal/handler/agent_ws_e2e_test.go` |
| T6 | `backend/internal/domain/agent.go`, `backend/internal/handler/agent_thread.go`, `backend/internal/handler/agent_thread_test.go` (new), `frontend/src/features/data/queries.ts`, `frontend/src/features/agent-chat/SessionsPanel.tsx`, `SessionsPanel.test.tsx` |
| T7 | `frontend/src/features/agent-chat/types.ts`, `eventReducer.ts`, `eventReducer.test.ts`, `plan.ts` (new), `plan.test.ts` (new) |
| T8 | `frontend/src/features/agent-chat/ProposedPlanCard.tsx` (new), `ProposedPlanCard.test.tsx` (new), `planMarkdown.ts` (new), `planMarkdown.test.ts` (new) |
| T9 | `frontend/src/features/agent-chat/timeline.ts`, `timeline.test.ts` |
| T10 | `frontend/src/features/agent-chat/ComposerPlanFollowUpBanner.tsx` (new), `ComposerPlanFollowUpBanner.test.tsx` (new) |
| T11 | `frontend/src/features/agent-chat/MessagesTimeline.tsx`, `MessagesTimeline.test.tsx` |
| T12 | `frontend/src/features/agent-chat/ChatComposer.tsx`, `ChatComposer.test.tsx`, `AgentChatPane.tsx`, `AgentChatPane.test.tsx` |

## Convergence files (CLAUDE.md orchestration rule)

CLAUDE.md names six files parallel agents must never co-edit:
`routeTree.gen.ts`, `useDevDeckStore.ts`, `store/types.ts`, `domain/models.go`,
`cmd/server/main.go`, `port/store.go`.

**None of T1–T12 touch five of the six.** T6 touches `domain/agent.go` and
`frontend/src/features/data/queries.ts` — these are *different files* from
`domain/models.go`/`store/types.ts` (confirmed: `domain/agent.go` holds
`AgentThread`, a separate file from `domain/models.go`; the frontend mirror
lives at `queries.ts:1359-1369`, not `store/types.ts`). They are not on
CLAUDE.md's list, but the spec's own Risks section requires them to land in
**one commit** (§8's "Commit granularity" — a SQL-free overlay pattern split
across two commits would compile but silently disagree). T6 is written as a
single cross-cutting task for exactly this reason: one agent, one commit,
touching both languages.

**`cmd/server/main.go` — corrected finding, not touched by this plan.** The
spec's §4(b) fallback claims restarting a session to change interaction mode
"costs a `main.go` change" (`ResumeCursor` plumbing) and must be serialized.
Re-reading the actual code during this plan's grounding shows that claim is
stronger than the evidence: `Reactor.ensureSession`
(`orchestration/workers.go:565-598`) already receives `sessionIn` as a local,
freely-mutable value and already reads `r.Engine.State().Thread(threadID)` in
the same function where it could set `sessionIn.ResumeCursor = t.ResumeCursor`
— no `main.go` involvement needed for that part. `threadDirectory.Unbind`
(`workers.go:696-700`) already exists, so forcing a rebind-and-restart is also
achievable entirely inside `workers.go`. **T5 is scoped to stay inside its
file list above for both the (a) and (b) paths.** If whoever executes T5
discovers a real reason `main.go` must change after all, that edit must be
split into its own task, run solo (no other task may touch `main.go`
concurrently), and needs its own review pass — do not fold it into T5's
existing file list silently.

## T1 — Live-capture baseline + verification (blocking gate for T4, T5)

**Not TDD in the code sense — this is the evidence-gathering step the spec's
Testing section requires "before implementation, not after."** Its output is
a fixture file and a written decision that T4 and T5 depend on, not
application code.

**Why this exists:** three claims this spec's design rests on are either
unverified or (per the prerequisite section above) not present in this repo
at all:

1. A baseline NDJSON capture of DevDeck's exact `InteractionPlan` `buildArgs`
   plus A's `--permission-prompt-tool stdio`, showing `ExitPlanMode` proposed
   and its `input.plan` on both the `assistant` line and the paired
   `control_request` — this is what `testdata/plan.ndjson` (T4) must be cut
   from. The spec refers to this as `capture/m_stdio_plan`, which does not
   exist in this working tree (see prerequisite section) — recapture it.
2. What happens when the client denies that `control_request` with the exact
   message from §1.3 — does the CLI still emit a terminal `result`? Does the
   thread need a defensive idle-dispatch, or does it settle on its own? No
   capture run has ever exercised this (spec's own "Risks" section).
2. Whether `{"type":"control_request","request":{"subtype":"set_permission_mode",...}}`
   is accepted on an already-running session (spec §4(a), explicitly
   "documented, not verified" — no capture run has tried it).

**Steps:**

1. Build or locate a minimal driver: pipe a scripted `stream-json` stdin into
   `claude --print --output-format stream-json --input-format stream-json
   --verbose --include-partial-messages --permission-mode plan
   --permission-prompt-tool stdio`, prompting the model to make a small,
   verifiable plan and call `ExitPlanMode`. Record raw NDJSON.
2. Deny the `ExitPlanMode` control_request with the verbatim t3code message
   (§1.3: `"The client captured your proposed plan. Stop here and wait for the
   user's feedback or implementation request in a later turn."`). Record what
   follows on the wire — specifically whether a `"type":"result"` line still
   arrives.
3. On a second live session past `system/init`, send a `control_request` with
   `subtype:"set_permission_mode"` (try the shape implied by the CLI's
   embedded strings if inspectable via `strings $(which claude) | grep -i
   permission_mode`; otherwise try the most natural shape — `{"mode":"default"}`
   alongside the subtype — and read what `control_response` comes back, error
   or success). Record the exact accepted/rejected shape.
4. From step 1's transcript, cut `backend/internal/agentcore/provider/claude/testdata/plan.ndjson`
   (paths sanitized, matching how `testdata/turn.ndjson` was prepared) — this
   file is T4's fixture, not written by T4 itself.
5. Write the two findings (deny-path behavior, set_permission_mode viability)
   into T5's task tracking before T5 starts — they select which branch of §4
   T5 implements.

**Environment requirement, stated plainly:** this needs a `claude` CLI
(2.1.x), authenticated, with network egress, in whatever environment executes
this task. If that is not available, **stop and escalate** rather than
fabricate NDJSON or guess the `set_permission_mode` wire shape — every prior
mistake this spec documents (the `stopContentBlock` assumption, the trusted
provider docs) came from skipping exactly this step.

**Done when:** `claude/testdata/plan.ndjson` exists and is committed, and a
written verdict exists for both open questions (deny-path settling behavior;
set_permission_mode viability).

**Verify:** `git show --stat` on the fixture commit; no build/test command
applies to this task.

## T2 — Canonical event (`event.go`)

Independent of everything else in this plan.

**Tests first**, in `event_test.go` (alongside existing payload round-trip
tests — see `TestPayloadSurvivesRoundTrip` pattern already used by
`store/agentevent_test.go` for the sibling case):
- `ProposedPlanPayload` round-trips through `Event.UnmarshalJSON` when
  `payloadRegistry` carries it: encode an `Event{Type: TurnProposedCompleted,
  Payload: &ProposedPlanPayload{...}}`, marshal, unmarshal, assert the decoded
  payload matches field-for-field.
- An `Event` of this new type with **no** registry entry decodes to a nil
  payload rather than erroring (regression guard on the pattern
  `payloadRegistry` already documents at `event.go:326-332` — write this test
  first, watch it fail before adding the registry line, to prove the registry
  entry is what makes it pass).

**Then implement**, in `event.go`:
```go
TurnProposedCompleted Type = "turn.proposed.completed"

type ProposedPlanPayload struct {
    PlanMarkdown string `json:"planMarkdown"`
    PlanFilePath string `json:"planFilePath,omitempty"`
    ToolUseID    string `json:"toolUseId,omitempty"`
}

func (ProposedPlanPayload) EventType() Type { return TurnProposedCompleted }
```
Add the constant beside `TurnPlanUpdated`/`TurnDiffUpdated` (`event.go:41-42`,
same "Turn" family). Add one line to `payloadRegistry` (`event.go:293-306`).

**Done when:** `event_test.go` passes.

**Verify:** `cd backend && go test ./internal/agentcore/event/... && go vet ./...`

## T3 — Orchestration command/event + `Thread.ProposedPlan`

Independent of T1/T2/T4 (different Go types — `orchestration.EventType` is a
separate enum from `event.Type`; `orchestration` does not need T2's payload to
compile).

**Tests first**, in `decider_test.go` (alongside
`TestClientDispatchableExcludesServerOnlyCommands`,
`TestInteractionModeSetAppliesToState` — same file, same table-test style):
- `CmdThreadPlanPropose` is **absent** from `ClientDispatchable` — extend
  `TestClientDispatchableExcludesServerOnlyCommands`'s table rather than
  writing a new test (`decider_test.go:181-197`).
- `applyOne`: an `EvtThreadPlanProposed` event sets `Thread.ProposedPlan` to
  the decoded payload; a following `EvtThreadTurnStartRequested` clears it
  back to `nil`. Table-test style matching `TestInteractionModeSetAppliesToState`
  (`decider_test.go:239-257`).
- `clone()` deep-copies `ProposedPlan` correctly (a pointer field needs the
  same care `PendingRequests` already gets in `clone()`,
  `engine.go:58-69` — pick either a copy-by-value-then-take-address or leave
  it as a shared pointer since `ProposedPlan` is only ever replaced wholesale,
  never mutated in place; write the test to pin whichever choice is made so a
  future edit can't silently start mutating a shared plan across snapshots).

**Tests first**, extending `handler/agent_ws_test.go`'s
`TestServerOnlyCommandRejected` (`agent_ws_test.go:217`) with a
`thread.plan.propose` case — no production `agent_ws.go` change is needed:
its existing `ClientDispatchable` lookup (`agent_ws.go:224-227`) already
covers any command absent from the map.

**Then implement**, in `command.go`:
```go
// server-only block, command.go:42-46
CmdThreadPlanPropose CommandType = "thread.plan.propose"
// NOT added to ClientDispatchable (command.go:51-61)

// command.go:113-127
EvtThreadPlanProposed EventType = "thread.plan-proposed"
// NOT added to IntentEvents (command.go:131-140) — it triggers no provider call
```
Payload struct for the command (decoded straight from T2's
`event.ProposedPlanPayload` fields by T5's Ingestion case):
```go
type PlanProposePayload struct {
    PlanMarkdown string          `json:"planMarkdown"`
    PlanFilePath string          `json:"planFilePath,omitempty"`
    ToolUseID    string          `json:"toolUseId,omitempty"`
}
```

In `engine.go`, add to `Thread` (`engine.go:27-47`):
```go
ProposedPlan *ProposedPlan
```
with a matching `ProposedPlan` struct mirroring the payload above. Two new
cases in `applyOne`'s switch (`engine.go:227-345`): set on
`EvtThreadPlanProposed`, clear (`nil`) on the existing
`EvtThreadTurnStartRequested` case (`engine.go:248-252` already exists —
add the one line, don't duplicate the case).

**Done when:** `decider_test.go` and `agent_ws_test.go` pass.

**Verify:** `cd backend && go test ./internal/agentcore/orchestration/... ./internal/handler/... && go vet ./...`

## T4 — Capture: `parse.go` (needs T2; fixture sourced from T1)

**Tests first**, in `parse_test.go` (reuse the existing `parseFixture(t,
path)` helper — `parse_test.go:38-39` shows the pattern):
- `extractExitPlanModePlan`-equivalent unit tests on a bare `input` object:
  present/non-empty → the trimmed string; present-but-blank → empty/absent;
  key absent → absent; wrong JSON type → absent. Mirrors t3code's
  `extractExitPlanModePlan` (spec §1.1) — trim-then-check, not just
  non-empty-check.
- `parseLine` over `testdata/plan.ndjson` (T1's fixture): exactly one
  `event.TurnProposedCompleted` across the whole file, even though the plan
  text appears on both the `assistant` line and the `control_request` line —
  proves the `capturedPlans` dedupe works.
- Same fixture: **no** `ItemStarted`/`ItemCompleted` event for the
  `ExitPlanMode` content block (§1.4 — the dead disabled-tool-row bug this
  spec's "Correction" section documents).
- A guard test asserting the fixture's `assistant` line's `tool_use` block
  still carries a non-empty `input.plan` — per the spec, "It must fail loudly,
  not degrade" if a future CLI recapture drops it from that line.
- `TestFixtureProducesTextDeltas`-style regression: `testdata/turn.ndjson`
  (the pre-existing 2.1.224 fixture) still parses unchanged — do not touch
  that fixture.

**Then implement**, in `parse.go`:
- `parseState` gains `capturedPlans map[string]bool`
  (`newParseState`, `parse.go:80-88`), keyed `tool:<toolUseId>` when a
  tool-use id is present, else `plan:<markdown>` (t3code's
  `exitPlanCaptureKey`).
- `parseLine`'s `"assistant"` case currently returns `nil` unconditionally
  (`parse.go:175-182`, part of the `"assistant", "user", "rate_limit_event"`
  group). Split it out: `"assistant"` scans the message's content blocks for
  `type=="tool_use" && name=="ExitPlanMode"`, extracts `input.plan`, checks
  the dedupe map, and if new, emits one `TurnProposedCompleted`. `"user"` and
  `"rate_limit_event"` keep returning `nil` — do not touch their contract.
- The `control_request` branch (§1.2) — **integration point, verify against
  A's landed diff first.** As of this plan's writing, `control_request`
  falls into `parseLine`'s `default` case and becomes a `RuntimeWarning`
  (`parse.go:183-192`, comment: "Approval handling ships in spec 2"). By the
  time this task runs, A will have replaced that with a real classifier. Add
  the `tool_name:"ExitPlanMode"` branch there, calling the same extractor and
  dedupe map as the `assistant` case above — the capture shows the
  `assistant` line arrives first for a shared `tool_use_id`
  (`toolu_01UNeXLedXjsmJ25eWTgfoHr` in the spec's cited capture, both lines),
  so in practice this branch is a no-op safety net, not the primary path.
- `startContentBlock` (`parse.go:311-333`): when `block.Type == "tool_use"`
  and `block.Name == "ExitPlanMode"`, record the block kind as usual but
  return no `ItemStarted`. `stopContentBlock` (`parse.go:363-380`) already
  gates on `st.blockKind[*body.Index] != "tool_use"` — add the same
  name-based skip there. Keep accumulating `blockInput` regardless (comment:
  "if a future CLI starts streaming the plan through the block, that is where
  it will appear").
- Package comment (`parse.go:1-22`): add a second version note — the plan
  fixture is CLI 2.1.233, the existing turn fixture is 2.1.224. Do not
  rewrite the existing note.

**Done when:** `parse_test.go` passes, including every existing test
unchanged.

**Verify:** `cd backend && go test ./internal/agentcore/provider/claude/... && go vet ./...`

## T5 — `workers.go` wiring + live-session mode reach (needs T1, T2, T3)

Two independent problems the spec bundles under one file because both touch
`Reactor`/`Ingestion`: (i) turning a captured plan into `Thread.ProposedPlan`,
(ii) making `--permission-mode plan` actually reach a running CLI process
(spec §4, problem #2). Both land in this one task because both need
`workers.go`, and CLAUDE.md-style file ownership means only one task may own
that file.

**Tests first**, in `workers_test.go` (pattern: `TestIngestionCarriesTurnUsageIntoContextTokens`):
- `Ingestion.handle` on an `event.TurnProposedCompleted` dispatches
  `CmdThreadPlanPropose` with the payload's fields carried through verbatim.
- Decide, from T1's verdict: if denying `ExitPlanMode` does **not** reliably
  produce a terminal `result` (i.e. the thread would stay `running`/`waiting`
  forever), this case *also* dispatches a defensive idle status — the same
  belt-and-braces pattern `eventReducer.ts:300-302` already applies to errors
  on the frontend side. Write the test for whichever behavior T1 found before
  writing the implementation.

**Tests first**, in `workers_reactor_test.go` (existing fakes there already
implement `provider.Adapter` — extend the fake, don't add a second one):
- `Reactor.react` on `EvtThreadInteractionModeSet` calls the adapter's new
  `SetInteractionMode` (§4a) — assert via the fake's recorded calls, the same
  way `fakeAdapter.rec` already records `SendTurn` calls
  (`provider/provider_test.go:29-30`).
- If T1's `set_permission_mode` experiment failed: instead assert the
  restart-with-resume sequence — `StopSession` called, `Dir.Unbind` called,
  then a fresh `StartSession` whose `SessionStartInput.ResumeCursor` matches
  `Thread.ResumeCursor`. Only one of these two test shapes is written,
  depending on T1's finding — do not write both and skip one.

**Then implement:**
- `provider/provider.go`: add one method to the `Adapter` interface
  (`provider.go:206-227`):
  ```go
  SetInteractionMode(ctx context.Context, threadID string, mode InteractionMode) error
  ```
  This breaks every implementer's compile — there are five today:
  `claude/adapter.go`, `pi/adapter.go`, `provider/provider_test.go`'s
  `fakeAdapter`, `orchestration/workers_reactor_test.go`'s fake, and
  `handler/agent_ws_e2e_test.go`'s fake (confirmed via `grep -rln "func.*RespondToUserInput"`
  — every current implementer of one method implements them all). Add a stub
  to each of the three test fakes (no-op, matching how they already stub
  `RespondToRequest`/`RespondToUserInput`).
- `claude/adapter.go`: implement `SetInteractionMode` following
  `InterruptTurn`'s exact pattern (`adapter.go:410-419` — write one
  `control_request` frame via `sess.stdinEnc.Encode`, looked up the same way
  `InterruptTurn` looks up `sess`). Use the exact `subtype`/field shape T1
  verified — do not guess it from the spec's "documented, not verified"
  hedge.
- `pi/adapter.go`: no-op implementation (`return nil`), mirroring
  `RespondToRequest`'s doc-commented reason ("no adapter opens a request
  yet... must return nil rather than an error") — pi's `Capabilities.SupportsPlanMode`
  is already `false`, so this path should not normally be reached, but the
  interface must still be satisfied safely.
- `workers.go` `Reactor.react` (`workers.go:433-548`): add a case for
  `EvtThreadInteractionModeSet` (already in `IntentEvents`,
  `command.go:131-140` — confirmed today's switch has no case for it, the
  exact gap the spec's problem #2 names). Two shapes depending on T1:
  - **(a)** — decode `InteractionModeSetPayload`, resolve the thread's bound
    adapter the same way the `EvtThreadSessionStopRequested` case does
    (`workers.go:537-544`), call `a.SetInteractionMode(ctx, e.ThreadID,
    p.Mode)`.
  - **(b)** fallback — call `a.StopSession`, `r.Provider.Dir.Unbind(e.ThreadID)`,
    then re-run (or inline) `ensureSession`'s body with
    `sessionIn.ResumeCursor` set from `r.Engine.State().Thread(e.ThreadID).ResumeCursor`
    before calling `a.StartSession`. **Stays inside `workers.go` — see the
    "Convergence files" section above for why no `main.go` edit should be
    needed.** If it turns out one is, stop and split it into its own solo
    task rather than silently expanding this one.
- `Ingestion.handle` (`workers.go:100-186`): add a case for
  `event.TurnProposedCompleted` before the `default` branch, dispatching
  `CmdThreadPlanPropose` (plus the conditional idle-dispatch from the test
  above).

**Done when:** `workers_test.go` and `workers_reactor_test.go` pass, and
every other `provider.Adapter` implementer still compiles.

**Verify:** `cd backend && go build ./... && go test ./internal/agentcore/... ./internal/handler/... && go vet ./...`

## T6 — Sidebar plan badge (needs T3; backend+frontend, one commit)

Cross-cutting on purpose — the spec's Risks section requires
`domain/agent.go` and `queries.ts`'s `AgentThread` interface to change
together (§8, "Commit granularity"). One task, one agent, one commit.

**Tests first**, backend, new `handler/agent_thread_test.go` (this file does
not exist yet — `ls internal/handler/` confirmed only `agent.go`,
`agent_smoke_test.go`, `agent_thread.go`, `agent_ws.go`,
`agent_ws_e2e_test.go`, `agent_ws_test.go`):
- `withLiveStatus`-equivalent: given an engine state where a thread's
  `Thread.ProposedPlan != nil`, `GetThreads` returns that row with
  `PlanReady: true`; a thread with `ProposedPlan == nil`, or one the engine
  has never heard of, returns `PlanReady: false` (matching the existing
  "keeps its stored value rather than being blanked" fallback,
  `agent_thread.go:52-55`).

**Tests first**, frontend, extending `SessionsPanel.test.tsx`:
- A row whose `AgentThread.planReady` is `true` renders a "Plan" pill beside
  the status dot; `false`/absent renders none.

**Then implement:**
- `domain/agent.go`: add `PlanReady bool \`json:"planReady"\`` to
  `AgentThread` (`agent.go:130-140`).
- `handler/agent_thread.go`: extend `withLiveStatus`
  (`agent_thread.go:56-67`) with one more line per row, reading
  `live.ProposedPlan != nil` the same way it already reads `live.Status`.
- `frontend/src/features/data/queries.ts`: add `planReady: boolean` to the
  `AgentThread` interface (`queries.ts:1359-1369`).
- `SessionsPanel.tsx`: render a small "Plan" pill next to `StatusDot` when
  `thread.planReady` — reuse `@/components/ui/pill` (already used elsewhere
  in this codebase, confirmed present at `src/components/ui/pill.tsx`).

**Done when:** `agent_thread_test.go` and `SessionsPanel.test.tsx` pass.

**Verify:** `cd backend && go test ./internal/handler/... && go vet ./...`
then `cd frontend && npm run typecheck && npx vitest run src/features/agent-chat/SessionsPanel.test.tsx`

## T7 — Frontend read model (independent)

**Tests first**, `eventReducer.test.ts` (existing file, extend it):
- A `thread.plan-proposed` event folds into one `ChatItem{kind:'plan'}`;
  replaying the identical event twice (same `eventId`/`toolUseId`) still
  produces exactly one item — same idempotency contract the tool path already
  has via `applyForwarded`'s `idx === -1` check (`eventReducer.ts:203-225`).
  Key the plan item by `toolUseId ?? eventId`.

**Tests first**, new `plan.test.ts`:
- `latestProposedPlan(items)`: empty list → `null`; one `'plan'` item →
  that item; two `'plan'` items → the later one; a `'plan'` item followed by
  a `'user'` item → `null` (a new turn supersedes the old plan, mirroring the
  backend's `EvtThreadTurnStartRequested`-clears-`ProposedPlan` rule from T3 —
  same two events, same rule, on purpose per spec §5).

**Then implement:**
- `types.ts`: `ChatItemKind` gains `'plan'` (`types.ts:13`). No new fields on
  `ChatItem` — plan markdown rides the existing `text` field.
- `eventReducer.ts`: one branch in `reduceAgentEvents`'s event loop
  (`eventReducer.ts:259-307`), parallel to the existing
  `'thread.message-sent'` branch — decode the payload's `planMarkdown` into
  `item.text`, `kind: 'plan'`.
- New `plan.ts`:
  ```ts
  export function latestProposedPlan(items: ChatItem[]): ChatItem | null {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === 'user') return null
      if (items[i].kind === 'plan') return items[i]
    }
    return null
  }
  ```
  (Exact scan direction/semantics pinned by the test table above, not by this
  sketch — write the test first.)

**Done when:** `eventReducer.test.ts` and `plan.test.ts` pass.

**Verify:** `cd frontend && npm run typecheck && npx vitest run src/features/agent-chat/eventReducer.test.ts src/features/agent-chat/plan.test.ts`

## T8 — `ProposedPlanCard` + `planMarkdown.ts` (independent)

Independent of T7 — the card takes primitive props (`markdown: string`,
callbacks), not a `ChatItem`, so it does not need `ChatItemKind`. Port
`t3code/apps/web/src/proposedPlan.ts`'s test file as the starting table
(the spec names it explicitly: `proposedPlan.test.ts`).

**Tests first**, new `planMarkdown.test.ts`, one suite per ported function:
- `proposedPlanTitle` — derives a short title from the plan markdown (e.g.
  its first heading/line).
- `stripDisplayedPlanMarkdown` / `buildCollapsedProposedPlanPreviewMarkdown` —
  collapse threshold exactly **900 characters or 20 lines**, preview capped
  at **10 visible lines** (spec §6, ported from t3code's
  `ProposedPlanCard.tsx:71,73-75`) — table-test just below and just above
  each threshold.
- `buildProposedPlanMarkdownFilename` — deterministic filename for the
  Download action.
- `normalizePlanMarkdownForExport` — whatever normalization t3code applies
  before Copy/Download (verify against the actual ported source, not assumed).
- `buildPlanImplementationPrompt` — produces `PLEASE IMPLEMENT THIS PLAN:\n<plan>`
  verbatim (T12 depends on this exact string).
- `resolvePlanFollowUpSubmission` — the three-way table from spec §7:
  non-empty draft → `{action:'refine', text: draft, mode: 'plan'}` (mode
  unchanged); empty draft → `{action:'implement', text:
  buildPlanImplementationPrompt(plan), mode: 'default'}`.

**Tests first**, new `ProposedPlanCard.test.tsx`:
- Renders collapsed when markdown exceeds the threshold; expands on click.
- Copy calls the clipboard helper with the normalized markdown; Download
  triggers a file save named via `buildProposedPlanMarkdownFilename`; Save to
  workspace calls `writeWorktreeFile(machine, worktreeId, {path, content})` —
  **note the real signature** takes a single `WorktreeFileContent` object
  (`{path, content}`), not four positional args as an earlier draft of the
  spec's substitution table implies (`lib/machineApi.ts:97-103`, confirmed).
- Save is disabled when no worktree/machine is available.

**Then implement**, porting from
`t3code/apps/web/src/components/chat/ProposedPlanCard.tsx:148-205` and
`t3code/apps/web/src/proposedPlan.ts` with the spec's §6 substitution table:
`MessageResponse` (`@/components/ai-elements/message`, `chat-md` class, same
pattern `MessagesTimeline.tsx:100` already uses) for markdown, `@/components/ui/pill`
for the badge, `@/components/ui/tab-strip-popover-menu`'s `TabStripPopoverMenu`
for the action menu (same pattern `ChatComposer.tsx:211-221` already uses),
`@/components/ui/dialog` for any confirm dialog, `sonner`'s `toast` for
feedback. All four target files confirmed present in this repo
(`src/components/ui/pill.tsx`, `tab-strip-popover-menu.tsx`, `dialog.tsx`,
`src/components/ai-elements/message.tsx`).

**Constraint:** `gg/t3code` is reference-only — read it, never edit it, and
never assume its component names exist here; every substitution above was
confirmed against this repo's actual files.

**Done when:** `planMarkdown.test.ts` and `ProposedPlanCard.test.tsx` pass.

**Verify:** `cd frontend && npm run typecheck && npx vitest run src/features/agent-chat/planMarkdown.test.ts src/features/agent-chat/ProposedPlanCard.test.tsx`

## T9 — Timeline plan entry (needs T7)

**Tests first**, `timeline.test.ts` (existing file, extend it):
- `buildTimeline` emits `{kind: 'plan', item}` for a `ChatItem` with
  `kind: 'plan'` — a **new** `TimelineEntry` variant, not folded into
  `{kind:'message', item}`.
- A `'plan'` item does not get folded into a surrounding `tool-group` — a
  tool item immediately before and after a plan item produce two separate
  `tool-group` entries with the plan entry between them (same "any non-tool
  item breaks the run" rule the reasoning/message branches already get,
  `timeline.ts:31-35`).

**Then implement:**
```ts
export interface PlanEntry {
  kind: 'plan'
  item: ChatItem
}
export type TimelineEntry = MessageEntry | ReasoningEntry | ToolGroupEntry | PlanEntry
```
One new branch in `buildTimeline`'s loop (`timeline.ts:40-57`), checked
before the generic `entries.push({kind:'message', item})` fallback. Per the
spec, `adapter.ts`'s `entryCreatedAt`/`entryCompletedAt`/`turnSpans`
(`adapter.ts:76-98,154-168`) and `MessagesTimeline.tsx`'s `entryKey`
(`MessagesTimeline.tsx:53-56`) all read `entry.item` for any non-`tool-group`
kind — confirm this by running their existing tests unmodified (see
Regression list) rather than editing those files.

**Done when:** `timeline.test.ts` passes, and `adapter.test.ts` passes
unmodified.

**Verify:** `cd frontend && npm run typecheck && npx vitest run src/features/agent-chat/timeline.test.ts src/features/agent-chat/adapter.test.ts`

## T10 — `ComposerPlanFollowUpBanner` (needs T7, T8)

**Tests first**, new `ComposerPlanFollowUpBanner.test.tsx`:
- Renders only when all three hold: `interactionMode === 'plan'`,
  `status === 'idle'`, `latestProposedPlan(items) !== null`. Flip any one to
  false → renders nothing.
- Shows a "Plan Ready" pill plus the plan's title via `proposedPlanTitle`
  (T8).

**Then implement**, porting the 28-line t3code original per spec §7. Props:
`plan: ChatItem | null`, `interactionMode`, `status` (or a single derived
`show: boolean` computed by the caller — decide during implementation and pin
it with the test above, since T12 is the only caller and can compute either
shape).

**Done when:** `ComposerPlanFollowUpBanner.test.tsx` passes.

**Verify:** `cd frontend && npm run typecheck && npx vitest run src/features/agent-chat/ComposerPlanFollowUpBanner.test.tsx`

## T11 — Transcript render (needs T9, T8)

**Tests first**, `MessagesTimeline.test.tsx` (existing file, extend it):
- A view whose `items` contains a `'plan'` item renders `ProposedPlanCard`
  with that item's `text` as its markdown.
- `entryKey` for a plan entry is stable across re-renders (uses `entry.item.id`,
  already generic — confirm no change needed at `MessagesTimeline.tsx:53-56`).

**Then implement:** one new render branch in the entry-kind switch, calling
`ProposedPlanCard` for `entry.kind === 'plan'`, alongside the existing
`MessageRow`/`ReasoningRow`/tool-group branches.

**Done when:** `MessagesTimeline.test.tsx` passes.

**Verify:** `cd frontend && npm run typecheck && npx vitest run src/features/agent-chat/MessagesTimeline.test.tsx`

## T12 — Composer shell wiring (needs T10)

**Tests first**, extending `ChatComposer.test.tsx` and `AgentChatPane.test.tsx`:
- The banner slot renders `ComposerPlanFollowUpBanner` only under the
  follow-up condition (T10's condition, exercised end-to-end here).
- Empty draft + follow-up state → pressing the action button submits
  `buildPlanImplementationPrompt(plan)` and sets interaction mode to
  `'default'`.
- Non-empty draft + follow-up state → pressing the action button (labeled
  "Refine") submits the typed draft and leaves interaction mode at `'plan'`.
- Outside the follow-up state, the existing steer/interrupt behavior
  (`ChatComposer.tsx:150-167`, the "One button, not two" comment) is
  unchanged — assert this with the *existing* tests passing unmodified, not
  new ones.

**Then implement:**
- `ChatComposer.tsx`: the `data-slot="composer-panels"` div
  (`ChatComposer.tsx:189-191`) is empty today (a comment says "A's pending
  user-input / approval panels fill this slot later"). By the time this task
  runs, A will already have put its own panel(s) there. Per the spec, **B
  lands second and owns turning it into a stack** — convert the single empty
  div into a container that renders A's existing panel(s) plus
  `ComposerPlanFollowUpBanner` when the follow-up condition holds, without
  removing whatever A put there.
- The action button (`ChatComposer.tsx:225-241`) gains a third state: in the
  follow-up condition, its label/handler come from `resolvePlanFollowUpSubmission`
  (T8) instead of the existing send/interrupt branch. Preserve the existing
  send/interrupt logic and its comment outside the follow-up state — do not
  restructure it.
- `AgentChatPane.tsx`: thread the follow-up submit through — `interactionMode`
  and its setter already exist here (`AgentChatPane.tsx:144,158-161`), so
  "Implement" is calling the existing setter then the existing `sendTurn`,
  both already present.
- **Do not touch** `ComposerControls.tsx`, `ComposerPromptEditor.tsx`,
  `composerSerialize.ts`, `adapter.ts`, `useAgentChatSocket.ts` — the spec's
  Files-touched section lists these as untouched, and none of this task's
  changes require them.

**Done when:** `ChatComposer.test.tsx` and `AgentChatPane.test.tsx` pass,
including every pre-existing test in both files, unmodified.

**Verify:** `cd frontend && npm run typecheck && npx vitest run src/features/agent-chat/ChatComposer.test.tsx src/features/agent-chat/AgentChatPane.test.tsx`

---

## Review, fix, finalize

Review runs once, over the whole change — not per task.

**Review lenses (parallel):** spec conformance (re-read
`2026-08-15-composer-plan-surface-design.md` against the diff); TDD honesty
(do the tests in T1–T12 actually constrain behavior, or were they written to
pass after the fact — specifically check T4's dedupe test and T5's §4
branch-selection test, the two places a wrong implementation could still
"pass" a loosely written test); the two unverified-until-T1 behaviors (deny
settling, `set_permission_mode`) actually got a real live-capture answer, not
an assumption; regression risk in every file the spec's "Untouched" list
names (`useAgentChatSocket.ts`, `adapter.ts`, `composerSerialize.ts`,
`ComposerPromptEditor.tsx`, `ComposerControls.tsx`, `handler/agent_ws.go`,
`store/agentevent.go`) — diff each one and confirm it is in fact untouched.

**Fix:** apply confirmed findings only.

**Finalize:**
```bash
cd backend && go build ./... && go vet ./... && go test ./...
cd frontend && npm run typecheck && npm test
```

## Known-good baseline

Verified today, on the current working tree, before any task in this plan
starts:

- **Frontend:** `npm test` → **1 failed test file**
  (`src/features/editor/monacoLspClient.guard.test.ts`, 1 failed test), 120
  passed test files, 1205 of 1206 individual tests passing. This is the
  pre-existing, unrelated monaco guard failure — **do not fix it as part of
  this plan.** Any *second* failing test file, or a failure count that grows
  beyond 1205 passing, is a real regression from this work.
- **Backend:** `go build ./...` and `go vet ./...` both clean (no output,
  zero exit).

Re-run both before claiming any task or the whole plan complete, and compare
against these exact numbers.

# Composer — Pending User-Input & Approval Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the CLI's `--permission-prompt-tool stdio` control channel end to end —
CLI stdout → parser → canonical event → Ingestion → engine → WebSocket →
reducer → panel → command → decider → Reactor → Service → adapter → CLI
stdin — so `AskUserQuestion` (deliverable **A1**) and `can_use_tool`
(deliverable **A2**) actually reach the operator instead of silently hanging
or silently denying.

**Architecture:** Two deliverables, shipped as two commits (the pre-commit
hook typechecks the whole project, so neither can land file-by-file). A1
builds and exercises all fourteen seams with a security-harmless payload (a
string); A2 changes only the two ends of the same pipe (real classification
in the parser, a real broker + decision mapping in the adapter). Every
backend task is TDD over table-driven fixtures copied verbatim from the
spec's live captures; every frontend pure-logic task is a straight port of
t3code's own already-tested functions.

**Tech Stack:** Go 1.25 (backend, `devdeck/backend` module, table-driven
`testing`), React 19 + TypeScript 5.7 + Vitest + Testing Library (frontend).

**Spec:** `docs/superpowers/specs/2026-08-15-composer-pending-user-input-approval-design.md`

## Global Constraints

- TDD throughout: every task's tests are written and run RED before the
  implementation that makes them pass.
- `--permission-prompt-tool stdio` is added **unconditionally** to `buildArgs`
  (every `RuntimeMode`/`InteractionMode` combination) — spec §1.1.
- `Broker.Await` is never added. The `approval.Broker` interface stays
  `Resolve` + `CancelThread` (+ this plan's `Open`, added in T10) — no
  blocking primitive with no caller. Spec §3.
- No provider-specific value (`tool_use_id`, raw `input`,
  `permission_suggestions`) may leak into `orchestration` or the client. It
  lives in the claude package's `parseState`/`pendingRequest` only —
  `event/event.go`'s own rule (`event.go:6-10`).
- `AskUserQuestion`'s answer id is the full question text, falling back to
  `q-<idx>` for an empty/non-string question — normalized once, in Go, never
  in the client. Spec §1.2.
- `ExitPlanMode` is answered `deny` with t3code's plan-captured message in
  **both** A1 and A2 — this plan never lets plan mode strand the operator,
  and never renders `ProposedPlanCard` (that is subsystem B). Spec §4.6.
- DevDeck never decides `allow` on the operator's behalf. The only automatic
  answer this plan introduces is `deny`, preserving today's behaviour while
  the flag is new. Spec §2.0.
- **Known-good baseline:** `npm test` (from `frontend/`) has **one
  pre-existing failure**, in the monaco guard test. It is not caused by this
  work and must not be "fixed" as part of it. Any **second** failure is a
  real regression and blocks the task.
- **CLAUDE.md convergence files** (never edited by parallel agents,
  serialize instead): `frontend/src/routeTree.gen.ts`,
  `frontend/src/store/useDevDeckStore.ts`, `frontend/src/store/types.ts`,
  `backend/internal/domain/models.go`, `backend/cmd/server/main.go`,
  `backend/internal/port/store.go`. This plan touches exactly one of them —
  `backend/cmd/server/main.go`, in T13, alone, last, after every other A2
  backend task. No other task in this plan may touch it.
- This plan additionally treats `backend/internal/agentcore/provider/claude/parse.go`,
  `backend/internal/agentcore/provider/claude/adapter.go`,
  `backend/internal/agentcore/orchestration/workers.go`,
  `frontend/src/features/agent-chat/types.ts`,
  `frontend/src/features/agent-chat/eventReducer.ts`,
  `frontend/src/features/agent-chat/useAgentChatSocket.ts`,
  `frontend/src/features/agent-chat/ChatComposer.tsx`, and
  `frontend/src/features/agent-chat/AgentChatPane.tsx` as **project-local
  convergence files for THIS feature**: each is opened by one A1 task and
  reopened by exactly one later A2 task. This is safe **only** because A1
  and A2 are sequential deliverables (A2 starts after every A1 task has
  merged) — never run an A2 task in parallel with the A1 task that opened
  the same file. Both File-ownership tables below name every such reopen
  explicitly.

---

## Dependency shape

```
Deliverable A1 (backend)                    Deliverable A1 (frontend)
─────────────────────────                   ──────────────────────────
T1 parser+event.go+fixtures                 T4 pendingUserInput.ts ─┐
  └──▶ T2 adapter.go                        T8 useAgentChatSocket ──┤ (all independent
                                                                     │  of each other and
T3 orchestration wiring  (independent       T4 ──▶ T5 types.ts      │  of every backend
   of T1/T2 — parallel)                            ├──▶ T6 eventReducer.ts   task)
                                                    └──▶ T7 PendingUserInputPanel.tsx
                                             T6, T7, T8 ──▶ T9 ChatComposer + AgentChatPane
                                             (T3 must also be done before T9 is meaningful
                                              at runtime, though not a compile dependency)

Deliverable A2 (backend) — starts only after every A1 task above has merged
────────────────────────
T10 approval broker + Ingestion Open()  ──┐
T11 parse.go real can_use_tool (reopens   │
    T1's file)                    ────────┼──▶ T12 adapter.go RespondToRequest
                                            │        (reopens T2's file, needs T11)
                                            └──▶ T13 main.go wiring (reopens nothing —
                                                 first-ever edit, but IS the CLAUDE.md
                                                 convergence file; needs T10+T11+T12)

Deliverable A2 (frontend) — starts only after every A1 frontend task has merged
─────────────────────────
T14 types.ts (reopens T5's file)
  └──▶ T15 eventReducer.ts (reopens T6's file)
  └──▶ T16 ComposerPendingApprovalPanel.tsx + Actions.tsx  (parallel with T15)
T17 useAgentChatSocket.ts (reopens T8's file) — independent
T15, T16, T17 ──▶ T18 ChatComposer + AgentChatPane (reopens T9's files)
```

Within A1: **T1→T2** and **T3** are two independent tracks (run in
parallel). **T4, T8** are independent of everything. **T4→T5→{T6,T7}** is a
chain with one fork (T6 ∥ T7). **T9** is the sink and needs T6, T7, T8 done
(and T3 done backend-side for the feature to work end to end, though not to
compile). Within A2: **T10** and **T11** are independent of each other (both
depend only on "all of A1 merged"); **T12** needs T11; **T13** needs T10,
T11, T12. **T14→{T15,T16}** and **T17** independent; **T18** is the sink.

---

## File ownership — Deliverable A1

No file is written by two A1 tasks. (Two files are reopened by an A2 task
later — see the A2 table and the Global Constraints note above.)

| Task | Writes |
|---|---|
| T1 | `backend/internal/agentcore/event/event.go`, `backend/internal/agentcore/provider/claude/parse.go`, `backend/internal/agentcore/provider/claude/parse_test.go`, `backend/internal/agentcore/provider/claude/testdata/control_request_askuser.ndjson`, `backend/internal/agentcore/provider/claude/testdata/control_request_exitplanmode.ndjson`, `backend/internal/agentcore/provider/claude/testdata/control_request_unknown_subtype.ndjson`, `backend/internal/agentcore/provider/claude/testdata/control_cancel_userinput.ndjson`, `backend/internal/agentcore/provider/claude/testdata/control_response_no_id.ndjson` |
| T2 | `backend/internal/agentcore/provider/claude/adapter.go`, `backend/internal/agentcore/provider/claude/driver_test.go` |
| T3 | `backend/internal/agentcore/orchestration/command.go`, `backend/internal/agentcore/orchestration/engine.go`, `backend/internal/agentcore/orchestration/workers.go`, `backend/internal/agentcore/orchestration/workers_test.go`, `backend/internal/agentcore/orchestration/workers_reactor_test.go`, `backend/internal/agentcore/provider/provider.go`, `backend/internal/agentcore/provider/provider_test.go` |
| T4 | `frontend/src/features/agent-chat/pendingUserInput.ts`, `frontend/src/features/agent-chat/pendingUserInput.test.ts` |
| T5 | `frontend/src/features/agent-chat/types.ts` |
| T6 | `frontend/src/features/agent-chat/eventReducer.ts`, `frontend/src/features/agent-chat/eventReducer.test.ts` |
| T7 | `frontend/src/features/agent-chat/ComposerPendingUserInputPanel.tsx`, `frontend/src/features/agent-chat/ComposerPendingUserInputPanel.test.tsx` |
| T8 | `frontend/src/features/agent-chat/useAgentChatSocket.ts` |
| T9 | `frontend/src/features/agent-chat/ChatComposer.tsx`, `frontend/src/features/agent-chat/AgentChatPane.tsx`, `frontend/src/features/agent-chat/ChatComposer.test.tsx`, `frontend/src/features/agent-chat/AgentChatPane.test.tsx` |

**Parallelizable within A1:** {T1→T2} ∥ T3 ∥ T4 ∥ T8 may all start immediately.
T5 waits on T4; T6 and T7 both wait on T5 and may run in parallel with each
other; T9 waits on T6, T7, T8 (and should not be treated as functionally
done until T2 and T3 have also merged, even though nothing forces that
order at compile time).

## File ownership — Deliverable A2

Starts only once every A1 task has merged. Files marked **(reopen)** were
last written by the named A1 task; per the Global Constraints note, this is
a sequential reopen, never a parallel co-edit.

| Task | Writes |
|---|---|
| T10 | `backend/internal/agentcore/approval/broker.go`, `backend/internal/agentcore/approval/memory_broker.go` (new), `backend/internal/agentcore/approval/memory_broker_test.go` (new), `backend/internal/agentcore/orchestration/workers.go` **(reopen, was T3)** |
| T11 | `backend/internal/agentcore/provider/claude/parse.go` **(reopen, was T1)**, `backend/internal/agentcore/provider/claude/parse_test.go` **(reopen, was T1)**, `backend/internal/agentcore/provider/claude/testdata/control_request_bash_blocked.ndjson` (new), `backend/internal/agentcore/provider/claude/testdata/control_request_webfetch_accept.ndjson` (new), `backend/internal/agentcore/provider/claude/testdata/control_cancel_approval.ndjson` (new) |
| T12 | `backend/internal/agentcore/provider/claude/adapter.go` **(reopen, was T2)**, `backend/internal/agentcore/provider/claude/decision_test.go` (new) |
| T13 | `backend/cmd/server/main.go` — **CLAUDE.md convergence file; single task, must not run alongside any other task in this plan** |
| T14 | `frontend/src/features/agent-chat/types.ts` **(reopen, was T5)** |
| T15 | `frontend/src/features/agent-chat/eventReducer.ts` **(reopen, was T6)**, `frontend/src/features/agent-chat/eventReducer.test.ts` **(reopen, was T6)** |
| T16 | `frontend/src/features/agent-chat/ComposerPendingApprovalPanel.tsx` (new), `frontend/src/features/agent-chat/ComposerPendingApprovalPanel.test.tsx` (new), `frontend/src/features/agent-chat/ComposerPendingApprovalActions.tsx` (new), `frontend/src/features/agent-chat/ComposerPendingApprovalActions.test.tsx` (new) |
| T17 | `frontend/src/features/agent-chat/useAgentChatSocket.ts` **(reopen, was T8)** |
| T18 | `frontend/src/features/agent-chat/ChatComposer.tsx` **(reopen, was T9)**, `frontend/src/features/agent-chat/AgentChatPane.tsx` **(reopen, was T9)**, `frontend/src/features/agent-chat/ChatComposer.test.tsx` **(reopen, was T9)** |

**Parallelizable within A2:** T10 ∥ T11 (both depend only on "A1 merged").
T12 waits on T11 (same function it extends). T13 waits on T10+T11+T12 and
is the lone `main.go` edit — run it alone. T14 starts the frontend track;
{T15, T16} may run in parallel once T14 lands; T17 is independent from the
start; T18 is the sink, waiting on T15, T16, T17.

---

# Deliverable A1

## T1 — Parser: `control_request` recognition, question normalization, event.go additions

**Independent** (starting task of the T1→T2 backend chain; parallel with T3).

**Files:**
- Modify: `backend/internal/agentcore/event/event.go`
- Modify: `backend/internal/agentcore/provider/claude/parse.go:148-212` (`wireLine`, `parseLine`'s switch, new `parseControlRequest`/`parseControlCancelRequest`)
- Modify: `backend/internal/agentcore/provider/claude/parse_test.go`
- Create: `backend/internal/agentcore/provider/claude/testdata/control_request_askuser.ndjson`
- Create: `backend/internal/agentcore/provider/claude/testdata/control_request_exitplanmode.ndjson`
- Create: `backend/internal/agentcore/provider/claude/testdata/control_request_unknown_subtype.ndjson`
- Create: `backend/internal/agentcore/provider/claude/testdata/control_cancel_userinput.ndjson`
- Create: `backend/internal/agentcore/provider/claude/testdata/control_response_no_id.ndjson`

**Interfaces:**
- Consumes: `event.Type` constants `UserInputRequested`, `ToolDenied`, `RequestResolved` (already exist, `event.go:53,65,52`); `event.RequestType` const `ReqToolUserInput` (already exists, `event.go:106`); `parseState.envelope(typ event.Type) event.Event` (exists, `parse.go:121`).
- Produces (for T2, and for T11 in A2):
  - `type pendingKind int` with `pendingKindUserInput`, `pendingKindApproval` — A1 only ever constructs `pendingKindUserInput`.
  - `type pendingRequest struct { requestID, toolUseID, toolName string; kind pendingKind; requestType event.RequestType; input json.RawMessage; suggestions json.RawMessage }`
  - `func (st *parseState) setPending(id string, p *pendingRequest)`
  - `func (st *parseState) takePending(id string) (*pendingRequest, bool)`
  - `func (st *parseState) queueAutoDeny(requestID, message string)`
  - `func (st *parseState) takeAutoDenies() []autoDenyReply` where `type autoDenyReply struct { requestID, message string }`
  - `event.ToolDeniedPayload{ToolName, Message string}` (T2 does not need this directly, but T11/T12 do).

### Step 1: Write the failing tests

Add to `event/event_test.go`... actually this package has no dedicated payload test file beyond what already exists; add a table entry to whatever existing payload round-trip test covers `RequestOpenedPayload`/`UserInputRequestedPayload` (search `event_test.go` for the pattern `TestDecisionValid` uses, and add alongside it):

```go
func TestToolDeniedPayloadRegistered(t *testing.T) {
	raw := []byte(`{"eventId":"e1","type":"tool.denied","threadId":"w-abc","requestId":"r1",
		"createdAt":"2026-01-01T00:00:00Z","payload":{"toolName":"Write","message":"nope"}}`)
	var e Event
	if err := json.Unmarshal(raw, &e); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	p, ok := e.Payload.(*ToolDeniedPayload)
	if !ok {
		t.Fatalf("payload = %T, want *ToolDeniedPayload", e.Payload)
	}
	if p.ToolName != "Write" || p.Message != "nope" {
		t.Fatalf("payload = %+v", p)
	}
}
```

Create the five fixtures. Each is **one line**, copied verbatim from the
spec's captures (spec §0, §1.2). `control_request_askuser.ndjson`:

```json
{"type":"control_request","request_id":"f327a720-0000-0000-0000-000000000001","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{"questions":[{"question":"Do you prefer tabs or spaces for indentation?","header":"Indentation","options":[{"label":"Spaces","description":"Use spaces for indentation"},{"label":"Tabs","description":"Use tabs for indentation"}],"multiSelect":false}]},"tool_use_id":"toolu_01HMT3example","requires_user_interaction":true}}
```

`control_request_exitplanmode.ndjson` (shape per spec §4.6, `m_stdio_plan`):

```json
{"type":"control_request","request_id":"a11ce000-0000-0000-0000-000000000002","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","display_name":"ExitPlanMode","input":{"planFilePath":"/home/user/.claude/plans/plan-1.md"},"tool_use_id":"toolu_01ExitPlanExample","requires_user_interaction":true}}
```

`control_request_unknown_subtype.ndjson` (proves the "one warning, never a
crash" contract for a control_request shape this parser has never seen):

```json
{"type":"control_request","request_id":"b22ce000-0000-0000-0000-000000000003","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}
```

`control_cancel_userinput.ndjson` — two lines: the AskUserQuestion request,
then its cancellation (mirrors `e10_int_pending`'s shape but against a
pending *question*, which is what A1 can actually construct):

```json
{"type":"control_request","request_id":"c33ce000-0000-0000-0000-000000000004","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{"questions":[{"question":"Continue?","header":"Confirm","options":[{"label":"Yes","description":"Yes"}],"multiSelect":false}]},"tool_use_id":"toolu_01CancelExample","requires_user_interaction":true}}
{"type":"control_cancel_request","request_id":"c33ce000-0000-0000-0000-000000000004"}
```

`control_response_no_id.ndjson` (the interrupt ack, `e10`'s second line —
must be silently ignored, no event, no warning):

```json
{"type":"control_response","response":{"subtype":"success","response":{"still_queued":[]}}}
```

Append to `parse_test.go`:

```go
func TestControlRequestAskUserQuestionProducesUserInputRequested(t *testing.T) {
	evts := parseFixture(t, "testdata/control_request_askuser.ndjson")
	if len(evts) != 1 {
		t.Fatalf("got %d events, want 1: %+v", len(evts), evts)
	}
	e := evts[0]
	if e.Type != event.UserInputRequested {
		t.Fatalf("type = %s, want user-input.requested", e.Type)
	}
	// A test that fails if someone reads request.request_id instead of the
	// top-level one — the two differ in the fixture on purpose only in that
	// the fixture has no nested request_id at all, so a bug reading the wrong
	// field would leave RequestID empty.
	if e.RequestID != "f327a720-0000-0000-0000-000000000001" {
		t.Fatalf("RequestID = %q, want the TOP-LEVEL request_id", e.RequestID)
	}
	if e.Refs == nil || e.Refs.CallID != "toolu_01HMT3example" {
		t.Fatalf("Refs.CallID = %+v, want tool_use_id", e.Refs)
	}
	p, ok := e.Payload.(*event.UserInputRequestedPayload)
	if !ok {
		t.Fatalf("payload = %T", e.Payload)
	}
	var qs []map[string]any
	if err := json.Unmarshal(p.Questions, &qs); err != nil {
		t.Fatalf("questions: %v", err)
	}
	if qs[0]["id"] != "Do you prefer tabs or spaces for indentation?" {
		t.Fatalf("id = %v, want the full question text", qs[0]["id"])
	}
}

func TestControlRequestQuestionFallsBackToIndexedID(t *testing.T) {
	// A question with no `question` string must still get a stable id.
	st := newParseState("w-abc", "claude:default")
	line := []byte(`{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"header":"H","options":[]}]},"tool_use_id":"t1","requires_user_interaction":true}}`)
	evts := parseLine(line, st)
	p := evts[0].Payload.(*event.UserInputRequestedPayload)
	var qs []map[string]any
	_ = json.Unmarshal(p.Questions, &qs)
	if qs[0]["id"] != "q-0" {
		t.Fatalf("id = %v, want q-0", qs[0]["id"])
	}
}

func TestControlRequestExitPlanModeIsNotUserInput(t *testing.T) {
	evts := parseFixture(t, "testdata/control_request_exitplanmode.ndjson")
	for _, e := range evts {
		if e.Type == event.UserInputRequested {
			t.Fatalf("ExitPlanMode must not be classified as user input: %+v", e)
		}
	}
	// A1 auto-denies it and reports the denial in the transcript.
	if len(evts) != 1 || evts[0].Type != event.ToolDenied {
		t.Fatalf("events = %+v, want exactly one tool.denied", evts)
	}
}

func TestControlRequestUnknownSubtypeIsOneWarning(t *testing.T) {
	evts := parseFixture(t, "testdata/control_request_unknown_subtype.ndjson")
	if len(evts) != 1 || evts[0].Type != event.RuntimeWarning {
		t.Fatalf("events = %+v, want exactly one runtime.warning", evts)
	}
	if evts[0].Raw == nil || len(evts[0].Raw.Payload) == 0 {
		t.Fatal("warning must carry Raw for debugging")
	}
}

func TestControlCancelRequestRetiresAPendingQuestion(t *testing.T) {
	evts := parseFixture(t, "testdata/control_cancel_userinput.ndjson")
	if len(evts) != 2 {
		t.Fatalf("got %d events, want 2 (requested + resolved): %+v", len(evts), evts)
	}
	if evts[1].Type != event.UserInputResolved {
		t.Fatalf("second event type = %s, want user-input.resolved", evts[1].Type)
	}
	if evts[1].RequestID != "c33ce000-0000-0000-0000-000000000004" {
		t.Fatalf("resolved RequestID = %q", evts[1].RequestID)
	}
}

func TestControlResponseWithNoRequestIDIsIgnoredNotWarned(t *testing.T) {
	evts := parseFixture(t, "testdata/control_response_no_id.ndjson")
	if len(evts) != 0 {
		t.Fatalf("events = %+v, want none — control_response is recognized noise", evts)
	}
}
```

### Step 2: Run tests to verify they fail

Run: `go test ./backend/internal/agentcore/event/... ./backend/internal/agentcore/provider/claude/... -run 'ToolDenied|ControlRequest|ControlCancel|ControlResponse' -v`
Expected: FAIL — `ToolDeniedPayload` undefined, `parseControlRequest` undefined, `control_request`/`control_cancel_request` fall into the existing `default:` warning arm (so the "exactly one event" assertions fail on the AskUserQuestion/cancel fixtures, which currently produce warnings instead).

### Step 3: Implement

`event/event.go` — add after `RequestResolvedPayload`:

```go
// ToolDeniedPayload — a tool call the CLI asked permission for and the
// system (not the operator — see event.Decision for operator answers)
// answered deny. A1 uses this for ExitPlanMode and every other can_use_tool
// it cannot yet route to a real decision; A2's real approval flow never
// produces this event — a real deny goes through RequestResolved instead.
type ToolDeniedPayload struct {
	ToolName string `json:"toolName"`
	Message  string `json:"message"`
}

func (ToolDeniedPayload) EventType() Type { return ToolDenied }
```

Add `ToolDenied: func() Payload { return &ToolDeniedPayload{} },` to
`payloadRegistry`.

`parse.go` — extend `wireLine`:

```go
type wireLine struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype"`
	SessionID string          `json:"session_id"`
	IsError   bool            `json:"is_error"`
	Usage     json.RawMessage `json:"usage"`
	Event     json.RawMessage `json:"event"`
	RequestID string          `json:"request_id"`
	Request   json.RawMessage `json:"request"`
}

type controlRequestBody struct {
	Subtype                 string          `json:"subtype"`
	ToolName                string          `json:"tool_name"`
	Input                   json.RawMessage `json:"input"`
	Description             string          `json:"description"`
	PermissionSuggestions   json.RawMessage `json:"permission_suggestions"`
	ToolUseID               string          `json:"tool_use_id"`
	RequiresUserInteraction bool            `json:"requires_user_interaction"`
	BlockedPath             string          `json:"blocked_path"`
}
```

`parseLine`'s switch gains two cases, and folds `"control_response"` into
the existing recognized-noise arm:

```go
switch w.Type {
case "system":
	return parseSystem(w, st, line)
case "stream_event":
	return parseStreamEvent(w, st, line)
case "result":
	return parseResult(w, st)
case "control_request":
	return parseControlRequest(w, st, line)
case "control_cancel_request":
	return parseControlCancelRequest(w, st)
case "assistant", "user", "rate_limit_event", "control_response":
	// control_response is the CLI's ack of a control_response WE sent (the
	// interrupt-ack shape, e10) — recognized noise, never a warning, and it
	// must not assume request_id is present (e10's second line has none).
	return nil
default:
	return warning(st, fmt.Sprintf("unrecognized message type %q", w.Type), line, w.Type)
}
```

Pending state, on `parseState`:

```go
type pendingKind int

const (
	pendingKindUserInput pendingKind = iota
	pendingKindApproval
)

// pendingRequest is the provider-specific metadata a decision needs to be
// echoed back to the CLI. It never leaves this package — see event.go's
// no-leak rule (event.go:6-10). A1 only ever creates pendingKindUserInput
// entries; A2 (T11) extends this to pendingKindApproval for ordinary tools.
type pendingRequest struct {
	requestID   string
	toolUseID   string
	toolName    string
	kind        pendingKind
	requestType event.RequestType
	// input is the ORIGINAL, unmodified bytes the CLI sent — for a question,
	// input.questions verbatim (never DevDeck's normalized version — the SDK
	// looks answers up by the text it sent, and echoing our own reshaping
	// risks dropping a field the CLI still expects).
	input       json.RawMessage
	suggestions json.RawMessage // A2 only
}

type autoDenyReply struct {
	requestID string
	message   string
}

func (st *parseState) setPending(id string, p *pendingRequest) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.pending == nil {
		st.pending = make(map[string]*pendingRequest)
	}
	st.pending[id] = p
}

func (st *parseState) takePending(id string) (*pendingRequest, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	p, ok := st.pending[id]
	if ok {
		delete(st.pending, id)
	}
	return p, ok
}

func (st *parseState) queueAutoDeny(requestID, message string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.autoDenies = append(st.autoDenies, autoDenyReply{requestID: requestID, message: message})
}

func (st *parseState) takeAutoDenies() []autoDenyReply {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := st.autoDenies
	st.autoDenies = nil
	return out
}
```

Add `mu sync.Mutex`, `pending map[string]*pendingRequest`, and
`autoDenies []autoDenyReply` fields to the existing `parseState` struct
(`parse.go:37-72`) — guarded because `pending` is written by `readLoop`'s
goroutine and read/deleted by the Reactor's goroutine via T2's
`RespondToUserInput` (and, in A2, by `RespondToRequest`); `sync` joins the
file's imports.

Auto-deny message constants and the classification switch:

```go
const (
	autoDenyMessage = "DevDeck cannot approve tool use yet. Ask the operator to switch the thread's mode, or proceed without this tool."
	planCapturedDenyMessage = "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn."
)

// parseControlRequest handles "type":"control_request" lines — the approval
// and user-input control channel (gg/HANDOFF.md section 6). Three outcomes:
// AskUserQuestion becomes event.UserInputRequested; ExitPlanMode and (in A1)
// every other can_use_tool are auto-denied immediately, queued for readLoop
// to write back over stdin (see T2) and reported as event.ToolDenied so the
// denial is visible in the transcript instead of invisible, which is what
// today's silent-denial mode does (spec §0, Correction 1).
func parseControlRequest(w wireLine, st *parseState, raw []byte) []event.Event {
	var body controlRequestBody
	if err := json.Unmarshal(w.Request, &body); err != nil {
		return warning(st, "malformed control_request: "+err.Error(), raw, "control_request")
	}
	if body.Subtype != "can_use_tool" {
		// set_permission_mode, set_model, request_user_dialog, and anything
		// else the CLI's embedded schema documents: understood to exist,
		// deliberately not built (spec's Non-goals) — one warning, not a crash.
		return warning(st, fmt.Sprintf("unrecognized control_request subtype %q", body.Subtype), raw, "control_request")
	}
	if w.RequestID == "" {
		return warning(st, "control_request missing top-level request_id", raw, "control_request")
	}

	switch body.ToolName {
	case "AskUserQuestion":
		var qin struct {
			Questions json.RawMessage `json:"questions"`
		}
		_ = json.Unmarshal(body.Input, &qin)
		st.setPending(w.RequestID, &pendingRequest{
			requestID: w.RequestID, toolUseID: body.ToolUseID, toolName: body.ToolName,
			kind: pendingKindUserInput, requestType: event.ReqToolUserInput,
			input: qin.Questions,
		})
		e := st.envelope(event.UserInputRequested)
		e.RequestID = w.RequestID
		e.Refs = withCallID(e.Refs, body.ToolUseID)
		e.Payload = &event.UserInputRequestedPayload{Questions: normalizeUserInputQuestions(qin.Questions)}
		return []event.Event{e}

	case "ExitPlanMode":
		st.queueAutoDeny(w.RequestID, planCapturedDenyMessage)
		e := st.envelope(event.ToolDenied)
		e.RequestID = w.RequestID
		e.Payload = &event.ToolDeniedPayload{ToolName: body.ToolName, Message: planCapturedDenyMessage}
		return []event.Event{e}

	default:
		// A1: every other can_use_tool is auto-denied — the flag turns
		// approval-required from silent-denial into ask, and A1 ships no
		// panel to answer with (spec §2.0). A2 (T11) replaces this branch
		// with a real event.RequestOpened + broker registration.
		st.queueAutoDeny(w.RequestID, autoDenyMessage)
		e := st.envelope(event.ToolDenied)
		e.RequestID = w.RequestID
		e.Payload = &event.ToolDeniedPayload{ToolName: body.ToolName, Message: autoDenyMessage}
		return []event.Event{e}
	}
}

// withCallID copies refs (nil-safe) and stamps CallID — Refs is the ONLY
// place a native id may live (event.go:121-132).
func withCallID(refs *event.Refs, callID string) *event.Refs {
	out := event.Refs{}
	if refs != nil {
		out = *refs
	}
	out.CallID = callID
	return &out
}

// parseControlCancelRequest retires whatever pending entry the CLI just
// cancelled — the CLI sends this itself when an interrupt lands on a pending
// prompt (spec §0 "Cancellation", capture e10_int_pending). A1 can only ever
// have a user-input entry pending; A2 (T11) extends this with the approval
// branch once approval entries exist.
func parseControlCancelRequest(w wireLine, st *parseState) []event.Event {
	if w.RequestID == "" {
		return nil
	}
	p, ok := st.takePending(w.RequestID)
	if !ok {
		return nil
	}
	if p.kind == pendingKindUserInput {
		e := st.envelope(event.UserInputResolved)
		e.RequestID = w.RequestID
		return []event.Event{e}
	}
	e := st.envelope(event.RequestResolved)
	e.RequestID = w.RequestID
	e.Payload = &event.RequestResolvedPayload{RequestType: p.requestType, Decision: event.DecisionCancel}
	return []event.Event{e}
}
```

Question normalization (t3code's exact fallback rule,
`ClaudeAdapter.ts:3782-3789`):

```go
type normalizedQuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

type normalizedQuestion struct {
	ID          string                     `json:"id"`
	Header      string                     `json:"header"`
	Question    string                     `json:"question"`
	Options     []normalizedQuestionOption `json:"options"`
	MultiSelect bool                       `json:"multiSelect"`
}

func normalizeUserInputQuestions(questions json.RawMessage) json.RawMessage {
	var raw []struct {
		Question string `json:"question"`
		Header   string `json:"header"`
		Options  []struct {
			Label       string `json:"label"`
			Description string `json:"description"`
		} `json:"options"`
		MultiSelect bool `json:"multiSelect"`
	}
	_ = json.Unmarshal(questions, &raw)

	out := make([]normalizedQuestion, 0, len(raw))
	for idx, q := range raw {
		id := q.Question
		if id == "" {
			id = fmt.Sprintf("q-%d", idx)
		}
		header := q.Header
		if header == "" {
			header = fmt.Sprintf("Question %d", idx+1)
		}
		opts := make([]normalizedQuestionOption, 0, len(q.Options))
		for _, o := range q.Options {
			opts = append(opts, normalizedQuestionOption{Label: o.Label, Description: o.Description})
		}
		out = append(out, normalizedQuestion{
			ID: id, Header: header, Question: q.Question, Options: opts, MultiSelect: q.MultiSelect,
		})
	}
	b, err := json.Marshal(out)
	if err != nil {
		return json.RawMessage(`[]`)
	}
	return b
}
```

### Step 4: Run tests to verify they pass

Run: `go test ./backend/internal/agentcore/event/... ./backend/internal/agentcore/provider/claude/... -v`
Expected: PASS, including the pre-existing `TestFixtureProducesTextDeltas`
and friends (untouched fixture, untouched behavior).

### Step 5: Commit

```bash
git add backend/internal/agentcore/event/event.go \
        backend/internal/agentcore/provider/claude/parse.go \
        backend/internal/agentcore/provider/claude/parse_test.go \
        backend/internal/agentcore/provider/claude/testdata/control_request_askuser.ndjson \
        backend/internal/agentcore/provider/claude/testdata/control_request_exitplanmode.ndjson \
        backend/internal/agentcore/provider/claude/testdata/control_request_unknown_subtype.ndjson \
        backend/internal/agentcore/provider/claude/testdata/control_cancel_userinput.ndjson \
        backend/internal/agentcore/provider/claude/testdata/control_response_no_id.ndjson
git commit -m "feat(claude): parse control_request into user-input/tool-denied events"
```

**Verify:** `go vet ./backend/...` — no new warnings.

---

## T2 — Adapter: the flag, `stdinMu`, auto-deny drain, real `RespondToUserInput`

**Chained after T1.**

**Files:**
- Modify: `backend/internal/agentcore/provider/claude/adapter.go:80-505`
- Modify: `backend/internal/agentcore/provider/claude/driver_test.go`

**Interfaces:**
- Consumes: T1's `parseState.setPending`/`takePending`/`queueAutoDeny`/`takeAutoDenies`, `pendingRequest`, `event.ToolDenied` (already emitted by the parser — T2 does not touch it), `event.UserInputResolved` (T2 emits this itself, on success).
- Produces: `session.stdinMu sync.Mutex`, `session.writeControlResponse(requestID string, response map[string]any) error` (used again, unmodified, by T12/A2's `RespondToRequest`).

### Step 1: Write the failing tests

Append to `driver_test.go`:

```go
// Correction 1 (spec §0): today's approval-required mode is silent-denial,
// not "asks but can't answer" — the flag is what turns it into a real ask,
// and AskUserQuestion is not even offered to the model without it.
func TestBuildArgsAddsPermissionPromptToolStdio(t *testing.T) {
	for _, in := range []provider.SessionStartInput{
		{},
		{Mode: provider.ModeFullAccess},
		{Mode: provider.ModeAuto},
		{Mode: provider.ModeAutoAcceptEdits},
		{Interact: provider.InteractionPlan},
	} {
		args := buildArgs(Config{}, in)
		joined := strings.Join(args, " ")
		if !strings.Contains(joined, "--permission-prompt-tool stdio") {
			t.Fatalf("mode=%+v interact=%+v missing --permission-prompt-tool stdio; got: %s", in.Mode, in.Interact, joined)
		}
	}
}
```

A dedicated, small integration-style test proving the auto-deny write
actually reaches stdin needs a fake `io.Writer` in place of a real process —
add a package-level seam. Since `StartSession` currently always spawns a
real `exec.CommandContext`, testing `RespondToUserInput`/the auto-deny drain
without a live CLI means constructing a `session` directly (the struct is
already unexported and same-package, so the test can build one by hand):

```go
func TestRespondToUserInputEchoesOriginalQuestionsAndAnswers(t *testing.T) {
	var buf bytes.Buffer
	st := newParseState("w-abc", "claude:default")
	st.setPending("req-1", &pendingRequest{
		requestID: "req-1", toolUseID: "toolu_1", toolName: "AskUserQuestion",
		kind: pendingKindUserInput,
		input: json.RawMessage(`[{"question":"Tabs or spaces?","header":"H","options":[],"multiSelect":false}]`),
	})
	sess := &session{threadID: "w-abc", stdinEnc: json.NewEncoder(&buf), state: st}

	a := &adapter{instanceID: "claude:default", sessions: map[string]*session{"w-abc": sess}, events: make(chan event.Event, 4)}
	if err := a.RespondToUserInput(context.Background(), "w-abc", "req-1", map[string]any{"Tabs or spaces?": "Tabs"}); err != nil {
		t.Fatalf("RespondToUserInput: %v", err)
	}

	var wire map[string]any
	if err := json.Unmarshal(buf.Bytes(), &wire); err != nil {
		t.Fatalf("stdin write is not JSON: %v (%s)", err, buf.String())
	}
	resp := wire["response"].(map[string]any)
	if resp["request_id"] != "req-1" {
		t.Fatalf("request_id = %v, want req-1", resp["request_id"])
	}
	inner := resp["response"].(map[string]any)
	if inner["behavior"] != "allow" {
		t.Fatalf("behavior = %v, want allow", inner["behavior"])
	}
	updated := inner["updatedInput"].(map[string]any)
	if updated["questions"] == nil {
		t.Fatal("updatedInput.questions must echo the original array")
	}
	answers := updated["answers"].(map[string]any)
	if answers["Tabs or spaces?"] != "Tabs" {
		t.Fatalf("answers = %v", answers)
	}

	// The pending entry must be retired — a second respond is a no-op, not
	// a second stdin write.
	buf.Reset()
	if err := a.RespondToUserInput(context.Background(), "w-abc", "req-1", map[string]any{}); err != nil {
		t.Fatalf("second respond: %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("second respond wrote to stdin, want no-op: %s", buf.String())
	}
}

func TestRespondToUserInputOnUnknownThreadIsANoop(t *testing.T) {
	a := &adapter{sessions: map[string]*session{}, events: make(chan event.Event, 1)}
	if err := a.RespondToUserInput(context.Background(), "w-nope", "req-1", nil); err != nil {
		t.Fatalf("unknown thread must be a benign no-op, got: %v", err)
	}
}
```

### Step 2: Run tests to verify they fail

Run: `go test ./backend/internal/agentcore/provider/claude/... -run 'BuildArgsAddsPermissionPromptToolStdio|RespondToUserInput' -v`
Expected: FAIL — `--permission-prompt-tool` absent from `buildArgs`'s
output; `RespondToUserInput` still returns `nil` without writing anything.

### Step 3: Implement

`buildArgs` — add the flag unconditionally (spec §1.1) and rewrite the
stale comment at `adapter.go:169-174`:

```go
args := []string{
	"--print",
	"--output-format", "stream-json",
	"--input-format", "stream-json",
	"--verbose",
	"--include-partial-messages",
	// Required in every mode, unconditionally: AskUserQuestion is not
	// offered to the model without it (verified: system/init's tool list
	// differs by exactly AskUserQuestion/EnterPlanMode/ExitPlanMode between
	// a run with and without this flag), and the modes that never prompt
	// (auto, bypassPermissions, dontAsk) are unaffected by its presence.
	// Corrected belief: without this flag, approval-required does not "ask
	// but have nothing to say yes with" — it silently denies every tool
	// call (system/permission_denied, dropped entirely pre-T1). This flag
	// is what turns that into a real ask.
	"--permission-prompt-tool", "stdio",
}

switch {
case in.Interact == provider.InteractionPlan:
	args = append(args, "--permission-mode", "plan")
case in.Mode == provider.ModeAutoAcceptEdits:
	args = append(args, "--permission-mode", "acceptEdits")
case in.Mode == provider.ModeFullAccess:
	args = append(args, "--permission-mode", "bypassPermissions")
case in.Mode == provider.ModeAuto:
	args = append(args, "--permission-mode", "auto")
default:
	// approval-required: the CLI's own default, now a REAL ask (see the
	// flag's comment above). parse.go's auto-responder answers every
	// can_use_tool it cannot yet route to a decision; A2 replaces that with
	// the real broker.
}
```

`session` (`adapter.go:31-42` roughly) gains a mutex and every existing
writer takes it:

```go
type session struct {
	threadID  string
	cmd       *exec.Cmd
	stderr    *boundedBuffer
	stdinEnc  *json.Encoder
	state     *parseState
	cancel    context.CancelFunc
	startedAt int64
	model     string

	// stdinMu serializes every write to the CLI's stdin. Before this task
	// SendTurn/InterruptTurn were the only writers and both ran on the
	// Reactor's single goroutine; the auto-deny drain below writes from
	// readLoop's goroutine instead, so two goroutines can now interleave on
	// one json.Encoder without it — a corrupt NDJSON line the CLI can't
	// parse, which takes the whole session down.
	stdinMu sync.Mutex
}

// writeControlResponse is the one place this package writes a
// control_response. Reused unmodified by A2's RespondToRequest.
func (s *session) writeControlResponse(requestID string, response map[string]any) error {
	s.stdinMu.Lock()
	defer s.stdinMu.Unlock()
	return s.stdinEnc.Encode(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "success",
			"request_id": requestID,
			"response":   response,
		},
	})
}
```

`SendTurn` and `InterruptTurn` wrap their existing `sess.stdinEnc.Encode(...)`
calls with `sess.stdinMu.Lock()`/`defer sess.stdinMu.Unlock()` (three-line
diff each, logic unchanged).

`readLoop` drains the parser's auto-deny queue after every line:

```go
for sc.Scan() {
	line := bytes.TrimSpace(sc.Bytes())
	if len(line) == 0 {
		continue
	}
	for _, ev := range parseLine(append([]byte(nil), line...), sess.state) {
		a.emit(ev)
	}
	for _, d := range sess.state.takeAutoDenies() {
		if err := sess.writeControlResponse(d.requestID, map[string]any{
			"behavior": "deny",
			"message":  d.message,
		}); err != nil {
			log.Printf("claude: instance %s thread %s: auto-deny write: %v", a.instanceID, sess.threadID, err)
		}
	}
}
```

`RespondToUserInput` becomes real:

```go
// RespondToUserInput answers a pending AskUserQuestion. The original
// questions array must be echoed verbatim (spec §1.5) — this is why the
// pending map exists even in A1: the raw input arrives minutes before the
// answer does.
func (a *adapter) RespondToUserInput(ctx context.Context, threadID, requestID string, answers map[string]any) error {
	a.mu.Lock()
	sess, ok := a.sessions[threadID]
	a.mu.Unlock()
	if !ok {
		return nil
	}
	p, found := sess.state.takePending(requestID)
	if !found {
		// Already resolved or cancelled — a double-tap from a second device,
		// or a cancel that raced this call. Benign, mirrors ErrUnknownRequest.
		return nil
	}
	if err := sess.writeControlResponse(requestID, map[string]any{
		"behavior": "allow",
		"updatedInput": map[string]any{
			"questions": json.RawMessage(p.input),
			"answers":   answers,
		},
	}); err != nil {
		return err
	}
	a.emit(event.Event{
		Type: event.UserInputResolved, Provider: string(Kind), InstanceID: string(a.instanceID),
		ThreadID: threadID, RequestID: requestID, CreatedAt: time.Now().UTC(),
	})
	return nil
}
```

`RespondToRequest` (`adapter.go:423-430`) stays `return nil` in A1 — its
doc comment is corrected in T12, not here, since T12 is the task that gives
it real behaviour.

### Step 4: Run tests to verify they pass

Run: `go test ./backend/internal/agentcore/provider/claude/... -v`
Expected: PASS, and the whole package (`TestBuildArgs*`,
`TestFixtureProducesTextDeltas`, T1's new tests) stays green.

### Step 5: Commit

```bash
git add backend/internal/agentcore/provider/claude/adapter.go \
        backend/internal/agentcore/provider/claude/driver_test.go
git commit -m "feat(claude): add --permission-prompt-tool stdio, answer AskUserQuestion for real"
```

**Verify:** `go test ./backend/internal/agentcore/... -race -run Claude` and
`go vet ./backend/...`.

---

## T3 — Orchestration wiring: Ingestion forwards the payload, Reactor answers user input

**Independent of T1/T2 — parallel track.** Only requires the
`provider.Adapter.RespondToUserInput` interface method, which already
exists (`provider.go:220`) and is already implemented (as a no-op) by every
test fake in this package.

**Files:**
- Modify: `backend/internal/agentcore/orchestration/command.go:85-96`
- Modify: `backend/internal/agentcore/orchestration/engine.go:151-168` (decider's `CmdThreadUserInputRespond` case)
- Modify: `backend/internal/agentcore/orchestration/workers.go:100-127` (Ingestion), `:433-548` (Reactor `react`)
- Modify: `backend/internal/agentcore/orchestration/workers_test.go`
- Modify: `backend/internal/agentcore/orchestration/workers_reactor_test.go`
- Modify: `backend/internal/agentcore/provider/provider.go:361-384`
- Modify: `backend/internal/agentcore/provider/provider_test.go`

**Interfaces:**
- Consumes: `provider.Adapter.RespondToUserInput` (exists), `event.RequestOpened`/`event.UserInputRequested` (exist), `Command`/`Event` (exist).
- Produces: `orchestration.UserInputRespondPayload{RequestID string; Answers map[string]any}` — consumed by the Reactor's own new case and, at the WS boundary, decoded from the client's `thread.user-input.respond` command (T8 sends this shape).

### Step 1: Write the failing tests

`workers_test.go` — the ordering regression test (payload before status,
flush before both):

```go
// Regression: Ingestion's RequestOpened/UserInputRequested case used to
// return after dispatching only CmdThreadSessionSet — the whole canonical
// envelope (Detail/Args/Options/Questions) was computed by nobody and
// delivered to nobody, so a waiting thread rendered identically to a
// running one. Two commands, in this order: activity FIRST (what the panel
// renders), status SECOND (a client painting on status===waiting must never
// see an empty panel for one frame).
func TestUserInputRequestedForwardsActivityBeforeStatus(t *testing.T) {
	store := NewMemStore()
	n := 0
	e := NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 16,
		NewID: func() string { n++; return "ae-" + string(rune('a'+n)) },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)
	dispatchCreate(t, e, "w-abc")

	a := &stubAdapter{ch: make(chan event.Event, 4)}
	m := 0
	in := NewIngestion(e, approval.NoopBroker{}, func() string { m++; return "ac-in-" + string(rune('a'+m)) })
	go in.Consume(ctx, a)

	a.ch <- event.Event{
		Type: event.UserInputRequested, ThreadID: "w-abc", RequestID: "req-1",
		Payload: &event.UserInputRequestedPayload{Questions: json.RawMessage(`[{"id":"q1"}]`)},
	}

	waitFor(t, func() bool {
		th, ok := e.State().Thread("w-abc")
		return ok && th.Status == ThreadWaiting
	})

	var activitySeq, sessionSetSeq uint64
	for _, ev := range store.All() {
		if ev.Type == EvtThreadActivityAppended && strings.Contains(string(ev.Payload), "req-1") {
			activitySeq = ev.Seq
		}
		if ev.Type == EvtThreadSessionSet && strings.Contains(string(ev.Payload), "req-1") {
			sessionSetSeq = ev.Seq
		}
	}
	if activitySeq == 0 || sessionSetSeq == 0 {
		t.Fatalf("missing events; store = %+v", store.All())
	}
	if activitySeq >= sessionSetSeq {
		t.Fatalf("activity seq %d must be BEFORE session-set seq %d", activitySeq, sessionSetSeq)
	}
}
```

`workers_reactor_test.go` — the Reactor regression test (this is the test
that fails on `main` today, per spec: answering a question is a silent
no-op that leaves the agent blocked forever). Extend `fakeAdapter` with a
recorder for `RespondToUserInput`, mirroring the existing `sendTurnCalls`
pattern:

```go
// Added to fakeAdapter:
	mu                    sync.Mutex // already exists — reuse it
	userInputCalls        []struct {
		threadID, requestID string
		answers             map[string]any
	}

func (a *fakeAdapter) RespondToUserInput(_ context.Context, threadID, requestID string, answers map[string]any) error {
	a.rec.record("RespondToUserInput")
	a.mu.Lock()
	defer a.mu.Unlock()
	a.userInputCalls = append(a.userInputCalls, struct {
		threadID, requestID string
		answers             map[string]any
	}{threadID, requestID, answers})
	return nil
}
```

(This replaces the existing trivial `func (a *fakeAdapter) RespondToUserInput(context.Context, string, string, map[string]any) error { return nil }`.)

```go
// TestReactorRespondsToUserInput is the regression test for the silent
// no-op: before this task, EvtThreadUserInputResponseRequested fell through
// react's switch to `return nil` — the pending flag cleared, the thread
// flipped waiting -> running, and the provider was never told anything.
func TestReactorRespondsToUserInput(t *testing.T) {
	h := newReactorHarness(t, noopBrokerFn)
	defer h.cancel()

	h.dispatch(t, "w-abc", CmdThreadCreate, mustRaw(t, map[string]any{}))
	h.waitForCall(t, "StartSession")
	h.dispatch(t, "w-abc", CmdThreadSessionSet, mustRaw(t, map[string]any{
		"status": string(ThreadWaiting), "pendingRequestAdd": "req-1",
	}))

	h.dispatch(t, "w-abc", CmdThreadUserInputRespond, mustRaw(t, UserInputRespondPayload{
		RequestID: "req-1", Answers: map[string]any{"Tabs or spaces?": "Tabs"},
	}))

	h.waitForCall(t, "RespondToUserInput")
	calls := h.adapter.userInputCalls
	if len(calls) != 1 || calls[0].requestID != "req-1" || calls[0].answers["Tabs or spaces?"] != "Tabs" {
		t.Fatalf("userInputCalls = %+v", calls)
	}
}
```

`provider_test.go`:

```go
func TestServiceRoutesUserInputResponseToItsInstance(t *testing.T) {
	d := &fakeDriver{}
	r := NewRegistry(d)
	ctx := context.Background()
	if _, err := r.StartInstance(ctx, "fake", InstanceSpec{InstanceID: "fake:work"}); err != nil {
		t.Fatalf("start: %v", err)
	}
	svc := &Service{Registry: r, Dir: mapDirectory{"w-abc": "fake:work"}}
	if err := svc.RespondToUserInput(ctx, "w-abc", "req-1", map[string]any{"q": "a"}); err != nil {
		t.Fatalf("respond: %v", err)
	}
	if err := svc.RespondToUserInput(ctx, "w-unbound", "req-1", nil); err == nil {
		t.Fatal("unbound thread should error")
	}
}
```

### Step 2: Run tests to verify they fail

Run: `go test ./backend/internal/agentcore/orchestration/... ./backend/internal/agentcore/provider/... -v`
Expected: FAIL — `TestUserInputRequestedForwardsActivityBeforeStatus` finds
no activity event containing `req-1` (today's code returns before
forwarding it); `TestReactorRespondsToUserInput` never sees
`"RespondToUserInput"` recorded (`react`'s switch has no case for
`EvtThreadUserInputResponseRequested`, falls to `return nil`);
`TestServiceRoutesUserInputResponseToItsInstance` fails to compile
(`Service.RespondToUserInput` does not exist).

### Step 3: Implement

`command.go` — add beside `ApprovalRespondPayload`:

```go
type UserInputRespondPayload struct {
	RequestID string         `json:"requestId"`
	Answers   map[string]any `json:"answers"`
}
```

`engine.go`'s `Decide`, `CmdThreadUserInputRespond` case — swap the
anonymous struct for the typed payload (the "not pending" guard is
unchanged):

```go
case CmdThreadUserInputRespond:
	t, ok := s.Threads[cmd.ThreadID]
	if !ok {
		return nil, fmt.Errorf("thread %s does not exist", cmd.ThreadID)
	}
	var p UserInputRespondPayload
	if err := json.Unmarshal(cmd.Payload, &p); err != nil {
		return nil, err
	}
	if !t.PendingRequests[p.RequestID] {
		return nil, fmt.Errorf("request %s is not pending", p.RequestID)
	}
	return []Event{mk(EvtThreadUserInputResponseRequested, json.RawMessage(cmd.Payload))}, nil
```

`workers.go`'s `Ingestion.handle`, `RequestOpened, UserInputRequested` case
— flush, THEN activity-append, THEN session-set:

```go
case event.RequestOpened, event.UserInputRequested:
	if err := in.flushThread(ctx, ev.ThreadID); err != nil {
		return err
	}
	if err := in.dispatch(ctx, Command{
		Type: CmdThreadActivityAppend, ThreadID: ev.ThreadID,
		Payload: mustJSON(ev),
	}); err != nil {
		return err
	}
	return in.dispatch(ctx, Command{
		Type:     CmdThreadSessionSet,
		ThreadID: ev.ThreadID,
		Payload: mustJSON(map[string]any{
			"status":            string(ThreadWaiting),
			"pendingRequestAdd": ev.RequestID,
		}),
	})
```

`workers.go`'s `Reactor.react` — new case, placed next to
`EvtThreadApprovalResponseRequested`:

```go
case EvtThreadUserInputResponseRequested:
	var p UserInputRespondPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return err
	}
	// No Broker.Resolve here, unlike the approval case above: there is
	// nothing to unblock. DevDeck drives the raw CLI over stdin/stdout RPC
	// (adapter.go), not the TS SDK's canUseTool callback — see spec §3's
	// correction to HANDOFF §6. User input is never callback-style on any
	// provider this codebase ships.
	return r.Provider.RespondToUserInput(ctx, e.ThreadID, p.RequestID, p.Answers)
```

`provider.go` — new `Service` method, copied from `RespondToRequest`:

```go
func (s *Service) RespondToUserInput(ctx context.Context, threadID, requestID string, answers map[string]any) error {
	a, err := s.adapterFor(threadID)
	if err != nil {
		return err
	}
	return a.RespondToUserInput(ctx, threadID, requestID, answers)
}
```

### Step 4: Run tests to verify they pass

Run: `go test ./backend/internal/agentcore/orchestration/... ./backend/internal/agentcore/provider/... -race -v`
Expected: PASS, including every existing `TestApprovalDoubleTap*`,
`TestReactor*`, `TestIngestion*` test, untouched.

### Step 5: Commit

```bash
git add backend/internal/agentcore/orchestration/command.go \
        backend/internal/agentcore/orchestration/engine.go \
        backend/internal/agentcore/orchestration/workers.go \
        backend/internal/agentcore/orchestration/workers_test.go \
        backend/internal/agentcore/orchestration/workers_reactor_test.go \
        backend/internal/agentcore/provider/provider.go \
        backend/internal/agentcore/provider/provider_test.go
git commit -m "feat(orchestration): forward pending-request activity and route user-input responses"
```

**Verify:** `go test ./backend/... -race` and `go vet ./backend/...`.

---

## T4 — `pendingUserInput.ts` (pure port)

**Independent** — no dependency on anything else in this plan.

**Files:**
- Create: `frontend/src/features/agent-chat/pendingUserInput.ts`
- Create: `frontend/src/features/agent-chat/pendingUserInput.test.ts`

**Interfaces:**
- Produces: `UserInputQuestionOption{label, description}`, `UserInputQuestion{id, header, question, options, multiSelect}` (defined **locally** — spec §1.6, not imported from `@t3tools/contracts`), `PendingUserInputDraftAnswer{selectedOptionLabels?, customAnswer?}`, `PendingUserInputProgress{...}`, and the eight functions: `resolvePendingUserInputAnswer`, `setPendingUserInputCustomAnswer`, `togglePendingUserInputOptionSelection`, `buildPendingUserInputAnswers`, `countAnsweredPendingUserInputQuestions`, `findFirstUnansweredPendingUserInputQuestionIndex`, `derivePendingUserInputProgress`. Consumed by T5 (type import), T7 (component logic), T9 (ChatComposer's local answer state).

### Step 1: Write the failing tests

Port `apps/web/src/pendingUserInput.test.ts` from
`gg/t3code` — read that file for the exact case list, then write it against
the locally-defined `UserInputQuestion` type. The load-bearing cases (do not
skip any):

```ts
import { describe, expect, it } from 'vitest'
import {
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from '@/features/agent-chat/pendingUserInput'
import type { PendingUserInputDraftAnswer, UserInputQuestion } from '@/features/agent-chat/pendingUserInput'

const singleSelect: UserInputQuestion = {
  id: 'Tabs or spaces?', header: 'Style', question: 'Tabs or spaces?',
  options: [{ label: 'Tabs', description: '' }, { label: 'Spaces', description: '' }],
  multiSelect: false,
}
const multiSelect: UserInputQuestion = { ...singleSelect, id: 'Which files?', multiSelect: true }

describe('resolvePendingUserInputAnswer', () => {
  it('a non-empty custom answer beats any selected option', () => {
    const draft: PendingUserInputDraftAnswer = { customAnswer: 'Both, actually', selectedOptionLabels: ['Tabs'] }
    expect(resolvePendingUserInputAnswer(singleSelect, draft)).toBe('Both, actually')
  })
  it('single-select returns the first selected label', () => {
    expect(resolvePendingUserInputAnswer(singleSelect, { selectedOptionLabels: ['Tabs'] })).toBe('Tabs')
  })
  it('multi-select returns the array, or null if empty', () => {
    expect(resolvePendingUserInputAnswer(multiSelect, { selectedOptionLabels: ['Tabs', 'Spaces'] })).toEqual(['Tabs', 'Spaces'])
    expect(resolvePendingUserInputAnswer(multiSelect, { selectedOptionLabels: [] })).toBeNull()
  })
  it('no draft at all is null', () => {
    expect(resolvePendingUserInputAnswer(singleSelect, undefined)).toBeNull()
  })
})

describe('togglePendingUserInputOptionSelection', () => {
  it('multiSelect: toggling twice is idempotent (back to empty)', () => {
    let draft = togglePendingUserInputOptionSelection(multiSelect, undefined, 'Tabs')
    draft = togglePendingUserInputOptionSelection(multiSelect, draft, 'Tabs')
    expect(resolvePendingUserInputAnswer(multiSelect, draft)).toBeNull()
  })
  it('single-select: picking a second option replaces the first, clears customAnswer', () => {
    let draft = togglePendingUserInputOptionSelection(singleSelect, undefined, 'Tabs')
    draft = togglePendingUserInputOptionSelection(singleSelect, draft, 'Spaces')
    expect(resolvePendingUserInputAnswer(singleSelect, draft)).toBe('Spaces')
  })
})

describe('buildPendingUserInputAnswers', () => {
  it('returns null while any question is unanswered', () => {
    const answers = buildPendingUserInputAnswers([singleSelect, multiSelect], {
      [singleSelect.id]: { selectedOptionLabels: ['Tabs'] },
    })
    expect(answers).toBeNull()
  })
  it('returns the full map once every question is answered', () => {
    const answers = buildPendingUserInputAnswers([singleSelect, multiSelect], {
      [singleSelect.id]: { selectedOptionLabels: ['Tabs'] },
      [multiSelect.id]: { selectedOptionLabels: ['Spaces'] },
    })
    expect(answers).toEqual({ [singleSelect.id]: 'Tabs', [multiSelect.id]: ['Spaces'] })
  })
})

describe('findFirstUnansweredPendingUserInputQuestionIndex', () => {
  it('clamps to the last index when every question is answered', () => {
    const idx = findFirstUnansweredPendingUserInputQuestionIndex([singleSelect], {
      [singleSelect.id]: { selectedOptionLabels: ['Tabs'] },
    })
    expect(idx).toBe(0)
  })
})

describe('derivePendingUserInputProgress', () => {
  it('reports isLastQuestion and isComplete independently', () => {
    const progress = derivePendingUserInputProgress([singleSelect, multiSelect], {
      [singleSelect.id]: { selectedOptionLabels: ['Tabs'] },
    }, 0)
    expect(progress.isLastQuestion).toBe(false)
    expect(progress.isComplete).toBe(false)
    expect(progress.canAdvance).toBe(true)
  })
})

describe('setPendingUserInputCustomAnswer', () => {
  it('a non-empty custom answer clears any selected options', () => {
    const draft = setPendingUserInputCustomAnswer({ selectedOptionLabels: ['Tabs'] }, 'Both please')
    expect(draft.selectedOptionLabels).toBeUndefined()
    expect(draft.customAnswer).toBe('Both please')
  })
})
```

### Step 2: Run test to verify it fails

Run: `cd frontend && npx vitest run src/features/agent-chat/pendingUserInput.test.ts`
Expected: FAIL — `pendingUserInput.ts` does not exist.

### Step 3: Implement

Copy `gg/t3code/apps/web/src/pendingUserInput.ts` verbatim in behavior, with
one change: replace `import type { UserInputQuestion } from "@t3tools/contracts"`
with a local definition at the top of the file:

```ts
export interface UserInputQuestionOption {
  label: string
  description: string
}

export interface UserInputQuestion {
  id: string
  header: string
  question: string
  options: UserInputQuestionOption[]
  multiSelect: boolean
}
```

Every function below that import is a straight copy (see the spec-cited
source at `gg/t3code/apps/web/src/pendingUserInput.ts:1-173` — do not
reference `@t3tools/contracts` anywhere, and do not import React or touch
the DOM).

### Step 4: Run test to verify it passes

Run: `cd frontend && npx vitest run src/features/agent-chat/pendingUserInput.test.ts`
Expected: PASS.

### Step 5: Commit

```bash
git add frontend/src/features/agent-chat/pendingUserInput.ts \
        frontend/src/features/agent-chat/pendingUserInput.test.ts
git commit -m "feat(agent-chat): port t3code's pendingUserInput pure logic"
```

**Verify:** `cd frontend && npm run typecheck`

---

## T5 — `types.ts`: `PendingUserInput` + `AgentThreadView.pendingUserInputs`

**Chained after T4.**

**Files:**
- Modify: `frontend/src/features/agent-chat/types.ts`

**Interfaces:**
- Consumes: T4's `UserInputQuestion`.
- Produces: `PendingUserInput{requestId: string; createdAt: number; questions: UserInputQuestion[]}`, and `AgentThreadView.pendingUserInputs: PendingUserInput[]` — consumed by T6 (reducer), T7 (panel props), T9 (ChatComposer/AgentChatPane).

This is a type-only, additive edit with no runtime logic of its own — no
new test file. Its correctness is proven by T6's reducer tests (which
cannot compile without the field) and by `npm run typecheck`.

### Step 1: Write the (type-level) failing check

There is no test to write for a type addition in isolation; the check is
T6's tests failing to compile without it. Confirm the gap first:

Run: `cd frontend && npm run typecheck 2>&1 | grep -i "pendingUserInputs"`
Expected: no output yet (the field does not exist, so nothing references it
yet either) — this step is a no-op placeholder that becomes meaningful once
T6 exists; proceed straight to Step 3, and let T6's own Step 2 be the RED
signal for this task's correctness.

### Step 3: Implement

```ts
import type { UserInputQuestion } from '@/features/agent-chat/pendingUserInput'

/** One open `AskUserQuestion` request, derived from the forwarded
 *  `user-input.requested` / `user-input.resolved` events — mirrors the
 *  backend's `event.UserInputRequestedPayload` (normalized in Go, never
 *  here — see `pendingUserInput.ts`'s doc comment on why). */
export interface PendingUserInput {
  requestId: string
  createdAt: number
  questions: UserInputQuestion[]
}
```

Add to `AgentThreadView`:

```ts
export interface AgentThreadView {
  items: ChatItem[]
  status: 'idle' | 'running' | 'waiting' | 'stopped'
  lastSeq: number
  hasGap: boolean
  error: string | null
  contextTokens: number
  /** Open `AskUserQuestion` requests, oldest first. `ComposerPendingUserInputPanel`
   *  renders only the head — see its own doc comment for the queue-of-one
   *  UI decision. */
  pendingUserInputs: PendingUserInput[]
}
```

Update `emptyThreadView()` in `eventReducer.ts`... **do not** edit
`eventReducer.ts` here — that is T6's file. This task ends with
`AgentThreadView` requiring a field that `emptyThreadView()` does not yet
provide, which is deliberately left red for T6 to turn green (T6 owns
`eventReducer.ts`).

### Step 4: Run to verify

Run: `cd frontend && npm run typecheck`
Expected: FAIL — `eventReducer.ts`'s `emptyThreadView()` (and its frozen
`EMPTY_THREAD_VIEW`) are missing the required `pendingUserInputs` property.
This is the correct, expected failure state to hand to T6.

### Step 5: Commit

```bash
git add frontend/src/features/agent-chat/types.ts
git commit -m "feat(agent-chat): add PendingUserInput type to AgentThreadView"
```

**Verify:** none standalone — T6 turns the typecheck green. Do not merge T5
alone; land it together with T6 in the same PR/commit sequence if your
workflow requires green-at-every-commit (this plan's task boundary is for
review granularity, not deployability).

---

## T6 — `eventReducer.ts`: fold `user-input.requested`/`user-input.resolved`

**Chained after T5.** Parallel with T7.

**Files:**
- Modify: `frontend/src/features/agent-chat/eventReducer.ts`
- Modify: `frontend/src/features/agent-chat/eventReducer.test.ts`

**Interfaces:**
- Consumes: T5's `PendingUserInput`, `AgentThreadView.pendingUserInputs`.
- Produces: nothing new for other tasks — this is a leaf of the type chain feeding runtime behavior only (T9 reads `view.pendingUserInputs`, which this task actually populates).

### Step 1: Write the failing tests

Append to `eventReducer.test.ts` (mirror the file's existing
`AgentEvent` builder patterns — read the top of that file for the exact
helper names before writing; the assertions below assume a helper shaped
like the existing ones that build a `thread.activity-appended` fixture
event):

```ts
function userInputRequestedEvent(seq: number, requestId: string): AgentEvent {
  return {
    seq, eventId: `e${seq}`, type: 'thread.activity-appended', threadId: 't1', commandId: `c${seq}`,
    createdAt: seq * 1000,
    payload: {
      type: 'user-input.requested', requestId, threadId: 't1',
      payload: { questions: [{ id: 'q1', header: 'H', question: 'Q?', options: [], multiSelect: false }] },
    },
  }
}
function userInputResolvedEvent(seq: number, requestId: string): AgentEvent {
  return {
    seq, eventId: `e${seq}`, type: 'thread.activity-appended', threadId: 't1', commandId: `c${seq}`,
    createdAt: seq * 1000,
    payload: { type: 'user-input.resolved', requestId, threadId: 't1' },
  }
}

describe('reduceAgentEvents — pendingUserInputs', () => {
  it('user-input.requested opens a pending request', () => {
    const view = reduceAgentEvents(emptyThreadView(), [userInputRequestedEvent(1, 'req-1')])
    expect(view.pendingUserInputs).toHaveLength(1)
    expect(view.pendingUserInputs[0].requestId).toBe('req-1')
    expect(view.pendingUserInputs[0].questions[0].id).toBe('q1')
  })

  it('user-input.resolved closes it', () => {
    const opened = reduceAgentEvents(emptyThreadView(), [userInputRequestedEvent(1, 'req-1')])
    const closed = reduceAgentEvents(opened, [userInputResolvedEvent(2, 'req-1')])
    expect(closed.pendingUserInputs).toHaveLength(0)
  })

  it('a replayed tail re-delivering both is idempotent', () => {
    const first = reduceAgentEvents(emptyThreadView(), [userInputRequestedEvent(1, 'req-1'), userInputResolvedEvent(2, 'req-1')])
    const replayed = reduceAgentEvents(first, [userInputRequestedEvent(1, 'req-1'), userInputResolvedEvent(2, 'req-1')])
    expect(replayed).toBe(first) // seq <= lastSeq short-circuits, same reference
    expect(replayed.pendingUserInputs).toHaveLength(0)
  })

  it('two open requests preserve arrival order', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      userInputRequestedEvent(1, 'req-1'),
      userInputRequestedEvent(2, 'req-2'),
    ])
    expect(view.pendingUserInputs.map((p) => p.requestId)).toEqual(['req-1', 'req-2'])
  })
})
```

### Step 2: Run tests to verify they fail

Run: `cd frontend && npx vitest run src/features/agent-chat/eventReducer.test.ts`
Expected: FAIL — `view.pendingUserInputs` is `undefined` (field not yet
populated by the reducer; `emptyThreadView()` doesn't even set it, so
`npm run typecheck` is ALSO red at this point, per T5's Step 4).

### Step 3: Implement

`emptyThreadView()`:

```ts
export function emptyThreadView(): AgentThreadView {
  return {
    items: [],
    status: 'idle',
    lastSeq: 0,
    hasGap: false,
    error: null,
    contextTokens: 0,
    pendingUserInputs: [],
  }
}
```

Extend `ForwardedProviderEvent` with the envelope-level `requestId` field
(mirrors Go's `Event.RequestID`, sibling to `type`/`itemId`, NOT nested
under `.payload`):

```ts
interface ForwardedProviderEvent {
  type: string
  itemId?: string
  requestId?: string
  payload?: {
    itemType?: string
    title?: string
    status?: string
    message?: string
    detail?: unknown
    /** `UserInputRequestedPayload.Questions` — present only on `user-input.requested`. */
    questions?: unknown
  }
}
```

A type guard for the normalized question shape (defensive — the backend
already guarantees it, but this file never trusts the wire beyond a shallow
check, matching every other guard here):

```ts
import type { UserInputQuestion } from '@/features/agent-chat/pendingUserInput'

function isUserInputQuestionArray(value: unknown): value is UserInputQuestion[] {
  if (!Array.isArray(value)) return false
  return value.every(
    (q) =>
      typeof q === 'object' &&
      q !== null &&
      typeof (q as Record<string, unknown>).id === 'string' &&
      typeof (q as Record<string, unknown>).question === 'string' &&
      Array.isArray((q as Record<string, unknown>).options),
  )
}
```

Open/close helpers, mirroring `applyDelta`'s "return a new array, or the
same one if nothing changed" contract:

```ts
function openPendingUserInput(pending: PendingUserInput[], ev: ForwardedProviderEvent, createdAt: number): PendingUserInput[] {
  if (!ev.requestId) return pending
  if (pending.some((p) => p.requestId === ev.requestId)) return pending // idempotent replay
  const questions = ev.payload?.questions
  if (!isUserInputQuestionArray(questions)) return pending
  return [...pending, { requestId: ev.requestId, createdAt, questions }]
}

function closePendingUserInput(pending: PendingUserInput[], requestId: string | undefined): PendingUserInput[] {
  if (!requestId) return pending
  const next = pending.filter((p) => p.requestId !== requestId)
  return next.length === pending.length ? pending : next
}
```

In `reduceAgentEvents`'s loop, add a `pendingUserInputs` local (seeded from
`view.pendingUserInputs`) and branch BEFORE the existing generic
`isForwardedProviderEvent` → `applyForwarded` fallthrough:

```ts
let pendingUserInputs = view.pendingUserInputs
// ...
} else if (isForwardedProviderEvent(event.payload) && event.payload.type === 'user-input.requested') {
  pendingUserInputs = openPendingUserInput(pendingUserInputs, event.payload, event.createdAt)
} else if (isForwardedProviderEvent(event.payload) && event.payload.type === 'user-input.resolved') {
  pendingUserInputs = closePendingUserInput(pendingUserInputs, event.payload.requestId)
} else if (isForwardedProviderEvent(event.payload)) {
  const before = items
  items = applyForwarded(items, event.eventId, event.payload, event.createdAt)
  // ...unchanged error-settles-status block...
}
```

And the final return gains `pendingUserInputs`.

### Step 4: Run tests to verify they pass

Run: `cd frontend && npx vitest run src/features/agent-chat/eventReducer.test.ts && npm run typecheck`
Expected: PASS — including every existing `eventReducer.test.ts` case
(delta folding, tool rows, error settling), untouched.

### Step 5: Commit

```bash
git add frontend/src/features/agent-chat/eventReducer.ts \
        frontend/src/features/agent-chat/eventReducer.test.ts
git commit -m "feat(agent-chat): fold user-input.requested/resolved into pendingUserInputs"
```

**Verify:** `cd frontend && npx vitest run src/features/agent-chat/eventReducer.test.ts && npm run typecheck`

---

## T7 — `ComposerPendingUserInputPanel.tsx`

**Chained after T5. Parallel with T6** (both depend only on T4+T5, not on
each other).

**Files:**
- Create: `frontend/src/features/agent-chat/ComposerPendingUserInputPanel.tsx`
- Create: `frontend/src/features/agent-chat/ComposerPendingUserInputPanel.test.tsx`

**Interfaces:**
- Consumes: T4's pure functions + `UserInputQuestion`, T5's `PendingUserInput`.
- Produces: `ComposerPendingUserInputPanelProps { pendingUserInputs: PendingUserInput[]; answers: Record<string, PendingUserInputDraftAnswer>; questionIndex: number; onToggleOption: (questionId: string, optionLabel: string) => void; onAdvance: () => void }` — the exact shape T9 mounts and wires state for.

### Step 1: Write the failing tests

Port the interaction cases from t3code's panel, against the local props
contract (t3code's version takes `respondingRequestIds`/`onRespondToUserInput`
indirectly through `ChatView`; this plan's version is simpler because T9
keeps `answers`/`questionIndex` as local component state and calls
`onAdvance` — there is no separate "isResponding" prop in A1, since a
double-submit is already guarded server-side by the engine's pending check,
T3):

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ComposerPendingUserInputPanel } from '@/features/agent-chat/ComposerPendingUserInputPanel'
import type { PendingUserInput } from '@/features/agent-chat/types'
import type { PendingUserInputDraftAnswer } from '@/features/agent-chat/pendingUserInput'

afterEach(() => cleanup())

const twoQuestionPrompt: PendingUserInput = {
  requestId: 'req-1', createdAt: 1,
  questions: [
    { id: 'q1', header: 'Style', question: 'Tabs or spaces?', multiSelect: false,
      options: [{ label: 'Tabs', description: '' }, { label: 'Spaces', description: '' }] },
    { id: 'q2', header: 'More', question: 'Semicolons?', multiSelect: false,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] },
  ],
}

function renderPanel(overrides: Partial<Parameters<typeof ComposerPendingUserInputPanel>[0]> = {}) {
  const onToggleOption = vi.fn()
  const onAdvance = vi.fn()
  render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[twoQuestionPrompt]}
      answers={{}}
      questionIndex={0}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      {...overrides}
    />,
  )
  return { onToggleOption, onAdvance }
}

describe('ComposerPendingUserInputPanel', () => {
  it('renders nothing when there is no pending request', () => {
    const { container } = render(
      <ComposerPendingUserInputPanel pendingUserInputs={[]} answers={{}} questionIndex={0} onToggleOption={vi.fn()} onAdvance={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('digit 3 does nothing (only two options exist) but digit 1 selects the first option', () => {
    const { onToggleOption } = renderPanel()
    fireEvent.keyDown(document, { key: '3' })
    expect(onToggleOption).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: '1' })
    expect(onToggleOption).toHaveBeenCalledWith('q1', 'Tabs')
  })

  it('digit shortcut does nothing when focus is inside a text input', () => {
    render(
      <div>
        <input data-testid="editor" />
        <ComposerPendingUserInputPanel pendingUserInputs={[twoQuestionPrompt]} answers={{}} questionIndex={0} onToggleOption={vi.fn()} onAdvance={vi.fn()} />
      </div>,
    )
    const onToggleOption = vi.fn()
    screen.getByTestId('editor').focus()
    fireEvent.keyDown(screen.getByTestId('editor'), { key: '1' })
    expect(onToggleOption).not.toHaveBeenCalled()
  })

  it('single-select auto-advances 200ms after a click', async () => {
    vi.useFakeTimers()
    const { onAdvance } = renderPanel()
    fireEvent.click(screen.getByText('Tabs'))
    vi.advanceTimersByTime(200)
    expect(onAdvance).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('multi-select does NOT auto-advance', async () => {
    vi.useFakeTimers()
    const multi: PendingUserInput = { ...twoQuestionPrompt, questions: [{ ...twoQuestionPrompt.questions[0], multiSelect: true }] }
    const onAdvance = vi.fn()
    render(<ComposerPendingUserInputPanel pendingUserInputs={[multi]} answers={{}} questionIndex={0} onToggleOption={vi.fn()} onAdvance={onAdvance} />)
    fireEvent.click(screen.getByText('Tabs'))
    vi.advanceTimersByTime(500)
    expect(onAdvance).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('shows an n/m counter only when there is more than one question', () => {
    renderPanel()
    expect(screen.getByText('1/2')).toBeInTheDocument()
  })

  it('the selected option shows a check icon, not its kbd hint', () => {
    renderPanel({ answers: { q1: { selectedOptionLabels: ['Tabs'] } } })
    expect(screen.queryByText('1')).not.toBeInTheDocument()
  })
})
```

### Step 2: Run tests to verify they fail

Run: `cd frontend && npx vitest run src/features/agent-chat/ComposerPendingUserInputPanel.test.tsx`
Expected: FAIL — the component does not exist.

### Step 3: Implement

Port `gg/t3code/apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx`
(`ComposerPendingUserInputPanel` + `ComposerPendingUserInputCard`), with
these deliberate deviations from the source, all stated in the spec:

- Import `derivePendingUserInputProgress`/`PendingUserInputDraftAnswer` from
  `@/features/agent-chat/pendingUserInput` (T4), `PendingUserInput` from
  `@/features/agent-chat/types` (T5).
- Drop `respondingRequestIds`/`isResponding` entirely — A1 has no separate
  "in flight" prop; the double-submit case is a server-side no-op (T3), and
  a client-side `isResponding` derived purely from "did I already call
  onAdvance" is unnecessary complexity this port does not need.
- Use this repo's semantic tokens, not t3code's `text-secondary-label` /
  `text-foreground/90` raw values — `text-muted-foreground`,
  `text-foreground`, `border-border`, `bg-muted` (matching `T2`'s guidance
  from the prior composer plan for the same class of port).
- **Focus-on-open** (spec §1.7 — new behavior, not in t3code): when
  `pendingUserInputs[0]?.requestId` changes (a fresh prompt appears), move
  focus to the first option button:

```tsx
const firstOptionRef = useRef<HTMLButtonElement | null>(null)
useEffect(() => {
  if (activePrompt) firstOptionRef.current?.focus()
}, [activePrompt?.requestId])
```

  attach `ref={index === 0 ? firstOptionRef : undefined}` on the first
  option button.
- The digit-shortcut listener keeps t3code's exact bail conditions
  (`HTMLInputElement`/`HTMLTextAreaElement`/`[contenteditable]:not([contenteditable="false"])`)
  verbatim — do not weaken them, per spec §1.7's explicit instruction (a
  weaker rule would make typing "1." at the start of a message select an
  option).
- `onAdvance` is the caller's responsibility to decide submit-vs-next-question
  (T9 owns that; this component only ever calls `onAdvance()`, matching
  t3code's `onAdvanceActivePendingUserInput` contract at
  `ChatView.tsx:5385-5401`).

### Step 4: Run tests to verify they pass

Run: `cd frontend && npx vitest run src/features/agent-chat/ComposerPendingUserInputPanel.test.tsx`
Expected: PASS.

### Step 5: Commit

```bash
git add frontend/src/features/agent-chat/ComposerPendingUserInputPanel.tsx \
        frontend/src/features/agent-chat/ComposerPendingUserInputPanel.test.tsx
git commit -m "feat(agent-chat): add ComposerPendingUserInputPanel"
```

**Verify:** `cd frontend && npx vitest run src/features/agent-chat/ComposerPendingUserInputPanel.test.tsx && npm run typecheck`

---

## T8 — `useAgentChatSocket.ts`: `respondToUserInput`

**Independent** — touches only this file, needs nothing from T4-T7.

**Files:**
- Modify: `frontend/src/features/agent-chat/useAgentChatSocket.ts`

**Interfaces:**
- Consumes: nothing new (the existing `dispatch` helper, `AgentCommandType`).
- Produces: `respondToUserInput: (requestId: string, answers: Record<string, unknown>) => void` on `UseAgentChatSocketResult` — consumed by T9 (passed down from `AgentChatPane` to `ChatComposer`).

No dedicated test file exists for this hook today (`useAgentChatSocket.test.ts`
is absent from the repo — confirmed by listing `src/features/agent-chat/*.test.*`;
every other hook of this shape in this codebase is covered indirectly
through the components that use it). This task follows that precedent:
coverage arrives via T9's `AgentChatPane.test.tsx` additions, not a new file
here.

### Step 1: Write the failing check

T9's forthcoming test will assert `respondToUserInput` reaches the socket
as a `thread.user-input.respond` command — write that assertion NOW as a
temporary local check to drive this task honestly, then delete it once T9
lands its own copy (T9 is the chained consumer and will re-assert this
properly with a mounted `AgentChatPane`). For this task alone, the
verification is `npm run typecheck` failing because `respondToUserInput` is
referenced nowhere yet is trivially satisfiable — since this task has no
component to render, treat **Step 2** as: confirm the symbol does not exist.

Run: `cd frontend && grep -n "respondToUserInput" src/features/agent-chat/useAgentChatSocket.ts`
Expected: no matches (RED, by absence).

### Step 3: Implement

Widen the command union and the result interface:

```ts
type AgentCommandType =
  | 'thread.turn.start'
  | 'thread.turn.interrupt'
  | 'thread.runtime-mode.set'
  | 'thread.interaction-mode.set'
  | 'thread.user-input.respond'
```

```ts
export interface UseAgentChatSocketResult {
  view: AgentThreadView
  status: AgentSocketStatus
  sendTurn: (text: string, model?: TurnModelSelection) => void
  abortTurn: () => void
  setRuntimeMode: (mode: RuntimeMode) => void
  setInteractionMode: (mode: InteractionMode) => void
  /** Dispatches `thread.user-input.respond` — already on the server's
   *  `ClientDispatchable` allowlist (`command.go:56`), no backend
   *  authorization change needed. */
  respondToUserInput: (requestId: string, answers: Record<string, unknown>) => void
}
```

Add the callback beside `setRuntimeMode`/`setInteractionMode`:

```ts
const respondToUserInput = useCallback(
  (requestId: string, answers: Record<string, unknown>) => dispatch('thread.user-input.respond', { requestId, answers }),
  [dispatch],
)
```

Add it to the final `return { ... }`.

### Step 4: Run to verify

Run: `cd frontend && npm run typecheck`
Expected: PASS (this task's own edit is internally consistent; full
end-to-end verification is T9's).

### Step 5: Commit

```bash
git add frontend/src/features/agent-chat/useAgentChatSocket.ts
git commit -m "feat(agent-chat): expose respondToUserInput on the agent chat socket"
```

**Verify:** `cd frontend && npm run typecheck`

---

## T9 — Wire the panel into `ChatComposer`/`AgentChatPane`

**Sink of T6, T7, T8.** (Also needs T2 and T3 merged for the feature to
work end to end at runtime — not a compile-time dependency, but do not
consider A1 "done" until all six of T1-T3, T6-T8 have landed.)

**Files:**
- Modify: `frontend/src/features/agent-chat/ChatComposer.tsx:181-250`
- Modify: `frontend/src/features/agent-chat/AgentChatPane.tsx:127-206`
- Modify: `frontend/src/features/agent-chat/ChatComposer.test.tsx`
- Modify: `frontend/src/features/agent-chat/AgentChatPane.test.tsx`

**Interfaces:**
- Consumes: T7's `ComposerPendingUserInputPanel`/props contract, T5's
  `PendingUserInput`, T4's `PendingUserInputDraftAnswer`/
  `buildPendingUserInputAnswers`/`derivePendingUserInputProgress`, T8's
  `respondToUserInput`.
- Produces: `ChatComposerProps` gains `pendingUserInputs: PendingUserInput[]`
  and `onRespondToUserInput: (requestId: string, answers: Record<string, unknown>) => void`.
  `AgentChatPaneProps` is unchanged (it derives both from its own
  `useAgentChatSocket` call, same pattern as `view`/`sendTurn` today).

### Step 1: Write the failing tests

`ChatComposer.test.tsx` — add to the existing `controls` fixture file:

```tsx
import { ComposerPendingUserInputPanel } from '@/features/agent-chat/ComposerPendingUserInputPanel' // not imported directly by the test — sanity only

const onePendingQuestion: ChatComposerProps['pendingUserInputs'] = [
  {
    requestId: 'req-1', createdAt: 1,
    questions: [{ id: 'q1', header: 'Style', question: 'Tabs or spaces?', multiSelect: false,
      options: [{ label: 'Tabs', description: '' }, { label: 'Spaces', description: '' }] }],
  },
]

it('renders the pending user-input panel above the editor and submits on advance', () => {
  const onRespondToUserInput = vi.fn()
  render(
    <ChatComposer
      status="waiting"
      onSend={vi.fn()}
      onAbort={vi.fn()}
      controls={controls}
      pendingUserInputs={onePendingQuestion}
      onRespondToUserInput={onRespondToUserInput}
    />,
  )
  fireEvent.click(screen.getByText('Tabs'))
  // Single-select auto-advances; this prompt has one question, so advancing
  // past it submits immediately.
  vi.useFakeTimers()
  vi.advanceTimersByTime(200)
  expect(onRespondToUserInput).toHaveBeenCalledWith('req-1', { 'Tabs or spaces?': 'Tabs' })
  vi.useRealTimers()
})

it('renders nothing extra when there are no pending user-input requests', () => {
  render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} pendingUserInputs={[]} onRespondToUserInput={vi.fn()} />)
  expect(screen.queryByRole('button', { name: /Tabs/ })).not.toBeInTheDocument()
})
```

`AgentChatPane.test.tsx` — extend whatever mounting helper the file already
uses (read its top before writing) with one case proving the prop actually
threads through:

```tsx
it('threads pendingUserInputs and the responder from the socket into the composer', () => {
  // Mock useAgentChatSocket (this file's existing pattern — read the top of
  // AgentChatPane.test.tsx for the exact vi.mock shape already in use) to
  // return one pendingUserInputs entry and a spy respondToUserInput, then
  // assert the panel's option button renders — proves the prop reached
  // ChatComposer, not just that AgentChatPane compiles.
})
```

### Step 2: Run tests to verify they fail

Run: `cd frontend && npx vitest run src/features/agent-chat/ChatComposer.test.tsx src/features/agent-chat/AgentChatPane.test.tsx`
Expected: FAIL — `ChatComposerProps` has no `pendingUserInputs`/
`onRespondToUserInput` (compile error), and the `data-slot="composer-panels"`
div is still empty.

### Step 3: Implement

`ChatComposer.tsx` — new props, local per-question draft state (reset when
the active request changes), fill the slot:

```tsx
import { ComposerPendingUserInputPanel } from '@/features/agent-chat/ComposerPendingUserInputPanel'
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  togglePendingUserInputOptionSelection,
} from '@/features/agent-chat/pendingUserInput'
import type { PendingUserInputDraftAnswer } from '@/features/agent-chat/pendingUserInput'
import type { PendingUserInput } from '@/features/agent-chat/types'

export interface ChatComposerProps {
  // ...existing fields...
  pendingUserInputs: PendingUserInput[]
  onRespondToUserInput: (requestId: string, answers: Record<string, unknown>) => void
}
```

Inside the component:

```tsx
const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({})
const [questionIndex, setQuestionIndex] = useState(0)
const activeRequestId = pendingUserInputs[0]?.requestId

// A fresh prompt starts its own draft, at its own first question — carrying
// over the previous prompt's answers/index would show the wrong progress.
useEffect(() => {
  setAnswers({})
  setQuestionIndex(0)
}, [activeRequestId])

const onToggleOption = (questionId: string, optionLabel: string) => {
  const prompt = pendingUserInputs[0]
  if (!prompt) return
  const question = prompt.questions.find((q) => q.id === questionId)
  if (!question) return
  setAnswers((existing) => ({ ...existing, [questionId]: togglePendingUserInputOptionSelection(question, existing[questionId], optionLabel) }))
}

const onAdvance = () => {
  const prompt = pendingUserInputs[0]
  if (!prompt) return
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex)
  if (!progress.isLastQuestion) {
    setQuestionIndex(progress.questionIndex + 1)
    return
  }
  const resolved = buildPendingUserInputAnswers(prompt.questions, answers)
  if (resolved) onRespondToUserInput(prompt.requestId, resolved)
}
```

In the JSX, replace the empty slot comment:

```tsx
<div data-slot="composer-panels">
  <ComposerPendingUserInputPanel
    pendingUserInputs={pendingUserInputs}
    answers={answers}
    questionIndex={questionIndex}
    onToggleOption={onToggleOption}
    onAdvance={onAdvance}
  />
</div>
```

`AgentChatPane.tsx` — thread the two new props from the socket hook (T8)
straight through, same pattern as `sendTurn`/`abortTurn`:

```tsx
const { view, status, sendTurn, abortTurn, setRuntimeMode, setInteractionMode, respondToUserInput } =
  useAgentChatSocket({ machine, threadKey })
```

```tsx
<ChatComposer
  status={view.status}
  onSend={(text) => sendTurn(text, turnModel(model, effort, contextWindow))}
  onAbort={abortTurn}
  controls={controls}
  machine={machine}
  worktreeId={worktreeId}
  worktree={worktreeLabel}
  branch={branch}
  variant={isEmpty ? 'hero' : 'docked'}
  pendingUserInputs={view.pendingUserInputs}
  onRespondToUserInput={respondToUserInput}
/>
```

(Both call sites of `<ChatComposer>` — hero and docked share one `composer`
constant already, so this is a single edit.)

### Step 4: Run tests to verify they pass

Run: `cd frontend && npx vitest run src/features/agent-chat/ChatComposer.test.tsx src/features/agent-chat/AgentChatPane.test.tsx && npm run typecheck`
Expected: PASS, including every pre-existing case in both files
(`ChatComposer`'s Enter/Shift+Enter test, the interrupt-vs-send test, the
inline/menu control row split; `AgentChatPane`'s connecting/empty/error
states).

### Step 5: Commit

```bash
git add frontend/src/features/agent-chat/ChatComposer.tsx \
        frontend/src/features/agent-chat/AgentChatPane.tsx \
        frontend/src/features/agent-chat/ChatComposer.test.tsx \
        frontend/src/features/agent-chat/AgentChatPane.test.tsx
git commit -m "feat(agent-chat): mount ComposerPendingUserInputPanel in the composer"
```

**Verify:** `cd frontend && npm test` — one pre-existing monaco guard
failure only; `npm run typecheck`; `npm run build`.

---

## A1 — Review, fix, finalize

Review runs once, over the whole A1 diff (T1-T9) — not per task.

**Review lenses (parallel):**
- Spec conformance against `2026-08-15-composer-pending-user-input-approval-design.md`
  §0-§1, §3 (the HANDOFF correction), §5 (discrimination rules), §6 (dormant
  and why).
- TDD honesty — was every test above actually run RED before its
  implementation, or retrofitted to pass?
- The two ordering contracts: flush→activity→status in `Ingestion.handle`,
  and `stdinMu` actually held on every writer (`SendTurn`, `InterruptTurn`,
  the auto-deny drain, `RespondToUserInput`) — a missed lock here is a
  `-race` failure that will not show up without `-race`.
- Regression risk in the untouched-by-contract files named in the spec's
  Testing section: `ComposerControls.test.tsx`, `ComposerPromptEditor.test.tsx`,
  `MessagesTimeline.test.tsx`, `adapter.test.ts`, `timeline.test.ts`,
  `composerSerialize.test.ts`, `driver_test.go` (existing cases),
  `workers_test.go`/`workers_reactor_test.go` (existing cases).

**Fix:** apply confirmed findings only.

**Finalize:**
- Backend: `go build ./backend/... && go vet ./backend/... && go test ./backend/... -race`
- Frontend: `cd frontend && npm run typecheck && npm test && npm run build`

**Manual gate before A1 merges (spec's Testing section, "not covered by any
test"):** run the real `claude` CLI through DevDeck with the new flag —
confirm `AskUserQuestion` actually reaches the panel and a chosen answer
round-trips back into the model's next reply ("You said you prefer
Tabs"-style confirmation). Also close two named-but-unverified spec risks
before merging, both cheap:
- **multiSelect answer shape.** No capture forced a multiSelect question;
  confirm DevDeck sends `answers[id]` as a `string[]` (not a bare string)
  for a multi-select question, with one live `drive.py`-style run.
- **Two simultaneously pending requests.** Not required to build a queue UI
  (explicit non-goal), but confirm the `n/m` head-of-queue rendering doesn't
  break when a second `AskUserQuestion` arrives while the first is still
  open.

---

# Deliverable A2

Starts only after every A1 task (T1-T9) has merged. A2 changes only the
semantics at the two ends of the same pipe A1 built: real classification in
the parser (instead of blanket auto-deny), and a real broker + decision
mapping in the adapter (instead of a hardcoded deny message).

## T10 — Approval broker + `Ingestion.Open()` wiring

**Independent within A2** (parallel with T11 — different files).

**Files:**
- Modify: `backend/internal/agentcore/approval/broker.go`
- Create: `backend/internal/agentcore/approval/memory_broker.go`
- Create: `backend/internal/agentcore/approval/memory_broker_test.go`
- Modify: `backend/internal/agentcore/orchestration/workers.go` (**reopens T3's file** — safe only because T3 has merged; this is the only A2 backend task touching `workers.go`)

**Interfaces:**
- Consumes: `event.Decision` (exists).
- Produces: `Broker` interface gains `Open(threadID, requestID string)`
  (breaking change to the interface — `NoopBroker` and every test fake
  implementing `approval.Broker` needs a no-op `Open` too; grep
  `approval.Broker` implementers before touching call sites).
  `MemoryBroker{OnCancel func(threadID, requestID string)}` — consumed by
  T13 (`main.go` wires `OnCancel` to `provider.Service.RespondToRequest`).

### Step 1: Write the failing tests

`memory_broker_test.go`:

```go
package approval

import (
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

func TestMemoryBrokerResolveDeliversToOnResolveNotOnCancel(t *testing.T) {
	b := &MemoryBroker{}
	b.Open("w-abc", "req-1")
	if err := b.Resolve("req-1", event.DecisionAccept); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	// Resolved requests are retired — a second Resolve is unknown.
	if err := b.Resolve("req-1", event.DecisionAccept); err != ErrUnknownRequest {
		t.Fatalf("second resolve = %v, want ErrUnknownRequest", err)
	}
}

func TestMemoryBrokerCancelThreadFansOutToEveryOpenRequest(t *testing.T) {
	var cancelled []string
	b := &MemoryBroker{OnCancel: func(threadID, requestID string) { cancelled = append(cancelled, threadID+"/"+requestID) }}
	b.Open("w-abc", "req-1")
	b.Open("w-abc", "req-2")
	b.Open("w-def", "req-3") // a different thread — must not be touched

	b.CancelThread("w-abc")

	if len(cancelled) != 2 {
		t.Fatalf("cancelled = %v, want exactly 2 (req-1, req-2)", cancelled)
	}
	// Cancelled requests are retired.
	if err := b.Resolve("req-1", event.DecisionAccept); err != ErrUnknownRequest {
		t.Fatalf("resolve after cancel = %v, want ErrUnknownRequest", err)
	}
	// The untouched thread's request is still open.
	if err := b.Resolve("req-3", event.DecisionAccept); err != nil {
		t.Fatalf("resolve on untouched thread: %v", err)
	}
}

func TestMemoryBrokerResolveUnknownRequestIsBenign(t *testing.T) {
	b := &MemoryBroker{}
	if err := b.Resolve("never-opened", event.DecisionAccept); err != ErrUnknownRequest {
		t.Fatalf("err = %v, want ErrUnknownRequest — a double-tap from a second device must be benign", err)
	}
}

func TestMemoryBrokerCancelThreadWithNoOpenRequestsIsANoop(t *testing.T) {
	called := false
	b := &MemoryBroker{OnCancel: func(string, string) { called = true }}
	b.CancelThread("w-nothing-pending")
	if called {
		t.Fatal("OnCancel must not fire for a thread with nothing open")
	}
}

func TestNoopBrokerImplementsOpen(t *testing.T) {
	var _ Broker = NoopBroker{}
	NoopBroker{}.Open("w-abc", "req-1") // must not panic
}
```

### Step 2: Run tests to verify they fail

Run: `go test ./backend/internal/agentcore/approval/... -v`
Expected: FAIL — `MemoryBroker` undefined; `Broker` interface has no `Open`.

### Step 3: Implement

`broker.go` — add `Open` to the interface, update the stale package comment
(it currently says "Spec 1 ships the interface and a no-op only... lands in
spec 2"):

```go
// Package approval bridges the asymmetry at the heart of agent permissions:
// the agent calls and blocks, but the answer arrives from a completely
// different direction (an HTTP request from the user), possibly minutes
// later and possibly from a different device.
//
// There is no blocking primitive here (no Await) — DevDeck drives the
// claude CLI over stdin/stdout RPC, not a callback-style SDK, so there is no
// adapter goroutine to unblock. See the design spec's correction to
// gg/HANDOFF.md section 6. What this package IS responsible for: knowing
// which requestIds are open on which thread, and fanning a thread-wide
// cancellation out to whoever must write the wire reply.
package approval

import (
	"errors"

	"devdeck/backend/internal/agentcore/event"
)

var ErrUnknownRequest = errors.New("approval: unknown request")

type Broker interface {
	// Open registers a request as pending on a thread, so a later
	// CancelThread can find and deny it.
	Open(threadID, requestID string)
	// Resolve delivers a decision to a waiting caller.
	Resolve(requestID string, d event.Decision) error
	// CancelThread abandons every pending request on a thread.
	CancelThread(threadID string)
}

// NoopBroker satisfies Broker without tracking anything — used wherever a
// provider never opens a request through this package (e.g. pi today).
type NoopBroker struct{}

func (NoopBroker) Open(string, string)                  {}
func (NoopBroker) Resolve(string, event.Decision) error  { return ErrUnknownRequest }
func (NoopBroker) CancelThread(string)                   {}

var _ Broker = NoopBroker{}
```

`memory_broker.go` (new):

```go
package approval

import (
	"sync"

	"devdeck/backend/internal/agentcore/event"
)

// MemoryBroker is the real Broker: an in-memory, per-process registry of
// open requestIds per thread, plus cancellation fan-out. It carries no
// provider-specific metadata (tool_use_id, raw input, permission_suggestions
// — those live in the claude package's parseState/pendingRequest, per
// event.go's no-leak rule) — only enough to answer "which requests are open
// on this thread" and "tell whoever writes the wire reply to deny them."
type MemoryBroker struct {
	mu       sync.Mutex
	byThread map[string]map[string]struct{} // threadID -> requestIDs
	byReq    map[string]string              // requestID -> threadID, for O(1) Resolve

	// OnCancel is called once per request CancelThread abandons — set by
	// main.go to provider.Service.RespondToRequest(ctx, threadID, requestID,
	// event.DecisionCancel). A process death (no live session) makes that
	// write fail; it is discarded on purpose — the point is retiring the
	// bookkeeping so the UI's RequestResolved event still clears.
	OnCancel func(threadID, requestID string)
}

func (b *MemoryBroker) Open(threadID, requestID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.byThread == nil {
		b.byThread = make(map[string]map[string]struct{})
		b.byReq = make(map[string]string)
	}
	if b.byThread[threadID] == nil {
		b.byThread[threadID] = make(map[string]struct{})
	}
	b.byThread[threadID][requestID] = struct{}{}
	b.byReq[requestID] = threadID
}

func (b *MemoryBroker) Resolve(requestID string, _ event.Decision) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	threadID, ok := b.byReq[requestID]
	if !ok {
		return ErrUnknownRequest
	}
	delete(b.byReq, requestID)
	if reqs := b.byThread[threadID]; reqs != nil {
		delete(reqs, requestID)
	}
	return nil
}

func (b *MemoryBroker) CancelThread(threadID string) {
	b.mu.Lock()
	reqs := b.byThread[threadID]
	ids := make([]string, 0, len(reqs))
	for id := range reqs {
		ids = append(ids, id)
	}
	for _, id := range ids {
		delete(b.byReq, id)
	}
	delete(b.byThread, threadID)
	cb := b.OnCancel
	b.mu.Unlock()

	if cb == nil {
		return
	}
	for _, id := range ids {
		cb(threadID, id)
	}
}

var _ Broker = (*MemoryBroker)(nil)
```

`workers.go` — `Ingestion.handle`'s `RequestOpened, UserInputRequested`
case gains one line, guarded to `RequestOpened` only (user input is never
callback/broker-style — spec §3's fourth trap):

```go
case event.RequestOpened, event.UserInputRequested:
	if err := in.flushThread(ctx, ev.ThreadID); err != nil {
		return err
	}
	if ev.Type == event.RequestOpened {
		in.Broker.Open(ev.ThreadID, ev.RequestID)
	}
	if err := in.dispatch(ctx, Command{
		Type: CmdThreadActivityAppend, ThreadID: ev.ThreadID,
		Payload: mustJSON(ev),
	}); err != nil {
		return err
	}
	return in.dispatch(ctx, Command{
		Type:     CmdThreadSessionSet,
		ThreadID: ev.ThreadID,
		Payload: mustJSON(map[string]any{
			"status":            string(ThreadWaiting),
			"pendingRequestAdd": ev.RequestID,
		}),
	})
```

This branch is unreachable for `event.RequestOpened` until T11 lands (the
parser never emits it before then) — dead but harmless, and it means T11
does not need to touch `workers.go` at all. Also update every
`approval.Broker` test fake across the two packages that implement it by
hand (`orderingBroker` in `workers_reactor_test.go`, `recordingBroker` in
`workers_test.go`) with a trivial `func (b ...) Open(string, string) {}` —
this is a **one-line addition per fake**, inside files T3 already owns;
since T10 is the task adding the interface method, T10 makes this addition
too (a compile-fix, not a behavior change, and small enough not to warrant
its own task or to count as "reopening T3's test files" in any meaningful
sense — note it here for the executor rather than pretending it doesn't
happen).

### Step 4: Run tests to verify they pass

Run: `go test ./backend/internal/agentcore/approval/... ./backend/internal/agentcore/orchestration/... -race -v`
Expected: PASS, including every existing test in both packages (the `Open`
additions to `orderingBroker`/`recordingBroker` are compile-fixes, not
behavior changes).

### Step 5: Commit

```bash
git add backend/internal/agentcore/approval/broker.go \
        backend/internal/agentcore/approval/memory_broker.go \
        backend/internal/agentcore/approval/memory_broker_test.go \
        backend/internal/agentcore/orchestration/workers.go \
        backend/internal/agentcore/orchestration/workers_test.go \
        backend/internal/agentcore/orchestration/workers_reactor_test.go
git commit -m "feat(approval): add MemoryBroker and wire Ingestion.Open for pending approvals"
```

**Verify:** `go test ./backend/... -race && go vet ./backend/...`

---

## T11 — Parser: real `can_use_tool` classification → `RequestOpened`

**Independent within A2** (parallel with T10). Reopens T1's `parse.go` —
safe only because T1 has merged.

**Files:**
- Modify: `backend/internal/agentcore/provider/claude/parse.go` (extends `parseControlRequest`'s `default:` branch and `parseControlCancelRequest`)
- Modify: `backend/internal/agentcore/provider/claude/parse_test.go`
- Create: `backend/internal/agentcore/provider/claude/testdata/control_request_bash_blocked.ndjson`
- Create: `backend/internal/agentcore/provider/claude/testdata/control_request_webfetch_accept.ndjson`
- Create: `backend/internal/agentcore/provider/claude/testdata/control_cancel_approval.ndjson`

**Interfaces:**
- Consumes: T1's `pendingRequest`, `pendingKindApproval`, `st.setPending`/`st.queueAutoDeny` (removed for this path; see below), `event.RequestOpened`, `event.RequestType` consts.
- Produces: nothing new for other tasks; T12 reads the SAME `pendingRequest.suggestions`/`toolUseID` fields T1 already declared (no new field needed).

### Step 1: Write the failing tests

Fixtures — `control_request_bash_blocked.ndjson` (per spec §0, `e15_bash`
shape, three suggestion kinds):

```json
{"type":"control_request","request_id":"d44ce000-0000-0000-0000-000000000005","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"rm -rf /tmp/scratch"},"description":"rm -rf /tmp/scratch","blocked_path":"/tmp/scratch","permission_suggestions":[{"type":"addRules","rule":"Bash(rm -rf /tmp/scratch)"},{"type":"addDirectories","directory":"/tmp/scratch"},{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_01BashExample"}}
```

`control_request_webfetch_accept.ndjson` (per spec §0, `e7`, NO
`permission_suggestions` at all — proves `acceptForSession` must be
withheld):

```json
{"type":"control_request","request_id":"e55ce000-0000-0000-0000-000000000006","request":{"subtype":"can_use_tool","tool_name":"WebFetch","display_name":"WebFetch","input":{"url":"https://example.com"},"description":"Fetch https://example.com","tool_use_id":"toolu_01WebFetchExample"}}
```

`control_cancel_approval.ndjson` (per spec, `e10_int_pending` shape — a
pending PERMISSION, cancelled):

```json
{"type":"control_request","request_id":"f66ce000-0000-0000-0000-000000000007","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"/tmp/hello.txt","content":"hi"},"description":"hello.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_01WriteExample"}}
{"type":"control_cancel_request","request_id":"f66ce000-0000-0000-0000-000000000007"}
```

Append to `parse_test.go`:

```go
func TestControlRequestBashProducesRequestOpenedWithClassification(t *testing.T) {
	evts := parseFixture(t, "testdata/control_request_bash_blocked.ndjson")
	if len(evts) != 1 || evts[0].Type != event.RequestOpened {
		t.Fatalf("events = %+v, want exactly one request.opened", evts)
	}
	e := evts[0]
	if e.RequestID != "d44ce000-0000-0000-0000-000000000005" {
		t.Fatalf("RequestID = %q", e.RequestID)
	}
	p, ok := e.Payload.(*event.RequestOpenedPayload)
	if !ok {
		t.Fatalf("payload = %T", e.Payload)
	}
	if p.RequestType != event.ReqCommandExecApproval {
		t.Fatalf("requestType = %s, want command_execution_approval", p.RequestType)
	}
	// blocked_path is the most specific thing the CLI says about WHY it
	// asked — it must be folded into Detail.
	if !strings.Contains(p.Detail, "/tmp/scratch") {
		t.Fatalf("Detail = %q, want it to mention the blocked path", p.Detail)
	}
	wantOptions := map[event.Decision]bool{
		event.DecisionAccept: true, event.DecisionAcceptForSession: true,
		event.DecisionDecline: true, event.DecisionCancel: true,
	}
	for _, opt := range p.Options {
		delete(wantOptions, opt)
	}
	if len(wantOptions) != 0 {
		t.Fatalf("Options = %v, missing %v", p.Options, wantOptions)
	}
}

// The worst kind of permission bug: "Always allow this session" silently
// degrading to "allow once" because the CLI sent no suggestions to echo.
func TestControlRequestWithNoSuggestionsExcludesAcceptForSession(t *testing.T) {
	evts := parseFixture(t, "testdata/control_request_webfetch_accept.ndjson")
	p := evts[0].Payload.(*event.RequestOpenedPayload)
	for _, opt := range p.Options {
		if opt == event.DecisionAcceptForSession {
			t.Fatal("acceptForSession must be withheld when permission_suggestions is empty")
		}
	}
}

func TestControlCancelRequestRetiresAPendingApproval(t *testing.T) {
	evts := parseFixture(t, "testdata/control_cancel_approval.ndjson")
	if len(evts) != 2 {
		t.Fatalf("got %d events, want 2: %+v", len(evts), evts)
	}
	resolved, ok := evts[1].Payload.(*event.RequestResolvedPayload)
	if !ok {
		t.Fatalf("second payload = %T, want *RequestResolvedPayload", evts[1].Payload)
	}
	if resolved.Decision != event.DecisionCancel {
		t.Fatalf("decision = %s, want cancel", resolved.Decision)
	}
	if resolved.RequestType != event.ReqFileChangeApproval {
		t.Fatalf("requestType = %s, want file_change_approval", resolved.RequestType)
	}
}

func TestControlRequestExitPlanModeStillAutoDeniesInA2(t *testing.T) {
	// A2 must not regress A1's plan-mode safety net — re-run T1's fixture.
	evts := parseFixture(t, "testdata/control_request_exitplanmode.ndjson")
	if len(evts) != 1 || evts[0].Type != event.ToolDenied {
		t.Fatalf("events = %+v, want exactly one tool.denied — A2 must not turn ExitPlanMode into an approval", evts)
	}
}
```

### Step 2: Run tests to verify they fail

Run: `go test ./backend/internal/agentcore/provider/claude/... -run 'ControlRequest|ControlCancel' -v`
Expected: FAIL — the `default:` branch of `parseControlRequest` still
auto-denies every non-`AskUserQuestion`/`ExitPlanMode` tool (T1's
behaviour), so `evts[0].Type` is `event.ToolDenied`, not `event.RequestOpened`.

### Step 3: Implement

Tool classification (spec §4.4) and detail/args (spec §4.3):

```go
func classifyRequestType(toolName string) event.RequestType {
	switch toolName {
	case "Bash":
		return event.ReqCommandExecApproval
	case "Write", "Edit", "NotebookEdit":
		return event.ReqFileChangeApproval
	case "Read":
		return event.ReqFileReadApproval
	default:
		return event.ReqUnknown
	}
}

// summarizeToolRequest is t3code's per-tool one-line fallback
// (ClaudeAdapter.ts) for when the CLI sends no `description`.
func summarizeToolRequest(toolName string, input json.RawMessage) string {
	switch toolName {
	case "Bash":
		var in struct {
			Command string `json:"command"`
		}
		_ = json.Unmarshal(input, &in)
		if in.Command != "" {
			return in.Command
		}
	case "Write", "Edit":
		var in struct {
			FilePath string `json:"file_path"`
		}
		_ = json.Unmarshal(input, &in)
		if in.FilePath != "" {
			return in.FilePath
		}
	}
	return toolName
}
```

Replace T1's `default:` branch inside `parseControlRequest`:

```go
default:
	requestType := classifyRequestType(body.ToolName)
	detail := body.Description
	if detail == "" {
		detail = summarizeToolRequest(body.ToolName, body.Input)
	}
	if body.BlockedPath != "" {
		detail = detail + " (blocked path: " + body.BlockedPath + ")"
	}
	options := []event.Decision{event.DecisionAccept, event.DecisionDecline, event.DecisionCancel}
	if len(body.PermissionSuggestions) > 0 && string(body.PermissionSuggestions) != "null" {
		options = append(options, event.DecisionAcceptForSession)
	}

	st.setPending(w.RequestID, &pendingRequest{
		requestID: w.RequestID, toolUseID: body.ToolUseID, toolName: body.ToolName,
		kind: pendingKindApproval, requestType: requestType,
		input: body.Input, suggestions: body.PermissionSuggestions,
	})

	e := st.envelope(event.RequestOpened)
	e.RequestID = w.RequestID
	e.Refs = withCallID(e.Refs, body.ToolUseID)
	e.Payload = &event.RequestOpenedPayload{
		RequestType: requestType, Detail: detail, Args: body.Input, Options: options,
	}
	return []event.Event{e}
```

`parseControlCancelRequest`'s `pendingKindApproval` branch (already stubbed
by T1 to emit `event.RequestResolved{RequestType: p.requestType, Decision:
DecisionCancel}`) needs no code change — `p.requestType` is now populated
correctly by this task's `setPending` call above. Confirm this by reading
T1's existing branch before assuming a no-op; if it was left as a TODO
comment instead of the real branch, implement it now exactly as T1's Step 3
code block specifies.

### Step 4: Run tests to verify they pass

Run: `go test ./backend/internal/agentcore/provider/claude/... -v`
Expected: PASS, including every T1 test (AskUserQuestion, ExitPlanMode,
unknown-subtype, control_response-with-no-id) untouched.

### Step 5: Commit

```bash
git add backend/internal/agentcore/provider/claude/parse.go \
        backend/internal/agentcore/provider/claude/parse_test.go \
        backend/internal/agentcore/provider/claude/testdata/control_request_bash_blocked.ndjson \
        backend/internal/agentcore/provider/claude/testdata/control_request_webfetch_accept.ndjson \
        backend/internal/agentcore/provider/claude/testdata/control_cancel_approval.ndjson
git commit -m "feat(claude): classify can_use_tool into a real request.opened event"
```

**Verify:** `go test ./backend/internal/agentcore/provider/claude/... -race && go vet ./backend/...`

---

## T12 — Adapter: real `RespondToRequest`

**Chained after T11** (needs `pendingRequest.suggestions`/`toolUseID`
populated for ordinary tools, which only exists once T11 lands). Reopens
T2's `adapter.go` — safe only because T2 has merged.

**Files:**
- Modify: `backend/internal/agentcore/provider/claude/adapter.go:423-430` (`RespondToRequest`)
- Create: `backend/internal/agentcore/provider/claude/decision_test.go`

**Interfaces:**
- Consumes: T2's `session.writeControlResponse` (unmodified, reused as-is),
  T1/T11's `parseState.takePending`.
- Produces: nothing new for other tasks — this is a leaf.

### Step 1: Write the failing tests

`decision_test.go` — the pure decision-mapping table, byte-compared against
the four verified captures (spec §4.3):

```go
package claude

import (
	"encoding/json"
	"reflect"
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

func TestPermissionResultForDecision(t *testing.T) {
	input := json.RawMessage(`{"file_path":"/tmp/hello.txt","content":"hi"}`)
	suggestions := json.RawMessage(`[{"type":"setMode","mode":"acceptEdits","destination":"session"}]`)

	cases := []struct {
		name string
		d    event.Decision
		want map[string]any
	}{
		{"accept", event.DecisionAccept, map[string]any{
			"behavior": "allow", "updatedInput": map[string]any{"file_path": "/tmp/hello.txt", "content": "hi"},
		}},
		{"acceptForSession", event.DecisionAcceptForSession, map[string]any{
			"behavior": "allow", "updatedInput": map[string]any{"file_path": "/tmp/hello.txt", "content": "hi"},
			"updatedPermissions": []any{map[string]any{"type": "setMode", "mode": "acceptEdits", "destination": "session"}},
		}},
		{"decline", event.DecisionDecline, map[string]any{
			"behavior": "deny", "message": "User declined tool execution.",
		}},
		{"cancel", event.DecisionCancel, map[string]any{
			"behavior": "deny", "message": "User cancelled tool execution.",
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := permissionResult(c.d, input, suggestions)
			var gotMap map[string]any
			b, _ := json.Marshal(got)
			_ = json.Unmarshal(b, &gotMap)
			if !reflect.DeepEqual(gotMap, c.want) {
				t.Fatalf("got %#v, want %#v", gotMap, c.want)
			}
		})
	}
}

// acceptForSession must NOT echo updatedPermissions when the CLI sent no
// suggestions — the parser already withholds the Options entry (T11), and
// the adapter must not manufacture one anyway if it's ever called this way.
func TestPermissionResultAcceptForSessionOmitsEmptySuggestions(t *testing.T) {
	got := permissionResult(event.DecisionAcceptForSession, json.RawMessage(`{}`), nil)
	if _, ok := got["updatedPermissions"]; ok {
		t.Fatal("updatedPermissions must be absent when there were no suggestions to echo")
	}
}
```

```go
func TestRespondToRequestWritesTheMappedDecisionAndRetiresPending(t *testing.T) {
	var buf bytes.Buffer
	st := newParseState("w-abc", "claude:default")
	st.setPending("req-1", &pendingRequest{
		requestID: "req-1", toolUseID: "toolu_1", toolName: "Write",
		kind: pendingKindApproval, requestType: event.ReqFileChangeApproval,
		input: json.RawMessage(`{"file_path":"/tmp/hello.txt"}`),
	})
	sess := &session{threadID: "w-abc", stdinEnc: json.NewEncoder(&buf), state: st}
	a := &adapter{instanceID: "claude:default", sessions: map[string]*session{"w-abc": sess}, events: make(chan event.Event, 4)}

	if err := a.RespondToRequest(context.Background(), "w-abc", "req-1", event.DecisionAccept); err != nil {
		t.Fatalf("respond: %v", err)
	}
	var wire map[string]any
	_ = json.Unmarshal(buf.Bytes(), &wire)
	inner := wire["response"].(map[string]any)["response"].(map[string]any)
	if inner["behavior"] != "allow" {
		t.Fatalf("behavior = %v", inner["behavior"])
	}

	buf.Reset()
	if err := a.RespondToRequest(context.Background(), "w-abc", "req-1", event.DecisionAccept); err != nil {
		t.Fatalf("second respond: %v", err)
	}
	if buf.Len() != 0 {
		t.Fatal("second respond on a retired request must be a no-op")
	}
}
```

### Step 2: Run tests to verify they fail

Run: `go test ./backend/internal/agentcore/provider/claude/... -run 'PermissionResult|RespondToRequest' -v`
Expected: FAIL — `permissionResult` undefined; `RespondToRequest` still
`return nil` unconditionally.

### Step 3: Implement

```go
// permissionResult maps a Decision onto the CLI's PermissionResult shape —
// identical to t3code (ClaudeAdapter.ts:4033-4051), verified byte-for-byte
// against captures e2, e14, e3.
func permissionResult(d event.Decision, input, suggestions json.RawMessage) map[string]any {
	switch d {
	case event.DecisionAccept, event.DecisionAcceptForSession:
		out := map[string]any{"behavior": "allow", "updatedInput": json.RawMessage(input)}
		if d == event.DecisionAcceptForSession && len(suggestions) > 0 && string(suggestions) != "null" {
			out["updatedPermissions"] = json.RawMessage(suggestions)
		}
		return out
	case event.DecisionCancel:
		return map[string]any{"behavior": "deny", "message": "User cancelled tool execution."}
	default: // decline
		return map[string]any{"behavior": "deny", "message": "User declined tool execution."}
	}
}

// RespondToRequest answers a pending can_use_tool approval.
func (a *adapter) RespondToRequest(ctx context.Context, threadID, requestID string, d event.Decision) error {
	a.mu.Lock()
	sess, ok := a.sessions[threadID]
	a.mu.Unlock()
	if !ok {
		return nil
	}
	p, found := sess.state.takePending(requestID)
	if !found {
		return nil
	}
	return sess.writeControlResponse(requestID, permissionResult(d, p.input, p.suggestions))
}
```

Update the doc comment above `RespondToRequest` (it currently says "no-op
in spec 1... The real implementation lands in spec 2" — now true, rewrite
it to describe the real behaviour, matching T2's rewrite of the
`buildArgs`/approval-required comment).

### Step 4: Run tests to verify they pass

Run: `go test ./backend/internal/agentcore/provider/claude/... -race -v`
Expected: PASS, whole package green.

### Step 5: Commit

```bash
git add backend/internal/agentcore/provider/claude/adapter.go \
        backend/internal/agentcore/provider/claude/decision_test.go
git commit -m "feat(claude): map operator decisions to real PermissionResult replies"
```

**Verify:** `go test ./backend/internal/agentcore/provider/claude/... -race && go vet ./backend/...`

---

## T13 — `main.go`: wire `MemoryBroker`

**CLAUDE.md convergence file. Single task, single edit, run alone — never
alongside any other task in this plan.** Needs T10, T11, T12 merged.

**Files:**
- Modify: `backend/cmd/server/main.go:445-446,463-464`

**Interfaces:**
- Consumes: T10's `approval.MemoryBroker`, existing `agentChatSvc *provider.Service` (already wired at `main.go:438`).
- Produces: nothing consumed by a later task — this is the final A2 backend
  integration step.

### Step 1: Write the failing test

`main.go`'s wiring has no unit test of its own (it is the composition
root); the check for this task is the existing full-stack test suite
(`backend/internal/handler/agent_smoke_test.go`,
`backend/internal/handler/agent_ws_e2e_test.go`) staying green plus a
manual smoke run. Confirm the RED state first:

Run: `grep -n "approval.NoopBroker{}" backend/cmd/server/main.go`
Expected: two matches (`main.go:446`, `main.go:464`) — the gap this task
closes.

### Step 2: (same as Step 1 for this composition-root task — no separate red test run)

### Step 3: Implement

```go
agentBroker := &approval.MemoryBroker{}

agentIngestion := orchestration.NewIngestion(
	agentEngine, agentBroker, func() string { return "ac-" + randomHex(8) },
)
```

```go
agentReactor := &orchestration.Reactor{
	Engine: agentEngine, Provider: agentChatSvc, Broker: agentBroker,
	// ...unchanged...
}
```

And, once `agentReactor`/`agentIngestion` exist (order matters — `OnCancel`
needs `agentChatSvc`, which is already in scope by this point in `main.go`):

```go
agentBroker.OnCancel = func(threadID, requestID string) {
	// Best-effort — see MemoryBroker.OnCancel's doc comment. Errors here are
	// swallowed on purpose: a dead session's write failing is expected, not
	// a bug to surface.
	_ = agentChatSvc.RespondToRequest(context.Background(), threadID, requestID, event.DecisionCancel)
}
```

Place this assignment immediately after `agentBroker := &approval.MemoryBroker{}`
(before `agentIngestion`/`agentReactor` are constructed, since both hold a
reference to the same `agentBroker` value — a `*MemoryBroker`, so the later
field assignment is visible to both regardless of order, but assigning it
up front keeps the read order matching the write order for a future
reader). Add `"devdeck/backend/internal/agentcore/event"` to `main.go`'s
imports if not already present (it is — `event.Decision` is referenced
nowhere else in `main.go` today, check with `grep -n
'agentcore/event"' backend/cmd/server/main.go` and add the import if absent).

### Step 4: Run tests to verify they pass

Run: `go build ./backend/... && go vet ./backend/... && go test ./backend/... -race`
Expected: PASS — full backend suite green, including
`agent_smoke_test.go`/`agent_ws_e2e_test.go`.

### Step 5: Commit

```bash
git add backend/cmd/server/main.go
git commit -m "feat(main): wire MemoryBroker in place of NoopBroker for real approvals"
```

**Verify:** `go build ./backend/... && go vet ./backend/... && go test ./backend/... -race`, plus a manual boot (`go run ./backend/cmd/server --role both`) confirming no panic at startup.

---

## T14 — `types.ts`: `PendingApproval` + `AgentThreadView.pendingApprovals`

**Independent within A2** (starts the frontend track). Reopens T5's file.

**Files:**
- Modify: `frontend/src/features/agent-chat/types.ts`

**Interfaces:**
- Produces: `PendingApproval{requestId: string; createdAt: number; requestType: string; detail?: string; args?: unknown; options: string[]}`, `AgentThreadView.pendingApprovals: PendingApproval[]` — consumed by T15, T16, T18.

Same shape as T5: additive, type-only, no test file of its own; T15 turns
the resulting typecheck failure green.

### Step 1: Confirm the gap

Run: `cd frontend && grep -n "pendingApprovals" src/features/agent-chat/types.ts`
Expected: no matches.

### Step 3: Implement

```ts
/** One open approval request — mirrors the backend's `event.RequestOpenedPayload`
 *  plus the envelope's own `requestId`/`createdAt`. `requestType`/`options`
 *  are the wire strings verbatim (`event.RequestType`/`event.Decision`
 *  values, e.g. "command_execution_approval" / "acceptForSession") — this
 *  file does not re-enum them, matching how `AgentEvent.type` is left as a
 *  plain `string` rather than a TS union of every backend event type. */
export interface PendingApproval {
  requestId: string
  createdAt: number
  requestType: string
  detail?: string
  args?: unknown
  options: string[]
}
```

Add `pendingApprovals: PendingApproval[]` to `AgentThreadView`, alongside
`pendingUserInputs`.

### Step 4: Run to verify

Run: `cd frontend && npm run typecheck`
Expected: FAIL — `eventReducer.ts`'s `emptyThreadView()` is missing the new
required field (same pattern as T5→T6; T15 is the intended fix).

### Step 5: Commit

```bash
git add frontend/src/features/agent-chat/types.ts
git commit -m "feat(agent-chat): add PendingApproval type to AgentThreadView"
```

**Verify:** none standalone — land together with T15.

---

## T15 — `eventReducer.ts`: fold `request.opened`/`request.resolved`

**Chained after T14. Parallel with T16.** Reopens T6's file.

**Files:**
- Modify: `frontend/src/features/agent-chat/eventReducer.ts`
- Modify: `frontend/src/features/agent-chat/eventReducer.test.ts`

**Interfaces:**
- Consumes: T14's `PendingApproval`.
- Produces: nothing new — leaf, feeds T18's runtime behavior via `view.pendingApprovals`.

### Step 1: Write the failing tests

Mirror T6's tests, one level up (approval instead of user-input):

```ts
function requestOpenedEvent(seq: number, requestId: string): AgentEvent {
  return {
    seq, eventId: `e${seq}`, type: 'thread.activity-appended', threadId: 't1', commandId: `c${seq}`,
    createdAt: seq * 1000,
    payload: {
      type: 'request.opened', requestId, threadId: 't1',
      payload: { requestType: 'command_execution_approval', detail: 'rm -rf /tmp/x', options: ['accept', 'decline', 'cancel'] },
    },
  }
}
function requestResolvedEvent(seq: number, requestId: string): AgentEvent {
  return {
    seq, eventId: `e${seq}`, type: 'thread.activity-appended', threadId: 't1', commandId: `c${seq}`,
    createdAt: seq * 1000,
    payload: { type: 'request.resolved', requestId, threadId: 't1', payload: { requestType: 'command_execution_approval', decision: 'accept' } },
  }
}

describe('reduceAgentEvents — pendingApprovals', () => {
  it('request.opened opens, request.resolved closes', () => {
    const opened = reduceAgentEvents(emptyThreadView(), [requestOpenedEvent(1, 'req-1')])
    expect(opened.pendingApprovals).toHaveLength(1)
    expect(opened.pendingApprovals[0].options).toContain('accept')
    const closed = reduceAgentEvents(opened, [requestResolvedEvent(2, 'req-1')])
    expect(closed.pendingApprovals).toHaveLength(0)
  })

  it('a cancel-shaped resolved event (from control_cancel_request) still closes it', () => {
    const opened = reduceAgentEvents(emptyThreadView(), [requestOpenedEvent(1, 'req-1')])
    const cancelEvent = requestResolvedEvent(2, 'req-1')
    ;(cancelEvent.payload as any).payload.decision = 'cancel'
    const closed = reduceAgentEvents(opened, [cancelEvent])
    expect(closed.pendingApprovals).toHaveLength(0)
  })

  it('acceptForSession absent from options is preserved through the fold', () => {
    const ev = requestOpenedEvent(1, 'req-1')
    ;(ev.payload as any).payload.options = ['accept', 'decline', 'cancel']
    const view = reduceAgentEvents(emptyThreadView(), [ev])
    expect(view.pendingApprovals[0].options).not.toContain('acceptForSession')
  })
})
```

### Step 2: Run tests to verify they fail

Run: `cd frontend && npx vitest run src/features/agent-chat/eventReducer.test.ts`
Expected: FAIL — `pendingApprovals` undefined on the returned view.

### Step 3: Implement

`emptyThreadView()` gains `pendingApprovals: []`.

Extend the `ForwardedProviderEvent.payload` shape with the approval fields:

```ts
payload?: {
  itemType?: string
  title?: string
  status?: string
  message?: string
  detail?: unknown
  questions?: unknown
  requestType?: string
  decision?: string
  args?: unknown
  options?: unknown
}
```

```ts
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function openPendingApproval(pending: PendingApproval[], ev: ForwardedProviderEvent, createdAt: number): PendingApproval[] {
  if (!ev.requestId) return pending
  if (pending.some((p) => p.requestId === ev.requestId)) return pending
  const requestType = ev.payload?.requestType
  if (typeof requestType !== 'string') return pending
  return [
    ...pending,
    {
      requestId: ev.requestId,
      createdAt,
      requestType,
      detail: typeof ev.payload?.detail === 'string' ? ev.payload.detail : undefined,
      args: ev.payload?.args,
      options: isStringArray(ev.payload?.options) ? ev.payload.options : [],
    },
  ]
}

function closePendingApproval(pending: PendingApproval[], requestId: string | undefined): PendingApproval[] {
  if (!requestId) return pending
  const next = pending.filter((p) => p.requestId !== requestId)
  return next.length === pending.length ? pending : next
}
```

In the reducer loop, alongside the `user-input.*` branches:

```ts
} else if (isForwardedProviderEvent(event.payload) && event.payload.type === 'request.opened') {
  pendingApprovals = openPendingApproval(pendingApprovals, event.payload, event.createdAt)
} else if (isForwardedProviderEvent(event.payload) && event.payload.type === 'request.resolved') {
  pendingApprovals = closePendingApproval(pendingApprovals, event.payload.requestId)
} else if (...)
```

Add `pendingApprovals` to the local-vars block and the final return.

### Step 4: Run tests to verify they pass

Run: `cd frontend && npx vitest run src/features/agent-chat/eventReducer.test.ts && npm run typecheck`
Expected: PASS, including every T6 and pre-existing case.

### Step 5: Commit

```bash
git add frontend/src/features/agent-chat/eventReducer.ts \
        frontend/src/features/agent-chat/eventReducer.test.ts
git commit -m "feat(agent-chat): fold request.opened/resolved into pendingApprovals"
```

**Verify:** `cd frontend && npx vitest run src/features/agent-chat/eventReducer.test.ts && npm run typecheck`

---

## T16 — `ComposerPendingApprovalPanel.tsx` + `ComposerPendingApprovalActions.tsx`

**Chained after T14. Parallel with T15.**

**Files:**
- Create: `frontend/src/features/agent-chat/ComposerPendingApprovalPanel.tsx`
- Create: `frontend/src/features/agent-chat/ComposerPendingApprovalPanel.test.tsx`
- Create: `frontend/src/features/agent-chat/ComposerPendingApprovalActions.tsx`
- Create: `frontend/src/features/agent-chat/ComposerPendingApprovalActions.test.tsx`

**Interfaces:**
- Consumes: T14's `PendingApproval`.
- Produces: `ComposerPendingApprovalPanelProps { pendingApprovals: PendingApproval[]; onRespondToApproval: (requestId: string, decision: string) => void }` — the shape T18 mounts.

### Step 1: Write the failing tests

`ComposerPendingApprovalActions.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ComposerPendingApprovalActions } from '@/features/agent-chat/ComposerPendingApprovalActions'

afterEach(() => cleanup())

describe('ComposerPendingApprovalActions', () => {
  it('renders Cancel, Decline, Approve, and Always-allow when acceptForSession is offered', () => {
    render(<ComposerPendingApprovalActions requestId="req-1" options={['accept', 'acceptForSession', 'decline', 'cancel']} onRespond={vi.fn()} />)
    expect(screen.getByText('Cancel turn')).toBeInTheDocument()
    expect(screen.getByText('Decline')).toBeInTheDocument()
    expect(screen.getByText('Always allow this session')).toBeInTheDocument()
    expect(screen.getByText('Approve once')).toBeInTheDocument()
  })

  it('omits Always-allow when acceptForSession is not in options', () => {
    render(<ComposerPendingApprovalActions requestId="req-1" options={['accept', 'decline', 'cancel']} onRespond={vi.fn()} />)
    expect(screen.queryByText('Always allow this session')).not.toBeInTheDocument()
  })

  it('clicking Approve once calls onRespond with accept', () => {
    const onRespond = vi.fn()
    render(<ComposerPendingApprovalActions requestId="req-1" options={['accept', 'decline', 'cancel']} onRespond={onRespond} />)
    fireEvent.click(screen.getByText('Approve once'))
    expect(onRespond).toHaveBeenCalledWith('req-1', 'accept')
  })
})
```

`ComposerPendingApprovalPanel.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ComposerPendingApprovalPanel } from '@/features/agent-chat/ComposerPendingApprovalPanel'
import type { PendingApproval } from '@/features/agent-chat/types'

afterEach(() => cleanup())

const approval: PendingApproval = {
  requestId: 'req-1', createdAt: 1, requestType: 'command_execution_approval',
  detail: 'rm -rf /tmp/x', options: ['accept', 'decline', 'cancel'],
}

describe('ComposerPendingApprovalPanel', () => {
  it('renders nothing when there is no pending approval', () => {
    const { container } = render(<ComposerPendingApprovalPanel pendingApprovals={[]} onRespondToApproval={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the summary, detail, and an n/m counter when more than one is pending', () => {
    render(<ComposerPendingApprovalPanel pendingApprovals={[approval, { ...approval, requestId: 'req-2' }]} onRespondToApproval={vi.fn()} />)
    expect(screen.getByText('Command approval requested')).toBeInTheDocument()
    expect(screen.getByText('rm -rf /tmp/x')).toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()
  })
})
```

### Step 2: Run tests to verify they fail

Run: `cd frontend && npx vitest run src/features/agent-chat/ComposerPendingApprovalPanel.test.tsx src/features/agent-chat/ComposerPendingApprovalActions.test.tsx`
Expected: FAIL — neither component exists.

### Step 3: Implement

`ComposerPendingApprovalActions.tsx` — port t3code's version
(`gg/t3code/apps/web/src/components/chat/ComposerPendingApprovalActions.tsx`),
adapted to this repo's `Button` component and props (no `ApprovalRequestId`
branded type — plain `string`, matching this plan's `PendingApproval`):

```tsx
import { Button } from '@/components/shadcn/button'

export interface ComposerPendingApprovalActionsProps {
  requestId: string
  options: string[]
  onRespond: (requestId: string, decision: string) => void
}

export function ComposerPendingApprovalActions({ requestId, options, onRespond }: ComposerPendingApprovalActionsProps) {
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => onRespond(requestId, 'cancel')}>
        Cancel turn
      </Button>
      <Button size="sm" variant="outline" onClick={() => onRespond(requestId, 'decline')}>
        Decline
      </Button>
      {options.includes('acceptForSession') ? (
        <Button size="sm" variant="outline" onClick={() => onRespond(requestId, 'acceptForSession')}>
          Always allow this session
        </Button>
      ) : null}
      <Button size="sm" variant="default" onClick={() => onRespond(requestId, 'accept')}>
        Approve once
      </Button>
    </>
  )
}
```

(Confirm the exact import path/variant names for this repo's `Button` — read
`frontend/src/components/shadcn/button.tsx` before writing; use whatever
`variant` values that file actually exports, matching `ComposerControls.tsx`'s
existing usage rather than inventing new ones.)

`ComposerPendingApprovalPanel.tsx` — port
`gg/t3code/apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx`,
this repo's tokens (`text-muted-foreground`, `border-border`, `bg-muted`,
not t3code's raw values), mounting `ComposerPendingApprovalActions`:

```tsx
import { ComposerPendingApprovalActions } from '@/features/agent-chat/ComposerPendingApprovalActions'
import type { PendingApproval } from '@/features/agent-chat/types'

export interface ComposerPendingApprovalPanelProps {
  pendingApprovals: PendingApproval[]
  onRespondToApproval: (requestId: string, decision: string) => void
}

const SUMMARY: Record<string, string> = {
  command_execution_approval: 'Command approval requested',
  file_read_approval: 'File-read approval requested',
  file_change_approval: 'File-change approval requested',
}

export function ComposerPendingApprovalPanel({ pendingApprovals, onRespondToApproval }: ComposerPendingApprovalPanelProps) {
  const active = pendingApprovals[0]
  if (!active) return null

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold tracking-[0.2em] uppercase text-muted-foreground">Pending approval</span>
        <span className="text-sm font-medium">{SUMMARY[active.requestType] ?? 'Approval requested'}</span>
        {pendingApprovals.length > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingApprovals.length}</span>
        ) : null}
      </div>
      {active.detail ? (
        <div className="mt-3 rounded-lg border border-border bg-background/70 p-3">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
            {active.detail}
          </pre>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <ComposerPendingApprovalActions
          requestId={active.requestId}
          options={active.options}
          onRespond={onRespondToApproval}
        />
      </div>
    </div>
  )
}
```

### Step 4: Run tests to verify they pass

Run: `cd frontend && npx vitest run src/features/agent-chat/ComposerPendingApprovalPanel.test.tsx src/features/agent-chat/ComposerPendingApprovalActions.test.tsx`
Expected: PASS.

### Step 5: Commit

```bash
git add frontend/src/features/agent-chat/ComposerPendingApprovalPanel.tsx \
        frontend/src/features/agent-chat/ComposerPendingApprovalPanel.test.tsx \
        frontend/src/features/agent-chat/ComposerPendingApprovalActions.tsx \
        frontend/src/features/agent-chat/ComposerPendingApprovalActions.test.tsx
git commit -m "feat(agent-chat): add ComposerPendingApprovalPanel and its actions"
```

**Verify:** `cd frontend && npx vitest run src/features/agent-chat/ComposerPendingApprovalPanel.test.tsx src/features/agent-chat/ComposerPendingApprovalActions.test.tsx && npm run typecheck`

---

## T17 — `useAgentChatSocket.ts`: `respondToApproval`

**Independent within A2.** Reopens T8's file.

**Files:**
- Modify: `frontend/src/features/agent-chat/useAgentChatSocket.ts`

**Interfaces:**
- Produces: `respondToApproval: (requestId: string, decision: string) => void` on `UseAgentChatSocketResult`.

### Step 1: Confirm the gap

Run: `cd frontend && grep -n "respondToApproval" src/features/agent-chat/useAgentChatSocket.ts`
Expected: no matches.

### Step 3: Implement

```ts
type AgentCommandType =
  | 'thread.turn.start'
  | 'thread.turn.interrupt'
  | 'thread.runtime-mode.set'
  | 'thread.interaction-mode.set'
  | 'thread.user-input.respond'
  | 'thread.approval.respond'
```

```ts
export interface UseAgentChatSocketResult {
  // ...existing fields...
  respondToUserInput: (requestId: string, answers: Record<string, unknown>) => void
  /** Dispatches `thread.approval.respond` — already on `ClientDispatchable`
   *  (`command.go:55`). `decision` is one of `event.Decision`'s wire values. */
  respondToApproval: (requestId: string, decision: string) => void
}
```

```ts
const respondToApproval = useCallback(
  (requestId: string, decision: string) => dispatch('thread.approval.respond', { requestId, decision }),
  [dispatch],
)
```

Add to the final `return`.

### Step 4: Run to verify

Run: `cd frontend && npm run typecheck`
Expected: PASS.

### Step 5: Commit

```bash
git add frontend/src/features/agent-chat/useAgentChatSocket.ts
git commit -m "feat(agent-chat): expose respondToApproval on the agent chat socket"
```

**Verify:** `cd frontend && npm run typecheck`

---

## T18 — Wire the approval panel into `ChatComposer`/`AgentChatPane`

**Sink of T15, T16, T17.** Reopens T9's files.

**Files:**
- Modify: `frontend/src/features/agent-chat/ChatComposer.tsx`
- Modify: `frontend/src/features/agent-chat/AgentChatPane.tsx`
- Modify: `frontend/src/features/agent-chat/ChatComposer.test.tsx`

**Interfaces:**
- Consumes: T16's `ComposerPendingApprovalPanel`, T14's `PendingApproval`, T17's `respondToApproval`.
- Produces: `ChatComposerProps` gains `pendingApprovals: PendingApproval[]` and `onRespondToApproval: (requestId: string, decision: string) => void`.

**Panel precedence, decided here (not specified verbatim upstream — the
spec's data-flow diagram shows both panels as siblings of the same slot
without stating which wins when both are simultaneously pending):** render
`ComposerPendingUserInputPanel` if `pendingUserInputs` is non-empty,
otherwise `ComposerPendingApprovalPanel` if `pendingApprovals` is non-empty.
Rationale: a question is rarer and typically gates what the agent does
next; an approval can wait one extra render. Both panels already show an
`n/m` counter for their own queue (spec's stated non-goal is a *combined*
multi-kind queue UI, not this ordering choice).

### Step 1: Write the failing tests

`ChatComposer.test.tsx`:

```tsx
const onePendingApproval: ChatComposerProps['pendingApprovals'] = [
  { requestId: 'req-2', createdAt: 1, requestType: 'command_execution_approval', detail: 'rm -rf /tmp/x', options: ['accept', 'decline', 'cancel'] },
]

it('renders the approval panel and forwards a decision', () => {
  const onRespondToApproval = vi.fn()
  render(
    <ChatComposer
      status="waiting" onSend={vi.fn()} onAbort={vi.fn()} controls={controls}
      pendingUserInputs={[]} onRespondToUserInput={vi.fn()}
      pendingApprovals={onePendingApproval} onRespondToApproval={onRespondToApproval}
    />,
  )
  fireEvent.click(screen.getByText('Approve once'))
  expect(onRespondToApproval).toHaveBeenCalledWith('req-2', 'accept')
})

it('the user-input panel takes precedence when both are pending', () => {
  render(
    <ChatComposer
      status="waiting" onSend={vi.fn()} onAbort={vi.fn()} controls={controls}
      pendingUserInputs={onePendingQuestion} onRespondToUserInput={vi.fn()}
      pendingApprovals={onePendingApproval} onRespondToApproval={vi.fn()}
    />,
  )
  expect(screen.getByText('Tabs')).toBeInTheDocument()
  expect(screen.queryByText('Approve once')).not.toBeInTheDocument()
})
```

### Step 2: Run tests to verify they fail

Run: `cd frontend && npx vitest run src/features/agent-chat/ChatComposer.test.tsx`
Expected: FAIL — `ChatComposerProps` has no `pendingApprovals`/
`onRespondToApproval` (compile error).

### Step 3: Implement

`ChatComposer.tsx`:

```tsx
import { ComposerPendingApprovalPanel } from '@/features/agent-chat/ComposerPendingApprovalPanel'
import type { PendingApproval } from '@/features/agent-chat/types'

export interface ChatComposerProps {
  // ...existing + T9's fields...
  pendingApprovals: PendingApproval[]
  onRespondToApproval: (requestId: string, decision: string) => void
}
```

```tsx
<div data-slot="composer-panels">
  {pendingUserInputs.length > 0 ? (
    <ComposerPendingUserInputPanel
      pendingUserInputs={pendingUserInputs}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
    />
  ) : pendingApprovals.length > 0 ? (
    <ComposerPendingApprovalPanel pendingApprovals={pendingApprovals} onRespondToApproval={onRespondToApproval} />
  ) : null}
</div>
```

`AgentChatPane.tsx`:

```tsx
const { view, status, sendTurn, abortTurn, setRuntimeMode, setInteractionMode, respondToUserInput, respondToApproval } =
  useAgentChatSocket({ machine, threadKey })
```

```tsx
<ChatComposer
  // ...unchanged...
  pendingUserInputs={view.pendingUserInputs}
  onRespondToUserInput={respondToUserInput}
  pendingApprovals={view.pendingApprovals}
  onRespondToApproval={respondToApproval}
/>
```

### Step 4: Run tests to verify they pass

Run: `cd frontend && npx vitest run src/features/agent-chat/ChatComposer.test.tsx src/features/agent-chat/AgentChatPane.test.tsx && npm run typecheck`
Expected: PASS, every prior case (T9's, and every pre-existing case) still
green.

### Step 5: Commit

```bash
git add frontend/src/features/agent-chat/ChatComposer.tsx \
        frontend/src/features/agent-chat/AgentChatPane.tsx \
        frontend/src/features/agent-chat/ChatComposer.test.tsx
git commit -m "feat(agent-chat): mount ComposerPendingApprovalPanel alongside the user-input panel"
```

**Verify:** `cd frontend && npm test && npm run typecheck && npm run build`

---

## A2 — Review, fix, finalize

Review runs once, over the whole A2 diff (T10-T18).

**Review lenses (parallel):**
- Spec conformance against §2-§4.6 (decision mapping, request classification,
  `Options` withholding, `ExitPlanMode` still denying in A2), §3 (the four
  HANDOFF traps table — re-verify each row against the actual T10-T13 code,
  not just the spec's prose).
- TDD honesty, same standard as A1.
- The **double-tap and restart-safety invariants A2 must not weaken**:
  `TestApprovalDoubleTap…` (unmodified, must stay green — it already covers
  the decider's guard); `ReconcileOrphanedThreads` clearing
  `PendingRequests` in bulk still fires for an approval left pending across
  a restart (no new code needed, but confirm the existing test —
  `TestReconcileOrphanedThreadsClearsAPendingApproval` — still passes
  unmodified against the new code paths).
- `MemoryBroker`'s mutex discipline under `-race`, specifically the
  `Ingestion.Open` (Consume goroutine) vs. `Reactor`'s `CancelThread`
  (Reactor goroutine) interleaving named in T10.
- Regression risk in every file named in A1's finalize step, plus
  `agent_smoke_test.go`/`agent_ws_e2e_test.go` (full end-to-end, exercised
  for the first time by T13's wiring).

**Fix:** apply confirmed findings only.

**Finalize:**
- Backend: `go build ./backend/... && go vet ./backend/... && go test ./backend/... -race`
- Frontend: `cd frontend && npm run typecheck && npm test && npm run build`

**Manual gate before A2 merges:** the same live-CLI gate as A1, extended to
a real approval round-trip — trigger a `Write`/`Bash` tool call in
approval-required mode, confirm the panel renders the right summary/detail,
click each of Approve once / Always allow this session / Decline / Cancel
turn in turn (across separate runs) and confirm the CLI's resulting
behaviour matches spec §0's table (`e2`, `e14`, `e3` captures). Also verify
`ExitPlanMode` still cannot be escaped through this panel (spec §4.6 — B
owns the approve path, A must not accidentally open one).

---

## Known-good baseline

`npm test` (from `frontend/`) has **one pre-existing failure**, in the
monaco guard test (see MEMORY: "devdeck monaco guard test flake"). It is
not caused by this work and must not be "fixed" as part of either
deliverable. **Any second failure, at any point in A1 or A2, is a real
regression** — stop and fix it before moving to the next task, per
`superpowers:systematic-debugging`.

`go test ./backend/...` has no known pre-existing failures; a red backend
test at any point in this plan is a regression, full stop.

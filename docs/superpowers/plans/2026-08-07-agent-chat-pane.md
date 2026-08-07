# Agent Chat Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DevDeck's raw agent PTY with a structured chat pane backed by an event-sourced harness, so the backend understands turns, reasoning, and tool calls instead of shuttling opaque bytes.

**Architecture:** A canonical event vocabulary sits between agent CLIs and everything above them. A pure decider turns Commands into Events; an engine commits them atomically through `port.Store` and publishes them. An Ingestion worker feeds provider output *in*; a Reactor worker drives provider calls *out*. All of it runs on the **runtime** machine that owns the worktree, reached from the browser over `/ws/agent`.

**Tech Stack:** Go 1.25 (stdlib `net/http`, `nhooyr.io/websocket`, `modernc.org/sqlite`), React 19 + TypeScript 5.7, zustand, Vitest, Tailwind v4, `@base-ui/react`.

**Source spec:** `docs/superpowers/specs/2026-08-07-agent-chat-pane-design.md`
**Source skeleton:** `gg/agentcore/` — port it, don't reinvent it. `gg/HANDOFF.md` explains *why* each piece is shaped the way it is; read it before Task 1.

## Global Constraints

Every task's requirements implicitly include this section.

**Porting the skeleton**
- Go module path is `devdeck/backend`. Every skeleton import of `example.com/agentcore/X` becomes `devdeck/backend/internal/agentcore/X`. The skeleton's own `go.mod` is **not** copied.
- Skeleton comments are in Indonesian. **Translate every comment to English, preserving the reasoning** — the reasoning is the valuable part. Do not drop a comment because it is long.
- Skeleton error strings are in Indonesian (`"thread %s sudah ada"`). Translate to English (`"thread %s already exists"`).

**Event-sourcing invariants — never compromise these**
- `Decide(state, cmd, now, newID)` is **pure**: no I/O, no `time.Now()`, no randomness. `now` and `newID` are parameters precisely so the whole rule set is table-testable.
- Order is **commit → swap state → publish**, never any other order. Swapping first means a failed commit leaves the read model holding facts that were never logged.
- `CommandID` drives idempotency. `SeenCommand` is checked *before* `Decide`.
- Commands are imperative and dotted (`thread.turn.start`); events are past-tense and hyphenated (`thread.turn-start-requested`). Never mix.
- `Sequence` is monotonic per `(ItemID, StreamKind)`.
- Native provider IDs live **only** in `Refs`. Orchestration uses DevDeck IDs.
- `Raw` is stored for debugging and **never** branched on in production code.
- **`InstanceID`, never `Kind`, for routing** — from the first commit, even though this spec creates one instance per agent. t3code paid for this migration twice.

**DevDeck conventions**
- All persistence goes through `port.Store`. Handlers use `handleStoreErr(w, err)`; errors always use the `{"error":"message"}` envelope, never raw SQL.
- SQLite uses `?` placeholders (not `$1`). Schema is appended to the `const schema` string in `backend/internal/store/db.go` using `CREATE TABLE IF NOT EXISTS`.
- IDs are type-prefixed hex generated via `crypto/rand`. Agent threads reuse the worktree id; new ids introduced here use prefix `ae-` (agent event) and `ac-` (agent command).
- Logging is `log.Printf` (stdlib). The skeleton uses `slog` — convert to `log.Printf` to match the codebase.
- Frontend: `@/*` alias only, `import type` for type-only imports (`verbatimModuleSyntax` is on), dark-only v2 tokens from `globals.css`, `lucide-react` icons, `cn()` for class merging, `sonner` for toasts.
- **Never edit `frontend/src/routeTree.gen.ts`.**

**Convergence files — serialize, never touch from parallel agents**
`backend/internal/port/store.go` · `backend/cmd/server/main.go` · `backend/internal/domain/models.go` · `frontend/src/store/useDevDeckStore.ts` · `frontend/src/store/types.ts` · `frontend/src/routeTree.gen.ts`

**Verification**
- Backend: `cd backend && go vet ./... && go test ./... -race`
- Frontend: `cd frontend && npm run typecheck && npm test`
- The pre-commit hook runs an **unscoped full-project typecheck** and will block commits for pre-existing errors elsewhere in the tree. Verify against the working tree, not a clean `HEAD` checkout. If the hook blocks on errors your task did not introduce, commit with `--no-verify` and say so in the task report.

## File Structure

**Backend — new**

| File | Responsibility |
|---|---|
| `backend/internal/agentcore/event/event.go` | Canonical event vocabulary, payload registry, JSON decode |
| `backend/internal/agentcore/event/event_test.go` | Round-trip and unknown-type tolerance |
| `backend/internal/agentcore/provider/provider.go` | Driver, Adapter, Registry, Service, ThreadDirectory |
| `backend/internal/agentcore/provider/claude/driver.go` | Claude Driver — config, `Probe`, `Create` |
| `backend/internal/agentcore/provider/claude/adapter.go` | Claude Adapter — process, sessions, turns |
| `backend/internal/agentcore/provider/claude/parse.go` | `stream-json` NDJSON → canonical events |
| `backend/internal/agentcore/provider/claude/parse_test.go` | Fixture-driven parser tests |
| `backend/internal/agentcore/provider/claude/testdata/*.ndjson` | Captured CLI output |
| `backend/internal/agentcore/approval/broker.go` | Broker **interface only** — implementation is spec 2 |
| `backend/internal/agentcore/orchestration/command.go` | Command + Event types, `ClientDispatchable`, `IntentEvents` |
| `backend/internal/agentcore/orchestration/engine.go` | State, `Decide`, `Apply`, `Engine` |
| `backend/internal/agentcore/orchestration/memstore.go` | In-memory store for tests |
| `backend/internal/agentcore/orchestration/engine_test.go` | Decider + engine table tests |
| `backend/internal/agentcore/orchestration/workers.go` | Ingestion + Reactor |
| `backend/internal/store/agentevent.go` | SQLite implementation of the agent-event methods |
| `backend/internal/store/agentevent_test.go` | Atomicity, idempotency, ordering |
| `backend/internal/handler/agent_ws.go` | `/ws/agent` — envelope protocol, replay-from-Seq |
| `backend/internal/handler/agent_ws_test.go` | Handshake, replay, idempotent resend |

**Backend — modified**

| File | Change |
|---|---|
| `backend/internal/port/store.go` | +4 methods (**convergence**) |
| `backend/internal/store/db.go` | +3 tables in `const schema` |
| `backend/internal/service/agent.go` | Probe snapshot on `ListAgents` |
| `backend/cmd/server/main.go` | Wire engine, registry, workers, route (**convergence**) |

**Frontend — new**

| File | Responsibility |
|---|---|
| `frontend/src/features/agent-chat/types.ts` | Wire types mirroring the Go event envelope |
| `frontend/src/features/agent-chat/eventReducer.ts` | `Event[]` → view model (pure) |
| `frontend/src/features/agent-chat/eventReducer.test.ts` | Ordering, gaps, duplicates |
| `frontend/src/features/agent-chat/timeline.ts` | Grouping into renderable entries (pure) |
| `frontend/src/features/agent-chat/timeline.test.ts` | Grouping rules |
| `frontend/src/features/agent-chat/scrollAnchoring.ts` | Follow-mode re-arm band (pure) |
| `frontend/src/features/agent-chat/scrollAnchoring.test.ts` | Re-arm threshold behaviour |
| `frontend/src/features/agent-chat/useAgentChatSocket.ts` | WS lifecycle, replay-from-Seq, reconnect |
| `frontend/src/features/agent-chat/AgentChatPane.tsx` | Pane shell — loading / error / empty states |
| `frontend/src/features/agent-chat/ChatHeader.tsx` | Agent · model · mode pickers |
| `frontend/src/features/agent-chat/MessagesTimeline.tsx` | Messages, reasoning blocks, tool rows |
| `frontend/src/features/agent-chat/ChatComposer.tsx` | Input, send, abort |

**Frontend — modified**

| File | Change |
|---|---|
| `frontend/src/features/terminal/paneTree.ts` | `agent-chat` pane kind + factory |
| `frontend/src/features/terminal/ExpandedTerminal.tsx` | Render the pane; default a worktree to chat |
| `frontend/src/store/useDevDeckStore.ts` | `agentThreads` slice (**convergence**) |

---

### Task 1: Canonical event vocabulary

The whole design rests on this file, and it is the one place we deliberately build ahead of need: all CORE types are defined now, including ones Claude never emits, because an event vocabulary born from one provider stays bent around it forever.

**Files:**
- Create: `backend/internal/agentcore/event/event.go` (port of `gg/agentcore/event/event.go`)
- Test: `backend/internal/agentcore/event/event_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `event.Type` constants; `event.Event{EventID, Type, Provider, InstanceID, ThreadID, TurnID, ItemID, RequestID, CreatedAt, Refs *Refs, Raw *Raw, Payload Payload}`; `event.Payload interface{ EventType() Type }`; payload structs `SessionStartedPayload`, `SessionExitedPayload`, `TurnStartedPayload`, `TurnCompletedPayload{Status string; Usage *Usage}`, `ItemStartedPayload`, `ItemCompletedPayload`, `ContentDeltaPayload{ItemType, Stream, Text, Sequence uint64}`, `RequestOpenedPayload`, `RequestResolvedPayload`, `UserInputRequestedPayload`, `ErrorPayload`, `WarningPayload`; `event.Decision` (`accept`/`acceptForSession`/`decline`/`cancel`) with `Valid() bool`; `event.StreamKind` (`text`/`reasoning`/`stdout`/`stderr`); `event.ItemType`; `event.RequestType`; `event.RegisterPayload(t Type, mk func() Payload)`.

- [ ] **Step 1: Copy the skeleton file into place**

```bash
mkdir -p backend/internal/agentcore/event
cp gg/agentcore/event/event.go backend/internal/agentcore/event/event.go
```

- [ ] **Step 2: Apply the mechanical edits**

Three edits, nothing else:
1. Translate every comment and error string from Indonesian to English, **keeping the reasoning intact**. The comment on `Sequence` explaining why it is mandatory, and the one on `Raw` forbidding logic that reads it, are load-bearing — keep them.
2. Delete the trailing `type wireEvent struct{...}` and `var _ = wireEvent{}` at the bottom of the file. They are dead code the skeleton left behind; `UnmarshalJSON` uses its own local anonymous struct.
3. Leave the package name (`event`) and all type/field names exactly as they are. Later tasks depend on these names.

- [ ] **Step 3: Write the failing test**

Create `backend/internal/agentcore/event/event_test.go`:

```go
package event

import (
	"encoding/json"
	"testing"
	"time"
)

func TestRoundTripContentDelta(t *testing.T) {
	in := Event{
		EventID:    "ae-1",
		Type:       ContentDelta,
		Provider:   "claude",
		InstanceID: "claude:default",
		ThreadID:   "w-abc",
		TurnID:     "turn-1",
		ItemID:     "item-1",
		CreatedAt:  time.UnixMilli(1700000000000).UTC(),
		Refs:       &Refs{SessionID: "native-uuid"},
		Payload: &ContentDeltaPayload{
			ItemType: ItemAssistantMessage,
			Stream:   StreamText,
			Text:     "hello",
			Sequence: 7,
		},
	}

	b, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var out Event
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if out.Type != ContentDelta || out.ItemID != "item-1" {
		t.Fatalf("envelope lost: %+v", out)
	}
	if out.Refs == nil || out.Refs.SessionID != "native-uuid" {
		t.Fatalf("refs lost: %+v", out.Refs)
	}
	p, ok := out.Payload.(*ContentDeltaPayload)
	if !ok {
		t.Fatalf("payload type = %T, want *ContentDeltaPayload", out.Payload)
	}
	if p.Text != "hello" || p.Sequence != 7 || p.Stream != StreamText {
		t.Fatalf("payload lost: %+v", p)
	}
}

// An unknown event type must not fail the whole stream. This happens every
// time a provider ships a new event before we add a handler for it.
func TestUnknownTypeDecodesWithNilPayload(t *testing.T) {
	raw := []byte(`{"eventId":"ae-2","type":"some.future.event","threadId":"w-abc","payload":{"x":1}}`)

	var out Event
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unknown type must not error, got: %v", err)
	}
	if out.Payload != nil {
		t.Fatalf("payload = %v, want nil for unknown type", out.Payload)
	}
	if out.EventID != "ae-2" {
		t.Fatalf("envelope lost on unknown type: %+v", out)
	}
}

// Decision is the approval vocabulary; an invalid one must be rejected at the
// boundary rather than reaching a provider.
func TestDecisionValid(t *testing.T) {
	for _, d := range []Decision{DecisionAccept, DecisionAcceptForSession, DecisionDecline, DecisionCancel} {
		if !d.Valid() {
			t.Errorf("%q should be valid", d)
		}
	}
	if Decision("yolo").Valid() {
		t.Error(`"yolo" should not be valid`)
	}
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd backend && go test ./internal/agentcore/event/ -run TestRoundTrip -v`
Expected: FAIL — the package does not compile until Step 2's edits are correct, or assertions fail.

- [ ] **Step 5: Fix until green**

Run: `cd backend && go vet ./internal/agentcore/event/ && go test ./internal/agentcore/event/ -race -v`
Expected: PASS — three tests.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/agentcore/event/
git commit -m "feat(agentcore): canonical runtime event vocabulary"
```

---

### Task 2: Provider contracts — Driver, Adapter, Registry

Driver and Adapter are separate so the settings screen can show "claude v2.1.219, authenticated" **without spawning an agent process**. `Probe` treats a missing binary as a normal status, not an error.

**Files:**
- Create: `backend/internal/agentcore/provider/provider.go` (port of `gg/agentcore/provider/provider.go`)
- Create: `backend/internal/agentcore/approval/broker.go`
- Test: `backend/internal/agentcore/provider/provider_test.go`

**Interfaces:**
- Consumes: `event.Event`, `event.Decision` (Task 1).
- Produces: `provider.Kind`, `provider.InstanceID`, `provider.Driver` (`Kind`, `DefaultConfig`, `DecodeConfig`, `Probe`, `Create`), `provider.Adapter` (`Kind`, `InstanceID`, `Capabilities`, `StartSession`, `SendTurn`, `InterruptTurn`, `RespondToRequest`, `RespondToUserInput`, `StopSession`, `StopAll`, `HasSession`, `ListSessions`, `ReadThread`, `RollbackThread`, `Events() <-chan event.Event`), `provider.Snapshot{InstanceID, Kind, Available, Version, BinaryPath, Authed, AccountLabel, Models, Detail}`, `provider.RuntimeMode` (`approval-required`/`auto-accept-edits`/`auto`/`full-access`), `provider.InteractionMode` (`default`/`plan`), `provider.SessionStartInput`, `provider.SendTurnInput`, `provider.TurnStartResult{TurnID, Steered}`, `provider.ModelSelection`, `provider.Registry` (`NewRegistry`, `Driver`, `StartInstance`, `Adapter`, `StopInstance`, `Adapters`), `provider.ThreadDirectory`, `provider.Service`.
- Also produces: `approval.Broker` interface with `Resolve(requestID string, d event.Decision) error`, `CancelThread(threadID string)`, and `var ErrUnknownRequest = errors.New("approval: unknown request")`.

- [ ] **Step 1: Copy and edit the provider file**

```bash
mkdir -p backend/internal/agentcore/provider backend/internal/agentcore/approval
cp gg/agentcore/provider/provider.go backend/internal/agentcore/provider/provider.go
```

Edits: rewrite the import `example.com/agentcore/event` → `devdeck/backend/internal/agentcore/event`; translate all comments and error strings to English. Keep the `InstanceID` comment explaining why routing must never use `Kind` — it is the most expensive lesson in the source document.

- [ ] **Step 2: Write the approval broker interface**

Spec 1 does not implement approvals, but `Ingestion` and `Reactor` (Task 9) reference the broker. Define the interface now and a no-op so nothing is nil at runtime.

Create `backend/internal/agentcore/approval/broker.go`:

```go
// Package approval bridges the asymmetry at the heart of agent permissions:
// the agent calls and blocks, but the answer arrives from a completely
// different direction (an HTTP request from the user), possibly minutes later
// and possibly from a different device.
//
// Spec 1 ships the interface and a no-op only. The blocking implementation
// (Await + pendingApprovals) lands in spec 2 together with the four traps
// documented in gg/HANDOFF.md section 6.
package approval

import (
	"errors"

	"devdeck/backend/internal/agentcore/event"
)

// ErrUnknownRequest means the request id is not (or is no longer) pending.
// Callers treat this as benign: it is what a double-tap from a second device
// looks like.
var ErrUnknownRequest = errors.New("approval: unknown request")

// Broker unblocks an agent goroutine that is waiting on a user decision.
type Broker interface {
	// Resolve delivers a decision to a waiting caller.
	Resolve(requestID string, d event.Decision) error

	// CancelThread abandons every pending request on a thread. Called when a
	// session exits or a turn is interrupted — without it the UI shows ghost
	// prompts that can never be answered.
	CancelThread(threadID string)
}

// NoopBroker satisfies Broker without blocking anything. Used in spec 1,
// where no adapter opens a request yet.
type NoopBroker struct{}

func (NoopBroker) Resolve(string, event.Decision) error { return ErrUnknownRequest }
func (NoopBroker) CancelThread(string)                  {}

var _ Broker = NoopBroker{}
```

- [ ] **Step 3: Write the failing registry test**

Create `backend/internal/agentcore/provider/provider_test.go`:

```go
package provider

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

type fakeConfig struct{}

func (fakeConfig) ProviderKind() Kind { return "fake" }

type fakeAdapter struct {
	id  InstanceID
	ch  chan event.Event
	rec []string
}

func (a *fakeAdapter) Kind() Kind                 { return "fake" }
func (a *fakeAdapter) InstanceID() InstanceID     { return a.id }
func (a *fakeAdapter) Capabilities() Capabilities { return Capabilities{} }
func (a *fakeAdapter) StartSession(context.Context, SessionStartInput) (Session, error) {
	return Session{}, nil
}
func (a *fakeAdapter) SendTurn(_ context.Context, in SendTurnInput) (TurnStartResult, error) {
	a.rec = append(a.rec, "send:"+in.Text)
	return TurnStartResult{TurnID: in.TurnID}, nil
}
func (a *fakeAdapter) InterruptTurn(context.Context, string, string) error { return nil }
func (a *fakeAdapter) RespondToRequest(context.Context, string, string, event.Decision) error {
	return nil
}
func (a *fakeAdapter) RespondToUserInput(context.Context, string, string, map[string]any) error {
	return nil
}
func (a *fakeAdapter) StopSession(context.Context, string) error { return nil }
func (a *fakeAdapter) StopAll(context.Context) error             { return nil }
func (a *fakeAdapter) HasSession(string) bool                    { return true }
func (a *fakeAdapter) ListSessions() []Session                   { return nil }
func (a *fakeAdapter) ReadThread(context.Context, string) (ThreadSnapshot, error) {
	return ThreadSnapshot{}, nil
}
func (a *fakeAdapter) RollbackThread(context.Context, string, int) (ThreadSnapshot, error) {
	return ThreadSnapshot{}, nil
}
func (a *fakeAdapter) Events() <-chan event.Event { return a.ch }

type fakeDriver struct{ created int }

func (d *fakeDriver) Kind() Kind                     { return "fake" }
func (d *fakeDriver) DefaultConfig() json.RawMessage { return json.RawMessage(`{}`) }
func (d *fakeDriver) DecodeConfig(json.RawMessage) (Config, error) {
	return fakeConfig{}, nil
}
func (d *fakeDriver) Probe(context.Context, Config) (Snapshot, error) {
	return Snapshot{Kind: "fake", Available: true, Version: "1.0.0"}, nil
}
func (d *fakeDriver) Create(_ context.Context, spec InstanceSpec) (Adapter, error) {
	d.created++
	return &fakeAdapter{id: spec.InstanceID, ch: make(chan event.Event)}, nil
}

type mapDirectory map[string]InstanceID

func (m mapDirectory) InstanceFor(threadID string) (InstanceID, bool) {
	id, ok := m[threadID]
	return id, ok
}
func (m mapDirectory) Bind(threadID string, id InstanceID) { m[threadID] = id }
func (m mapDirectory) Unbind(threadID string)              { delete(m, threadID) }

// Two instances of the same Kind must coexist — this is exactly the case that
// forced t3code's Kind->InstanceID migration.
func TestRegistryRoutesByInstanceNotKind(t *testing.T) {
	d := &fakeDriver{}
	r := NewRegistry(d)
	ctx := context.Background()

	if _, err := r.StartInstance(ctx, "fake", InstanceSpec{InstanceID: "fake:work"}); err != nil {
		t.Fatalf("start work: %v", err)
	}
	if _, err := r.StartInstance(ctx, "fake", InstanceSpec{InstanceID: "fake:personal"}); err != nil {
		t.Fatalf("start personal: %v", err)
	}
	if d.created != 2 {
		t.Fatalf("created = %d, want 2 distinct instances of one Kind", d.created)
	}

	a, err := r.Adapter("fake:personal")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if a.InstanceID() != "fake:personal" {
		t.Fatalf("routed to %s, want fake:personal", a.InstanceID())
	}
}

func TestRegistryUnknownDriver(t *testing.T) {
	r := NewRegistry()
	_, err := r.StartInstance(context.Background(), "nope", InstanceSpec{InstanceID: "nope:1"})
	if !errors.Is(err, ErrUnknownDriver) {
		t.Fatalf("err = %v, want ErrUnknownDriver", err)
	}
}

func TestServiceRoutesThreadToItsInstance(t *testing.T) {
	d := &fakeDriver{}
	r := NewRegistry(d)
	ctx := context.Background()
	if _, err := r.StartInstance(ctx, "fake", InstanceSpec{InstanceID: "fake:work"}); err != nil {
		t.Fatalf("start: %v", err)
	}

	svc := &Service{Registry: r, Dir: mapDirectory{"w-abc": "fake:work"}}
	if _, err := svc.SendTurn(ctx, SendTurnInput{ThreadID: "w-abc", Text: "hi"}); err != nil {
		t.Fatalf("send: %v", err)
	}

	// An unbound thread must fail loudly rather than silently pick an adapter.
	if _, err := svc.SendTurn(ctx, SendTurnInput{ThreadID: "w-unbound", Text: "hi"}); err == nil {
		t.Fatal("unbound thread should error")
	}
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/agentcore/provider/ -v`
Expected: FAIL — compilation errors until imports are rewritten in Step 1.

- [ ] **Step 5: Fix until green**

Run: `cd backend && go vet ./internal/agentcore/... && go test ./internal/agentcore/... -race -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/agentcore/provider/ backend/internal/agentcore/approval/
git commit -m "feat(agentcore): provider Driver/Adapter contracts and registry"
```

---

### Task 3: Commands, decider, projector

This is where every business rule lives, and it is pure — no database, no agent process, no clock. That purity is the whole reason the rules are testable at all.

**Files:**
- Create: `backend/internal/agentcore/orchestration/command.go` (port of `gg/agentcore/orchestration/command.go`)
- Create: `backend/internal/agentcore/orchestration/engine.go` — **State, Decide, Apply only** in this task; the `Engine` struct arrives in Task 4
- Create: `backend/internal/agentcore/orchestration/decider_test.go`

**Interfaces:**
- Consumes: `event.*` (Task 1), `provider.*` (Task 2).
- Produces: `orchestration.CommandType` constants (`CmdThreadCreate`, `CmdThreadTurnStart`, `CmdThreadTurnInterrupt`, `CmdThreadApprovalRespond`, `CmdThreadUserInputRespond`, `CmdThreadSessionStop`, `CmdThreadRuntimeModeSet`, `CmdThreadInteractionModeSet`, `CmdThreadDelete`, `CmdThreadAssistantDelta`, `CmdThreadAssistantComplete`, `CmdThreadSessionSet`, `CmdThreadActivityAppend`, `CmdThreadTurnDiffComplete`); `orchestration.ClientDispatchable map[CommandType]bool`; `orchestration.Command{CommandID, Type, ThreadID, IssuedAt, Payload}`; `orchestration.EventType` constants; `orchestration.IntentEvents map[EventType]bool`; `orchestration.Event{Seq uint64, EventID, Type, ThreadID, CommandID, CreatedAt int64, Payload json.RawMessage}`; `orchestration.TurnStartPayload{Text, Attachments, Model}`; `orchestration.ApprovalRespondPayload{RequestID, Decision}`; `orchestration.RuntimeModeSetPayload{Mode}`; `orchestration.AssistantDeltaPayload{TurnID, ItemID, Stream, Text, Sequence}`; `orchestration.ThreadStatus` (`idle`/`running`/`waiting`/`stopped`); `orchestration.Thread`; `orchestration.State` + `NewState()` + `(*State).Thread(id)`; `Decide(s *State, cmd Command, now int64, newID func() string) ([]Event, error)`; `Apply(s *State, evts []Event) *State`.

- [ ] **Step 1: Copy both files and split engine.go**

```bash
mkdir -p backend/internal/agentcore/orchestration
cp gg/agentcore/orchestration/command.go backend/internal/agentcore/orchestration/command.go
cp gg/agentcore/orchestration/engine.go  backend/internal/agentcore/orchestration/engine.go
```

Edits to both: rewrite imports `example.com/agentcore/{event,provider}` → `devdeck/backend/internal/agentcore/{event,provider}`; translate comments and error strings to English.

In `engine.go`, **delete everything from the `Store` interface comment block downward** (the `Store` interface, `envelope`, `result`, `Engine`, `EngineOptions`, `NewEngine`, `Run`, `Dispatch`, `process`, `State()`, `Subscribe`, `publish`, `closeSubs`). Keep only: `ThreadStatus`, `Thread`, `State`, `NewState`, `clone`, `Thread(id)`, `Decide`, `Apply`, `applyOne`. Task 4 restores the rest. Remove the now-unused `context`, `sync`, and `time` imports.

Preserve the comment above `Decide` explaining why purity is not idealism — it is the justification a future reader needs before they are tempted to call `time.Now()` in there.

- [ ] **Step 2: Write the failing decider test**

Create `backend/internal/agentcore/orchestration/decider_test.go`:

```go
package orchestration

import (
	"encoding/json"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

// seqIDs gives the decider a deterministic id source, which is what makes
// these tests assertable at all.
func seqIDs() func() string {
	n := 0
	return func() string {
		n++
		return "ae-" + string(rune('0'+n))
	}
}

func mustRaw(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func createThread(t *testing.T, s *State, id string) *State {
	t.Helper()
	evts, err := Decide(s, Command{
		CommandID: "ac-create", Type: CmdThreadCreate, ThreadID: id,
		Payload: mustRaw(t, map[string]any{"instanceId": "claude:default"}),
	}, 1000, seqIDs())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return Apply(s, evts)
}

func TestCreateThenTurnStartRunsThread(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")

	th, ok := s.Thread("w-abc")
	if !ok {
		t.Fatal("thread not projected")
	}
	if th.Status != ThreadIdle {
		t.Fatalf("status = %s, want idle", th.Status)
	}
	if th.Mode != provider.ModeApprovalRequired {
		t.Fatalf("mode = %s, want approval-required default", th.Mode)
	}

	evts, err := Decide(s, Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "fix the auth redirect"}),
	}, 2000, seqIDs())
	if err != nil {
		t.Fatalf("turn start: %v", err)
	}

	// A turn produces the user's message AND the intent, in that order —
	// the message must be durable even if the provider call later fails.
	if len(evts) != 2 {
		t.Fatalf("len(evts) = %d, want 2", len(evts))
	}
	if evts[0].Type != EvtThreadMessageSent {
		t.Fatalf("evts[0] = %s, want thread.message-sent", evts[0].Type)
	}
	if evts[1].Type != EvtThreadTurnStartRequested {
		t.Fatalf("evts[1] = %s, want thread.turn-start-requested", evts[1].Type)
	}

	s = Apply(s, evts)
	if th, _ := s.Thread("w-abc"); th.Status != ThreadRunning {
		t.Fatalf("status = %s, want running", th.Status)
	}
}

func TestDuplicateThreadRejected(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")
	_, err := Decide(s, Command{
		CommandID: "ac-again", Type: CmdThreadCreate, ThreadID: "w-abc",
		Payload: mustRaw(t, map[string]any{}),
	}, 3000, seqIDs())
	if err == nil {
		t.Fatal("creating an existing thread should error")
	}
}

func TestEmptyTurnRejected(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")
	_, err := Decide(s, Command{
		CommandID: "ac-empty", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: ""}),
	}, 3000, seqIDs())
	if err == nil {
		t.Fatal("empty turn should error")
	}
}

// Approving a request that is not pending must be refused in the DECIDER,
// not the broker, so the refusal is recorded and explainable. This is what a
// double-tap from two devices looks like.
func TestApprovalDoubleTapRejected(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")

	// Simulate the adapter opening a request.
	evts, err := Decide(s, Command{
		CommandID: "ac-open", Type: CmdThreadSessionSet, ThreadID: "w-abc",
		Payload: mustRaw(t, map[string]any{
			"status": string(ThreadWaiting), "pendingRequestAdd": "req-1",
		}),
	}, 4000, seqIDs())
	if err != nil {
		t.Fatalf("session set: %v", err)
	}
	s = Apply(s, evts)

	if th, _ := s.Thread("w-abc"); th.Status != ThreadWaiting {
		t.Fatalf("status = %s, want waiting", th.Status)
	}

	respond := Command{
		CommandID: "ac-resp", Type: CmdThreadApprovalRespond, ThreadID: "w-abc",
		Payload: mustRaw(t, ApprovalRespondPayload{
			RequestID: "req-1", Decision: event.DecisionAccept,
		}),
	}

	first, err := Decide(s, respond, 5000, seqIDs())
	if err != nil {
		t.Fatalf("first approval: %v", err)
	}
	s = Apply(s, first)

	// Second device taps the same prompt.
	if _, err := Decide(s, respond, 5001, seqIDs()); err == nil {
		t.Fatal("second approval of the same request should be refused")
	}
}

func TestInvalidDecisionRejected(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")
	evts, _ := Decide(s, Command{
		CommandID: "ac-open", Type: CmdThreadSessionSet, ThreadID: "w-abc",
		Payload: mustRaw(t, map[string]any{"pendingRequestAdd": "req-1"}),
	}, 4000, seqIDs())
	s = Apply(s, evts)

	_, err := Decide(s, Command{
		CommandID: "ac-bad", Type: CmdThreadApprovalRespond, ThreadID: "w-abc",
		Payload: mustRaw(t, map[string]any{"requestId": "req-1", "decision": "yolo"}),
	}, 5000, seqIDs())
	if err == nil {
		t.Fatal("invalid decision should error")
	}
}

// Apply must never mutate the state it was given — the engine relies on this
// to swap state only after a successful commit.
func TestApplyDoesNotMutateInput(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")
	evts, _ := Decide(s, Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "go"}),
	}, 2000, seqIDs())

	_ = Apply(s, evts)

	if th, _ := s.Thread("w-abc"); th.Status != ThreadIdle {
		t.Fatalf("original state mutated: status = %s, want idle", th.Status)
	}
}

// Only these commands may arrive from a client. If a client could dispatch
// thread.message.assistant.delta it could forge agent output.
func TestClientDispatchableExcludesServerOnlyCommands(t *testing.T) {
	serverOnly := []CommandType{
		CmdThreadAssistantDelta, CmdThreadAssistantComplete,
		CmdThreadSessionSet, CmdThreadActivityAppend, CmdThreadTurnDiffComplete,
	}
	for _, c := range serverOnly {
		if ClientDispatchable[c] {
			t.Errorf("%s must not be client-dispatchable", c)
		}
	}
	if !ClientDispatchable[CmdThreadTurnStart] {
		t.Error("thread.turn.start must be client-dispatchable")
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/agentcore/orchestration/ -v`
Expected: FAIL — compilation errors until the import rewrite and engine.go split are done.

- [ ] **Step 4: Fix until green**

Run: `cd backend && go vet ./internal/agentcore/... && go test ./internal/agentcore/orchestration/ -race -v`
Expected: PASS — seven tests.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/agentcore/orchestration/
git commit -m "feat(agentcore): pure decider and projector"
```

---

### Task 4: Engine with idempotency and replay determinism

One goroutine serialises every command. That looks like a bottleneck and is not: the decider is pure and fast, and slow provider calls happen in the Reactor, outside this loop.

**Files:**
- Modify: `backend/internal/agentcore/orchestration/engine.go` — restore the `Store` interface and `Engine`
- Create: `backend/internal/agentcore/orchestration/memstore.go`
- Create: `backend/internal/agentcore/orchestration/engine_test.go`

**Interfaces:**
- Consumes: Task 3's `State`, `Decide`, `Apply`, `Command`, `Event`.
- Produces: `orchestration.Store` interface (`SeenCommand(ctx, commandID) ([]Event, bool, error)`, `Commit(ctx, commandID, evts) ([]Event, error)`, `EventsSince(ctx, seq uint64) ([]Event, error)`); `orchestration.Engine` with `NewEngine(EngineOptions) *Engine`, `Run(ctx)`, `Dispatch(ctx, Command) ([]Event, error)`, `State() *State`, `Subscribe(buf int) (<-chan []Event, func())`; `orchestration.EngineOptions{Store, Initial, NewID, Now, QueueSize}`; `orchestration.NewMemStore() *MemStore`.

- [ ] **Step 1: Restore the engine half of engine.go**

Re-add everything deleted in Task 3 Step 1, from `gg/agentcore/orchestration/engine.go` lines 258–469: the `Store` interface, `envelope`, `result`, `Engine`, `EngineOptions`, `NewEngine`, `Run`, `Dispatch`, `process`, `State()`, `Subscribe`, `publish`, `closeSubs`. Restore the `context`, `errors`, `sync`, and `time` imports.

Translate comments to English. The comment block in `process` explaining the commit → swap → publish ordering is the single most important comment in the package — keep it in full.

- [ ] **Step 2: Write the in-memory store**

Create `backend/internal/agentcore/orchestration/memstore.go`:

```go
package orchestration

import (
	"context"
	"sync"
)

// MemStore is the test double for Store. It exists so the engine's contract
// (idempotency, atomic commit, ordering) can be exercised without SQLite.
// Task 5 provides the real implementation; TestReplayDeterministic must pass
// against both.
type MemStore struct {
	mu       sync.Mutex
	log      []Event
	receipts map[string][]Event
	// FailCommit, when set, makes the next Commit fail. Used to prove the
	// engine does not swap state on a failed commit.
	FailCommit error
}

func NewMemStore() *MemStore {
	return &MemStore{receipts: make(map[string][]Event)}
}

func (m *MemStore) SeenCommand(_ context.Context, commandID string) ([]Event, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	evts, ok := m.receipts[commandID]
	return evts, ok, nil
}

func (m *MemStore) Commit(_ context.Context, commandID string, evts []Event) ([]Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.FailCommit != nil {
		err := m.FailCommit
		m.FailCommit = nil
		return nil, err
	}
	out := make([]Event, len(evts))
	for i, e := range evts {
		e.Seq = uint64(len(m.log) + i + 1)
		out[i] = e
	}
	m.log = append(m.log, out...)
	m.receipts[commandID] = out
	return out, nil
}

func (m *MemStore) EventsSince(_ context.Context, seq uint64) ([]Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Event
	for _, e := range m.log {
		if e.Seq > seq {
			out = append(out, e)
		}
	}
	return out, nil
}

// All returns the whole log, for replay tests.
func (m *MemStore) All() []Event {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Event(nil), m.log...)
}

var _ Store = (*MemStore)(nil)
```

- [ ] **Step 3: Write the failing engine test**

Create `backend/internal/agentcore/orchestration/engine_test.go`:

```go
package orchestration

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func newTestEngine(t *testing.T) (*Engine, *MemStore, context.CancelFunc) {
	t.Helper()
	store := NewMemStore()
	n := 0
	e := NewEngine(EngineOptions{
		Store: store,
		NewID: func() string { n++; return "ae-" + string(rune('a'+n)) },
		Now:   func() int64 { return 1000 },
		QueueSize: 8,
	})
	ctx, cancel := context.WithCancel(context.Background())
	go e.Run(ctx)
	return e, store, cancel
}

func dispatchCreate(t *testing.T, e *Engine, id string) {
	t.Helper()
	if _, err := e.Dispatch(context.Background(), Command{
		CommandID: "ac-create-" + id, Type: CmdThreadCreate, ThreadID: id,
		Payload: mustRaw(t, map[string]any{"instanceId": "claude:default"}),
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
}

func TestEngineLifecycle(t *testing.T) {
	e, store, cancel := newTestEngine(t)
	defer cancel()

	dispatchCreate(t, e, "w-abc")
	if _, err := e.Dispatch(context.Background(), Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "hello"}),
	}); err != nil {
		t.Fatalf("turn: %v", err)
	}

	th, ok := e.State().Thread("w-abc")
	if !ok || th.Status != ThreadRunning {
		t.Fatalf("thread = %+v, want running", th)
	}
	if got := len(store.All()); got != 3 {
		t.Fatalf("log length = %d, want 3 (created, message-sent, turn-start-requested)", got)
	}
	// Seq must be assigned by the store, monotonically.
	for i, ev := range store.All() {
		if ev.Seq != uint64(i+1) {
			t.Fatalf("event %d has Seq %d, want %d", i, ev.Seq, i+1)
		}
	}
}

// A reconnecting client resends the same CommandID. It must get the original
// events back, not a second turn.
func TestEngineIdempotency(t *testing.T) {
	e, store, cancel := newTestEngine(t)
	defer cancel()

	dispatchCreate(t, e, "w-abc")
	cmd := Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "hello"}),
	}

	first, err := e.Dispatch(context.Background(), cmd)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := e.Dispatch(context.Background(), cmd)
	if err != nil {
		t.Fatalf("resend must not error: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("resend produced different events:\n first=%+v\nsecond=%+v", first, second)
	}
	if got := len(store.All()); got != 3 {
		t.Fatalf("log length = %d, want 3 — resend must not append", got)
	}
}

func TestEngineRequiresCommandID(t *testing.T) {
	e, _, cancel := newTestEngine(t)
	defer cancel()
	if _, err := e.Dispatch(context.Background(), Command{Type: CmdThreadCreate, ThreadID: "w-abc"}); err == nil {
		t.Fatal("missing CommandID must error")
	}
}

// The ordering invariant: a failed commit must leave the in-memory read model
// untouched. If this regresses, state silently diverges from the log.
func TestFailedCommitDoesNotSwapState(t *testing.T) {
	e, store, cancel := newTestEngine(t)
	defer cancel()

	dispatchCreate(t, e, "w-abc")
	before, _ := e.State().Thread("w-abc")
	beforeStatus := before.Status

	store.FailCommit = errors.New("disk on fire")
	_, err := e.Dispatch(context.Background(), Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "hello"}),
	})
	if err == nil {
		t.Fatal("commit failure must surface as an error")
	}

	after, _ := e.State().Thread("w-abc")
	if after.Status != beforeStatus {
		t.Fatalf("status changed to %s after failed commit, want %s", after.Status, beforeStatus)
	}
}

// The regression guard for the entire event-sourcing contract. It must keep
// passing after Task 6 swaps MemStore for SQLite.
func TestReplayDeterministic(t *testing.T) {
	e, store, cancel := newTestEngine(t)
	defer cancel()

	dispatchCreate(t, e, "w-abc")
	if _, err := e.Dispatch(context.Background(), Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "hello"}),
	}); err != nil {
		t.Fatalf("turn: %v", err)
	}
	if _, err := e.Dispatch(context.Background(), Command{
		CommandID: "ac-mode", Type: CmdThreadRuntimeModeSet, ThreadID: "w-abc",
		Payload: mustRaw(t, map[string]any{"mode": "auto"}),
	}); err != nil {
		t.Fatalf("mode: %v", err)
	}

	replayed := Apply(NewState(), store.All())

	live := e.State()
	if !reflect.DeepEqual(live.Threads, replayed.Threads) {
		t.Fatalf("replay diverged:\n live=%+v\nreplay=%+v", live.Threads["w-abc"], replayed.Threads["w-abc"])
	}
}

func TestSubscribeReceivesCommittedEvents(t *testing.T) {
	e, _, cancel := newTestEngine(t)
	defer cancel()

	sub, unsub := e.Subscribe(16)
	defer unsub()

	dispatchCreate(t, e, "w-abc")

	batch, ok := <-sub
	if !ok || len(batch) == 0 {
		t.Fatal("subscriber received nothing")
	}
	if batch[0].Type != EvtThreadCreated {
		t.Fatalf("first event = %s, want thread.created", batch[0].Type)
	}
	if batch[0].Seq == 0 {
		t.Fatal("published events must carry the committed Seq")
	}
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/agentcore/orchestration/ -run TestEngine -v`
Expected: FAIL — `NewEngine` undefined until Step 1 restores it.

- [ ] **Step 5: Fix until green**

Run: `cd backend && go vet ./internal/agentcore/... && go test ./internal/agentcore/orchestration/ -race -v`
Expected: PASS — all decider and engine tests, no race warnings.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/agentcore/orchestration/
git commit -m "feat(agentcore): event-sourced engine with idempotency and replay determinism"
```

---

### Task 5: Persist the event log through port.Store

`Commit` must be **one** transaction: append events, assign `Seq`, write the receipt. Anything less and a crash can leave the read model permanently disagreeing with the log.

> `backend/internal/port/store.go` is a convergence file. This task owns it exclusively — do not run it in parallel with another task that touches it.

**Files:**
- Modify: `backend/internal/store/db.go` — append three tables to `const schema`
- Modify: `backend/internal/port/store.go` — add four methods to the `Store` interface
- Create: `backend/internal/store/agentevent.go`
- Create: `backend/internal/store/agentevent_test.go`

**Interfaces:**
- Consumes: `orchestration.Event` (Task 3).
- Produces on `port.Store`: `CommitAgentEvents(commandID string, evts []orchestration.Event) ([]orchestration.Event, error)`; `SeenAgentCommand(commandID string) ([]orchestration.Event, bool, error)`; `AgentEventsSince(threadID string, seq uint64) ([]orchestration.Event, error)`; `AgentThreadIDs(worktreeID string) ([]string, error)`.

- [ ] **Step 1: Add the schema**

In `backend/internal/store/db.go`, append to the `const schema` string, immediately before the closing backtick and the `INSERT OR IGNORE INTO settings` line:

```sql
CREATE TABLE IF NOT EXISTS agent_thread (
  id           TEXT PRIMARY KEY,
  worktree_id  TEXT NOT NULL,
  instance_id  TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_event (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL UNIQUE,
  thread_id  TEXT NOT NULL,
  type       TEXT NOT NULL,
  command_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload    TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_event_thread_seq
  ON agent_event(thread_id, seq);

CREATE TABLE IF NOT EXISTS agent_command_receipt (
  command_id TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

`seq` is `INTEGER PRIMARY KEY AUTOINCREMENT` so SQLite assigns the global ordering — the same role `MemStore` fills with `len(log)+i+1`.

- [ ] **Step 2: Write the failing store test**

Create `backend/internal/store/agentevent_test.go`:

```go
package store

import (
	"encoding/json"
	"errors"
	"testing"

	"devdeck/backend/internal/agentcore/orchestration"
)

func evt(id, threadID, cmdID string, typ orchestration.EventType) orchestration.Event {
	return orchestration.Event{
		EventID:   id,
		Type:      typ,
		ThreadID:  threadID,
		CommandID: cmdID,
		CreatedAt: 1000,
		Payload:   json.RawMessage(`{"k":"v"}`),
	}
}

func TestCommitAssignsMonotonicSeq(t *testing.T) {
	st := newTestStore(t)

	first, err := st.CommitAgentEvents("ac-1", []orchestration.Event{
		evt("ae-1", "w-abc", "ac-1", orchestration.EvtThreadCreated),
		evt("ae-2", "w-abc", "ac-1", orchestration.EvtThreadMessageSent),
	})
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if len(first) != 2 || first[0].Seq == 0 || first[1].Seq <= first[0].Seq {
		t.Fatalf("seq not assigned monotonically: %+v", first)
	}

	second, err := st.CommitAgentEvents("ac-2", []orchestration.Event{
		evt("ae-3", "w-abc", "ac-2", orchestration.EvtThreadTurnStartRequested),
	})
	if err != nil {
		t.Fatalf("commit 2: %v", err)
	}
	if second[0].Seq <= first[1].Seq {
		t.Fatalf("seq %d not greater than previous %d", second[0].Seq, first[1].Seq)
	}
}

func TestSeenAgentCommandReturnsOriginalEvents(t *testing.T) {
	st := newTestStore(t)

	committed, err := st.CommitAgentEvents("ac-1", []orchestration.Event{
		evt("ae-1", "w-abc", "ac-1", orchestration.EvtThreadCreated),
	})
	if err != nil {
		t.Fatalf("commit: %v", err)
	}

	got, seen, err := st.SeenAgentCommand("ac-1")
	if err != nil {
		t.Fatalf("seen: %v", err)
	}
	if !seen {
		t.Fatal("command should be seen")
	}
	if len(got) != 1 || got[0].EventID != committed[0].EventID || got[0].Seq != committed[0].Seq {
		t.Fatalf("got %+v, want %+v", got, committed)
	}

	if _, seen, _ := st.SeenAgentCommand("ac-never"); seen {
		t.Fatal("unknown command must not be seen")
	}
}

// The atomicity guarantee: a commit that fails partway must leave nothing
// behind, or replay and the read model diverge permanently.
func TestCommitIsAtomic(t *testing.T) {
	st := newTestStore(t)

	if _, err := st.CommitAgentEvents("ac-1", []orchestration.Event{
		evt("ae-1", "w-abc", "ac-1", orchestration.EvtThreadCreated),
	}); err != nil {
		t.Fatalf("first commit: %v", err)
	}

	// ae-1 again: event_id is UNIQUE, so the second event of this batch fails
	// and the first must roll back with it.
	_, err := st.CommitAgentEvents("ac-2", []orchestration.Event{
		evt("ae-2", "w-abc", "ac-2", orchestration.EvtThreadMessageSent),
		evt("ae-1", "w-abc", "ac-2", orchestration.EvtThreadCreated),
	})
	if err == nil {
		t.Fatal("duplicate event id must fail the commit")
	}

	all, err := st.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("events since: %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("log has %d events, want 1 — the failed batch must roll back entirely", len(all))
	}
	if _, seen, _ := st.SeenAgentCommand("ac-2"); seen {
		t.Fatal("receipt must not survive a rolled-back commit")
	}
}

func TestAgentEventsSinceFiltersByThreadAndSeq(t *testing.T) {
	st := newTestStore(t)

	if _, err := st.CommitAgentEvents("ac-1", []orchestration.Event{
		evt("ae-1", "w-abc", "ac-1", orchestration.EvtThreadCreated),
		evt("ae-2", "w-other", "ac-1", orchestration.EvtThreadCreated),
		evt("ae-3", "w-abc", "ac-1", orchestration.EvtThreadMessageSent),
	}); err != nil {
		t.Fatalf("commit: %v", err)
	}

	abc, err := st.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("since 0: %v", err)
	}
	if len(abc) != 2 {
		t.Fatalf("thread w-abc has %d events, want 2 (other thread must be excluded)", len(abc))
	}

	tail, err := st.AgentEventsSince("w-abc", abc[0].Seq)
	if err != nil {
		t.Fatalf("since seq: %v", err)
	}
	if len(tail) != 1 || tail[0].EventID != "ae-3" {
		t.Fatalf("tail = %+v, want only ae-3", tail)
	}
}

func TestPayloadSurvivesRoundTrip(t *testing.T) {
	st := newTestStore(t)
	if _, err := st.CommitAgentEvents("ac-1", []orchestration.Event{
		evt("ae-1", "w-abc", "ac-1", orchestration.EvtThreadCreated),
	}); err != nil {
		t.Fatalf("commit: %v", err)
	}
	got, err := st.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("since: %v", err)
	}
	var decoded map[string]string
	if err := json.Unmarshal(got[0].Payload, &decoded); err != nil {
		t.Fatalf("payload not valid JSON after round trip: %v", err)
	}
	if decoded["k"] != "v" {
		t.Fatalf("payload = %v, want {k:v}", decoded)
	}
}

var _ = errors.New
```

Check `backend/internal/store/testing.go` for the existing helper that opens an in-memory or temp-file store. If it is named something other than `newTestStore`, use the existing name rather than adding a second helper.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && go test ./internal/store/ -run TestCommit -v`
Expected: FAIL — `CommitAgentEvents` undefined.

- [ ] **Step 4: Implement the store methods**

Create `backend/internal/store/agentevent.go`:

```go
package store

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"devdeck/backend/internal/agentcore/orchestration"
)

// CommitAgentEvents appends events, assigns each a global Seq, and writes the
// command receipt — all in ONE transaction. Splitting these apart would let a
// crash leave the read model permanently disagreeing with the event log, with
// no way to detect it afterwards.
func (s *Store) CommitAgentEvents(commandID string, evts []orchestration.Event) ([]orchestration.Event, error) {
	if len(evts) == 0 {
		return nil, nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	out := make([]orchestration.Event, len(evts))
	for i, e := range evts {
		payload := string(e.Payload)
		if payload == "" {
			payload = "null"
		}
		res, err := tx.Exec(
			`INSERT INTO agent_event (event_id, thread_id, type, command_id, created_at, payload)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			e.EventID, e.ThreadID, string(e.Type), commandID, e.CreatedAt, payload,
		)
		if err != nil {
			return nil, fmt.Errorf("append agent event %s: %w", e.EventID, err)
		}
		seq, err := res.LastInsertId()
		if err != nil {
			return nil, err
		}
		e.Seq = uint64(seq)
		e.CommandID = commandID
		out[i] = e
	}

	if _, err := tx.Exec(
		`INSERT INTO agent_command_receipt (command_id, thread_id, created_at) VALUES (?, ?, ?)`,
		commandID, evts[0].ThreadID, evts[0].CreatedAt,
	); err != nil {
		return nil, fmt.Errorf("write receipt %s: %w", commandID, err)
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

// SeenAgentCommand reports whether this command was already processed and, if
// so, returns the events it produced. Checked before Decide so a client that
// reconnects and resends gets the original events instead of a second turn.
func (s *Store) SeenAgentCommand(commandID string) ([]orchestration.Event, bool, error) {
	var exists int
	err := s.db.QueryRow(
		`SELECT 1 FROM agent_command_receipt WHERE command_id = ?`, commandID,
	).Scan(&exists)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}

	rows, err := s.db.Query(
		`SELECT seq, event_id, thread_id, type, command_id, created_at, payload
		 FROM agent_event WHERE command_id = ? ORDER BY seq`, commandID,
	)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	evts, err := scanAgentEvents(rows)
	if err != nil {
		return nil, false, err
	}
	return evts, true, nil
}

// AgentEventsSince returns a thread's events after seq, in order. This is what
// makes reattach exact rather than best-effort: a client reports the last Seq
// it saw and receives precisely what it missed.
func (s *Store) AgentEventsSince(threadID string, seq uint64) ([]orchestration.Event, error) {
	rows, err := s.db.Query(
		`SELECT seq, event_id, thread_id, type, command_id, created_at, payload
		 FROM agent_event WHERE thread_id = ? AND seq > ? ORDER BY seq`,
		threadID, seq,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanAgentEvents(rows)
}

// AgentThreadIDs lists the threads belonging to a worktree.
func (s *Store) AgentThreadIDs(worktreeID string) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT id FROM agent_thread WHERE worktree_id = ? ORDER BY created_at`, worktreeID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func scanAgentEvents(rows *sql.Rows) ([]orchestration.Event, error) {
	var out []orchestration.Event
	for rows.Next() {
		var (
			e       orchestration.Event
			typ     string
			payload sql.NullString
		)
		if err := rows.Scan(&e.Seq, &e.EventID, &e.ThreadID, &typ, &e.CommandID, &e.CreatedAt, &payload); err != nil {
			return nil, err
		}
		e.Type = orchestration.EventType(typ)
		if payload.Valid && payload.String != "null" {
			e.Payload = json.RawMessage(payload.String)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
```

- [ ] **Step 5: Add the methods to the port.Store interface**

In `backend/internal/port/store.go`, add to the `Store` interface, with an import of `devdeck/backend/internal/agentcore/orchestration`:

```go
	// Agent chat event log. CommitAgentEvents MUST be one transaction —
	// append + Seq assignment + receipt — or a crash can leave the read
	// model permanently disagreeing with the log.
	CommitAgentEvents(commandID string, evts []orchestration.Event) ([]orchestration.Event, error)
	SeenAgentCommand(commandID string) ([]orchestration.Event, bool, error)
	AgentEventsSince(threadID string, seq uint64) ([]orchestration.Event, error)
	AgentThreadIDs(worktreeID string) ([]string, error)
```

- [ ] **Step 6: Update every port.Store implementation**

Run `cd backend && go build ./...` and fix each type that no longer satisfies `port.Store` — there are mocks and fakes in handler and service tests. Give each one a minimal implementation returning zero values and `nil`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && go vet ./... && go test ./internal/store/ -race -v -run TestCommit`
Then: `cd backend && go test ./... -race`
Expected: PASS across the board.

- [ ] **Step 8: Commit**

```bash
git add backend/internal/store/ backend/internal/port/store.go
git commit -m "feat(store): persist agent event log atomically through port.Store"
```

---

### Task 6: Run the engine on SQLite

The point of this task is a single assertion: `TestReplayDeterministic` must pass unchanged against the real store. If it does, the event-sourcing contract survived contact with a database.

**Files:**
- Create: `backend/internal/agentcore/orchestration/portstore.go`
- Create: `backend/internal/store/agentengine_test.go`

**Interfaces:**
- Consumes: `port.Store` methods (Task 5), `orchestration.Store` (Task 4).
- Produces: `orchestration.EventStore` interface (the narrow subset orchestration declares for itself) and `orchestration.NewPortStore(es EventStore) Store`.

- [ ] **Step 1: Write the adapter from port.Store to orchestration.Store**

Create `backend/internal/agentcore/orchestration/portstore.go`:

```go
package orchestration

import "context"

// EventStore is the narrow slice of persistence this package needs. It is
// declared HERE, by the consumer, rather than imported from port — that is
// what keeps the decider and engine tests free of SQLite while still routing
// every real write through the one port.Store implementation.
//
// backend/internal/store.Store satisfies this.
type EventStore interface {
	CommitAgentEvents(commandID string, evts []Event) ([]Event, error)
	SeenAgentCommand(commandID string) ([]Event, bool, error)
	AgentEventsSince(threadID string, seq uint64) ([]Event, error)
}

// portStore adapts an EventStore to the context-taking Store the engine uses.
type portStore struct{ es EventStore }

// NewPortStore wraps a persistent EventStore for the engine.
func NewPortStore(es EventStore) Store { return &portStore{es: es} }

func (p *portStore) SeenCommand(_ context.Context, commandID string) ([]Event, bool, error) {
	return p.es.SeenAgentCommand(commandID)
}

func (p *portStore) Commit(_ context.Context, commandID string, evts []Event) ([]Event, error) {
	return p.es.CommitAgentEvents(commandID, evts)
}

// EventsSince spans all threads for reconciliation; the per-thread variant
// used by the WebSocket handler calls the store directly.
func (p *portStore) EventsSince(_ context.Context, seq uint64) ([]Event, error) {
	return p.es.AgentEventsSince("", seq)
}
```

Note `AgentEventsSince("", seq)` returns nothing, because no thread has an empty id. That is intentional for spec 1: the engine's cross-thread reconciliation path is unused, and the WebSocket handler queries per thread. Add exactly that as a comment so a later reader does not treat it as a bug.

- [ ] **Step 2: Write the failing integration test**

Create `backend/internal/store/agentengine_test.go`:

```go
package store

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"devdeck/backend/internal/agentcore/orchestration"
)

// The whole event-sourcing contract, exercised against real SQLite. This is
// the same guarantee TestReplayDeterministic makes against MemStore; if the
// two ever disagree, the database is lying about ordering or payloads.
func TestEngineReplayDeterministicOnSQLite(t *testing.T) {
	st := newTestStore(t)

	n := 0
	e := orchestration.NewEngine(orchestration.EngineOptions{
		Store:     orchestration.NewPortStore(st),
		NewID:     func() string { n++; return "ae-" + string(rune('a'+n)) },
		Now:       func() int64 { return 1000 },
		QueueSize: 8,
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)

	mustRaw := func(v any) json.RawMessage {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		return b
	}

	if _, err := e.Dispatch(ctx, orchestration.Command{
		CommandID: "ac-create", Type: orchestration.CmdThreadCreate, ThreadID: "w-abc",
		Payload: mustRaw(map[string]any{"instanceId": "claude:default"}),
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := e.Dispatch(ctx, orchestration.Command{
		CommandID: "ac-turn", Type: orchestration.CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(orchestration.TurnStartPayload{Text: "hello"}),
	}); err != nil {
		t.Fatalf("turn: %v", err)
	}

	logged, err := st.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if len(logged) != 3 {
		t.Fatalf("log has %d events, want 3", len(logged))
	}

	replayed := orchestration.Apply(orchestration.NewState(), logged)
	live := e.State()
	if !reflect.DeepEqual(live.Threads, replayed.Threads) {
		t.Fatalf("replay from SQLite diverged:\n live=%+v\nreplay=%+v",
			live.Threads["w-abc"], replayed.Threads["w-abc"])
	}
}

// Idempotency must hold across the real receipt table, not just in memory.
func TestEngineIdempotencyOnSQLite(t *testing.T) {
	st := newTestStore(t)
	n := 0
	e := orchestration.NewEngine(orchestration.EngineOptions{
		Store:     orchestration.NewPortStore(st),
		NewID:     func() string { n++; return "ae-" + string(rune('a'+n)) },
		Now:       func() int64 { return 1000 },
		QueueSize: 8,
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)

	cmd := orchestration.Command{
		CommandID: "ac-create", Type: orchestration.CmdThreadCreate, ThreadID: "w-abc",
		Payload: json.RawMessage(`{"instanceId":"claude:default"}`),
	}
	first, err := e.Dispatch(ctx, cmd)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := e.Dispatch(ctx, cmd)
	if err != nil {
		t.Fatalf("resend: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("resend differed:\n first=%+v\nsecond=%+v", first, second)
	}

	logged, _ := st.AgentEventsSince("w-abc", 0)
	if len(logged) != 1 {
		t.Fatalf("log has %d events, want 1 — resend must not append", len(logged))
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && go test ./internal/store/ -run OnSQLite -v`
Expected: FAIL — `orchestration.NewPortStore` undefined.

- [ ] **Step 4: Fix until green**

Run: `cd backend && go vet ./... && go test ./internal/store/ ./internal/agentcore/... -race -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/agentcore/orchestration/portstore.go backend/internal/store/agentengine_test.go
git commit -m "feat(agentcore): run the engine on SQLite, replay determinism preserved"
```

---

### Task 7: Claude stream-json parser

This is the riskiest code in the spec. `stream-json` shifts between CLI versions, so the parser is built fixture-first and every unparseable message becomes a `RuntimeWarning` carrying `Raw` — never a crash, never a silent drop.

**Files:**
- Create: `backend/internal/agentcore/provider/claude/parse.go`
- Create: `backend/internal/agentcore/provider/claude/parse_test.go`
- Create: `backend/internal/agentcore/provider/claude/testdata/turn.ndjson`

**Interfaces:**
- Consumes: `event.*` (Task 1).
- Produces: `claude.parseLine(line []byte, st *parseState) []event.Event` and `claude.newParseState(threadID string, instanceID provider.InstanceID) *parseState`. `parseState` owns per-`(ItemID, StreamKind)` sequence counters so `Sequence` is monotonic.

- [ ] **Step 1: Capture a real fixture**

Run the CLI against a trivial prompt in a scratch directory and save the raw output. Do **not** hand-write this file — the point is to record what the CLI actually emits.

```bash
mkdir -p backend/internal/agentcore/provider/claude/testdata
cd /tmp && mkdir -p claude-fixture && cd claude-fixture
echo 'hi' | claude --print --output-format stream-json --input-format stream-json --include-partial-messages \
  > /Users/kiyora/Documents/explorer/agent/enginer.kiyora.dev/backend/internal/agentcore/provider/claude/testdata/turn.ndjson
```

Then read the captured file and record the CLI version in a comment at the top of `parse.go`:

```bash
claude --version
```

If the capture fails or produces nothing (not authenticated, network down), **stop and report it** rather than inventing a fixture — a parser written against imagined output is worse than no parser.

- [ ] **Step 2: Write the failing parser test**

Create `backend/internal/agentcore/provider/claude/parse_test.go`. Adjust the concrete assertions to match the fixture captured in Step 1 — the structural assertions below hold regardless of the exact shape:

```go
package claude

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

func parseFixture(t *testing.T, path string) []event.Event {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()

	st := newParseState("w-abc", "claude:default")
	var out []event.Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 8*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		out = append(out, parseLine(append([]byte(nil), line...), st)...)
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan: %v", err)
	}
	return out
}

func TestFixtureProducesTextDeltas(t *testing.T) {
	evts := parseFixture(t, "testdata/turn.ndjson")
	if len(evts) == 0 {
		t.Fatal("fixture produced no events")
	}

	var text int
	for _, e := range evts {
		if e.Type != event.ContentDelta {
			continue
		}
		p, ok := e.Payload.(*event.ContentDeltaPayload)
		if !ok {
			t.Fatalf("ContentDelta payload is %T", e.Payload)
		}
		if p.Stream == event.StreamText {
			text++
		}
	}
	if text == 0 {
		t.Fatal("no text deltas parsed from a real turn")
	}
}

// Every event must carry the envelope identity the orchestration layer routes
// on. A missing InstanceID here is the bug that forced t3code's migration.
func TestEveryEventCarriesThreadAndInstance(t *testing.T) {
	for _, e := range parseFixture(t, "testdata/turn.ndjson") {
		if e.ThreadID != "w-abc" {
			t.Fatalf("event %s has ThreadID %q, want w-abc", e.Type, e.ThreadID)
		}
		if e.InstanceID != "claude:default" {
			t.Fatalf("event %s has InstanceID %q, want claude:default", e.Type, e.InstanceID)
		}
	}
}

// Sequence must be monotonic per (ItemID, Stream) — the client relies on it to
// detect dropped or reordered deltas.
func TestSequenceMonotonicPerItemAndStream(t *testing.T) {
	last := map[string]uint64{}
	for _, e := range parseFixture(t, "testdata/turn.ndjson") {
		p, ok := e.Payload.(*event.ContentDeltaPayload)
		if !ok {
			continue
		}
		key := e.ItemID + "|" + string(p.Stream)
		if prev, seen := last[key]; seen && p.Sequence <= prev {
			t.Fatalf("sequence went %d -> %d for %s", prev, p.Sequence, key)
		}
		last[key] = p.Sequence
	}
}

// A message shape the parser does not understand must degrade to a warning
// that carries the raw payload, never a crash and never a silent drop. This
// WILL happen the next time the CLI ships a new event type.
func TestUnknownMessageBecomesWarningWithRaw(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	evts := parseLine([]byte(`{"type":"totally_new_thing","whatever":1}`), st)

	if len(evts) != 1 {
		t.Fatalf("got %d events, want 1 warning", len(evts))
	}
	if evts[0].Type != event.RuntimeWarning {
		t.Fatalf("type = %s, want runtime.warning", evts[0].Type)
	}
	if evts[0].Raw == nil || len(evts[0].Raw.Payload) == 0 {
		t.Fatal("warning must carry the raw payload for debugging")
	}
}

func TestMalformedJSONBecomesWarning(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	evts := parseLine([]byte(`{not json at all`), st)
	if len(evts) != 1 || evts[0].Type != event.RuntimeWarning {
		t.Fatalf("got %+v, want a single runtime.warning", evts)
	}
}

// Reasoning must land on its own stream so the UI can collapse it separately.
// Merging it into text now would mean a data migration later.
func TestReasoningUsesItsOwnStream(t *testing.T) {
	st := newParseState("w-abc", "claude:default")
	raw := `{"type":"stream_event","event":{"type":"content_block_delta",` +
		`"index":0,"delta":{"type":"thinking_delta","thinking":"considering..."}}}`

	var found bool
	for _, e := range parseLine([]byte(raw), st) {
		if p, ok := e.Payload.(*event.ContentDeltaPayload); ok && p.Stream == event.StreamReasoning {
			found = true
		}
	}
	if !found {
		t.Fatal("thinking_delta must map to StreamReasoning")
	}
}

var _ = json.Marshal
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && go test ./internal/agentcore/provider/claude/ -v`
Expected: FAIL — `newParseState` and `parseLine` undefined.

- [ ] **Step 4: Implement the parser**

Write `backend/internal/agentcore/provider/claude/parse.go` driven by the fixture. Requirements:

- `parseState` holds `threadID`, `instanceID`, `turnID`, a `map[string]uint64` of sequence counters keyed by `itemID + "|" + stream`, and the current native session id (stored into `Refs.SessionID`, never used as identity).
- `parseLine` unmarshals into a loose `struct{ Type string; ... json.RawMessage }`. Unmarshal failure → one `RuntimeWarning` with `Raw` populated. Unknown `Type` → same.
- Map, at minimum: the CLI's session/init message → `SessionStarted` with `Resume` set to the native session id; `content_block_delta` with `text_delta` → `ContentDelta` / `StreamText`; `content_block_delta` with `thinking_delta` → `ContentDelta` / `StreamReasoning`; tool-use blocks → `ItemStarted` / `ItemCompleted` with `ItemType == event.ItemToolCall`; the result message → `TurnCompleted` with `Usage` filled from the token counts.
- Every returned event sets `Provider: "claude"`, `InstanceID`, `ThreadID`, and `CreatedAt`. Sequence counters increment per `(ItemID, StreamKind)`.
- Put the captured CLI version in a file-level comment, e.g. `// Fixtures captured from claude CLI v2.1.219.`

- [ ] **Step 5: Run until green**

Run: `cd backend && go vet ./internal/agentcore/... && go test ./internal/agentcore/provider/claude/ -race -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/agentcore/provider/claude/
git commit -m "feat(agentcore): claude stream-json parser with fixture coverage"
```

---

### Task 8: Claude driver and adapter

**Files:**
- Create: `backend/internal/agentcore/provider/claude/driver.go`
- Create: `backend/internal/agentcore/provider/claude/adapter.go`
- Create: `backend/internal/agentcore/provider/claude/driver_test.go`
- Reference: `gg/agentcore/provider/claude/adapter.go` — the skeleton's deliberately incomplete sketch. Use it for shape; do not assume it is correct.

**Interfaces:**
- Consumes: `provider.*` (Task 2), `parseLine` / `newParseState` (Task 7), `detect.Resolve` / `detect.Installed`.
- Produces: `claude.NewDriver() provider.Driver`; `claude.Config{HomeDir, ExtraArgs}` implementing `provider.Config`; an unexported adapter implementing `provider.Adapter`.

- [ ] **Step 1: Write the failing driver test**

Create `backend/internal/agentcore/provider/claude/driver_test.go`:

```go
package claude

import (
	"context"
	"encoding/json"
	"testing"

	"devdeck/backend/internal/agentcore/provider"
)

func TestDriverKindAndDefaults(t *testing.T) {
	d := NewDriver()
	if d.Kind() != "claude" {
		t.Fatalf("kind = %s, want claude", d.Kind())
	}
	cfg, err := d.DecodeConfig(d.DefaultConfig())
	if err != nil {
		t.Fatalf("default config must decode: %v", err)
	}
	if cfg.ProviderKind() != "claude" {
		t.Fatalf("config kind = %s", cfg.ProviderKind())
	}
}

// A missing binary is a STATUS, not an error. Probe must report it so the UI
// can show "not installed" instead of swallowing an error, and the settings
// screen must never need to spawn an agent to find out.
func TestProbeReportsMissingBinaryAsStatus(t *testing.T) {
	d := NewDriver()
	cfg, err := d.DecodeConfig(json.RawMessage(`{"binaryName":"definitely-not-a-real-binary-xyz"}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	snap, err := d.Probe(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Probe must not error for a missing binary, got: %v", err)
	}
	if snap.Available {
		t.Fatal("snapshot should report Available=false")
	}
	if snap.Detail == "" {
		t.Fatal("snapshot must explain why it is unavailable")
	}
}

func TestDecodeConfigRejectsGarbage(t *testing.T) {
	d := NewDriver()
	if _, err := d.DecodeConfig(json.RawMessage(`{"homeDir":123}`)); err == nil {
		t.Fatal("type-mismatched config should error — this message reaches the settings UI")
	}
}

var _ provider.Driver = NewDriver()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/agentcore/provider/claude/ -run TestDriver -v`
Expected: FAIL — `NewDriver` undefined.

- [ ] **Step 3: Implement driver.go**

Requirements:
- `Config{BinaryName string; HomeDir string; ExtraArgs []string}` with `ProviderKind() provider.Kind { return "claude" }`. `DecodeConfig` uses a decoder with `DisallowUnknownFields` off but strict types, so `{"homeDir":123}` errors.
- `DefaultConfig()` returns `{"binaryName":"claude"}`.
- `Probe` calls `detect.ResolveBinary(cfg.BinaryName)`. Not found → `Snapshot{Kind:"claude", Available:false, Detail:"claude CLI not found on PATH"}` and **nil error**. Found → run `<bin> --version` with a 5-second context timeout, fill `Version` and `BinaryPath`, set `Available:true`.
- `Create` returns the adapter from Step 4, binding process lifetime to the passed `ctx`.

- [ ] **Step 4: Implement adapter.go**

Requirements:
- One `*exec.Cmd` per thread session, spawned in `SessionStartInput.Cwd`, with `HOME` overridden from `Config.HomeDir` when set — that is what keeps two instances from overwriting each other's credentials.
- Args built in **exactly one function**, `buildArgs`, which is the only place `RuntimeMode` and `InteractionMode` map to CLI flags. Every other file stays mode-agnostic.
- Base args: `--print --output-format stream-json --input-format stream-json --include-partial-messages`.
- A goroutine per session scans stdout line by line, calls `parseLine`, and pushes onto the single instance-wide `Events()` channel. Buffer it (256) and never block the scan loop.
- On process exit, emit `SessionExited` with the exit code, then remove the session. When the adapter's ctx is cancelled, kill all processes and close the events channel — consumers treat a closed channel as shutdown.
- `RespondToRequest` and `RespondToUserInput`: no-ops returning nil in spec 1, with a comment saying approvals land in spec 2. Do not stub them as errors — the Reactor calls both paths unconditionally by design.
- `Capabilities{SessionModelSwitch: provider.ModelSwitchInSession, SupportsPlanMode: true, SupportsResume: true, SupportsMCP: true}`.
- Guard all session-map access with a mutex; `Adapter` methods must be safe from many goroutines.

- [ ] **Step 5: Run until green**

Run: `cd backend && go vet ./internal/agentcore/... && go test ./internal/agentcore/... -race -v`
Expected: PASS. The adapter's process-spawning paths are not unit-tested here; they are covered end-to-end in Task 10.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/agentcore/provider/claude/
git commit -m "feat(agentcore): claude driver and adapter"
```

---

### Task 9: Ingestion and Reactor

Two workers, opposite directions. Keeping them separate is what prevents the deadlock where the engine waits on a provider that is waiting on the engine.

**Files:**
- Create: `backend/internal/agentcore/orchestration/workers.go` (port of `gg/agentcore/orchestration/workers.go`)
- Create: `backend/internal/agentcore/orchestration/workers_test.go`

**Interfaces:**
- Consumes: `Engine` (Task 4), `provider.Service` and `provider.Adapter` (Task 2), `approval.Broker` (Task 2), `event.*` (Task 1).
- Produces: `orchestration.Ingestion` with `NewIngestion(e *Engine, b approval.Broker, newID func() string) *Ingestion` and `Consume(ctx, a provider.Adapter)`; `orchestration.DeliveryPolicy{Buffered bool, MaxChars int}`; `orchestration.Reactor{Engine, Provider, Broker}` with `Run(ctx)`.

- [ ] **Step 1: Copy and adapt**

```bash
cp gg/agentcore/orchestration/workers.go backend/internal/agentcore/orchestration/workers.go
```

Edits:
1. Rewrite imports to `devdeck/backend/internal/agentcore/{approval,event,provider}`.
2. Replace the `*slog.Logger` field and every `in.Log.X(...)` / `r.Log.X(...)` call with stdlib `log.Printf`, matching the codebase. Drop the `Log` struct fields and the `log/slog` import.
3. Change `Broker *approval.Broker` to `Broker approval.Broker` (it is an interface now) in both `Ingestion` and `Reactor`, and change `NewIngestion`'s parameter to match.
4. Translate all comments to English. Keep the `DeliveryPolicy` comment explaining the two flush triggers, and the comment in `react` explaining why both `Broker.Resolve` **and** `Provider.RespondToRequest` are called — those explain decisions that look redundant until you know why.
5. Set the default `DeliveryPolicy` to `{Buffered: false, MaxChars: 24_000}`. Buffering is spec 2; the field exists now so spec 2 is a flag flip rather than a refactor.
6. Replace the `// TODO` in `Reactor.Run`'s error branch with an actual dispatch of a `CmdThreadActivityAppend` command carrying the error message, so a failed provider call is visible to the user instead of only in the log.

- [ ] **Step 2: Write the failing worker test**

Create `backend/internal/agentcore/orchestration/workers_test.go`:

```go
package orchestration

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/approval"
	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
)

type stubAdapter struct{ ch chan event.Event }

func (a *stubAdapter) Kind() provider.Kind             { return "stub" }
func (a *stubAdapter) InstanceID() provider.InstanceID { return "stub:1" }
func (a *stubAdapter) Capabilities() provider.Capabilities {
	return provider.Capabilities{}
}
func (a *stubAdapter) StartSession(context.Context, provider.SessionStartInput) (provider.Session, error) {
	return provider.Session{}, nil
}
func (a *stubAdapter) SendTurn(context.Context, provider.SendTurnInput) (provider.TurnStartResult, error) {
	return provider.TurnStartResult{}, nil
}
func (a *stubAdapter) InterruptTurn(context.Context, string, string) error { return nil }
func (a *stubAdapter) RespondToRequest(context.Context, string, string, event.Decision) error {
	return nil
}
func (a *stubAdapter) RespondToUserInput(context.Context, string, string, map[string]any) error {
	return nil
}
func (a *stubAdapter) StopSession(context.Context, string) error { return nil }
func (a *stubAdapter) StopAll(context.Context) error             { return nil }
func (a *stubAdapter) HasSession(string) bool                    { return true }
func (a *stubAdapter) ListSessions() []provider.Session          { return nil }
func (a *stubAdapter) ReadThread(context.Context, string) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, nil
}
func (a *stubAdapter) RollbackThread(context.Context, string, int) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, nil
}
func (a *stubAdapter) Events() <-chan event.Event { return a.ch }

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met within 2s")
}

func TestIngestionTurnsDeltasIntoLoggedEvents(t *testing.T) {
	store := NewMemStore()
	n := 0
	e := NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 16,
		NewID: func() string { n++; return "ae-" + string(rune('a'+n)) },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)

	if _, err := e.Dispatch(ctx, Command{
		CommandID: "ac-create", Type: CmdThreadCreate, ThreadID: "w-abc",
		Payload: json.RawMessage(`{"instanceId":"stub:1"}`),
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	a := &stubAdapter{ch: make(chan event.Event, 4)}
	m := 0
	in := NewIngestion(e, approval.NoopBroker{}, func() string { m++; return "ac-in-" + string(rune('a'+m)) })
	go in.Consume(ctx, a)

	a.ch <- event.Event{
		Type: event.ContentDelta, ThreadID: "w-abc", TurnID: "t1", ItemID: "i1",
		Payload: &event.ContentDeltaPayload{
			ItemType: event.ItemAssistantMessage, Stream: event.StreamText,
			Text: "hello", Sequence: 1,
		},
	}

	waitFor(t, func() bool {
		for _, ev := range store.All() {
			if ev.Type == EvtThreadActivityAppended {
				return true
			}
		}
		return false
	})
}

// A dead session must cancel pending approvals, or the UI shows a ghost
// prompt that can never be answered.
type recordingBroker struct{ cancelled []string }

func (b *recordingBroker) Resolve(string, event.Decision) error { return approval.ErrUnknownRequest }
func (b *recordingBroker) CancelThread(threadID string)         { b.cancelled = append(b.cancelled, threadID) }

func TestSessionExitedCancelsPendingApprovals(t *testing.T) {
	store := NewMemStore()
	n := 0
	e := NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 16,
		NewID: func() string { n++; return "ae-" + string(rune('a'+n)) },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)

	if _, err := e.Dispatch(ctx, Command{
		CommandID: "ac-create", Type: CmdThreadCreate, ThreadID: "w-abc",
		Payload: json.RawMessage(`{"instanceId":"stub:1"}`),
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	br := &recordingBroker{}
	a := &stubAdapter{ch: make(chan event.Event, 4)}
	m := 0
	in := NewIngestion(e, br, func() string { m++; return "ac-in-" + string(rune('a'+m)) })
	go in.Consume(ctx, a)

	a.ch <- event.Event{
		Type: event.SessionExited, ThreadID: "w-abc",
		Payload: &event.SessionExitedPayload{Reason: "exit"},
	}

	waitFor(t, func() bool { return len(br.cancelled) == 1 && br.cancelled[0] == "w-abc" })

	waitFor(t, func() bool {
		th, ok := e.State().Thread("w-abc")
		return ok && th.Status == ThreadStopped
	})
}

// A closed adapter channel means the process died; Consume must return rather
// than spin.
func TestConsumeReturnsWhenAdapterChannelCloses(t *testing.T) {
	store := NewMemStore()
	e := NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 4,
		NewID: func() string { return "ae-x" },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)

	a := &stubAdapter{ch: make(chan event.Event)}
	in := NewIngestion(e, approval.NoopBroker{}, func() string { return "ac-x" })

	done := make(chan struct{})
	go func() { in.Consume(ctx, a); close(done) }()
	close(a.ch)

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Consume did not return after the adapter channel closed")
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/agentcore/orchestration/ -run "TestIngestion|TestSession|TestConsume" -v`
Expected: FAIL — compilation errors until Step 1's edits land.

- [ ] **Step 4: Fix until green**

Run: `cd backend && go vet ./internal/agentcore/... && go test ./internal/agentcore/... -race -v`
Expected: PASS, no race warnings.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/agentcore/orchestration/
git commit -m "feat(agentcore): ingestion and reactor workers"
```

---

### Task 10: The /ws/agent WebSocket

> `backend/cmd/server/main.go` is a convergence file. This task owns it exclusively.

The payoff task: reattach is exact, because the client reports the last `Seq` it saw and the server replays precisely what it missed.

**Files:**
- Create: `backend/internal/handler/agent_ws.go`
- Create: `backend/internal/handler/agent_ws_test.go`
- Modify: `backend/cmd/server/main.go` — construct and register

**Interfaces:**
- Consumes: `Engine` (Task 4/6), `port.Store` (Task 5), `provider.Registry` (Task 2), `claude.NewDriver` (Task 8), `Ingestion` / `Reactor` (Task 9).
- Produces: `handler.NewAgentWSHandler(engine *orchestration.Engine, store port.Store, svc *provider.Service) *AgentWSHandler` with `HandleWS(w http.ResponseWriter, r *http.Request)`.

**Wire protocol** (both directions, one JSON object per WebSocket text message):

```
client -> server   {"kind":"hello","threadId":"w-abc","sinceSeq":42}
client -> server   {"kind":"command","command":{ ...orchestration.Command... }}
server -> client   {"kind":"events","events":[ ...orchestration.Event... ]}
server -> client   {"kind":"error","error":"message"}
```

- [ ] **Step 1: Write the failing handler test**

Create `backend/internal/handler/agent_ws_test.go`:

```go
package handler

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/orchestration"

	"nhooyr.io/websocket"
)

type wsFrame struct {
	Kind   string                `json:"kind"`
	Events []orchestration.Event `json:"events,omitempty"`
	Error  string                `json:"error,omitempty"`
}

func readFrame(t *testing.T, ctx context.Context, c *websocket.Conn) wsFrame {
	t.Helper()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var f wsFrame
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("decode frame %q: %v", data, err)
	}
	return f
}

func writeJSONFrame(t *testing.T, ctx context.Context, c *websocket.Conn, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// Sending a turn must produce events on the socket, and a reconnecting client
// that reports its last Seq must receive exactly what it missed — no more, no
// less. This is the property the ring buffer in /ws/terminal cannot give.
func TestReplayFromSeqIsExact(t *testing.T) {
	h, cleanup := newTestAgentWS(t)
	defer cleanup()

	srv := httptest.NewServer(http.HandlerFunc(h.HandleWS))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	c1, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c1.Close(websocket.StatusNormalClosure, "")

	writeJSONFrame(t, ctx, c1, map[string]any{"kind": "hello", "threadId": "w-abc", "sinceSeq": 0})
	writeJSONFrame(t, ctx, c1, map[string]any{
		"kind": "command",
		"command": orchestration.Command{
			CommandID: "ac-create", Type: orchestration.CmdThreadCreate, ThreadID: "w-abc",
			Payload: json.RawMessage(`{"instanceId":"claude:default"}`),
		},
	})

	var lastSeq uint64
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && lastSeq == 0 {
		f := readFrame(t, ctx, c1)
		for _, e := range f.Events {
			if e.Seq > lastSeq {
				lastSeq = e.Seq
			}
		}
	}
	if lastSeq == 0 {
		t.Fatal("no events arrived on the socket")
	}
	c1.Close(websocket.StatusNormalClosure, "")

	// Reconnect reporting what we already have; we must get nothing back.
	c2, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("redial: %v", err)
	}
	defer c2.Close(websocket.StatusNormalClosure, "")

	writeJSONFrame(t, ctx, c2, map[string]any{"kind": "hello", "threadId": "w-abc", "sinceSeq": lastSeq})

	shortCtx, shortCancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer shortCancel()
	if _, _, err := c2.Read(shortCtx); err == nil {
		t.Fatal("client already at head must receive no replay")
	}
}

// A client that reconnects and resends the same CommandID must not start a
// second turn. Mobile clients do this constantly.
func TestResendingCommandIDIsIdempotentOverTheSocket(t *testing.T) {
	h, cleanup := newTestAgentWS(t)
	defer cleanup()

	srv := httptest.NewServer(http.HandlerFunc(h.HandleWS))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	cmd := orchestration.Command{
		CommandID: "ac-create", Type: orchestration.CmdThreadCreate, ThreadID: "w-abc",
		Payload: json.RawMessage(`{"instanceId":"claude:default"}`),
	}
	writeJSONFrame(t, ctx, c, map[string]any{"kind": "hello", "threadId": "w-abc", "sinceSeq": 0})
	writeJSONFrame(t, ctx, c, map[string]any{"kind": "command", "command": cmd})
	writeJSONFrame(t, ctx, c, map[string]any{"kind": "command", "command": cmd})

	time.Sleep(300 * time.Millisecond)

	logged, err := h.store.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if len(logged) != 1 {
		t.Fatalf("log has %d events, want 1 — a resent CommandID must not append", len(logged))
	}
}

// A client must not be able to forge agent output.
func TestServerOnlyCommandRejected(t *testing.T) {
	h, cleanup := newTestAgentWS(t)
	defer cleanup()

	srv := httptest.NewServer(http.HandlerFunc(h.HandleWS))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	writeJSONFrame(t, ctx, c, map[string]any{"kind": "hello", "threadId": "w-abc", "sinceSeq": 0})
	writeJSONFrame(t, ctx, c, map[string]any{
		"kind": "command",
		"command": orchestration.Command{
			CommandID: "ac-forge", Type: orchestration.CmdThreadAssistantDelta, ThreadID: "w-abc",
			Payload: json.RawMessage(`{"text":"I am the agent"}`),
		},
	})

	f := readFrame(t, ctx, c)
	if f.Kind != "error" {
		t.Fatalf("frame kind = %s, want error for a server-only command", f.Kind)
	}
}
```

Add a `newTestAgentWS(t)` helper in the same file that builds a temp-file store (reuse the existing store test helper pattern), an engine on `orchestration.NewPortStore(st)`, a `provider.Service` with an empty registry, starts `engine.Run` on a cancellable context, and returns the handler plus a cleanup func. Add the `net/http` import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/handler/ -run TestReplayFromSeq -v`
Expected: FAIL — `NewAgentWSHandler` undefined.

- [ ] **Step 3: Implement the handler**

Create `backend/internal/handler/agent_ws.go`. Requirements:

- Accept with `websocket.Accept`, `InsecureSkipVerify: true` and `CompressionMode: websocket.CompressionContextTakeover` — match what `/ws/terminal` already negotiates, since production runs behind a tunnel.
- First frame must be `hello`. Anything else → send `{"kind":"error",...}` and close.
- On `hello`: call `store.AgentEventsSince(threadID, sinceSeq)`. Send one `events` frame if non-empty; send **nothing** if empty (the test asserts silence).
- Then `engine.Subscribe(256)`; forward every batch filtered to this `threadId`. A slow subscriber drops batches by design — the client recovers by reconnecting with its last `Seq`, which is exactly why replay exists.
- On `command`: reject unless `orchestration.ClientDispatchable[cmd.Type]`, replying with an `error` frame. Otherwise `engine.Dispatch`. A dispatch error becomes an `error` frame, never a closed socket.
- Reader and writer run in separate goroutines over one `context.WithCancel`; closing either cancels both.
- **The engine keeps running when the socket closes.** Do not stop sessions, do not cancel turns. This mirrors the PTY contract where closing a tab leaves the process alive.
- Log connects and disconnects with `log.Printf`, matching `terminal.Server.HandleWS`.

- [ ] **Step 4: Wire it into main.go**

In `backend/cmd/server/main.go`, after the store is constructed (around line 212) and near the existing terminal server setup:

```go
	// Agent chat harness. Runs on every role, but only a runtime ever has
	// worktrees to chat about; the hub simply proxies the WebSocket.
	agentRegistry := provider.NewRegistry(claude.NewDriver())
	agentEngine := orchestration.NewEngine(orchestration.EngineOptions{
		Store:     orchestration.NewPortStore(st),
		NewID:     func() string { return "ae-" + randomHex(8) },
		QueueSize: 64,
	})
	go agentEngine.Run(ctx)

	agentDir := orchestration.NewThreadDirectory()
	agentSvc := &provider.Service{Registry: agentRegistry, Dir: agentDir}
	agentReactor := &orchestration.Reactor{
		Engine: agentEngine, Provider: agentSvc, Broker: approval.NoopBroker{},
	}
	go agentReactor.Run(ctx)

	agentWS := handler.NewAgentWSHandler(agentEngine, st, agentSvc)
```

and register the route beside the existing terminal route (line 735):

```go
	mux.HandleFunc("/ws/agent", agentWS.HandleWS)
```

Use the file's existing hex-id helper rather than adding `randomHex` if one already exists — grep for the helper backing the `ws-`/`p-`/`w-` prefixes. Add a small `orchestration.NewThreadDirectory()` (a mutex-guarded map implementing `provider.ThreadDirectory`) in `workers.go` if Task 9 did not already add one.

- [ ] **Step 5: Run until green**

Run: `cd backend && go vet ./... && go test ./... -race`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/handler/agent_ws.go backend/internal/handler/agent_ws_test.go backend/cmd/server/main.go backend/internal/agentcore/
git commit -m "feat(agent): /ws/agent websocket with exact replay-from-seq"
```

---

### Task 11: Per-machine agent probe

The chat header must show what is installed on **that worktree's runtime**, not on the hub.

**Files:**
- Modify: `backend/internal/service/agent.go`
- Test: `backend/internal/service/agent_probe_test.go`

**Interfaces:**
- Consumes: `provider.Registry`, `provider.Snapshot` (Task 2); `detect.ProbeAll`.
- Produces: an `installed`, `version`, `binaryPath`, and `detail` field on each entry returned by `AgentService.ListAgents()`.

- [ ] **Step 1: Read the current shape**

Read `backend/internal/service/agent.go` and the type `ListAgents` returns. Extend that struct rather than introducing a parallel one — the frontend already consumes this endpoint.

- [ ] **Step 2: Write the failing test**

Create `backend/internal/service/agent_probe_test.go`:

```go
package service

import "testing"

// Every known agent must appear in the list whether or not it is installed —
// a missing binary is a status the UI renders, not an entry it omits.
func TestListAgentsIncludesUninstalledWithReason(t *testing.T) {
	svc := newTestAgentService(t)

	agents, err := svc.ListAgents()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(agents) == 0 {
		t.Fatal("no agents returned")
	}

	var sawUnavailable bool
	for _, a := range agents {
		if !a.Installed {
			sawUnavailable = true
			if a.Detail == "" {
				t.Errorf("agent %s is unavailable but gives no reason", a.ID)
			}
		}
	}
	if !sawUnavailable {
		t.Skip("every known agent is installed on this machine; nothing to assert")
	}
}
```

Add `newTestAgentService(t)` following the construction pattern already used in the service package's other tests.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && go test ./internal/service/ -run TestListAgentsIncludes -v`
Expected: FAIL — `Installed` / `Detail` fields undefined.

- [ ] **Step 4: Implement**

Add `Installed bool`, `Version string`, `BinaryPath string`, and `Detail string` to the agent summary struct. Populate them by calling each registered `Driver.Probe`. Keep `Probe` cheap: it must not spawn a session, and its result may be cached for the process lifetime, matching `detect.ProbeAll`'s existing "call once at startup" contract.

- [ ] **Step 5: Run until green**

Run: `cd backend && go vet ./... && go test ./... -race`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/service/
git commit -m "feat(agent): report per-machine agent availability from Probe"
```

---

### Task 12: Frontend pure logic

Written and tested before any component exists, because these are the parts that actually have edge cases: out-of-order deltas, gaps, and the scroll re-arm band.

**Files:**
- Create: `frontend/src/features/agent-chat/types.ts`
- Create: `frontend/src/features/agent-chat/eventReducer.ts` + `eventReducer.test.ts`
- Create: `frontend/src/features/agent-chat/timeline.ts` + `timeline.test.ts`
- Create: `frontend/src/features/agent-chat/scrollAnchoring.ts` + `scrollAnchoring.test.ts`

**Interfaces:**
- Consumes: the wire protocol from Task 10.
- Produces: `AgentEvent`, `AgentThreadView`, `ChatItem`; `emptyThreadView(): AgentThreadView`; `reduceAgentEvents(view, events): AgentThreadView`; `buildTimeline(view): TimelineEntry[]`; `shouldFollow(state, endInset): boolean` and `FOLLOW_REARM_THRESHOLD_PX`.

- [ ] **Step 1: Write the types**

Create `frontend/src/features/agent-chat/types.ts`:

```ts
/** Mirrors backend/internal/agentcore/orchestration.Event. `threadKey` on the
 *  frontend IS `threadId` on the backend — one name per side, no mapping. */
export interface AgentEvent {
  seq: number
  eventId: string
  type: string
  threadId: string
  commandId: string
  createdAt: number
  payload?: unknown
}

export type ChatItemKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'error'

export interface ChatItem {
  id: string
  kind: ChatItemKind
  text: string
  /** Tool rows only; read-only in this spec — Allow/Deny arrives with approvals. */
  toolName?: string
  status?: 'running' | 'done' | 'failed'
  /** Highest delta sequence folded into this item, per stream. */
  lastSequence: number
}

export interface AgentThreadView {
  items: ChatItem[]
  status: 'idle' | 'running' | 'waiting' | 'stopped'
  /** Highest Seq applied. Sent as `sinceSeq` when reconnecting. */
  lastSeq: number
  /** True when a delta arrived with a sequence gap — the UI shows a subtle
   *  marker rather than pretending the text is complete. */
  hasGap: boolean
  error: string | null
}
```

- [ ] **Step 2: Write the failing reducer test**

Create `frontend/src/features/agent-chat/eventReducer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { emptyThreadView, reduceAgentEvents } from '@/features/agent-chat/eventReducer'
import type { AgentEvent } from '@/features/agent-chat/types'

function delta(seq: number, itemId: string, text: string, sequence: number, stream = 'text'): AgentEvent {
  return {
    seq,
    eventId: `ae-${seq}`,
    type: 'thread.activity-appended',
    threadId: 'w-abc',
    commandId: `ac-${seq}`,
    createdAt: 1000,
    payload: { itemId, stream, text, sequence },
  }
}

describe('reduceAgentEvents', () => {
  it('appends deltas into a single assistant item', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      delta(1, 'i1', 'Hello ', 1),
      delta(2, 'i1', 'world', 2),
    ])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].kind).toBe('assistant')
    expect(view.items[0].text).toBe('Hello world')
    expect(view.lastSeq).toBe(2)
  })

  it('keeps reasoning in a separate item from the answer', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      delta(1, 'i1', 'thinking...', 1, 'reasoning'),
      delta(2, 'i2', 'the answer', 1, 'text'),
    ])
    expect(view.items.map((i) => i.kind)).toEqual(['reasoning', 'assistant'])
  })

  // The client cannot re-order what the server already ordered by Seq, but a
  // gap in the per-item sequence means a delta was genuinely lost.
  it('flags a sequence gap rather than silently concatenating', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      delta(1, 'i1', 'Hello ', 1),
      delta(2, 'i1', 'world', 5),
    ])
    expect(view.hasGap).toBe(true)
  })

  it('ignores an event already applied, so replay overlap is harmless', () => {
    const first = reduceAgentEvents(emptyThreadView(), [delta(1, 'i1', 'Hello', 1)])
    const second = reduceAgentEvents(first, [delta(1, 'i1', 'Hello', 1)])
    expect(second.items[0].text).toBe('Hello')
    expect(second.lastSeq).toBe(1)
  })

  it('is pure — the input view is not mutated', () => {
    const before = emptyThreadView()
    reduceAgentEvents(before, [delta(1, 'i1', 'Hello', 1)])
    expect(before.items).toHaveLength(0)
    expect(before.lastSeq).toBe(0)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd frontend && npx vitest run src/features/agent-chat/eventReducer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the reducer**

Create `frontend/src/features/agent-chat/eventReducer.ts` exporting `emptyThreadView()` and `reduceAgentEvents(view, events)`. Rules: skip any event whose `seq <= view.lastSeq`; group deltas by `itemId`; a `reasoning` stream produces a `reasoning` item, `text` an `assistant` item; set `hasGap` when a delta's `sequence` exceeds the item's `lastSequence + 1`; return a new object every time, never mutate.

- [ ] **Step 5: Write and pass the scroll-anchoring test**

Create `frontend/src/features/agent-chat/scrollAnchoring.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { FOLLOW_REARM_THRESHOLD_PX, shouldFollow } from '@/features/agent-chat/scrollAnchoring'

describe('shouldFollow', () => {
  it('follows when pinned to the bottom', () => {
    expect(shouldFollow({ contentLength: 1000, scroll: 800, scrollLength: 200 }, 0)).toBe(true)
  })

  // A strict 1px check re-arms while the user is reading history and yanks
  // them back down on the next streamed chunk. The band prevents that.
  it('does not follow when the user has scrolled up past the band', () => {
    expect(shouldFollow({ contentLength: 1000, scroll: 500, scrollLength: 200 }, 0)).toBe(false)
  })

  it('still follows within the re-arm band', () => {
    const scroll = 800 - (FOLLOW_REARM_THRESHOLD_PX - 1)
    expect(shouldFollow({ contentLength: 1000, scroll, scrollLength: 200 }, 0)).toBe(true)
  })

  it('accounts for the composer overlay inset', () => {
    expect(shouldFollow({ contentLength: 1120, scroll: 800, scrollLength: 200 }, 120)).toBe(true)
  })
})
```

Then create `scrollAnchoring.ts` with `export const FOLLOW_REARM_THRESHOLD_PX = 40` and `shouldFollow(state, endInset)` returning `contentLength - scroll - scrollLength - endInset <= FOLLOW_REARM_THRESHOLD_PX`.

- [ ] **Step 6: Write and pass the timeline test**

Create `timeline.test.ts` asserting `buildTimeline(view)` returns entries in item order, collapses consecutive tool rows into one group, and marks reasoning entries `collapsed: true` by default. Then implement `timeline.ts` to satisfy it.

- [ ] **Step 7: Run until green**

Run: `cd frontend && npm run typecheck && npx vitest run src/features/agent-chat/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/features/agent-chat/
git commit -m "feat(agent-chat): pure event reducer, timeline, and scroll anchoring"
```

---

### Task 13: The agent-chat pane kind and socket hook

> `frontend/src/store/useDevDeckStore.ts` is a convergence file. This task owns it exclusively.

**Files:**
- Modify: `frontend/src/features/terminal/paneTree.ts`
- Modify: `frontend/src/features/terminal/paneTree.test.ts`
- Modify: `frontend/src/store/useDevDeckStore.ts`
- Create: `frontend/src/features/agent-chat/useAgentChatSocket.ts`

**Interfaces:**
- Consumes: `reduceAgentEvents`, `emptyThreadView` (Task 12); `machineWsUrl` from `@/lib/machineClient`.
- Produces: `AgentChatContent` (`{ kind: 'agent-chat'; id; threadKey; label }`); `createAgentChatPane(worktreeId: string, seq?: number): AgentChatContent`; store slice `agentThreads: Record<string, AgentThreadView>` with `applyAgentEvents(threadKey, events)` and `resetAgentThread(threadKey)`; `useAgentChatSocket({ machine, threadKey })` returning `{ view, status, sendTurn, abortTurn }`.

- [ ] **Step 1: Write the failing paneTree test**

Append to `frontend/src/features/terminal/paneTree.test.ts`:

```ts
describe('createAgentChatPane', () => {
  it('uses the bare worktree id for the primary chat, mirroring terminal panes', () => {
    const pane = createAgentChatPane('w-abc')
    expect(pane.kind).toBe('agent-chat')
    expect(pane.id).toBe('w-abc')
    expect(pane.threadKey).toBe('w-abc')
    expect(pane.label).toBe('Chat')
  })

  it('suffixes additional chat panes so each gets its own thread', () => {
    const pane = createAgentChatPane('w-abc', 1)
    expect(pane.id).toBe('w-abc::chat-1')
    expect(pane.threadKey).toBe('w-abc::chat-1')
    expect(pane.label).toBe('Chat 2')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/features/terminal/paneTree.test.ts`
Expected: FAIL — `createAgentChatPane` is not exported.

- [ ] **Step 3: Extend paneTree.ts**

Add `'agent-chat'` to `PaneContentKind`; add the interface with a doc comment mirroring `TerminalContent`'s; add it to the `PaneContent` union; add the factory:

```ts
/** A chat thread against the worktree's configured agent. Its `threadKey` is
 *  the backend's ThreadID verbatim. The primary pane uses the bare worktree
 *  id; additional chat panes use `${worktreeId}::chat-${n}` — the same
 *  scheme TerminalContent uses for extra shells. */
export interface AgentChatContent extends BasePaneContent {
  kind: 'agent-chat'
  threadKey: string
}

export function createAgentChatPane(worktreeId: string, seq?: number): AgentChatContent {
  const threadKey = seq === undefined ? worktreeId : `${worktreeId}::chat-${seq}`
  const label = seq === undefined ? 'Chat' : `Chat ${seq + 1}`
  return { kind: 'agent-chat', id: threadKey, threadKey, label }
}
```

Check whether `paneTree.ts` has a `collectTerminalSessionKeys`-style walker or a serialize/deserialize switch that enumerates kinds; if so, handle `'agent-chat'` there too, or a chat pane will not survive a reload.

- [ ] **Step 4: Add the store slice**

In `frontend/src/store/useDevDeckStore.ts`, add `agentThreads: Record<string, AgentThreadView>` beside `browserTiles` and `sshTileLayouts`, with `applyAgentEvents(threadKey, events)` calling `reduceAgentEvents` and `resetAgentThread(threadKey)`. **Exclude `agentThreads` from the persist partializer** — a streamed view model is rebuilt from the server on reconnect, and persisting it would resurrect stale half-written messages.

- [ ] **Step 5: Write the socket hook**

Create `frontend/src/features/agent-chat/useAgentChatSocket.ts`. Requirements: build the URL with `machineWsUrl(machine, '/ws/agent', {})`; send `{kind:'hello', threadId: threadKey, sinceSeq: view.lastSeq}` on open; feed `events` frames into `applyAgentEvents`; surface `error` frames as the view's `error`; reconnect with backoff, always re-sending the current `lastSeq` so replay is exact; generate a fresh `commandId` per user action via `crypto.randomUUID()` and **reuse it on retry** so a resend is idempotent; clean up the socket on unmount.

- [ ] **Step 6: Run until green**

Run: `cd frontend && npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/terminal/paneTree.ts frontend/src/features/terminal/paneTree.test.ts frontend/src/store/useDevDeckStore.ts frontend/src/features/agent-chat/
git commit -m "feat(agent-chat): agent-chat pane kind, store slice, and socket hook"
```

---

### Task 14: Chat components and worktree wiring

**Files:**
- Create: `frontend/src/features/agent-chat/AgentChatPane.tsx`
- Create: `frontend/src/features/agent-chat/ChatHeader.tsx`
- Create: `frontend/src/features/agent-chat/MessagesTimeline.tsx`
- Create: `frontend/src/features/agent-chat/ChatComposer.tsx`
- Create: `frontend/src/features/agent-chat/AgentChatPane.test.tsx`
- Modify: `frontend/src/features/terminal/ExpandedTerminal.tsx`

**Interfaces:**
- Consumes: `useAgentChatSocket` (Task 13), `buildTimeline` / `shouldFollow` (Task 12), the probe fields on `useAgents()` (Task 11).
- Produces: `<AgentChatPane worktreeId threadKey machine />`.

- [ ] **Step 1: Write the failing component test**

Create `frontend/src/features/agent-chat/AgentChatPane.test.tsx` asserting the three states your frontend rules require, with `useAgentChatSocket` stubbed via `vi.mock`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentChatPane } from '@/features/agent-chat/AgentChatPane'
import { emptyThreadView } from '@/features/agent-chat/eventReducer'

const mockSocket = vi.fn()
vi.mock('@/features/agent-chat/useAgentChatSocket', () => ({
  useAgentChatSocket: () => mockSocket(),
}))

const machine = { id: 'm-1', name: 'dev', url: 'http://localhost:8989', key: 'k' } as never

describe('AgentChatPane', () => {
  it('shows a connecting state before the socket opens', () => {
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'connecting',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
    })
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} />)
    expect(screen.getByText(/connecting/i)).toBeInTheDocument()
  })

  it('shows an empty state once connected with no messages', () => {
    mockSocket.mockReturnValue({
      view: emptyThreadView(), status: 'open',
      sendTurn: vi.fn(), abortTurn: vi.fn(),
    })
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} />)
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument()
  })

  it('surfaces a thread error instead of rendering an empty timeline', () => {
    mockSocket.mockReturnValue({
      view: { ...emptyThreadView(), error: 'claude CLI not found on PATH' },
      status: 'open', sendTurn: vi.fn(), abortTurn: vi.fn(),
    })
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} />)
    expect(screen.getByText(/claude CLI not found on PATH/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/features/agent-chat/AgentChatPane.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Build the components**

Model the anatomy on `gg/t3code/apps/web/src/components/chat/` — `ChatHeader.tsx`, `MessagesTimeline.tsx`, `ChatComposer.tsx` are the three to read first. Take the **structure and interaction**, not the styling: every colour, radius, and spacing value comes from DevDeck's `globals.css` v2 tokens.

- `ChatHeader` — agent picker (disabled entries for uninstalled agents, with `Detail` as the tooltip), model picker, mode picker. Runtime mode and interaction mode are **two separate controls**; do not collapse them into one enum.
- `MessagesTimeline` — renders `buildTimeline(view)`. User messages, assistant text, reasoning collapsed by default behind a disclosure, tool rows read-only with a status dot. If `view.hasGap`, show a subtle inline marker rather than pretending the text is whole.
- `ChatComposer` — textarea, Send (Enter) and newline (Shift+Enter), Abort while `status === 'running'`.
- `AgentChatPane` — composes the three, owns `useAgentChatSocket`, and renders the loading / error / empty states the test asserts. Wire follow-mode scrolling through `shouldFollow`.
- Icons from `lucide-react`, `cn()` for class merging, `import type` for type-only imports.

- [ ] **Step 4: Wire into ExpandedTerminal**

In `ExpandedTerminal.tsx`, add an `agent-chat` branch to the pane-content switch rendering `<AgentChatPane>`. Then change the default layout for a worktree so its first pane is `createAgentChatPane(worktreeId)` instead of `createTerminalPane(worktreeId)`.

**Do not remove `createTerminalPane` or its call sites.** The "add a terminal" split action must keep working exactly as before — the decision was chat *alongside* the terminal, not instead of it. Existing persisted layouts already contain terminal panes and must keep rendering unchanged.

- [ ] **Step 5: Run until green**

Run: `cd frontend && npm run typecheck && npx vitest run`
Then: `cd backend && go vet ./... && go test ./... -race`
Expected: PASS.

- [ ] **Step 6: Manual verification**

Start the app, open a worktree whose `Agent` is `claude`, and confirm: the pane opens on Chat; sending a message streams assistant text; reasoning appears as a separate collapsed block; tool calls appear as rows; closing and reopening the tab replays the thread rather than losing it; splitting off a Terminal pane still gives a working shell.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/agent-chat/ frontend/src/features/terminal/ExpandedTerminal.tsx
git commit -m "feat(agent-chat): chat pane components, default worktree pane"
```

---

## Per-Task Review Gate

After **each** task's final commit, before starting the next:

1. **Verify** — run the task's own commands plus `cd backend && go vet ./... && go test ./... -race` and `cd frontend && npm run typecheck && npm test`. Paste real output; never claim green without it.
2. **Review** the diff for: an event vocabulary bent toward Claude; `Kind` used where `InstanceID` belongs; logic branching on `Raw`; `time.Now()` or randomness inside `Decide`; state swapped before commit; a convergence file edited outside its owning task; untranslated Indonesian comments.
3. **Fix** anything found, then re-run step 1.
4. Only then move to the next task.

## Self-Review Notes

Checked against the spec:

- Every spec section maps to a task: architecture/placement → 1-2, persistence → 5-6, canonical events → 1, Driver/Adapter + InstanceID → 2, per-machine Probe → 11, engine → 3-4, transport → 10, frontend → 12-14, error handling → distributed across tasks with explicit tests in 7 (unparseable → warning), 5 (atomic commit), 10 (dispatch error → error frame).
- Type consistency verified: `orchestration.Event` fields used identically in Tasks 3, 5, 6, 10; `AgentThreadView` shape identical in Tasks 12, 13, 14; `threadKey === threadId` stated in Task 12's types and enforced by Task 13's factory.
- **Known deviation from the spec's task-ordering ideal:** the spec's `AgentThreads(worktreeID)` store method is implemented in Task 5 as `AgentThreadIDs` and is not consumed by any task in this plan — spec 1's pane derives its `threadKey` from the worktree id directly. It is built now because Task 5 owns the convergence file and a second edit to `port/store.go` later is more expensive than an unused method today.
- **Deferred with no task, by design:** approval broker implementation, buffered delivery, the four non-Claude adapters, plan cards, turn diffs, checkpointing, cross-restart resume. All belong to specs 2-5.

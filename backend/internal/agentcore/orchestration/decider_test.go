package orchestration

import (
	"encoding/json"
	"strings"
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
		// A client that could dispatch thread.plan.propose could forge an
		// agent's proposed plan — same class of forgery assistant.delta is
		// excluded for.
		CmdThreadPlanPropose,
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

// Every CommandType must have an explicit decider rule. The generic
// "unrecognized command" fallthrough is how five commands silently shipped
// broken, including the one Ingestion uses for every tool call.
func TestEveryCommandTypeHasADeciderRule(t *testing.T) {
	all := []CommandType{
		CmdThreadCreate, CmdThreadTurnStart, CmdThreadTurnInterrupt,
		CmdThreadApprovalRespond, CmdThreadUserInputRespond, CmdThreadSessionStop,
		CmdThreadRuntimeModeSet, CmdThreadInteractionModeSet, CmdThreadDelete,
		CmdThreadAssistantDelta, CmdThreadAssistantComplete, CmdThreadSessionSet,
		CmdThreadActivityAppend, CmdThreadTurnDiffComplete, CmdThreadPlanPropose,
	}

	for _, ct := range all {
		s := createThread(t, NewState(), "w-abc")
		_, err := Decide(s, Command{
			CommandID: "ac-x", Type: ct, ThreadID: "w-abc",
			Payload: mustRaw(t, map[string]any{}),
		}, 1000, seqIDs())

		// A rule may legitimately reject bad input, but it must never report
		// the command as unknown.
		if err != nil && strings.Contains(err.Error(), "unrecognized command") {
			t.Errorf("%s has no decider rule", ct)
		}
	}
}

// Ingestion's fallback dispatches ActivityAppend for every provider event it
// doesn't explicitly handle — which is exactly what tool calls are.
func TestActivityAppendProducesAnEvent(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")
	evts, err := Decide(s, Command{
		CommandID: "ac-act", Type: CmdThreadActivityAppend, ThreadID: "w-abc",
		Payload: mustRaw(t, map[string]any{"itemType": "tool_call", "title": "Read"}),
	}, 2000, seqIDs())
	if err != nil {
		t.Fatalf("activity append: %v", err)
	}
	if len(evts) != 1 || evts[0].Type != EvtThreadActivityAppended {
		t.Fatalf("got %+v, want one thread.activity-appended", evts)
	}
}

func TestInteractionModeSetAppliesToState(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")
	evts, err := Decide(s, Command{
		CommandID: "ac-im", Type: CmdThreadInteractionModeSet, ThreadID: "w-abc",
		Payload: mustRaw(t, InteractionModeSetPayload{Mode: provider.InteractionPlan}),
	}, 3000, seqIDs())
	if err != nil {
		t.Fatalf("interaction mode: %v", err)
	}
	s = Apply(s, evts)
	if th, _ := s.Thread("w-abc"); th.Interact != provider.InteractionPlan {
		t.Fatalf("interact = %s, want plan", th.Interact)
	}
}

// Regression: Decide's CmdThreadUserInputRespond case rejects a response whose
// request is no longer pending, but that guard reads state the projector owns.
// Without an applyOne case for EvtThreadUserInputResponseRequested the request
// never clears, so the guard never fires and Status sticks at waiting forever.
func TestUserInputResponseClearsPendingAndRejectsDoubleTap(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")

	evts, err := Decide(s, Command{
		CommandID: "ac-open", Type: CmdThreadSessionSet, ThreadID: "w-abc",
		Payload: mustRaw(t, map[string]any{
			"status": string(ThreadWaiting), "pendingRequestAdd": "req-1",
		}),
	}, 4000, seqIDs())
	if err != nil {
		t.Fatalf("open request: %v", err)
	}
	s = Apply(s, evts)

	respond := func(commandID string) Command {
		return Command{
			CommandID: commandID, Type: CmdThreadUserInputRespond, ThreadID: "w-abc",
			Payload: mustRaw(t, map[string]any{
				"requestId": "req-1",
				"answers":   map[string]any{"choice": "yes"},
			}),
		}
	}

	first, err := Decide(s, respond("ac-resp-1"), 5000, seqIDs())
	if err != nil {
		t.Fatalf("first response: %v", err)
	}
	s = Apply(s, first)

	th, _ := s.Thread("w-abc")
	if th.PendingRequests["req-1"] {
		t.Fatal("req-1 still pending after being answered")
	}
	if th.Status != ThreadRunning {
		t.Fatalf("status = %s, want running once nothing is pending", th.Status)
	}

	// A second device answering the same request carries a DIFFERENT
	// CommandID, so SeenCommand cannot catch it — the pending check is the
	// only defence.
	if _, err := Decide(s, respond("ac-resp-2"), 5001, seqIDs()); err == nil {
		t.Fatal("answering an already-resolved request should be rejected")
	}
}

// EvtThreadPlanProposed puts a plan "on the table"; the next
// EvtThreadTurnStartRequested takes it back off, because any following turn
// supersedes it (spec: "cleared by the next
// EvtThreadTurnStartRequested"). Table-test style matching
// TestInteractionModeSetAppliesToState above.
func TestPlanProposedSetsThreadProposedPlanAndTurnStartClearsIt(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")

	evts, err := Decide(s, Command{
		CommandID: "ac-plan", Type: CmdThreadPlanPropose, ThreadID: "w-abc",
		Payload: mustRaw(t, PlanProposePayload{
			PlanMarkdown: "# Plan\n\n1. Do the thing",
			PlanFilePath: "/Users/agent/.claude/plans/do-the-thing.md",
			ToolUseID:    "toolu_01abc",
		}),
	}, 3000, seqIDs())
	if err != nil {
		t.Fatalf("plan propose: %v", err)
	}
	if len(evts) != 1 || evts[0].Type != EvtThreadPlanProposed {
		t.Fatalf("got %+v, want exactly one thread.plan-proposed", evts)
	}
	s = Apply(s, evts)

	th, _ := s.Thread("w-abc")
	if th.ProposedPlan == nil {
		t.Fatal("ProposedPlan not set")
	}
	if th.ProposedPlan.PlanMarkdown != "# Plan\n\n1. Do the thing" {
		t.Fatalf("PlanMarkdown = %q, want the proposed markdown", th.ProposedPlan.PlanMarkdown)
	}
	if th.ProposedPlan.PlanFilePath != "/Users/agent/.claude/plans/do-the-thing.md" {
		t.Fatalf("PlanFilePath = %q, want the proposed path", th.ProposedPlan.PlanFilePath)
	}
	if th.ProposedPlan.ToolUseID != "toolu_01abc" {
		t.Fatalf("ToolUseID = %q, want toolu_01abc", th.ProposedPlan.ToolUseID)
	}

	// A following turn supersedes the plan on the table.
	turnEvts, err := Decide(s, Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "please implement this plan"}),
	}, 4000, seqIDs())
	if err != nil {
		t.Fatalf("turn start: %v", err)
	}
	s = Apply(s, turnEvts)

	th, _ = s.Thread("w-abc")
	if th.ProposedPlan != nil {
		t.Fatalf("ProposedPlan = %+v, want nil after a following turn starts", th.ProposedPlan)
	}
}

// CmdThreadPlanPropose is server-only: it must never reach Decide with an
// invalid or missing payload from a client. This pins that a malformed
// payload is still handled explicitly (not the "unrecognized command"
// fallthrough) — TestEveryCommandTypeHasADeciderRule already covers the
// zero-value payload; this covers the field-for-field decode.
func TestPlanProposedPayloadDecodesFieldForField(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")
	evts, err := Decide(s, Command{
		CommandID: "ac-plan", Type: CmdThreadPlanPropose, ThreadID: "w-abc",
		Payload: mustRaw(t, PlanProposePayload{PlanMarkdown: "bare plan, no file path or tool id"}),
	}, 3000, seqIDs())
	if err != nil {
		t.Fatalf("plan propose: %v", err)
	}
	s = Apply(s, evts)
	th, _ := s.Thread("w-abc")
	if th.ProposedPlan == nil || th.ProposedPlan.PlanMarkdown != "bare plan, no file path or tool id" {
		t.Fatalf("ProposedPlan = %+v, want the markdown carried through with empty optional fields", th.ProposedPlan)
	}
	if th.ProposedPlan.PlanFilePath != "" || th.ProposedPlan.ToolUseID != "" {
		t.Fatalf("ProposedPlan = %+v, want empty optional fields left unset", th.ProposedPlan)
	}
}

// clone() must give every derived State its own Thread struct so that field
// REASSIGNMENT (t.ProposedPlan = nil, or := &newPlan) on one snapshot never
// leaks into another — the same "State == Apply(log), never mutated in
// place" invariant TestApplyDoesNotMutateInput pins for other fields.
// ProposedPlan itself is only ever replaced wholesale (never mutated
// in-place through its pointer), so clone() sharing the *ProposedPlan value
// across snapshots is deliberate — this test pins exactly that: the pointER
// FIELD is independent per snapshot, but an unmodified pointer VALUE may be
// shared, and that must not become a footgun later.
func TestCloneGivesEachSnapshotAnIndependentProposedPlanField(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")
	evts, err := Decide(s, Command{
		CommandID: "ac-plan", Type: CmdThreadPlanPropose, ThreadID: "w-abc",
		Payload: mustRaw(t, PlanProposePayload{PlanMarkdown: "# Plan"}),
	}, 3000, seqIDs())
	if err != nil {
		t.Fatalf("plan propose: %v", err)
	}
	before := Apply(s, evts)
	beforeThread, _ := before.Thread("w-abc")
	if beforeThread.ProposedPlan == nil {
		t.Fatal("ProposedPlan not set on the snapshot before the turn starts")
	}

	// Deriving a new snapshot (clone() + applyOne) that clears ProposedPlan
	// must not reach back and clear it on the snapshot already handed out.
	turnEvts, err := Decide(before, Command{
		CommandID: "ac-turn", Type: CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustRaw(t, TurnStartPayload{Text: "go"}),
	}, 4000, seqIDs())
	if err != nil {
		t.Fatalf("turn start: %v", err)
	}
	after := Apply(before, turnEvts)

	beforeThread, _ = before.Thread("w-abc")
	if beforeThread.ProposedPlan == nil {
		t.Fatal("deriving a new snapshot mutated the ProposedPlan field on the prior snapshot")
	}
	afterThread, _ := after.Thread("w-abc")
	if afterThread.ProposedPlan != nil {
		t.Fatalf("ProposedPlan = %+v, want nil on the snapshot after the turn starts", afterThread.ProposedPlan)
	}
}

// Both mode commands come straight off a client socket. Before the decider
// validated them, an unknown mode string was committed to the durable log and
// replayed to every client as the thread's mode, while AllowsUnprompted
// treated it as "ask for everything" — and the pill that sent it kept showing
// what it sent. A rejection is an error frame, which is the signal the
// composer's pills revert on.
func TestModeSetRejectsUnknownModesAndMissingThreads(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")

	cases := []struct {
		name    string
		typ     CommandType
		thread  string
		payload any
		wantErr string
	}{
		{"unknown runtime mode", CmdThreadRuntimeModeSet, "w-abc", map[string]any{"mode": "yolo"}, "invalid runtime mode"},
		{"empty runtime mode", CmdThreadRuntimeModeSet, "w-abc", map[string]any{}, "invalid runtime mode"},
		{"unknown interaction mode", CmdThreadInteractionModeSet, "w-abc", map[string]any{"mode": "architect"}, "invalid interaction mode"},
		{"runtime mode on a missing thread", CmdThreadRuntimeModeSet, "w-nope", map[string]any{"mode": "auto"}, "does not exist"},
		{"interaction mode on a missing thread", CmdThreadInteractionModeSet, "w-nope", map[string]any{"mode": "plan"}, "does not exist"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Decide(s, Command{
				CommandID: "ac-x", Type: tc.typ, ThreadID: tc.thread, Payload: mustRaw(t, tc.payload),
			}, 1000, seqIDs())
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want %q", err, tc.wantErr)
			}
		})
	}

	// Every real mode is still accepted.
	for _, mode := range []provider.RuntimeMode{provider.ModeApprovalRequired, provider.ModeAutoAcceptEdits, provider.ModeAuto, provider.ModeFullAccess} {
		if _, err := Decide(s, Command{
			CommandID: "ac-ok", Type: CmdThreadRuntimeModeSet, ThreadID: "w-abc",
			Payload: mustRaw(t, RuntimeModeSetPayload{Mode: mode}),
		}, 1000, seqIDs()); err != nil {
			t.Fatalf("mode %s rejected: %v", mode, err)
		}
	}
}

// Thread.Turns and Thread.Steered are what ensureSession's option-restart
// rule reads: Turns says whether the provider has a conversation to resume,
// Steered whether the latest turn joined one already in flight. Both must
// come out of the projector identically on replay.
func TestTurnStartCountsTurnsAndRecordsSteering(t *testing.T) {
	s := createThread(t, NewState(), "w-abc")
	turn := func(id string, at int64) {
		t.Helper()
		evts, err := Decide(s, Command{
			CommandID: id, Type: CmdThreadTurnStart, ThreadID: "w-abc",
			Payload: mustRaw(t, TurnStartPayload{Text: "go"}),
		}, at, seqIDs())
		if err != nil {
			t.Fatalf("turn %s: %v", id, err)
		}
		s = Apply(s, evts)
	}
	settle := func(status ThreadStatus, at int64) {
		t.Helper()
		evts, err := Decide(s, Command{
			CommandID: "ac-set-" + string(status), Type: CmdThreadSessionSet, ThreadID: "w-abc",
			Payload: mustRaw(t, map[string]any{"status": string(status)}),
		}, at, seqIDs())
		if err != nil {
			t.Fatalf("session set: %v", err)
		}
		s = Apply(s, evts)
	}

	// A fresh session announces itself as `running` (Ingestion's
	// SessionStarted case) before any turn exists. That is not a turn in
	// flight, and the first real turn after it must not read as steering —
	// live, it did: the composer's first effort pick on a new thread was
	// deferred with "options changed under a running turn".
	settle(ThreadRunning, 1500)
	th, _ := s.Thread("w-abc")
	if th.TurnInFlight {
		t.Fatalf("a session start must not count as a turn in flight")
	}

	turn("ac-t1", 2000)
	th, _ = s.Thread("w-abc")
	if th.Turns != 1 || th.Steered || !th.TurnInFlight {
		t.Fatalf("after first turn: Turns=%d Steered=%v InFlight=%v, want 1/false/true", th.Turns, th.Steered, th.TurnInFlight)
	}

	// A second message while the first is still running is steering.
	turn("ac-t2", 3000)
	th, _ = s.Thread("w-abc")
	if th.Turns != 2 || !th.Steered {
		t.Fatalf("after steered turn: Turns=%d Steered=%v, want 2/true", th.Turns, th.Steered)
	}

	// Waiting on an approval still counts as in flight.
	settle(ThreadWaiting, 3500)
	turn("ac-t3", 4000)
	th, _ = s.Thread("w-abc")
	if !th.Steered {
		t.Fatalf("a turn sent while waiting must be Steered")
	}

	// Once the thread settles, the next turn is a fresh one.
	settle(ThreadIdle, 5000)
	th, _ = s.Thread("w-abc")
	if th.TurnInFlight {
		t.Fatalf("idle must clear TurnInFlight")
	}
	turn("ac-t4", 6000)
	th, _ = s.Thread("w-abc")
	if th.Turns != 4 || th.Steered {
		t.Fatalf("after idle: Turns=%d Steered=%v, want 4/false", th.Turns, th.Steered)
	}

	// A stop settles it too.
	settle(ThreadStopped, 7000)
	turn("ac-t5", 8000)
	th, _ = s.Thread("w-abc")
	if th.Steered {
		t.Fatalf("a turn after a stop must not be Steered")
	}
}

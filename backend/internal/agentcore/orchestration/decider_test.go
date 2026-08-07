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

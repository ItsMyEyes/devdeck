package orchestration

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/approval"
	"devdeck/backend/internal/agentcore/event"
)

// silentTurnRig stands up an engine + ingestion pair against one thread and
// returns a feeder for adapter events plus a reader for the activity rows the
// client would render.
func silentTurnRig(t *testing.T) (feed func(event.Event), activities func() []event.Event, ctx context.Context) {
	t.Helper()
	store := NewMemStore()
	n := 0
	e := NewEngine(EngineOptions{
		Store: store, Now: func() int64 { return 1000 }, QueueSize: 16,
		NewID: func() string { n++; return "ae-" + string(rune('a'+n)) },
	})
	c, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go e.Run(c)

	if _, err := e.Dispatch(c, Command{
		CommandID: "ac-create", Type: CmdThreadCreate, ThreadID: "w-abc",
		Payload: json.RawMessage(`{"instanceId":"stub:1"}`),
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	a := &stubAdapter{ch: make(chan event.Event, 8)}
	m := 0
	in := NewIngestion(e, approval.NoopBroker{}, func() string { m++; return "ac-in-" + string(rune('a'+m)) })
	go in.Consume(c, a)

	// Reads back the forwarded provider envelopes the client renders as rows.
	// Only activity events carry one; session-set is status bookkeeping.
	return func(ev event.Event) { a.ch <- ev },
		func() []event.Event {
			var out []event.Event
			for _, ev := range store.All() {
				if ev.Type != EvtThreadActivityAppended {
					continue
				}
				var fwd event.Event
				if err := json.Unmarshal(ev.Payload, &fwd); err != nil {
					continue
				}
				out = append(out, fwd)
			}
			return out
		}, c
}

func hasActivity(evts []event.Event, typ event.Type) (event.Event, bool) {
	for _, e := range evts {
		if e.Type == typ {
			return e, true
		}
	}
	return event.Event{}, false
}

func payloadMessage(t *testing.T, e event.Event) string {
	t.Helper()
	// The forwarded envelope round-trips through JSON, so Payload comes back
	// as a decoded map rather than the original concrete type — read the field
	// the client reads (eventReducer.ts's `payload.message`).
	b, err := json.Marshal(e.Payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	var p struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal(b, &p)
	return p.Message
}

// The provider-agnostic half of the silent-turn bug. TurnCompletedPayload
// carried Status ("completed" | "failed") and Ingestion read it for exactly
// nothing: a failed turn and a successful one both produced one
// `thread.session-set` with status idle and NOTHING else, so the client had no
// row to render and no way to know one was missing.
func TestFailedTurnStatusReachesTheTranscript(t *testing.T) {
	feed, activities, _ := silentTurnRig(t)

	feed(event.Event{Type: event.TurnStarted, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.TurnStartedPayload{Model: "claude-sonnet-5"}})
	feed(event.Event{Type: event.TurnCompleted, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.TurnCompletedPayload{Status: "failed"}})

	waitFor(t, func() bool { _, ok := hasActivity(activities(), event.RuntimeError); return ok })
}

// A turn that "succeeds" while producing nothing at all is the exact shape a
// safeguard refusal takes: zero output tokens, no assistant message, no tool
// call. This backstop is what makes "never a silent turn" hold for a provider
// whose own failure shape DevDeck has never seen.
func TestTurnThatProducesNothingIsReported(t *testing.T) {
	feed, activities, _ := silentTurnRig(t)

	feed(event.Event{Type: event.TurnStarted, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.TurnStartedPayload{Model: "claude-sonnet-5"}})
	feed(event.Event{Type: event.TurnCompleted, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.TurnCompletedPayload{
			Status: "completed",
			Usage:  &event.Usage{InputTokens: 55965, OutputTokens: 0},
		}})

	waitFor(t, func() bool { _, ok := hasActivity(activities(), event.RuntimeWarning); return ok })
	got, _ := hasActivity(activities(), event.RuntimeWarning)
	if msg := payloadMessage(t, got); !strings.Contains(msg, "without producing any output") {
		t.Errorf("notice message = %q, want it to say the turn produced nothing", msg)
	}
}

// The other half of the contract: a turn that DID say something must stay
// clean. Firing the backstop on a normal reply would put a spurious notice
// under every single turn.
func TestTurnWithTextIsNotReported(t *testing.T) {
	feed, activities, _ := silentTurnRig(t)

	feed(event.Event{Type: event.TurnStarted, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.TurnStartedPayload{Model: "claude-sonnet-5"}})
	feed(event.Event{Type: event.ContentDelta, ThreadID: "w-abc", TurnID: "t1", ItemID: "i1",
		Payload: &event.ContentDeltaPayload{
			ItemType: event.ItemAssistantMessage, Stream: event.StreamText,
			Text: "the busiest pod is api-gateway", Sequence: 1,
		}})
	feed(event.Event{Type: event.TurnCompleted, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.TurnCompletedPayload{Status: "completed"}})

	// Wait for the turn to have fully settled before asserting the absence,
	// or this passes simply by checking too early.
	waitFor(t, func() bool {
		for _, ev := range activities() {
			if ev.Type == event.ContentDelta || ev.ItemID == "i1" {
				return true
			}
		}
		return len(activities()) > 0
	})
	waitFor(t, func() bool { return len(activities()) >= 2 })
	for _, ev := range activities() {
		if ev.Type == event.RuntimeWarning || ev.Type == event.RuntimeError {
			t.Fatalf("a turn that produced text was reported as silent: %s", ev.Type)
		}
	}
}

// A turn whose only visible output is an approval card has very much said
// something — the operator is looking at a prompt. Reporting it as silent
// would stack a "produced no output" notice under a card they are being asked
// to answer.
func TestTurnWaitingOnAnApprovalIsNotReported(t *testing.T) {
	feed, activities, _ := silentTurnRig(t)

	feed(event.Event{Type: event.TurnStarted, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.TurnStartedPayload{Model: "claude-sonnet-5"}})
	feed(event.Event{Type: event.RequestOpened, ThreadID: "w-abc", TurnID: "t1", RequestID: "req-1",
		Payload: &event.RequestOpenedPayload{RequestType: event.ReqCommandExecApproval, Detail: "kubectl top pods"}})
	feed(event.Event{Type: event.TurnCompleted, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.TurnCompletedPayload{Status: "completed"}})

	waitFor(t, func() bool { return len(activities()) >= 2 })
	for _, ev := range activities() {
		if ev.Type == event.RuntimeWarning || ev.Type == event.RuntimeError {
			t.Fatalf("a turn holding an approval card was reported as silent: %s", ev.Type)
		}
	}
}

// The provider already explained itself (claude's parseSystem/parseResult do
// this now), so the backstop must stay quiet rather than appending a second,
// vaguer notice underneath a specific one.
func TestBackstopStaysQuietWhenAReasonWasAlreadyReported(t *testing.T) {
	feed, activities, _ := silentTurnRig(t)

	feed(event.Event{Type: event.TurnStarted, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.TurnStartedPayload{Model: "claude-sonnet-5"}})
	feed(event.Event{Type: event.RuntimeError, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.ErrorPayload{Message: "The model refused this request.", Code: "cyber"}})
	feed(event.Event{Type: event.TurnCompleted, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.TurnCompletedPayload{Status: "failed"}})

	waitFor(t, func() bool { return len(activities()) >= 2 })

	var errors int
	for _, ev := range activities() {
		if ev.Type == event.RuntimeError {
			errors++
		}
		if ev.Type == event.RuntimeWarning {
			t.Fatal("backstop fired on a turn that already reported its reason")
		}
	}
	if errors != 1 {
		t.Errorf("got %d runtime.error rows, want exactly 1 — the provider's own reason", errors)
	}
}

// An interrupt the operator pressed themselves legitimately produces nothing.
// Telling them their own Stop button produced no output is noise.
func TestAbortedTurnIsNotReportedAsSilent(t *testing.T) {
	feed, activities, _ := silentTurnRig(t)

	feed(event.Event{Type: event.TurnStarted, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.TurnStartedPayload{Model: "claude-sonnet-5"}})
	feed(event.Event{Type: event.TurnAborted, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.TurnCompletedPayload{Status: "interrupted"}})

	waitFor(t, func() bool { return len(activities()) >= 1 })
	for _, ev := range activities() {
		if ev.Type == event.RuntimeWarning {
			t.Fatal("an operator-initiated abort was reported as a silent turn")
		}
	}
}

// Signals must not leak across turns: a thread that answered one turn and then
// went silent on the NEXT one still has to report the second.
func TestSignalResetsBetweenTurns(t *testing.T) {
	feed, activities, _ := silentTurnRig(t)

	feed(event.Event{Type: event.TurnStarted, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.TurnStartedPayload{Model: "claude-sonnet-5"}})
	feed(event.Event{Type: event.ContentDelta, ThreadID: "w-abc", TurnID: "t1", ItemID: "i1",
		Payload: &event.ContentDeltaPayload{
			ItemType: event.ItemAssistantMessage, Stream: event.StreamText, Text: "ok", Sequence: 1,
		}})
	feed(event.Event{Type: event.TurnCompleted, ThreadID: "w-abc", TurnID: "t1",
		Payload: &event.TurnCompletedPayload{Status: "completed"}})

	feed(event.Event{Type: event.TurnStarted, ThreadID: "w-abc", TurnID: "t2",
		Payload: &event.TurnStartedPayload{Model: "claude-sonnet-5"}})
	feed(event.Event{Type: event.TurnCompleted, ThreadID: "w-abc", TurnID: "t2",
		Payload: &event.TurnCompletedPayload{Status: "completed"}})

	waitFor(t, func() bool { _, ok := hasActivity(activities(), event.RuntimeWarning); return ok })
	got, _ := hasActivity(activities(), event.RuntimeWarning)
	if got.TurnID != "t2" {
		t.Errorf("notice landed on turn %q, want the silent second turn %q", got.TurnID, "t2")
	}
}

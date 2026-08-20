package pi

import (
	"bufio"
	"bytes"
	"os"
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

// parseFixture replays testdata/turn.jsonl — a live-captured pi v0.78.1 RPC
// session (init get_state + one full tool-using turn: think, call bash,
// receive the result, answer in text) — through parseLine.
func parseFixture(t *testing.T, path string) []event.Event {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()

	st := newParseState("w-abc", "pi:default")
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

func TestFixtureCapturesSessionStartedFromInitGetState(t *testing.T) {
	evts := parseFixture(t, "testdata/turn.jsonl")
	for _, e := range evts {
		if e.Type != event.SessionStarted {
			continue
		}
		if e.Refs == nil || e.Refs.SessionID == "" {
			t.Fatal("SessionStarted must carry the native session id in Refs")
		}
		return
	}
	t.Fatal("fixture produced no SessionStarted event")
}

func TestFixtureProducesTextAndThinkingDeltas(t *testing.T) {
	evts := parseFixture(t, "testdata/turn.jsonl")

	var text, reasoning int
	for _, e := range evts {
		if e.Type != event.ContentDelta {
			continue
		}
		p, ok := e.Payload.(*event.ContentDeltaPayload)
		if !ok {
			t.Fatalf("ContentDelta payload is %T", e.Payload)
		}
		switch p.Stream {
		case event.StreamText:
			text++
		case event.StreamReasoning:
			reasoning++
		}
	}
	if text == 0 {
		t.Fatal("no text deltas parsed from a real turn")
	}
	if reasoning == 0 {
		t.Fatal("no thinking deltas parsed from a real turn that used --thinking high")
	}
}

// The fixture's turn calls one bash tool. Both ends of its lifecycle must
// appear, sharing the same ItemID (the native toolCallId) so the client can
// correlate start and completion.
func TestFixtureProducesMatchedToolCallLifecycle(t *testing.T) {
	evts := parseFixture(t, "testdata/turn.jsonl")

	var startedID, completedID string
	var completedStatus string
	for _, e := range evts {
		switch e.Type {
		case event.ItemStarted:
			p := e.Payload.(*event.ItemStartedPayload)
			if p.ItemType == event.ItemToolCall {
				startedID = e.ItemID
			}
		case event.ItemCompleted:
			p := e.Payload.(*event.ItemCompletedPayload)
			if p.ItemType == event.ItemToolCall {
				completedID = e.ItemID
				completedStatus = p.Status
			}
		}
	}
	if startedID == "" {
		t.Fatal("no tool_call ItemStarted parsed from a turn that ran bash")
	}
	if completedID != startedID {
		t.Fatalf("ItemCompleted id %q does not match ItemStarted id %q", completedID, startedID)
	}
	if completedStatus != "completed" {
		t.Fatalf("tool call status = %q, want completed (isError was false)", completedStatus)
	}
}

// The fixture's turn spans two model round-trips (decide to call bash, then
// answer in text) — i.e. two turn_end events — but exactly one TurnCompleted:
// this package's turn boundary is agent_end, not turn_end. See parse.go's
// package comment.
func TestFixtureProducesExactlyOneTurnCompleted(t *testing.T) {
	evts := parseFixture(t, "testdata/turn.jsonl")
	var completed int
	for _, e := range evts {
		if e.Type == event.TurnCompleted {
			completed++
		}
	}
	if completed != 1 {
		t.Fatalf("TurnCompleted count = %d, want exactly 1 (one agent_end per prompt)", completed)
	}
}

func TestFixtureTurnCompletedCarriesSummedUsage(t *testing.T) {
	evts := parseFixture(t, "testdata/turn.jsonl")
	for _, e := range evts {
		if e.Type != event.TurnCompleted {
			continue
		}
		p := e.Payload.(*event.TurnCompletedPayload)
		if p.Status != "completed" {
			t.Fatalf("status = %q, want completed", p.Status)
		}
		if p.Usage == nil || p.Usage.OutputTokens == 0 {
			t.Fatal("expected non-zero summed output tokens across the two assistant messages")
		}
		return
	}
	t.Fatal("no TurnCompleted in fixture")
}

func TestEveryEventCarriesThreadAndInstance(t *testing.T) {
	for _, e := range parseFixture(t, "testdata/turn.jsonl") {
		if e.ThreadID != "w-abc" {
			t.Fatalf("event %s has ThreadID %q, want w-abc", e.Type, e.ThreadID)
		}
		if e.InstanceID != "pi:default" {
			t.Fatalf("event %s has InstanceID %q, want pi:default", e.Type, e.InstanceID)
		}
	}
}

func TestSequenceMonotonicPerItemAndStream(t *testing.T) {
	last := map[string]uint64{}
	for _, e := range parseFixture(t, "testdata/turn.jsonl") {
		p, ok := e.Payload.(*event.ContentDeltaPayload)
		if !ok {
			continue
		}
		key := e.ItemID + "|" + string(p.Stream)
		if p.Sequence != last[key]+1 {
			t.Fatalf("item %s stream %s: sequence %d follows %d, want %d", e.ItemID, p.Stream, p.Sequence, last[key], last[key]+1)
		}
		last[key] = p.Sequence
	}
}

// A malformed line must degrade to a warning, never panic or return an error
// — the whole point of the Raw-carrying fallback path (see parse.go).
func TestMalformedLineBecomesWarningNotPanic(t *testing.T) {
	st := newParseState("w-abc", "pi:default")
	evts := parseLine([]byte(`{not valid json`), st)
	if len(evts) != 1 || evts[0].Type != event.RuntimeWarning {
		t.Fatalf("malformed line should produce exactly one RuntimeWarning, got: %v", evts)
	}
	if evts[0].Raw == nil || len(evts[0].Raw.Payload) == 0 {
		t.Fatal("warning must carry the original bytes in Raw for debugging")
	}
}

func TestUnrecognizedTypeBecomesWarningWithRaw(t *testing.T) {
	st := newParseState("w-abc", "pi:default")
	evts := parseLine([]byte(`{"type":"some_future_event","foo":"bar"}`), st)
	if len(evts) != 1 || evts[0].Type != event.RuntimeWarning {
		t.Fatalf("unrecognized type should produce exactly one RuntimeWarning, got: %v", evts)
	}
}

// A prompt pi rejects outright gets no agent_end — parseResponse must
// complete the turn as failed itself, or the UI hangs on "Working..."
// forever (see the "agent thread must settle" precedent this mirrors).
func TestRejectedPromptCompletesTurnAsFailed(t *testing.T) {
	st := newParseState("w-abc", "pi:default")
	evts := parseLine([]byte(`{"type":"response","command":"prompt","success":false,"error":"agent busy"}`), st)
	if len(evts) != 1 || evts[0].Type != event.TurnCompleted {
		t.Fatalf("rejected prompt should produce exactly one TurnCompleted, got: %v", evts)
	}
	p := evts[0].Payload.(*event.TurnCompletedPayload)
	if p.Status != "failed" {
		t.Fatalf("status = %q, want failed", p.Status)
	}
}

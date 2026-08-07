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

// The fixture's session/init message must produce a SessionStarted event
// carrying the native session id in Refs, never as orchestration identity.
func TestFixtureProducesSessionStarted(t *testing.T) {
	var found bool
	for _, e := range parseFixture(t, "testdata/turn.ndjson") {
		if e.Type != event.SessionStarted {
			continue
		}
		found = true
		if e.Refs == nil || e.Refs.SessionID == "" {
			t.Fatalf("session started event missing native session id in Refs: %+v", e.Refs)
		}
	}
	if !found {
		t.Fatal("fixture's system/init message did not produce a SessionStarted event")
	}
}

// The fixture's result message must produce a TurnCompleted event with usage
// filled from the token counts.
func TestFixtureProducesTurnCompletedWithUsage(t *testing.T) {
	var found bool
	for _, e := range parseFixture(t, "testdata/turn.ndjson") {
		if e.Type != event.TurnCompleted {
			continue
		}
		found = true
		p, ok := e.Payload.(*event.TurnCompletedPayload)
		if !ok {
			t.Fatalf("TurnCompleted payload is %T", e.Payload)
		}
		if p.Status != "completed" {
			t.Fatalf("status = %q, want completed", p.Status)
		}
		if p.Usage == nil || p.Usage.OutputTokens == 0 {
			t.Fatalf("usage not filled: %+v", p.Usage)
		}
	}
	if !found {
		t.Fatal("fixture's result message did not produce a TurnCompleted event")
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

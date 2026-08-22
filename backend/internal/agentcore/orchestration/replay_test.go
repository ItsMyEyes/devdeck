package orchestration

import (
	"encoding/json"
	"testing"

	"devdeck/backend/internal/agentcore/event"
)

// delta builds one streamed token event, the shape Ingestion durably logs
// thousands of times per turn.
func delta(seq uint64, createdAt int64, turnID, itemID, stream, text string, sequence uint64) Event {
	raw, err := json.Marshal(AssistantDeltaPayload{
		TurnID:   turnID,
		ItemID:   itemID,
		Stream:   event.StreamKind(stream),
		Text:     text,
		Sequence: sequence,
	})
	if err != nil {
		panic(err)
	}
	return Event{
		Seq:       seq,
		EventID:   "ae-" + itemID + "-" + text,
		Type:      EvtThreadActivityAppended,
		ThreadID:  "w-abc",
		CreatedAt: createdAt,
		Payload:   raw,
	}
}

// decodeCoalesced reads back what CoalesceReplay produced, including the two
// merge-only fields.
func decodeCoalesced(t *testing.T, ev Event) CoalescedDeltaPayload {
	t.Helper()
	var p CoalescedDeltaPayload
	if err := json.Unmarshal(ev.Payload, &p); err != nil {
		t.Fatalf("decode coalesced payload: %v", err)
	}
	return p
}

func TestCoalesceReplayMergesConsecutiveDeltasOfOneItem(t *testing.T) {
	in := []Event{
		delta(10, 1000, "t1", "1#0", "text", "Hello", 1),
		delta(11, 1100, "t1", "1#0", "text", " ", 2),
		delta(12, 1200, "t1", "1#0", "text", "world", 3),
	}

	out := CoalesceReplay(in)

	if len(out) != 1 {
		t.Fatalf("got %d events, want 1 merged event", len(out))
	}
	p := decodeCoalesced(t, out[0])
	if p.Text != "Hello world" {
		t.Errorf("merged text = %q, want %q", p.Text, "Hello world")
	}
	// Seq must be the run's LAST, or the client's sinceSeq cursor lands mid-run
	// and the tail is replayed and concatenated a second time on reconnect.
	if out[0].Seq != 12 {
		t.Errorf("merged Seq = %d, want 12 (the run's last)", out[0].Seq)
	}
	if p.Sequence != 3 {
		t.Errorf("merged sequence = %d, want 3 (the run's last)", p.Sequence)
	}
	if p.FirstSequence != 1 {
		t.Errorf("firstSequence = %d, want 1 (the run's first, for the gap check)", p.FirstSequence)
	}
	// CreatedAt is the run's end; StartedAt carries its beginning, which is
	// what keeps a replayed turn's duration from collapsing to zero.
	if out[0].CreatedAt != 1200 {
		t.Errorf("merged CreatedAt = %d, want 1200 (the run's last)", out[0].CreatedAt)
	}
	if p.StartedAt != 1000 {
		t.Errorf("startedAt = %d, want 1000 (the run's first)", p.StartedAt)
	}
	if p.ItemID != "1#0" || string(p.Stream) != "text" || p.TurnID != "t1" {
		t.Errorf("merged identity = %+v, want itemId 1#0 / stream text / turn t1", p)
	}
}

func TestCoalesceReplayKeepsRunsSeparateAcrossItemsAndStreams(t *testing.T) {
	in := []Event{
		delta(1, 100, "t1", "1#0", "reasoning", "think", 1),
		delta(2, 200, "t1", "1#0", "reasoning", "ing", 2),
		// Different stream on the same item id must not fold into the above.
		delta(3, 300, "t1", "1#0", "text", "answer", 1),
		// Different item.
		delta(4, 400, "t1", "2#0", "text", "more", 1),
		delta(5, 500, "t1", "2#0", "text", " text", 2),
	}

	out := CoalesceReplay(in)

	if len(out) != 3 {
		t.Fatalf("got %d events, want 3 runs", len(out))
	}
	if got := decodeCoalesced(t, out[0]).Text; got != "thinking" {
		t.Errorf("run 0 text = %q, want %q", got, "thinking")
	}
	if got := decodeCoalesced(t, out[1]).Text; got != "answer" {
		t.Errorf("run 1 text = %q, want %q", got, "answer")
	}
	if got := decodeCoalesced(t, out[2]).Text; got != "more text" {
		t.Errorf("run 2 text = %q, want %q", got, "more text")
	}
}

func TestCoalesceReplayPreservesOrderAroundNonDeltaEvents(t *testing.T) {
	toolCall := Event{
		Seq: 3, EventID: "ae-tool", Type: EvtThreadActivityAppended, ThreadID: "w-abc", CreatedAt: 300,
		// A forwarded provider event: same event type, entirely different
		// shape. It has no itemId/stream/text/sequence, so it must never be
		// swallowed into a text run.
		Payload: json.RawMessage(`{"type":"item.started","itemType":"tool_call","itemId":"tool-1"}`),
	}
	in := []Event{
		delta(1, 100, "t1", "1#0", "text", "before", 1),
		delta(2, 200, "t1", "1#0", "text", " tool", 2),
		toolCall,
		// The SAME item resumes after the tool call. Merging this back into
		// the run above would move text written after the tool call to before
		// it — 36 of 902 items in the field thread do exactly this.
		delta(4, 400, "t1", "1#0", "text", " after", 3),
		delta(5, 500, "t1", "1#0", "text", " tool", 4),
	}

	out := CoalesceReplay(in)

	if len(out) != 3 {
		t.Fatalf("got %d events, want 3 (run, tool call, run)", len(out))
	}
	if got := decodeCoalesced(t, out[0]).Text; got != "before tool" {
		t.Errorf("first run = %q, want %q", got, "before tool")
	}
	if out[1].EventID != "ae-tool" {
		t.Errorf("middle event = %q, want the tool call passed through verbatim", out[1].EventID)
	}
	if string(out[1].Payload) != string(toolCall.Payload) {
		t.Errorf("tool call payload was rewritten: %s", out[1].Payload)
	}
	second := decodeCoalesced(t, out[2])
	if second.Text != " after tool" {
		t.Errorf("second run = %q, want %q", second.Text, " after tool")
	}
	// The resumed run is contiguous with the first (2 -> 3), so the client's
	// gap check must see firstSequence 3 against lastSequence 2 and stay quiet.
	if second.FirstSequence != 3 {
		t.Errorf("resumed run firstSequence = %d, want 3", second.FirstSequence)
	}
}

func TestCoalesceReplayBreaksRunAtSequenceGap(t *testing.T) {
	in := []Event{
		delta(1, 100, "t1", "1#0", "text", "a", 1),
		delta(2, 200, "t1", "1#0", "text", "b", 2),
		// 2 -> 7 is a real hole in the log. Merging across it would hide the
		// gap the client raises "Some updates may be missing" for.
		delta(3, 300, "t1", "1#0", "text", "c", 7),
		delta(4, 400, "t1", "1#0", "text", "d", 8),
	}

	out := CoalesceReplay(in)

	if len(out) != 2 {
		t.Fatalf("got %d events, want 2 runs split at the sequence gap", len(out))
	}
	if got := decodeCoalesced(t, out[0]); got.Text != "ab" || got.Sequence != 2 {
		t.Errorf("first run = %q seq %d, want \"ab\" seq 2", got.Text, got.Sequence)
	}
	after := decodeCoalesced(t, out[1])
	if after.Text != "cd" {
		t.Errorf("second run = %q, want %q", after.Text, "cd")
	}
	if after.FirstSequence != 7 {
		t.Errorf("firstSequence = %d, want 7 so the client still sees the hole", after.FirstSequence)
	}
}

func TestCoalesceReplayLeavesNonDeltaAndShortRunsByteIdentical(t *testing.T) {
	created := Event{Seq: 1, EventID: "ae-1", Type: EvtThreadCreated, ThreadID: "w-abc", Payload: json.RawMessage(`{"instanceId":"claude:default"}`)}
	sent := Event{Seq: 2, EventID: "ae-2", Type: EvtThreadMessageSent, ThreadID: "w-abc", Payload: json.RawMessage(`{"text":"hi"}`)}
	lone := delta(3, 300, "t1", "1#0", "text", "x", 1)
	session := Event{Seq: 4, EventID: "ae-4", Type: EvtThreadSessionSet, ThreadID: "w-abc", Payload: json.RawMessage(`{"status":"idle"}`)}

	in := []Event{created, sent, lone, session}
	out := CoalesceReplay(in)

	if len(out) != 4 {
		t.Fatalf("got %d events, want 4 unchanged", len(out))
	}
	for i := range in {
		if out[i].Seq != in[i].Seq || out[i].EventID != in[i].EventID {
			t.Fatalf("event %d changed identity: %+v", i, out[i])
		}
		if string(out[i].Payload) != string(in[i].Payload) {
			t.Errorf("event %d payload rewritten:\n got %s\nwant %s", i, out[i].Payload, in[i].Payload)
		}
	}
}

func TestCoalesceReplayHandlesEmptyAndSingle(t *testing.T) {
	if got := CoalesceReplay(nil); len(got) != 0 {
		t.Errorf("nil input produced %d events", len(got))
	}
	one := []Event{delta(1, 100, "t1", "1#0", "text", "solo", 1)}
	got := CoalesceReplay(one)
	if len(got) != 1 || string(got[0].Payload) != string(one[0].Payload) {
		t.Errorf("single event was not passed through verbatim: %+v", got)
	}
}

// The whole point of the change, stated as a number: the replay a real thread
// produces must shrink by orders of magnitude without losing a character.
func TestCoalesceReplayCollapsesATokenStream(t *testing.T) {
	const tokens = 5000
	in := make([]Event, 0, tokens)
	want := ""
	for i := 0; i < tokens; i++ {
		text := string(rune('a' + i%26))
		want += text
		in = append(in, delta(uint64(i+1), int64(1000+i), "t1", "1#0", "text", text, uint64(i+1)))
	}

	out := CoalesceReplay(in)

	if len(out) != 1 {
		t.Fatalf("got %d events, want 1", len(out))
	}
	if got := decodeCoalesced(t, out[0]).Text; got != want {
		t.Errorf("merged text lost content: got %d chars, want %d", len(got), len(want))
	}

	before, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	after, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(after)*10 > len(before) {
		t.Errorf("replay only shrank from %d to %d bytes; expected at least a 10x reduction", len(before), len(after))
	}
	t.Logf("replay bytes: %d -> %d (%.1fx smaller)", len(before), len(after), float64(len(before))/float64(len(after)))
}

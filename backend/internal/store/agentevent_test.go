package store

import (
	"encoding/json"
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
	st := NewTestStore(t)

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
	st := NewTestStore(t)

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
	st := NewTestStore(t)

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
	st := NewTestStore(t)

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
	st := NewTestStore(t)
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

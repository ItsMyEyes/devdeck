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

// evtCreated builds an EvtThreadCreated event carrying a real create payload
// (instanceId), unlike the placeholder {"k":"v"} the other tests use — the
// agent_thread projection reads this field.
func evtCreated(id, threadID, cmdID string, createdAt int64, instanceID string) orchestration.Event {
	payload, _ := json.Marshal(map[string]string{"instanceId": instanceID})
	return orchestration.Event{
		EventID:   id,
		Type:      orchestration.EvtThreadCreated,
		ThreadID:  threadID,
		CommandID: cmdID,
		CreatedAt: createdAt,
		Payload:   payload,
	}
}

// Committing an EvtThreadCreated event must project a row into agent_thread,
// in the same transaction as the event append — this is the write side
// session history reads from, so a thread can be listed without replaying
// its whole event log.
func TestCommitAgentEventsWritesAgentThreadRow(t *testing.T) {
	st := NewTestStore(t)

	if _, err := st.CommitAgentEvents("ac-1", []orchestration.Event{
		evtCreated("ae-1", "w-abc", "ac-1", 1000, "claude:default"),
	}); err != nil {
		t.Fatalf("commit: %v", err)
	}

	threads, err := st.AgentThreads("w-abc")
	if err != nil {
		t.Fatalf("agent threads: %v", err)
	}
	if len(threads) != 1 {
		t.Fatalf("got %d agent_thread rows, want exactly 1", len(threads))
	}
	th := threads[0]
	if th.ID != "w-abc" || th.WorktreeID != "w-abc" || th.InstanceID != "claude:default" {
		t.Fatalf("thread row = %+v, want id/worktreeId w-abc, instanceId claude:default", th)
	}
	if th.CreatedAt != 1000 || th.UpdatedAt != 1000 {
		t.Fatalf("thread row = %+v, want created/updated at 1000", th)
	}
}

// The atomicity guarantee extends to the agent_thread projection: a batch
// that fails partway must leave no row behind, exactly like agent_event.
func TestCommitAgentEventsRollbackLeavesNoThreadRow(t *testing.T) {
	st := NewTestStore(t)

	if _, err := st.CommitAgentEvents("ac-1", []orchestration.Event{
		evt("ae-1", "w-other", "ac-1", orchestration.EvtThreadMessageSent),
	}); err != nil {
		t.Fatalf("seed commit: %v", err)
	}

	// ae-1 collides with the seeded event above, so this whole batch —
	// including its EvtThreadCreated for w-new — must roll back together.
	_, err := st.CommitAgentEvents("ac-2", []orchestration.Event{
		evtCreated("ae-2", "w-new", "ac-2", 2000, "claude:default"),
		evt("ae-1", "w-other", "ac-2", orchestration.EvtThreadMessageSent),
	})
	if err == nil {
		t.Fatal("duplicate event id must fail the commit")
	}

	threads, err := st.AgentThreads("w-new")
	if err != nil {
		t.Fatalf("agent threads: %v", err)
	}
	if len(threads) != 0 {
		t.Fatalf("got %d agent_thread rows after a rolled-back commit, want 0", len(threads))
	}
}

// AgentThreads filters by worktree (a "<worktreeId>::chat-N" thread still
// belongs to its worktree), orders by updated_at descending, and includes a
// thread that has no events beyond its own creation.
func TestAgentThreadsFiltersOrdersAndIncludesEventlessThreads(t *testing.T) {
	st := NewTestStore(t)

	mustCreate := func(cmdID, threadID string, createdAt int64) {
		t.Helper()
		if _, err := st.CommitAgentEvents(cmdID, []orchestration.Event{
			evtCreated("ae-"+cmdID, threadID, cmdID, createdAt, "claude:default"),
		}); err != nil {
			t.Fatalf("create %s: %v", threadID, err)
		}
	}

	mustCreate("ac-1", "w-abc", 1000)
	mustCreate("ac-2", "w-abc::chat-2", 2000)
	mustCreate("ac-3", "w-other", 1500)

	threads, err := st.AgentThreads("w-abc")
	if err != nil {
		t.Fatalf("agent threads: %v", err)
	}
	if len(threads) != 2 {
		t.Fatalf("got %d threads for w-abc, want 2 (w-other must be excluded)", len(threads))
	}
	// Newest-touched first; w-abc itself has had no event since its own
	// creation and must still appear.
	if threads[0].ID != "w-abc::chat-2" || threads[1].ID != "w-abc" {
		t.Fatalf("threads = %+v, want [w-abc::chat-2, w-abc] ordered by updated_at DESC", threads)
	}

	// A later commit on the older thread must bump it back to the front.
	// CreatedAt (3000) is after both threads' creation, unlike evt()'s fixed
	// 1000, or the bump wouldn't actually move w-abc ahead of w-abc::chat-2.
	if _, err := st.CommitAgentEvents("ac-4", []orchestration.Event{
		{
			EventID: "ae-4", Type: orchestration.EvtThreadMessageSent, ThreadID: "w-abc",
			CommandID: "ac-4", CreatedAt: 3000, Payload: json.RawMessage(`{"k":"v"}`),
		},
	}); err != nil {
		t.Fatalf("touch: %v", err)
	}
	threads, err = st.AgentThreads("w-abc")
	if err != nil {
		t.Fatalf("agent threads after touch: %v", err)
	}
	if threads[0].ID != "w-abc" {
		t.Fatalf("threads = %+v, want w-abc first after a later commit touched it", threads)
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

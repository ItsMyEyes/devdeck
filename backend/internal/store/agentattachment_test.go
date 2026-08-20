package store

import (
	"testing"

	"devdeck/backend/internal/agentcore/orchestration"
)

func TestCreateAgentAttachment_RoundTrip(t *testing.T) {
	st := NewTestStore(t)

	data := []byte("fake-png-bytes")
	created, err := st.CreateAgentAttachment("w-abc", "screenshot.png", "image/png", data, "2026-08-15T00:00:00Z")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.ID == "" {
		t.Fatal("expected a non-empty id")
	}
	if created.ThreadID != "w-abc" || created.Name != "screenshot.png" || created.MimeType != "image/png" {
		t.Fatalf("created = %+v", created)
	}
	if created.SizeBytes != int64(len(data)) {
		t.Fatalf("sizeBytes = %d, want %d", created.SizeBytes, len(data))
	}
	if created.CreatedAt != "2026-08-15T00:00:00Z" {
		t.Fatalf("createdAt = %q", created.CreatedAt)
	}

	gotMeta, gotData, err := st.AgentAttachmentData(created.ID)
	if err != nil {
		t.Fatalf("data: %v", err)
	}
	if gotMeta != created {
		t.Fatalf("metadata mismatch: got %+v, want %+v", gotMeta, created)
	}
	if string(gotData) != string(data) {
		t.Fatalf("data mismatch: got %q, want %q", gotData, data)
	}
}

func TestAgentAttachmentData_UnknownID(t *testing.T) {
	st := NewTestStore(t)

	if _, _, err := st.AgentAttachmentData("aatt-doesnotexist"); err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// DeleteAgentThread already deletes three tables in one transaction; the
// fourth — agent_attachment — must go with them, or an erased thread leaves
// its images behind forever with no id anyone can reach them by.
func TestDeleteAgentThread_CascadesAttachments(t *testing.T) {
	st := NewTestStore(t)

	if _, err := st.CommitAgentEvents("ac-1", []orchestration.Event{
		evtCreated("ae-1", "w-abc", "ac-1", 1000, "claude:default"),
	}); err != nil {
		t.Fatalf("commit: %v", err)
	}
	created, err := st.CreateAgentAttachment("w-abc", "shot.png", "image/png", []byte("data"), "2026-08-15T00:00:00Z")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if err := st.DeleteAgentThread("w-abc"); err != nil {
		t.Fatalf("delete thread: %v", err)
	}

	if _, _, err := st.AgentAttachmentData(created.ID); err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound after the owning thread was deleted", err)
	}
}

// The startup sweep: an attachment whose thread_id names no agent_thread row
// is orphaned (its upload raced or outlived the thread) and must be swept;
// one whose thread still exists must survive untouched.
func TestDeleteOrphanAgentAttachments(t *testing.T) {
	st := NewTestStore(t)

	if _, err := st.CommitAgentEvents("ac-1", []orchestration.Event{
		evtCreated("ae-1", "w-live", "ac-1", 1000, "claude:default"),
	}); err != nil {
		t.Fatalf("commit: %v", err)
	}
	live, err := st.CreateAgentAttachment("w-live", "a.png", "image/png", []byte("a"), "2026-08-15T00:00:00Z")
	if err != nil {
		t.Fatalf("create live: %v", err)
	}
	orphan, err := st.CreateAgentAttachment("w-orphan", "b.png", "image/png", []byte("b"), "2026-08-15T00:00:00Z")
	if err != nil {
		t.Fatalf("create orphan: %v", err)
	}

	n, err := st.DeleteOrphanAgentAttachments()
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if n != 1 {
		t.Fatalf("swept %d rows, want 1", n)
	}

	if _, _, err := st.AgentAttachmentData(orphan.ID); err != ErrNotFound {
		t.Fatalf("orphan survived the sweep: err = %v", err)
	}
	if _, _, err := st.AgentAttachmentData(live.ID); err != nil {
		t.Fatalf("live attachment swept away: %v", err)
	}
}

// The load-bearing difference from issue_attachments' issueByID guard: C2
// uploads on add, which can race ahead of the thread's own EvtThreadCreated
// commit. CreateAgentAttachment must not reject a thread_id it has never
// heard of.
func TestCreateAgentAttachment_NoThreadRequired(t *testing.T) {
	st := NewTestStore(t)

	if _, err := st.CreateAgentAttachment("w-future", "a.png", "image/png", []byte("a"), "2026-08-15T00:00:00Z"); err != nil {
		t.Fatalf("create against unknown thread: %v", err)
	}
}

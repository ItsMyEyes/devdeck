package store

import (
	"testing"

	"loom/backend/internal/port"
)

func TestCreateIssueCommentTopLevelAndReply(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	proj, _ := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core")
	iss, _ := s.CreateIssue(proj.ID, "Fix login bug", "", "2026-07-02T10:00:00Z")

	root, err := s.CreateIssueComment(iss.ID, nil, "You", "Looking into this now.", "2026-07-02T10:05:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if root.ParentID != nil {
		t.Errorf("top-level comment ParentID = %v, want nil", root.ParentID)
	}

	reply, err := s.CreateIssueComment(iss.ID, &root.ID, "You", "Found the culprit.", "2026-07-02T10:10:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if reply.ParentID == nil || *reply.ParentID != root.ID {
		t.Errorf("reply ParentID = %v, want %q", reply.ParentID, root.ID)
	}

	comments, err := s.ListIssueComments(iss.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(comments) != 2 {
		t.Fatalf("ListIssueComments = %d entries, want 2", len(comments))
	}
	if comments[0].ID != root.ID || comments[1].ID != reply.ID {
		t.Errorf("ListIssueComments order = %+v, want [root, reply] oldest first", comments)
	}
}

func TestCreateIssueCommentRejectsUnknownParent(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	proj, _ := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core")
	iss, _ := s.CreateIssue(proj.ID, "Fix login bug", "", "2026-07-02T10:00:00Z")

	bogus := "cm-doesnotexist"
	if _, err := s.CreateIssueComment(iss.ID, &bogus, "You", "orphan reply", "2026-07-02T10:05:00Z"); err != ErrNotFound {
		t.Errorf("CreateIssueComment with unknown parentId = %v, want ErrNotFound", err)
	}
}

func TestUpdateAndDeleteIssueComment(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	proj, _ := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core")
	iss, _ := s.CreateIssue(proj.ID, "Fix login bug", "", "2026-07-02T10:00:00Z")
	c, _ := s.CreateIssueComment(iss.ID, nil, "You", "first draft", "2026-07-02T10:05:00Z")

	updated, err := s.UpdateIssueComment(c.ID, "2026-07-02T10:06:00Z", "edited body")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Body != "edited body" {
		t.Errorf("UpdateIssueComment Body = %q, want %q", updated.Body, "edited body")
	}
	if updated.UpdatedAt != "2026-07-02T10:06:00Z" {
		t.Errorf("UpdateIssueComment UpdatedAt = %q, want %q", updated.UpdatedAt, "2026-07-02T10:06:00Z")
	}

	if err := s.DeleteIssueComment(c.ID); err != nil {
		t.Fatal(err)
	}
	comments, err := s.ListIssueComments(iss.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(comments) != 0 {
		t.Errorf("ListIssueComments after delete = %+v, want empty", comments)
	}
}

func TestDeleteRootCommentCascadesToReplies(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	proj, _ := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core")
	iss, _ := s.CreateIssue(proj.ID, "Fix login bug", "", "2026-07-02T10:00:00Z")
	root, _ := s.CreateIssueComment(iss.ID, nil, "You", "root", "2026-07-02T10:05:00Z")
	if _, err := s.CreateIssueComment(iss.ID, &root.ID, "You", "reply", "2026-07-02T10:06:00Z"); err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteIssueComment(root.ID); err != nil {
		t.Fatal(err)
	}
	comments, err := s.ListIssueComments(iss.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(comments) != 0 {
		t.Errorf("ListIssueComments after deleting root = %+v, want empty (reply cascaded)", comments)
	}
}

func TestUpdateIssueRecordsTimelineEvents(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	proj, _ := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core")
	iss, _ := s.CreateIssue(proj.ID, "Fix login bug", "", "2026-07-02T10:00:00Z")

	events, err := s.ListIssueEvents(iss.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("ListIssueEvents for a fresh issue = %+v, want empty", events)
	}

	newStatus := "in_progress"
	newPriority := "high"
	assignee := "kiyora"
	if _, err := s.UpdateIssue(iss.ID, "2026-07-02T11:00:00Z", port.IssuePatch{
		Status:      &newStatus,
		Priority:    &newPriority,
		Assignee:    &assignee,
		HasAssignee: true,
	}); err != nil {
		t.Fatal(err)
	}

	events, err = s.ListIssueEvents(iss.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 {
		t.Fatalf("ListIssueEvents after status+priority+assignee change = %d entries, want 3: %+v", len(events), events)
	}
	byKind := map[string]bool{}
	for _, e := range events {
		byKind[e.Kind] = true
	}
	for _, want := range []string{"status_changed", "priority_changed", "assignee_changed"} {
		if !byKind[want] {
			t.Errorf("missing event kind %q in %+v", want, events)
		}
	}

	// A patch with no actual value change must not add a duplicate event.
	if _, err := s.UpdateIssue(iss.ID, "2026-07-02T12:00:00Z", port.IssuePatch{Status: &newStatus}); err != nil {
		t.Fatal(err)
	}
	events, err = s.ListIssueEvents(iss.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 {
		t.Errorf("ListIssueEvents after a no-op status patch = %d entries, want still 3", len(events))
	}
}

package store

import (
	"testing"

	"devdeck/backend/internal/port"
)

func TestCreateIssueDefaultsStatusAndPosition(t *testing.T) {
	s := newTestStore(t)
	ws, err := s.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	proj, err := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}

	iss, err := s.CreateIssue(proj.ID, "Fix login bug", "", "2026-07-02T10:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if iss.Status != "todo" {
		t.Errorf("CreateIssue with blank status = %q, want default %q", iss.Status, "todo")
	}
	if iss.Priority != "normal" {
		t.Errorf("CreateIssue priority = %q, want default %q", iss.Priority, "normal")
	}
	if iss.Position != 0 {
		t.Errorf("first issue in an empty column: Position = %v, want 0", iss.Position)
	}
	if iss.Assignee != nil {
		t.Errorf("CreateIssue Assignee = %v, want nil", iss.Assignee)
	}

	iss2, err := s.CreateIssue(proj.ID, "Second issue", "", "2026-07-02T10:05:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if iss2.Position != 1 {
		t.Errorf("second issue in the same column: Position = %v, want 1", iss2.Position)
	}

	proj, err = s.ProjectByID(proj.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(proj.Issues) != 2 {
		t.Errorf("ProjectByID().Issues = %+v, want 2 entries", proj.Issues)
	}
}

func TestUpdateIssueMovesColumnAndPosition(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	proj, _ := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core", "")
	iss, err := s.CreateIssue(proj.ID, "Fix login bug", "", "2026-07-02T10:00:00Z")
	if err != nil {
		t.Fatal(err)
	}

	newStatus := "in_progress"
	newPos := 2.5
	updated, err := s.UpdateIssue(iss.ID, "2026-07-02T11:00:00Z", port.IssuePatch{
		Status:   &newStatus,
		Position: &newPos,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != "in_progress" {
		t.Errorf("UpdateIssue Status = %q, want %q", updated.Status, "in_progress")
	}
	if updated.Position != 2.5 {
		t.Errorf("UpdateIssue Position = %v, want 2.5", updated.Position)
	}
	if updated.Title != "Fix login bug" {
		t.Errorf("UpdateIssue changed Title to %q, want it unchanged", updated.Title)
	}
	if updated.UpdatedAt != "2026-07-02T11:00:00Z" {
		t.Errorf("UpdateIssue UpdatedAt = %q, want %q", updated.UpdatedAt, "2026-07-02T11:00:00Z")
	}
}

func TestUpdateIssueAssigneeNullableClear(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	proj, _ := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core", "")
	iss, _ := s.CreateIssue(proj.ID, "Fix login bug", "", "2026-07-02T10:00:00Z")

	name := "kiyora"
	updated, err := s.UpdateIssue(iss.ID, "2026-07-02T11:00:00Z", port.IssuePatch{
		Assignee:    &name,
		HasAssignee: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Assignee == nil || *updated.Assignee != "kiyora" {
		t.Errorf("UpdateIssue Assignee = %v, want %q", updated.Assignee, "kiyora")
	}

	cleared, err := s.UpdateIssue(iss.ID, "2026-07-02T12:00:00Z", port.IssuePatch{
		Assignee:    nil,
		HasAssignee: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Assignee != nil {
		t.Errorf("UpdateIssue with HasAssignee+nil Assignee = %v, want nil (explicit clear)", cleared.Assignee)
	}
}

func TestDeleteIssueRemovesIt(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	proj, _ := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core", "")
	iss, _ := s.CreateIssue(proj.ID, "Fix login bug", "", "2026-07-02T10:00:00Z")

	if err := s.DeleteIssue(iss.ID); err != nil {
		t.Fatal(err)
	}
	proj, err := s.ProjectByID(proj.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(proj.Issues) != 0 {
		t.Errorf("Project.Issues after delete = %+v, want empty", proj.Issues)
	}
	if err := s.DeleteIssue(iss.ID); err != ErrNotFound {
		t.Errorf("DeleteIssue on already-deleted id = %v, want ErrNotFound", err)
	}
}

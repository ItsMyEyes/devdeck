package store

import (
	"path/filepath"
	"strings"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return New(db)
}

func TestCreateWorktreeLeavesEmptyTaskEmpty(t *testing.T) {
	s := newTestStore(t)
	ws, err := s.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	proj, err := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}

	wt, err := s.CreateWorktree(proj.ID, "root", "", "", "claude-sonnet-5", "claude", "", proj.Path)
	if err != nil {
		t.Fatal(err)
	}
	if wt.Task != "" {
		t.Errorf("CreateWorktree with blank task = %q, want empty string (placeholder task must not be persisted as a real launch prompt)", wt.Task)
	}
}

func TestCreateWorktreeRootModeSeedsShellNotAgentLines(t *testing.T) {
	s := newTestStore(t)
	ws, err := s.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	proj, err := s.CreateProject(ws.ID, "core", "/tmp/core", "acme/core", "")
	if err != nil {
		t.Fatal(err)
	}

	wt, err := s.CreateWorktree(proj.ID, "root", "", "", "", "", "", proj.Path)
	if err != nil {
		t.Fatal(err)
	}

	for _, l := range wt.Lines {
		if strings.Contains(l.T, "agent") {
			t.Errorf("root-mode seeded line mentions an agent, want plain-shell copy: %q", l.T)
		}
		if strings.Contains(l.T, "task context") {
			t.Errorf("root-mode seeded line mentions task context, which doesn't apply to a plain shell: %q", l.T)
		}
	}
	if len(wt.Lines) != 3 {
		t.Errorf("root-mode Lines = %d entries, want 3: %+v", len(wt.Lines), wt.Lines)
	}
}

func TestWorktreeInsertWithUnknownProjectIDSucceeds(t *testing.T) {
	s := newTestStore(t)
	// No workspace/project created at all — this project_id matches nothing
	// locally, simulating a runtime that has never heard of this project.
	w, err := s.CreateWorktree("p-doesnotexist", "root", "", "main", "", "", "", "/tmp/some/repo")
	if err != nil {
		t.Fatalf("CreateWorktree with unknown project_id should succeed (no local FK): %v", err)
	}
	if w.Path != "/tmp/some/repo" {
		t.Errorf("Path = %q, want /tmp/some/repo", w.Path)
	}
}

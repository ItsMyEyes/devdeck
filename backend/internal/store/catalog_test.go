package store

import (
	"testing"
	"time"

	"devdeck/backend/internal/domain"
)

func TestApplyCatalogSnapshotPreservesLocalProjectsAndWorktrees(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")
	hubProj, _ := s.CreateProject(ws.ID, "from-hub", "/srv/hub", "", "m-1")
	localProj, _ := s.CreateProject(ws.ID, "made-offline", "/srv/local", "", "m-1")
	if err := s.MarkProjectLocal(localProj.ID); err != nil {
		t.Fatal(err)
	}
	wt, err := s.CreateWorktree(hubProj.ID, "branch", "feature", "main", "", "", "", "/srv/hub/wt")
	if err != nil {
		t.Fatal(err)
	}

	// A snapshot that contains neither project: the hub row must vanish, the
	// local row must survive, and the worktree must be untouched.
	snap := domain.CatalogSnapshot{
		Workspaces: []domain.Workspace{{ID: ws.ID, Name: "clients"}},
	}
	if err := s.ApplyCatalogSnapshot(snap, time.Unix(1_700_000_000, 0)); err != nil {
		t.Fatal(err)
	}

	projects, err := s.ProjectsByMachine("m-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 1 || projects[0].ID != localProj.ID {
		t.Fatalf("projects = %+v, want only the local one (%s)", projects, localProj.ID)
	}
	if _, err := s.WorktreeByID(wt.ID); err != nil {
		t.Errorf("worktree was destroyed by a snapshot: %v", err)
	}
}

func TestApplyCatalogSnapshotRollsBackOnFailure(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")

	// A project whose workspace_id does not exist violates the FK, failing
	// mid-apply after workspaces have already been written.
	bad := domain.CatalogSnapshot{
		Workspaces: []domain.Workspace{{ID: "ws-new", Name: "renamed"}},
		Projects:   []domain.Project{{ID: "p-x", WorkspaceID: "ws-missing", Name: "orphan"}},
	}
	if err := s.ApplyCatalogSnapshot(bad, time.Unix(1_700_000_000, 0)); err == nil {
		t.Fatal("ApplyCatalogSnapshot succeeded on an FK violation, want error")
	}

	// The original workspace must still be there, unrenamed.
	got, err := s.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != ws.ID || got[0].Name != "clients" {
		t.Errorf("workspaces = %+v, want the pre-apply state intact", got)
	}
	if at, _ := s.LastSyncedAt(); at != nil {
		t.Errorf("LastSyncedAt = %v, want nil after a failed apply", at)
	}
}

func TestLastSyncedAtIsNilBeforeFirstSync(t *testing.T) {
	s := newTestStore(t)
	at, err := s.LastSyncedAt()
	if err != nil {
		t.Fatal(err)
	}
	if at != nil {
		t.Errorf("LastSyncedAt = %v, want nil", at)
	}
}

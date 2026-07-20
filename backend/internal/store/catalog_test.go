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

func TestCatalogForMachineNeverLeaksBusinessData(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")
	otherMachineProj, _ := s.CreateProject(ws.ID, "not-mine", "/srv/other", "", "m-other")
	mineProj, _ := s.CreateProject(ws.ID, "mine", "/srv/mine", "", "m-1")
	if _, err := s.CreateNews(ws.ID, "manual", "Q3 renewal at risk", "", "2026-07-01", true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateTodo(ws.ID, "chase invoice #114", "high"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateInvoice(ws.ID, "INV-1", "Acme Co", "1 Main St", nil, "2026-08-01", "2026-07-01", "draft", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateRecurringTemplate(ws.ID, "Acme Co", "1 Main St", nil, "", "", "", 1, 30, "2026-07-01"); err != nil {
		t.Fatal(err)
	}

	snap, err := s.CatalogForMachine("m-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Workspaces) != 1 {
		t.Fatalf("workspaces = %+v, want exactly one", snap.Workspaces)
	}
	w := snap.Workspaces[0]
	if len(w.News) != 0 || len(w.Todos) != 0 || len(w.Invoices) != 0 || len(w.RecurringTemplates) != 0 {
		t.Fatalf("workspace shell leaked business data: news=%d todos=%d invoices=%d recurring=%d",
			len(w.News), len(w.Todos), len(w.Invoices), len(w.RecurringTemplates))
	}
	if len(w.Projects) != 0 {
		t.Errorf("workspace shell carries nested projects = %+v, want none (projects ship flattened in snap.Projects)", w.Projects)
	}
	if len(snap.Projects) != 1 || snap.Projects[0].ID != mineProj.ID {
		t.Fatalf("snap.Projects = %+v, want only %s", snap.Projects, mineProj.ID)
	}
	for _, p := range snap.Projects {
		if p.ID == otherMachineProj.ID {
			t.Errorf("another machine's project (%s) leaked into this machine's catalog", otherMachineProj.ID)
		}
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

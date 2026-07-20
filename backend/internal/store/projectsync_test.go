package store

import "testing"

func TestMarkProjectSyncedClearsLocalOriginAndSyncError(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")
	p, _ := s.CreateProject(ws.ID, "api", "/srv/api", "", "")
	if err := s.MarkProjectLocal(p.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.SetProjectSyncError(p.ID, "workspace was deleted"); err != nil {
		t.Fatal(err)
	}

	if err := s.MarkProjectSynced(p.ID); err != nil {
		t.Fatal(err)
	}
	got, err := s.ProjectByID(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Origin != "hub" {
		t.Errorf("Origin after MarkProjectSynced = %q, want hub", got.Origin)
	}
	if got.SyncError != nil {
		t.Errorf("SyncError after MarkProjectSynced = %v, want nil (cleared)", got.SyncError)
	}
}

func TestSetProjectSyncErrorLeavesOriginLocal(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")
	p, _ := s.CreateProject(ws.ID, "api", "/srv/api", "", "")
	if err := s.MarkProjectLocal(p.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.SetProjectSyncError(p.ID, "workspace was deleted"); err != nil {
		t.Fatal(err)
	}
	got, err := s.ProjectByID(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Origin != "local" {
		t.Errorf("Origin after SetProjectSyncError = %q, want local (still unsynced)", got.Origin)
	}
	if got.SyncError == nil || *got.SyncError != "workspace was deleted" {
		t.Errorf("SyncError = %v, want \"workspace was deleted\"", got.SyncError)
	}
}

func TestLocalProjectsReturnsOnlyLocalOrigin(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")
	synced, _ := s.CreateProject(ws.ID, "synced", "/srv/synced", "", "")
	local, _ := s.CreateProject(ws.ID, "local", "/srv/local", "", "")
	if err := s.MarkProjectLocal(local.ID); err != nil {
		t.Fatal(err)
	}

	got, err := s.LocalProjects()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != local.ID {
		t.Fatalf("LocalProjects() = %+v, want only %s (not %s)", got, local.ID, synced.ID)
	}
}

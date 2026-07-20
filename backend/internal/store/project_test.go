package store

import "testing"

func TestProjectByIDReadsOriginAndSyncError(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")
	p, err := s.CreateProject(ws.ID, "api", "/srv/api", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Origin != "hub" {
		t.Errorf("Origin on a freshly created project = %q, want hub (the schema default)", p.Origin)
	}
	if p.SyncError != nil {
		t.Errorf("SyncError on a freshly created project = %v, want nil", p.SyncError)
	}

	// Set sync_error directly via SQL — the write helper for this doesn't
	// exist until Task 2. This test is only proving the READ path here.
	if _, err := s.db.Exec(`UPDATE projects SET origin = 'local', sync_error = ? WHERE id = ?`, "workspace was deleted", p.ID); err != nil {
		t.Fatal(err)
	}
	got, err := s.ProjectByID(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Origin != "local" {
		t.Errorf("Origin after direct update = %q, want local", got.Origin)
	}
	if got.SyncError == nil || *got.SyncError != "workspace was deleted" {
		t.Errorf("SyncError after direct update = %v, want \"workspace was deleted\"", got.SyncError)
	}
}

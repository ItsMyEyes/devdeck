package service

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"devdeck/backend/internal/store"
)

func TestRuntimeWorkspaceListNestsLocalProjectsWithoutFanout(t *testing.T) {
	st := store.NewTestStore(t)

	var hits int
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer fake.Close()

	ws, _ := st.CreateWorkspace("clients")
	m, err := st.CreateMachine("builder", fake.URL, "mkey", false)
	if err != nil {
		t.Fatal(err)
	}
	st.CreateProject(ws.ID, "api", "/srv/api", "", m.ID)

	// The hub-mode service is the control: it MUST fan out to the machine
	// for worktrees, proving this test would actually fail if the
	// runtime-mode early return were ever removed.
	hubSvc := NewWorkspaceService(st)
	if _, err := hubSvc.List(); err != nil {
		t.Fatal(err)
	}
	if hits == 0 {
		t.Fatal("control failed: hub-mode List() never contacted the machine — this test cannot detect a missing runtime guard")
	}

	hits = 0
	svc := NewWorkspaceServiceForRuntime(st)
	got, err := svc.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || len(got[0].Projects) != 1 || got[0].Projects[0].Name != "api" {
		t.Fatalf("List() = %+v, want one workspace holding one project", got)
	}
	if hits != 0 {
		t.Errorf("runtime-mode List() contacted the machine %d time(s), want zero — a runtime has no machines to fan out to", hits)
	}
}

package handler

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

func newTestProjectHandler(t *testing.T) (*ProjectHandler, *store.Store) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	return NewProjectHandler(service.NewProjectService(st)), st
}

func TestPostCloneProjectDecodesMachineID(t *testing.T) {
	var gotAuth string
	fakeMachine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{"path":"/home/dev/myproj"}`))
	}))
	t.Cleanup(fakeMachine.Close)

	h, st := newTestProjectHandler(t)
	ws, err := st.CreateWorkspace("Acme")
	if err != nil {
		t.Fatal(err)
	}
	m, err := st.CreateMachine("builder", fakeMachine.URL, "rt-key", false)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/workspaces/"+ws.ID+"/projects/clone",
		strings.NewReader(`{"name":"myproj","path":"/home/dev/myproj","repo":"https://github.com/org/repo.git","machineId":"`+m.ID+`"}`))
	req.SetPathValue("wsId", ws.ID)
	rec := httptest.NewRecorder()
	h.PostCloneProject(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"machineId":"`+m.ID+`"`) {
		t.Errorf("response body = %s, want it to include machineId %q", rec.Body.String(), m.ID)
	}
	if gotAuth != "Bearer rt-key" {
		t.Errorf("machine saw Authorization = %q, want Bearer rt-key", gotAuth)
	}
}

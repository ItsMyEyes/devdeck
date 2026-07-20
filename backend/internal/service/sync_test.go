package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"devdeck/backend/internal/store"
)

func TestSyncOnceReplaysLocalProjectsBeforePulling(t *testing.T) {
	st := store.NewTestStore(t)
	ws, _ := st.CreateWorkspace("clients")
	local, _ := st.CreateProject(ws.ID, "api", "/srv/api", "", "")
	if err := st.MarkProjectLocal(local.ID); err != nil {
		t.Fatal(err)
	}

	var sawReplay, sawPull bool
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/runtime/projects":
			sawReplay = true
			_, _ = w.Write([]byte(`{"id":"` + local.ID + `","name":"api","path":"/srv/api","workspaceId":"` + ws.ID + `","machineId":"m-a","origin":"hub"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/runtime/catalog":
			sawPull = true
			_, _ = w.Write([]byte(`{"workspaces":[{"id":"` + ws.ID + `","name":"clients"}],"projects":[{"id":"` + local.ID + `","name":"api","path":"/srv/api","workspaceId":"` + ws.ID + `","machineId":"m-a"}],"sshConnections":[]}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer hub.Close()

	syncOnce(context.Background(), st, SyncConfig{HubURL: hub.URL, MachineKey: "rt-key"})

	if !sawReplay || !sawPull {
		t.Fatalf("sawReplay=%v sawPull=%v, want both true", sawReplay, sawPull)
	}
	got, err := st.ProjectByID(local.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Origin != "hub" {
		t.Errorf("Origin after a successful sync cycle = %q, want hub", got.Origin)
	}
}

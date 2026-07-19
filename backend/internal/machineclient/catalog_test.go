package machineclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchCatalogSendsMachineKeyAndDecodes(t *testing.T) {
	var gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"workspaces":[{"id":"ws-1","name":"clients"}],"projects":[{"id":"p-1","name":"api"}],"sshConnections":[]}`))
	}))
	defer srv.Close()

	snap, err := FetchCatalog(context.Background(), srv.URL, "rt-key-a")
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer rt-key-a" {
		t.Errorf("Authorization = %q, want the machine's own key", gotAuth)
	}
	if gotPath != "/api/runtime/catalog" {
		t.Errorf("path = %q, want /api/runtime/catalog", gotPath)
	}
	if len(snap.Workspaces) != 1 || len(snap.Projects) != 1 {
		t.Errorf("snapshot = %+v, want 1 workspace and 1 project", snap)
	}
}

func TestFetchCatalogErrorsOnNonOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	if _, err := FetchCatalog(context.Background(), srv.URL, "bad"); err == nil {
		t.Fatal("FetchCatalog succeeded on 401, want error")
	}
}

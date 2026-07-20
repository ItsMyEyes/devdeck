package machineclient

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"devdeck/backend/internal/domain"
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

func TestReplayProjectSendsProjectAndDecodesResult(t *testing.T) {
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"p-1","name":"api","path":"/srv/api","workspaceId":"ws-1","machineId":"m-a","origin":"hub"}`))
	}))
	defer srv.Close()

	p := domain.Project{ID: "p-1", WorkspaceID: "ws-1", Name: "api", Path: "/srv/api"}
	got, err := ReplayProject(context.Background(), srv.URL, "rt-key", p)
	if err != nil {
		t.Fatal(err)
	}
	if got.Origin != "hub" {
		t.Errorf("Origin = %q, want hub (the hub's response)", got.Origin)
	}
	if !strings.Contains(string(gotBody), `"id":"p-1"`) || !strings.Contains(string(gotBody), `"workspaceId":"ws-1"`) {
		t.Errorf("request body = %s, want it to carry id and workspaceId", gotBody)
	}
	if strings.Contains(string(gotBody), "machineId") {
		t.Errorf("request body = %s, must NOT include machineId — the hub derives it from the caller's key", gotBody)
	}
}

func TestReplayProjectReturnsErrWorkspaceGoneOn409(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"workspace does not exist"}`))
	}))
	defer srv.Close()

	_, err := ReplayProject(context.Background(), srv.URL, "rt-key", domain.Project{ID: "p-1", WorkspaceID: "ws-gone"})
	if !errors.Is(err, ErrWorkspaceGone) {
		t.Errorf("error = %v, want ErrWorkspaceGone", err)
	}
}

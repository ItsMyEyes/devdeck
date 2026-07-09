package machineclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"loom/backend/internal/domain"
)

func TestCloneOnMachineSendsRepoAndPathWithBearerKey(t *testing.T) {
	var gotAuth string
	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.URL.Path != "/api/fs/clone" || r.Method != http.MethodPost {
			t.Errorf("request = %s %s, want POST /api/fs/clone", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"path": gotBody["path"]})
	}))
	t.Cleanup(srv.Close)

	m := domain.Machine{ID: "m-1", URL: srv.URL, Key: "rtk"}
	err := CloneOnMachine(context.Background(), m, "https://github.com/org/repo.git", "/home/user/dev/repo")
	if err != nil {
		t.Fatalf("CloneOnMachine: %v", err)
	}
	if gotAuth != "Bearer rtk" {
		t.Errorf("Authorization = %q, want Bearer rtk", gotAuth)
	}
	if gotBody["repo"] != "https://github.com/org/repo.git" || gotBody["path"] != "/home/user/dev/repo" {
		t.Errorf("body = %+v", gotBody)
	}
}

func TestCloneOnMachineReturnsErrorMessageFromMachine(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "clone destination already exists"})
	}))
	t.Cleanup(srv.Close)

	m := domain.Machine{ID: "m-1", URL: srv.URL, Key: "rtk"}
	err := CloneOnMachine(context.Background(), m, "https://github.com/org/repo.git", "/home/user/dev/repo")
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "clone destination already exists") {
		t.Errorf("error = %q, want it to contain the machine's error message", err.Error())
	}
}

func TestCloneOnMachineWrapsUnreachableError(t *testing.T) {
	m := domain.Machine{ID: "m-dead", URL: "http://127.0.0.1:1", Key: "rtk"}
	err := CloneOnMachine(context.Background(), m, "https://github.com/org/repo.git", "/home/user/dev/repo")
	if err == nil {
		t.Fatal("expected an error for an unreachable machine, got nil")
	}
	if !strings.Contains(err.Error(), "m-dead") {
		t.Errorf("error = %q, want it to name the machine id", err.Error())
	}
}

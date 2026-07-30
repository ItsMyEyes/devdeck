package machineclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"devdeck/backend/internal/domain"
)

func TestCheckHealthOnline(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	status := CheckHealth(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"})
	if status.Status != "online" {
		t.Errorf("status = %q, want online", status.Status)
	}
}

func TestCheckHealthOfflineOnUnreachable(t *testing.T) {
	status := CheckHealth(context.Background(), domain.Machine{ID: "m-1", URL: "http://127.0.0.1:1", Key: "k"})
	if status.Status != "offline" {
		t.Errorf("status = %q, want offline", status.Status)
	}
}

func TestCheckHealthOfflineOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	status := CheckHealth(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"})
	if status.Status != "offline" {
		t.Errorf("status = %q, want offline", status.Status)
	}
}

func TestProbeSucceedsWithCorrectKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/whoami" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("Authorization") != "Bearer k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	if err := Probe(context.Background(), srv.URL, "k"); err != nil {
		t.Errorf("Probe() error = %v, want nil", err)
	}
}

func TestProbeFailsOnUnreachable(t *testing.T) {
	err := Probe(context.Background(), "http://127.0.0.1:1", "k")
	if err == nil {
		t.Fatal("Probe() error = nil, want an unreachable error")
	}
	if !strings.Contains(err.Error(), "unreachable") {
		t.Errorf("error = %q, want it to mention unreachable", err.Error())
	}
}

func TestProbeFailsOnWrongKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(srv.Close)

	err := Probe(context.Background(), srv.URL, "wrong")
	if err == nil {
		t.Fatal("Probe() error = nil, want a rejected-key error")
	}
	if !strings.Contains(err.Error(), "rejected the key") {
		t.Errorf("error = %q, want it to mention the key was rejected", err.Error())
	}
}

func TestRestartSucceedsAndPostsToSelfRestart(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath, gotAuth = r.Method, r.URL.Path, r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	if err := Restart(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"}); err != nil {
		t.Fatalf("Restart() error = %v, want nil", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/api/self/restart" || gotAuth != "Bearer k" {
		t.Errorf("got method=%s path=%s auth=%s, want POST /api/self/restart with Bearer k", gotMethod, gotPath, gotAuth)
	}
}

func TestRestartFailsOnUnreachable(t *testing.T) {
	err := Restart(context.Background(), domain.Machine{ID: "m-1", URL: "http://127.0.0.1:1", Key: "k"})
	if err == nil {
		t.Fatal("Restart() error = nil, want an unreachable error")
	}
	if !strings.Contains(err.Error(), "unreachable") {
		t.Errorf("error = %q, want it to mention unreachable", err.Error())
	}
}

func TestStopSucceedsAndPostsToSelfStop(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	if err := Stop(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"}); err != nil {
		t.Fatalf("Stop() error = %v, want nil", err)
	}
	if gotPath != "/api/self/stop" {
		t.Errorf("path = %q, want /api/self/stop", gotPath)
	}
}

func TestStopSurfacesTheTargetsErrorMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"this runtime is supervised by its desktop app and can't be stopped from here"}`))
	}))
	t.Cleanup(srv.Close)

	err := Stop(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"})
	if err == nil {
		t.Fatal("Stop() error = nil, want the target's refusal surfaced")
	}
	if !strings.Contains(err.Error(), "supervised by its desktop app") {
		t.Errorf("error = %q, want it to surface the target's own error message", err.Error())
	}
}

func TestVersionReturnsTheRuntimesRawJSON(t *testing.T) {
	var gotPath, gotMethod, gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod, gotAuth = r.URL.Path, r.Method, r.Header.Get("Authorization")
		w.Write([]byte(`{"version":"v1.4.2","sha256":"abc"}`))
	}))
	defer server.Close()

	body, err := Version(context.Background(), domain.Machine{ID: "m1", URL: server.URL, Key: "k"})
	if err != nil {
		t.Fatalf("Version() error = %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/api/self/version" || gotAuth != "Bearer k" {
		t.Errorf("got method=%s path=%s auth=%s, want GET /api/self/version with Bearer k", gotMethod, gotPath, gotAuth)
	}
	if !strings.Contains(string(body), `"v1.4.2"`) {
		t.Errorf("body = %s, want the runtime's JSON forwarded verbatim", body)
	}
}

func TestUpdateCheckPostsToTheRightPath(t *testing.T) {
	var gotPath, gotMethod string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod = r.URL.Path, r.Method
		w.Write([]byte(`{"updateAvailable":false}`))
	}))
	defer server.Close()

	if _, err := UpdateCheck(context.Background(), domain.Machine{ID: "m1", URL: server.URL, Key: "k"}); err != nil {
		t.Fatalf("UpdateCheck() error = %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/api/self/update-check" {
		t.Errorf("got method=%s path=%s, want GET /api/self/update-check", gotMethod, gotPath)
	}
}

func TestUpdatePostsToTheRightPath(t *testing.T) {
	var gotPath, gotMethod string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod = r.URL.Path, r.Method
		w.Write([]byte(`{"status":"updated","version":"v1.5.0"}`))
	}))
	defer server.Close()

	if _, err := Update(context.Background(), domain.Machine{ID: "m1", URL: server.URL, Key: "k"}); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/api/self/update" {
		t.Errorf("got method=%s path=%s, want POST /api/self/update", gotMethod, gotPath)
	}
}

func TestUpdateUnwrapsTheRuntimesErrorEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"error":"this runtime is supervised by its desktop app"}`))
	}))
	defer server.Close()

	_, err := Update(context.Background(), domain.Machine{ID: "m1", URL: server.URL, Key: "k"})
	if err == nil {
		t.Fatal("Update() error = nil, want non-nil for a 409")
	}
	if !strings.Contains(err.Error(), "supervised by its desktop app") {
		t.Errorf("error = %v, want the runtime's own reason", err)
	}
}

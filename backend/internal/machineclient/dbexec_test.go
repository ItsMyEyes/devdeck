package machineclient

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"devdeck/backend/internal/domain"
)

func TestRunDBRequestPreservesUpstreamStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"error":"statement affected 0 rows, expected 1"}`))
	}))
	defer srv.Close()

	err := RunDBRequest(t.Context(), domain.Machine{ID: "m1", URL: srv.URL, Key: "k"}, "/api/db/exec", map[string]any{}, nil)
	var remoteErr *RemoteError
	if !errors.As(err, &remoteErr) {
		t.Fatalf("err = %v, want *RemoteError", err)
	}
	if remoteErr.Status != http.StatusConflict {
		t.Fatalf("Status = %d, want 409", remoteErr.Status)
	}
}

func TestRunDBRequestSucceedsOn200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	var out struct {
		OK bool `json:"ok"`
	}
	if err := RunDBRequest(t.Context(), domain.Machine{ID: "m1", URL: srv.URL, Key: "k"}, "/api/db/test", map[string]any{}, &out); err != nil {
		t.Fatalf("RunDBRequest: %v", err)
	}
	if !out.OK {
		t.Fatal("expected ok=true to decode")
	}
}

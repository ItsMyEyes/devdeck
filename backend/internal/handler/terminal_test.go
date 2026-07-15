package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A worktree's primary terminal session id is the bare worktree id (no
// "::term-N" suffix — see frontend/src/features/terminal/paneTree.ts). It
// must never be killable through this endpoint: closing a spawned pane's
// tab must not be able to tear down the worktree's own session.
func TestDeleteSessionRejectsPrimaryWorktreeSession(t *testing.T) {
	req := httptest.NewRequest(http.MethodDelete, "/api/terminal/sessions/w-abc123", nil)
	req.SetPathValue("id", "w-abc123")
	rec := httptest.NewRecorder()

	NewTerminalHandler().DeleteSession(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["error"] == "" {
		t.Fatalf("expected an {\"error\": ...} envelope, got %v", body)
	}
}

func TestDeleteSessionRejectsEmptyID(t *testing.T) {
	req := httptest.NewRequest(http.MethodDelete, "/api/terminal/sessions/", nil)
	rec := httptest.NewRecorder()

	NewTerminalHandler().DeleteSession(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

// A spawned pane's session id carries the "::term-N" suffix and is the
// only shape this endpoint accepts — verified against KillSession's no-op
// path here (no live registry in this package's tests); the actual kill is
// covered by terminal.TestKillSessionTerminatesRunningProcess.
func TestDeleteSessionAcceptsSpawnedPaneSession(t *testing.T) {
	req := httptest.NewRequest(http.MethodDelete, "/api/terminal/sessions/w-abc123::term-1", nil)
	req.SetPathValue("id", "w-abc123::term-1")
	rec := httptest.NewRecorder()

	NewTerminalHandler().DeleteSession(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

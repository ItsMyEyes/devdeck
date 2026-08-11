package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"devdeck/backend/internal/domain"
)

// A worktree's primary terminal session id is the bare worktree id (no
// "::term-N" suffix — see frontend/src/features/terminal/paneTree.ts). The
// frontend still refuses to auto-kill it on a spawned pane's tab-close
// (killIfSpawnedTerminal in ExpandedTerminal.tsx), but this endpoint itself
// must now accept it: it also serves an explicit operator "kill this orphan"
// action, which must be able to reach a primary session left running with no
// reachable pane.
func TestDeleteSessionAcceptsPrimaryWorktreeSession(t *testing.T) {
	req := httptest.NewRequest(http.MethodDelete, "/api/terminal/sessions/w-abc123", nil)
	req.SetPathValue("id", "w-abc123")
	rec := httptest.NewRecorder()

	NewTerminalHandler().DeleteSession(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
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

// A spawned pane's session id carries the "::term-N" suffix — verified
// against KillSession's no-op path here (no live registry in this package's
// tests); the actual kill is covered by
// terminal.TestKillSessionTerminatesRunningProcess.
func TestDeleteSessionAcceptsSpawnedPaneSession(t *testing.T) {
	req := httptest.NewRequest(http.MethodDelete, "/api/terminal/sessions/w-abc123::term-1", nil)
	req.SetPathValue("id", "w-abc123::term-1")
	rec := httptest.NewRecorder()

	NewTerminalHandler().DeleteSession(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

// GetSessions must report `[]`, never `null`, when no PTY session is
// running — this package's tests never install a live registry (see
// TestDeleteSessionAcceptsSpawnedPaneSession's comment), so
// terminal.ActiveSessions always takes the nil-registry path here, which is
// exactly the shape a bare --role hub process (no terminal server at all)
// hits in production too.
func TestGetSessionsReturnsEmptyArrayNotNull(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/terminal/sessions", nil)
	rec := httptest.NewRecorder()

	NewTerminalHandler().GetSessions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if body := strings.TrimSpace(rec.Body.String()); body == "null" {
		t.Fatalf("expected [], got null")
	}
	var sessions []domain.TerminalSession
	if err := json.Unmarshal(rec.Body.Bytes(), &sessions); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if sessions == nil {
		t.Fatalf("expected a non-nil (possibly empty) slice, got nil")
	}
	if len(sessions) != 0 {
		t.Fatalf("expected 0 sessions, got %d", len(sessions))
	}
}

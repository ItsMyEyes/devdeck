package handler

import (
	"net/http"

	"devdeck/backend/internal/terminal"
)

// TerminalHandler handles terminal-session lifecycle endpoints outside the
// /ws/terminal WebSocket itself.
type TerminalHandler struct{}

// NewTerminalHandler creates a terminal-session handler.
func NewTerminalHandler() *TerminalHandler { return &TerminalHandler{} }

// GetSessions handles GET /api/terminal/sessions: lists every PTY session
// this process is currently running, including ones whose id fell out of
// the frontend's pane layout and are otherwise invisible (the only prior
// observability was the bare activeSessions count on /api/self). Always
// `[]`, never `null`, when nothing is running — see terminal.ActiveSessions.
func (h *TerminalHandler) GetSessions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, terminal.ActiveSessions())
}

// DeleteSession handles DELETE /api/terminal/sessions/{id}: immediately
// kills a terminal session's PTY process. Closing a pane's tab in the UI
// only removes it from the layout — left alone, the PTY lingers for the
// reconnect grace period (registry.detach) instead of exiting right away.
// This lets the frontend force the kill the moment the user actually closes
// a spawned pane's tab.
//
// Any live session id is accepted, including a worktree's primary (no
// "::term-N" suffix — see frontend/src/features/terminal/paneTree.ts). The
// guard against a spawned pane's tab-close tearing down its owning
// worktree's primary session lives in the frontend now
// (killIfSpawnedTerminal in ExpandedTerminal.tsx, which only auto-kills when
// `content.sessionKey !== worktree.id`); this endpoint also serves an
// explicit operator "kill this orphan" action from the session list, which
// must be able to reach a primary session — otherwise a runaway/forgotten
// primary session would be unreachable short of a backend restart.
func (h *TerminalHandler) DeleteSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "session id is required")
		return
	}
	if err := terminal.KillSession(id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

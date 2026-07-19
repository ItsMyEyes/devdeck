package handler

import (
	"net/http"
	"strings"

	"devdeck/backend/internal/terminal"
)

// TerminalHandler handles terminal-session lifecycle endpoints outside the
// /ws/terminal WebSocket itself.
type TerminalHandler struct{}

// NewTerminalHandler creates a terminal-session handler.
func NewTerminalHandler() *TerminalHandler { return &TerminalHandler{} }

// DeleteSession handles DELETE /api/terminal/sessions/{id}: immediately
// kills a spawned terminal pane's PTY process. Closing a pane's tab in the
// UI only removes it from the layout — left alone, the PTY lingers for the
// reconnect grace period (registry.detach) instead of exiting right away.
// This lets the frontend force the kill the moment the user actually closes
// the tab.
//
// A worktree's primary session (id has no "::term-N" suffix — see
// frontend/src/features/terminal/paneTree.ts) is refused: it backs the
// worktree itself, not one pane's tab, and must survive a spawned pane's tab
// being closed.
func (h *TerminalHandler) DeleteSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" || !strings.Contains(id, "::") {
		writeErr(w, http.StatusBadRequest, "cannot kill a worktree's primary terminal session")
		return
	}
	if err := terminal.KillSession(id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

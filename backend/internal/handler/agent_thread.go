package handler

import (
	"net/http"

	"devdeck/backend/internal/port"
)

// AgentThreadHandler serves the sessions sidebar's read side: the list of
// chat threads that exist for a worktree.
type AgentThreadHandler struct {
	store port.Store
}

// NewAgentThreadHandler returns a handler wired to the given store.
func NewAgentThreadHandler(st port.Store) *AgentThreadHandler {
	return &AgentThreadHandler{store: st}
}

// GetThreads handles GET /api/agent/threads?worktree=<id>, returning a
// worktree's chat threads newest-touched first.
func (h *AgentThreadHandler) GetThreads(w http.ResponseWriter, r *http.Request) {
	worktreeID := r.URL.Query().Get("worktree")
	if worktreeID == "" {
		writeErr(w, http.StatusBadRequest, "worktree is required")
		return
	}
	threads, err := h.store.AgentThreads(worktreeID)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, threads)
}

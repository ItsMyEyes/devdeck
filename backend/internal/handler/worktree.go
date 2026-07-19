package handler

import (
	"net/http"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/service"
)

// WorktreeHandler handles worktree CRUD endpoints.
type WorktreeHandler struct {
	svc *service.WorktreeService
}

// NewWorktreeHandler creates a worktree handler.
func NewWorktreeHandler(svc *service.WorktreeService) *WorktreeHandler {
	return &WorktreeHandler{svc: svc}
}

// PostWorktree creates a worktree (spawns an agent).
func (h *WorktreeHandler) PostWorktree(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode   string  `json:"mode"`
		Branch *string `json:"branch"`
		Base   *string `json:"base"`
		Model  string  `json:"model"`
		Agent  string  `json:"agent"`
		Task   *string `json:"task"`
		Path   string  `json:"path"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.Mode != "root" && body.Mode != "branch" {
		writeErr(w, http.StatusBadRequest, "mode must be \"branch\" or \"root\"")
		return
	}
	if body.Path == "" {
		writeErr(w, http.StatusBadRequest, "path is required")
		return
	}
	wt, err := h.svc.Create(r.PathValue("projectId"), body.Path, body.Mode, str(body.Branch), str(body.Base), body.Model, body.Agent, str(body.Task))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, wt)
}

// PatchWorktree updates a worktree's fields.
func (h *WorktreeHandler) PatchWorktree(w http.ResponseWriter, r *http.Request) {
	var p port.WorktreePatch
	raw, err := decodeBody(r, &p)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if _, ok := raw["pending"]; ok {
		p.HasPending = true
	}
	wt, err := h.svc.Update(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, wt)
}

// DeleteWorktree stops the worktree's background agent (if running) and deletes it.
func (h *WorktreeHandler) DeleteWorktree(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.svc.Delete(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListWorktrees returns a project's worktrees. Called by the hub to
// federate live worktree data from the runtime that owns the project (see
// service/workspace.go); harmless to expose on any role.
func (h *WorktreeHandler) ListWorktrees(w http.ResponseWriter, r *http.Request) {
	list, err := h.svc.ListByProject(r.PathValue("projectId"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

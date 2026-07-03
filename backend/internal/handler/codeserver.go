package handler

import (
	"net/http"

	"loom/backend/internal/service"
)

// CodeServerHandler handles the on-demand code-server endpoints for a worktree.
type CodeServerHandler struct {
	svc *service.CodeServerService
}

// NewCodeServerHandler creates a code-server handler.
func NewCodeServerHandler(svc *service.CodeServerService) *CodeServerHandler {
	return &CodeServerHandler{svc: svc}
}

type codeServerResponse struct {
	URL     string `json:"url"`
	Running bool   `json:"running"`
}

// PostCodeServer starts (or reuses) a worktree's code-server instance.
func (h *CodeServerHandler) PostCodeServer(w http.ResponseWriter, r *http.Request) {
	url, err := h.svc.Start(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, codeServerResponse{URL: url, Running: true})
}

// GetCodeServer reports whether a worktree's code-server instance is running.
func (h *CodeServerHandler) GetCodeServer(w http.ResponseWriter, r *http.Request) {
	url, running := h.svc.Status(r.PathValue("id"))
	writeJSON(w, http.StatusOK, codeServerResponse{URL: url, Running: running})
}

// DeleteCodeServer stops a worktree's running code-server instance, if any.
func (h *CodeServerHandler) DeleteCodeServer(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.svc.Stop(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PostProjectCodeServer starts (or reuses) a code-server instance rooted at
// a project's own directory, independent of any worktree.
func (h *CodeServerHandler) PostProjectCodeServer(w http.ResponseWriter, r *http.Request) {
	url, err := h.svc.StartForProject(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, codeServerResponse{URL: url, Running: true})
}

// GetProjectCodeServer reports whether a project's own code-server instance is running.
func (h *CodeServerHandler) GetProjectCodeServer(w http.ResponseWriter, r *http.Request) {
	url, running := h.svc.Status(r.PathValue("id"))
	writeJSON(w, http.StatusOK, codeServerResponse{URL: url, Running: running})
}

// DeleteProjectCodeServer stops a project's own running code-server instance, if any.
func (h *CodeServerHandler) DeleteProjectCodeServer(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.svc.Stop(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

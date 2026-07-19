package handler

import (
	"net/http"

	"devdeck/backend/internal/service"
)

// WorkspaceHandler handles workspace CRUD endpoints.
type WorkspaceHandler struct {
	svc *service.WorkspaceService
}

// NewWorkspaceHandler creates a workspace handler.
func NewWorkspaceHandler(svc *service.WorkspaceService) *WorkspaceHandler {
	return &WorkspaceHandler{svc: svc}
}

// GetWorkspaces returns the full nested workspace tree.
func (h *WorkspaceHandler) GetWorkspaces(w http.ResponseWriter, r *http.Request) {
	list, err := h.svc.List()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// PostWorkspace creates a new workspace.
func (h *WorkspaceHandler) PostWorkspace(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name *string `json:"name"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	name := "New workspace"
	if body.Name != nil && *body.Name != "" {
		name = *body.Name
	}
	ws, err := h.svc.Create(name)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, ws)
}

// PatchWorkspace renames a workspace.
func (h *WorkspaceHandler) PatchWorkspace(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name *string `json:"name"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	ws, err := h.svc.Update(r.PathValue("id"), body.Name)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, ws)
}

// DeleteWorkspace deletes a workspace and all its children.
func (h *WorkspaceHandler) DeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.svc.Delete(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

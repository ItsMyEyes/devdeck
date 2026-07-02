package handler

import (
	"net/http"

	"loom/backend/internal/service"
)

// ProjectHandler handles project CRUD endpoints.
type ProjectHandler struct {
	svc *service.ProjectService
}

// NewProjectHandler creates a project handler.
func NewProjectHandler(svc *service.ProjectService) *ProjectHandler {
	return &ProjectHandler{svc: svc}
}

// PostProject creates a project under a workspace.
func (h *ProjectHandler) PostProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name *string `json:"name"`
		Path *string `json:"path"`
		Repo *string `json:"repo"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	name := str(body.Name)
	path := str(body.Path)
	repo := str(body.Repo)
	p, err := h.svc.Create(r.PathValue("wsId"), name, path, repo)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// PatchProject updates a project's fields.
func (h *ProjectHandler) PatchProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     *string `json:"name"`
		Path     *string `json:"path"`
		Repo     *string `json:"repo"`
		Expanded *bool   `json:"expanded"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	p, err := h.svc.Update(r.PathValue("id"), body.Name, body.Path, body.Repo, body.Expanded)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// DeleteProject deletes a project and its worktrees.
func (h *ProjectHandler) DeleteProject(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.svc.Delete(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetProjectBranches returns the real git branches of a project's repository.
func (h *ProjectHandler) GetProjectBranches(w http.ResponseWriter, r *http.Request) {
	branches, err := h.svc.ListBranches(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, branches)
}

func str(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

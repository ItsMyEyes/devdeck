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
		Name      *string `json:"name"`
		Path      *string `json:"path"`
		Repo      *string `json:"repo"`
		MachineID *string `json:"machineId"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	name := str(body.Name)
	path := str(body.Path)
	repo := str(body.Repo)
	machineID := str(body.MachineID)
	p, err := h.svc.Create(r.PathValue("wsId"), name, path, repo, machineID)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// PostCloneProject clones a git repository, then creates a project for it.
func (h *ProjectHandler) PostCloneProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name      *string `json:"name"`
		Path      *string `json:"path"`
		Repo      *string `json:"repo"`
		MachineID *string `json:"machineId"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	p, err := h.svc.Clone(r.PathValue("wsId"), str(body.Name), str(body.Path), str(body.Repo), str(body.MachineID))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// PatchProject updates a project's fields.
func (h *ProjectHandler) PatchProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name      *string `json:"name"`
		Path      *string `json:"path"`
		Repo      *string `json:"repo"`
		MachineID *string `json:"machineId"`
		Expanded  *bool   `json:"expanded"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	p, err := h.svc.Update(r.PathValue("id"), body.Name, body.Path, body.Repo, body.MachineID, body.Expanded)
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
	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, http.StatusBadRequest, "path is required")
		return
	}
	branches, err := h.svc.ListBranches(path)
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

package handler

import (
	"net/http"
	"time"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/store"
)

// IssueHandler handles issue CRUD endpoints.
type IssueHandler struct {
	st *store.Store
}

// NewIssueHandler creates an issue handler.
func NewIssueHandler(st *store.Store) *IssueHandler {
	return &IssueHandler{st: st}
}

// PostIssue creates an issue under a project.
func (h *IssueHandler) PostIssue(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title  string  `json:"title"`
		Status *string `json:"status"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	createdAt := time.Now().UTC().Format(time.RFC3339)
	iss, err := h.st.CreateIssue(r.PathValue("projectId"), body.Title, str(body.Status), createdAt)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, iss)
}

// PatchIssue updates an issue's fields (also used for kanban drag-and-drop moves).
func (h *IssueHandler) PatchIssue(w http.ResponseWriter, r *http.Request) {
	var p port.IssuePatch
	raw, err := decodeBody(r, &p)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if _, ok := raw["assignee"]; ok {
		p.HasAssignee = true
	}
	updatedAt := time.Now().UTC().Format(time.RFC3339)
	iss, err := h.st.UpdateIssue(r.PathValue("id"), updatedAt, p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, iss)
}

// DeleteIssue deletes an issue.
func (h *IssueHandler) DeleteIssue(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteIssue(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

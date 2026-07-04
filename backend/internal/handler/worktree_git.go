package handler

import (
	"net/http"
	"strconv"

	"loom/backend/internal/service"
)

// WorktreeGitHandler exposes source-control operations scoped to one worktree.
type WorktreeGitHandler struct {
	svc *service.WorktreeGitService
}

func NewWorktreeGitHandler(svc *service.WorktreeGitService) *WorktreeGitHandler {
	return &WorktreeGitHandler{svc: svc}
}

func (h *WorktreeGitHandler) Status(w http.ResponseWriter, r *http.Request) {
	status, err := h.svc.Status(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (h *WorktreeGitHandler) Diff(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if hash := q.Get("commit"); hash != "" {
		diff, err := h.svc.ShowCommit(r.PathValue("id"), hash)
		if handleStoreErr(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, diff)
		return
	}
	diff, err := h.svc.Diff(
		r.PathValue("id"),
		q.Get("path"),
		q.Get("staged") == "true",
		q.Get("untracked") == "true",
	)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, diff)
}

func (h *WorktreeGitHandler) Stage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if handleStoreErr(w, h.svc.Stage(r.PathValue("id"), body.Paths)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *WorktreeGitHandler) Unstage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if handleStoreErr(w, h.svc.Unstage(r.PathValue("id"), body.Paths)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *WorktreeGitHandler) Discard(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if handleStoreErr(w, h.svc.Discard(r.PathValue("id"), body.Paths)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *WorktreeGitHandler) Commit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Message string `json:"message"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if handleStoreErr(w, h.svc.Commit(r.PathValue("id"), body.Message)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *WorktreeGitHandler) Push(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.svc.Push(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *WorktreeGitHandler) Pull(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.svc.Pull(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *WorktreeGitHandler) Log(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	commits, err := h.svc.Log(r.PathValue("id"), limit)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, commits)
}

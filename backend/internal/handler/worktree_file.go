package handler

import (
	"net/http"

	"loom/backend/internal/service"
)

// WorktreeFileHandler exposes text-file operations scoped to one worktree.
type WorktreeFileHandler struct {
	svc *service.WorktreeFileService
}

func NewWorktreeFileHandler(svc *service.WorktreeFileService) *WorktreeFileHandler {
	return &WorktreeFileHandler{svc: svc}
}

func (h *WorktreeFileHandler) List(w http.ResponseWriter, r *http.Request) {
	entries, err := h.svc.List(r.PathValue("id"), r.URL.Query().Get("path"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (h *WorktreeFileHandler) Read(w http.ResponseWriter, r *http.Request) {
	content, err := h.svc.Read(r.PathValue("id"), r.URL.Query().Get("path"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, content)
}

func (h *WorktreeFileHandler) Write(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	content, err := h.svc.Write(r.PathValue("id"), body.Path, body.Content)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, content)
}

func (h *WorktreeFileHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.svc.Delete(r.PathValue("id"), r.URL.Query().Get("path"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *WorktreeFileHandler) Search(w http.ResponseWriter, r *http.Request) {
	paths, err := h.svc.Search(r.PathValue("id"), r.URL.Query().Get("pattern"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, paths)
}

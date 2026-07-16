package handler

import (
	"mime/multipart"
	"net/http"
	"os"

	"loom/backend/internal/service"
)

const maxSSHUploadBytes = 256 << 20

// SSHFileHandler exposes text-file operations against a saved SSH
// connection's remote filesystem over SFTP — same route shapes as
// WorktreeFileHandler, keyed by connection id instead of worktree id.
type SSHFileHandler struct {
	svc *service.SSHFileService
}

func NewSSHFileHandler(svc *service.SSHFileService) *SSHFileHandler {
	return &SSHFileHandler{svc: svc}
}

func (h *SSHFileHandler) List(w http.ResponseWriter, r *http.Request) {
	entries, err := h.svc.List(r.Context(), r.PathValue("id"), r.URL.Query().Get("path"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (h *SSHFileHandler) Search(w http.ResponseWriter, r *http.Request) {
	includeDirs := r.URL.Query().Get("includeDirs") == "1" || r.URL.Query().Get("includeDirs") == "true"
	paths, err := h.svc.Search(r.Context(), r.PathValue("id"), r.URL.Query().Get("pattern"), includeDirs)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, paths)
}

func (h *SSHFileHandler) Read(w http.ResponseWriter, r *http.Request) {
	content, err := h.svc.Read(r.Context(), r.PathValue("id"), r.URL.Query().Get("path"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, content)
}

func (h *SSHFileHandler) Write(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	content, err := h.svc.Write(r.Context(), r.PathValue("id"), body.Path, body.Content)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, content)
}

func (h *SSHFileHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.svc.Delete(r.Context(), r.PathValue("id"), r.URL.Query().Get("path"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *SSHFileHandler) Upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxSSHUploadBytes)
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid multipart upload")
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	headers := r.MultipartForm.File["file"]
	if len(headers) == 0 {
		headers = r.MultipartForm.File["files"]
	}
	if len(headers) == 0 {
		writeErr(w, http.StatusBadRequest, "file is required")
		return
	}

	uploads := make([]service.WorktreeUploadFile, 0, len(headers))
	opened := make([]multipart.File, 0, len(headers))
	defer func() {
		for _, file := range opened {
			_ = file.Close()
		}
	}()
	for _, header := range headers {
		file, err := header.Open()
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid uploaded file")
			return
		}
		opened = append(opened, file)
		uploads = append(uploads, service.WorktreeUploadFile{Name: header.Filename, Reader: file})
	}

	entries, err := h.svc.Upload(r.Context(), r.PathValue("id"), r.URL.Query().Get("path"), uploads)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (h *SSHFileHandler) DeleteMany(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if handleStoreErr(w, h.svc.DeleteMany(r.Context(), r.PathValue("id"), body.Paths)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *SSHFileHandler) Archive(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	tmp, err := os.CreateTemp("", "loom-ssh-selection-*.zip")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "create archive failed")
		return
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	defer tmp.Close()

	if err := h.svc.Archive(r.Context(), r.PathValue("id"), body.Paths, tmp); handleStoreErr(w, err) {
		return
	}
	info, err := tmp.Stat()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "create archive failed")
		return
	}
	if _, err := tmp.Seek(0, 0); err != nil {
		writeErr(w, http.StatusInternalServerError, "create archive failed")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="selection.zip"`)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, "selection.zip", info.ModTime(), tmp)
}

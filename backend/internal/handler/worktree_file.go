package handler

import (
	"mime/multipart"
	"net/http"
	"os"
	"path"

	"devdeck/backend/internal/service"
)

const maxWorktreeUploadBytes = 256 << 20

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

// Download serves a worktree file's raw bytes, with none of Read's
// editor-oriented size/UTF-8 restrictions. Content-Type is pinned to
// application/octet-stream before http.ServeContent so ServeContent never
// sniffs: this serves user-controlled repo content, and a sniffed text/html
// would be same-origin under /api/machines/{id}/proxy/... — the attachment
// disposition is a second layer, not the only one.
func (h *WorktreeFileHandler) Download(w http.ResponseWriter, r *http.Request) {
	file, info, clean, err := h.svc.Download(r.PathValue("id"), r.URL.Query().Get("path"))
	if handleStoreErr(w, err) {
		return
	}
	defer file.Close()

	name := path.Base(clean)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", contentDisposition(name))
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, name, info.ModTime(), file)
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

func (h *WorktreeFileHandler) Upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxWorktreeUploadBytes)
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

	entries, err := h.svc.Upload(r.PathValue("id"), r.URL.Query().Get("path"), uploads)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (h *WorktreeFileHandler) DeleteMany(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if handleStoreErr(w, h.svc.DeleteMany(r.PathValue("id"), body.Paths)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *WorktreeFileHandler) Archive(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	tmp, err := os.CreateTemp("", "devdeck-selection-*.zip")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "create archive failed")
		return
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	defer tmp.Close()

	if err := h.svc.Archive(r.PathValue("id"), body.Paths, tmp); handleStoreErr(w, err) {
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

func (h *WorktreeFileHandler) Search(w http.ResponseWriter, r *http.Request) {
	includeDirs := r.URL.Query().Get("includeDirs") == "1" || r.URL.Query().Get("includeDirs") == "true"
	paths, err := h.svc.Search(r.PathValue("id"), r.URL.Query().Get("pattern"), includeDirs)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, paths)
}

func (h *WorktreeFileHandler) Grep(w http.ResponseWriter, r *http.Request) {
	opts := service.GrepOptions{
		Regex:          queryBool(r, "regex"),
		CaseSensitive:  queryBool(r, "caseSensitive"),
		IncludePattern: r.URL.Query().Get("includePattern"),
	}
	result, err := h.svc.Grep(r.Context(), r.PathValue("id"), r.URL.Query().Get("query"), opts)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// InstallRipgrep downloads and installs ripgrep on whichever process owns
// this worktree (the hub, or — via MachineProxyHandler's transparent
// forwarding — a remote Machine's runtime process), so the next Grep call
// can use it instead of the grep fallback.
func (h *WorktreeFileHandler) InstallRipgrep(w http.ResponseWriter, r *http.Request) {
	version, err := h.svc.InstallRipgrep(r.Context(), r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"installed": true, "version": version})
}

// queryBool parses a "1"/"true" boolean query param, same convention as the
// inline includeDirs check above — shared here so the new Grep handlers
// (worktree and SSH) don't each repeat it.
func queryBool(r *http.Request, name string) bool {
	v := r.URL.Query().Get(name)
	return v == "1" || v == "true"
}

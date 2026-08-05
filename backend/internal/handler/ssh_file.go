package handler

import (
	"mime/multipart"
	"net/http"
	"os"
	"path"

	"devdeck/backend/internal/service"
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

// Grep mirrors WorktreeFileHandler.Grep — same query params, same
// service.GrepResult response shape — for a saved SSH connection's remote
// filesystem instead of a local worktree.
func (h *SSHFileHandler) Grep(w http.ResponseWriter, r *http.Request) {
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

// InstallRipgrep downloads ripgrep on the hub and installs it onto
// connectionID's remote host over the already-open pooled SFTP connection,
// so the next Grep call can use it instead of the grep fallback.
func (h *SSHFileHandler) InstallRipgrep(w http.ResponseWriter, r *http.Request) {
	version, err := h.svc.InstallRipgrep(r.Context(), r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"installed": true, "version": version})
}

func (h *SSHFileHandler) Read(w http.ResponseWriter, r *http.Request) {
	content, err := h.svc.Read(r.Context(), r.PathValue("id"), r.URL.Query().Get("path"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, content)
}

// Download serves a remote file's raw bytes, with none of Read's
// editor-oriented size/UTF-8 restrictions. The service streams into a temp
// file rather than straight to w — sshmgr.WithSFTPClient scopes its client to
// the callback, so there is no handle to seek — and that temp file is then
// served via http.ServeContent so range requests still work, exactly as the
// Archive handler above does. Content-Type is pinned before ServeContent to
// suppress its sniffing, same reasoning as WorktreeFileHandler.Download.
func (h *SSHFileHandler) Download(w http.ResponseWriter, r *http.Request) {
	tmp, err := os.CreateTemp("", "devdeck-ssh-download-*")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "download failed")
		return
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	defer tmp.Close()

	meta, err := h.svc.Download(r.Context(), r.PathValue("id"), r.URL.Query().Get("path"), tmp)
	if handleStoreErr(w, err) {
		return
	}
	if _, err := tmp.Seek(0, 0); err != nil {
		writeErr(w, http.StatusInternalServerError, "download failed")
		return
	}

	name := path.Base(meta.Path)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", contentDisposition(name))
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, name, meta.ModTime, tmp)
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

func (h *SSHFileHandler) Mkdir(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	entry, err := h.svc.Mkdir(r.Context(), r.PathValue("id"), body.Path)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

func (h *SSHFileHandler) Move(w http.ResponseWriter, r *http.Request) {
	var body struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	entry, err := h.svc.Move(r.Context(), r.PathValue("id"), body.From, body.To)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

func (h *SSHFileHandler) Copy(w http.ResponseWriter, r *http.Request) {
	var body struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	entry, err := h.svc.Copy(r.Context(), r.PathValue("id"), body.From, body.To)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, entry)
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

// Extract accepts a multipart/form-data request carrying an "archive" zip
// file part and a "path" form field naming the destination folder — the
// exact inverse of Archive, and the same multipart shape as Upload. Mirrors
// WorktreeFileHandler.Extract; the SSH-vs-worktree difference (entries
// written over SFTP rather than the local filesystem) lives entirely in
// SSHFileService.Extract.
func (h *SSHFileHandler) Extract(w http.ResponseWriter, r *http.Request) {
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

	headers := r.MultipartForm.File["archive"]
	if len(headers) == 0 {
		writeErr(w, http.StatusBadRequest, "archive is required")
		return
	}
	file, err := headers[0].Open()
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid uploaded archive")
		return
	}
	defer file.Close()

	entries, err := h.svc.Extract(r.Context(), r.PathValue("id"), r.FormValue("path"), file)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (h *SSHFileHandler) Archive(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	tmp, err := os.CreateTemp("", "devdeck-ssh-selection-*.zip")
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

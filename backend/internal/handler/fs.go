package handler

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"loom/backend/internal/domain"
)

// FsHandler handles filesystem-browsing endpoints.
type FsHandler struct{}

// NewFsHandler creates a filesystem handler.
func NewFsHandler() *FsHandler { return &FsHandler{} }

// ListDir handles GET /api/fs/list?path=<path>.
// It returns the requested directory's visible folders and files, with
// git-repo indicators on folders.
func (h *FsHandler) ListDir(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("path")
	resolved, ok := resolveFsPath(w, raw, "missing path query parameter")
	if !ok {
		return
	}

	// Ensure the path exists and is a directory
	info, err := os.Stat(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			writeErr(w, http.StatusNotFound, "path not found")
			return
		}
		if os.IsPermission(err) {
			writeErr(w, http.StatusForbidden, "permission denied")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !info.IsDir() {
		writeErr(w, http.StatusBadRequest, "path is not a directory")
		return
	}

	// List entries
	entries, err := os.ReadDir(resolved)
	if err != nil {
		if os.IsPermission(err) {
			writeErr(w, http.StatusForbidden, "permission denied")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Build response: visible directories and files, with directories first.
	result := make([]domain.FsEntry, 0, len(entries))
	for _, e := range entries {
		// Hidden entries make the project explorer noisy. The current
		// directory's .git marker is still checked separately below.
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		git := false
		if e.IsDir() {
			_, err := os.Stat(filepath.Join(resolved, e.Name(), ".git"))
			git = err == nil
		}
		result = append(result, domain.FsEntry{Name: e.Name(), IsDir: e.IsDir(), Git: git})
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name)
	})

	// Check if the listed directory itself is a git repo (for footer indicator)
	currentGit := false
	if _, err := os.Stat(filepath.Join(resolved, ".git")); err == nil {
		currentGit = true
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"entries": result,
		"git":     currentGit,
	})
}

// Mkdir handles POST /api/fs/mkdir. It creates one child folder in the selected
// directory; nested paths and traversal in the name are intentionally rejected.
func (h *FsHandler) Mkdir(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	resolved, ok := resolveFsPath(w, body.Path, "path is required")
	if !ok {
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "folder name is required")
		return
	}
	if name == "." || name == ".." || strings.ContainsAny(name, `/\`) || strings.ContainsRune(name, '\x00') {
		writeErr(w, http.StatusBadRequest, "invalid folder name")
		return
	}
	target := filepath.Join(resolved, name)
	if err := os.Mkdir(target, 0o755); err != nil {
		if os.IsExist(err) {
			writeErr(w, http.StatusConflict, "folder already exists")
			return
		}
		if os.IsPermission(err) {
			writeErr(w, http.StatusForbidden, "permission denied")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"path": filepath.Clean(target)})
}

func resolveFsPath(w http.ResponseWriter, raw, missingMessage string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		writeErr(w, http.StatusBadRequest, missingMessage)
		return "", false
	}
	if hasPathTraversal(raw) {
		writeErr(w, http.StatusBadRequest, "path traversal not allowed")
		return "", false
	}
	home, err := os.UserHomeDir()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "cannot resolve home directory")
		return "", false
	}
	resolved := raw
	if strings.HasPrefix(resolved, "~") {
		resolved = filepath.Join(home, strings.TrimPrefix(resolved, "~"))
	}
	return filepath.Clean(resolved), true
}

func hasPathTraversal(raw string) bool {
	normalized := strings.ReplaceAll(raw, "\\", "/")
	for _, part := range strings.Split(normalized, "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

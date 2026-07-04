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
	if raw == "" {
		writeErr(w, http.StatusBadRequest, "missing path query parameter")
		return
	}

	// Reject path traversal attempts
	if strings.Contains(raw, "..") {
		writeErr(w, http.StatusBadRequest, "path traversal not allowed")
		return
	}

	// Expand ~ to home directory
	home, err := os.UserHomeDir()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "cannot resolve home directory")
		return
	}
	resolved := raw
	if strings.HasPrefix(resolved, "~") {
		resolved = filepath.Join(home, strings.TrimPrefix(resolved, "~"))
	}
	resolved = filepath.Clean(resolved)

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

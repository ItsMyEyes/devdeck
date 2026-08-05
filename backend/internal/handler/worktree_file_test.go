package handler

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

// binaryFixture is deliberately non-UTF-8 and NUL-containing — the byte
// pattern the Read endpoint rejects — so serving it intact proves the
// download route drops the editor's constraints.
var binaryFixture = []byte{0x89, 'P', 'N', 'G', 0x00, 0x1a, 0x0a, 0xff, 0xfe, 0x00}

// newDownloadTestHandler wires a real WorktreeFileService over a temp
// worktree, since Download's whole contract is about bytes and headers
// reaching the wire.
func newDownloadTestHandler(t *testing.T) (*WorktreeFileHandler, string) {
	t.Helper()
	base := t.TempDir()
	t.Setenv("HOME", base)
	root := filepath.Join(base, "repo")
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "logo.png"), binaryFixture, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, `we"ird füle.txt`), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	db, err := store.Open(filepath.Join(base, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	st := store.New(db)
	workspace, err := st.CreateWorkspace("Workspace")
	if err != nil {
		t.Fatal(err)
	}
	project, err := st.CreateProject(workspace.ID, "Project", "~/repo", "", "")
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := st.CreateWorktree(project.ID, "root", "", "", "", "", "", "~/repo")
	if err != nil {
		t.Fatal(err)
	}
	return NewWorktreeFileHandler(service.NewWorktreeFileService(st)), worktree.ID
}

func downloadRequest(worktreeID, path string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/worktrees/"+worktreeID+"/files/download?path="+path, nil)
	req.SetPathValue("id", worktreeID)
	return req
}

func TestWorktreeFileHandlerDownloadServesRawBytesWithHardenedHeaders(t *testing.T) {
	h, worktreeID := newDownloadTestHandler(t)

	rec := httptest.NewRecorder()
	h.Download(rec, downloadRequest(worktreeID, "logo.png"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(rec.Body.Bytes(), binaryFixture) {
		t.Errorf("body = %#v, want %#v", rec.Body.Bytes(), binaryFixture)
	}
	// Explicitly set before ServeContent so it never sniffs: a sniffed
	// text/html would be same-origin in proxy mode.
	if got := rec.Header().Get("Content-Type"); got != "application/octet-stream" {
		t.Errorf("Content-Type = %q, want application/octet-stream", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename="logo.png"; filename*=UTF-8''logo.png` {
		t.Errorf("Content-Disposition = %q", got)
	}
}

// A sniffable payload is the case that would silently regress if the explicit
// Content-Type were ever dropped: ServeContent would label this text/html.
func TestWorktreeFileHandlerDownloadNeverSniffsHTML(t *testing.T) {
	h, worktreeID := newDownloadTestHandler(t)
	if err := os.WriteFile(filepath.Join(os.Getenv("HOME"), "repo", "page.html"), []byte("<html><body>hi</body></html>"), 0o644); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	h.Download(rec, downloadRequest(worktreeID, "page.html"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/octet-stream" {
		t.Errorf("Content-Type = %q, want application/octet-stream", got)
	}
}

func TestWorktreeFileHandlerDownloadEscapesFilenameInHeader(t *testing.T) {
	h, worktreeID := newDownloadTestHandler(t)

	rec := httptest.NewRecorder()
	h.Download(rec, downloadRequest(worktreeID, "we%22ird%20f%C3%BCle.txt"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	want := `attachment; filename="we_ird f__le.txt"; filename*=UTF-8''we%22ird%20f%C3%BCle.txt`
	if got := rec.Header().Get("Content-Disposition"); got != want {
		t.Errorf("Content-Disposition = %q, want %q", got, want)
	}
}

func TestWorktreeFileHandlerDownloadMapsErrorsToTheStandardEnvelope(t *testing.T) {
	h, worktreeID := newDownloadTestHandler(t)

	tests := []struct {
		name string
		path string
		want int
	}{
		{"directory", "docs", http.StatusBadRequest},
		{"traversal", "..%2Ftest.db", http.StatusBadRequest},
		{"missing", "nope.txt", http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.Download(rec, downloadRequest(worktreeID, tt.path))
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d (body %q)", rec.Code, tt.want, rec.Body.String())
			}
			if got := rec.Body.String(); !bytes.Contains([]byte(got), []byte(`"error"`)) {
				t.Errorf("body = %q, want the {\"error\":...} envelope", got)
			}
		})
	}
}

// newExtractTestHandler wires a real WorktreeFileService over a temp
// worktree with an existing "dest" folder, same fixture shape as the
// service-level Extract tests.
func newExtractTestHandler(t *testing.T) (*WorktreeFileHandler, string, string) {
	t.Helper()
	base := t.TempDir()
	t.Setenv("HOME", base)
	root := filepath.Join(base, "repo")
	if err := os.MkdirAll(filepath.Join(root, "dest"), 0o755); err != nil {
		t.Fatal(err)
	}

	db, err := store.Open(filepath.Join(base, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	st := store.New(db)
	workspace, err := st.CreateWorkspace("Workspace")
	if err != nil {
		t.Fatal(err)
	}
	project, err := st.CreateProject(workspace.ID, "Project", "~/repo", "", "")
	if err != nil {
		t.Fatal(err)
	}
	worktree, err := st.CreateWorktree(project.ID, "root", "", "", "", "", "", "~/repo")
	if err != nil {
		t.Fatal(err)
	}
	return NewWorktreeFileHandler(service.NewWorktreeFileService(st)), worktree.ID, root
}

// buildTestZip builds an in-memory zip archive from name -> content pairs,
// same helper shape as the service test package's copy (unexported, one per
// package, matching binaryFixture's precedent of a duplicated small fixture
// rather than a cross-package import).
func buildTestZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if content != "" {
			if _, err := w.Write([]byte(content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// extractRequest builds a multipart/form-data POST carrying the archive
// bytes as an "archive" file part and destPath as a "path" form field — the
// exact shape Extract's handler documents.
func extractRequest(t *testing.T, worktreeID, destPath string, archive []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if err := mw.WriteField("path", destPath); err != nil {
		t.Fatal(err)
	}
	part, err := mw.CreateFormFile("archive", "selection.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(archive); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/worktrees/"+worktreeID+"/files/extract", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.SetPathValue("id", worktreeID)
	return req
}

func TestWorktreeFileHandlerExtractWritesNestedEntriesAndReturnsEntries(t *testing.T) {
	h, worktreeID, root := newExtractTestHandler(t)
	archive := buildTestZip(t, map[string]string{
		"README.md":          "hello",
		"src/nested/main.go": "package main",
	})

	rec := httptest.NewRecorder()
	h.Extract(rec, extractRequest(t, worktreeID, "dest", archive))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	var entries []service.WorktreeFileEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &entries); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("Extract response had no entries")
	}

	data, err := os.ReadFile(filepath.Join(root, "dest", "README.md"))
	if err != nil || string(data) != "hello" {
		t.Fatalf("dest/README.md = %q, %v, want %q", data, err, "hello")
	}
	data, err = os.ReadFile(filepath.Join(root, "dest", "src", "nested", "main.go"))
	if err != nil || string(data) != "package main" {
		t.Fatalf("dest/src/nested/main.go = %q, %v, want %q", data, err, "package main")
	}
}

// TestWorktreeFileHandlerExtractRejectsMaliciousArchivesWithTheErrorEnvelope
// covers every zip-slip/symlink rejection case at the handler layer, proving
// each one reaches the wire as {"error": "..."} rather than a raw Go error
// string or a leaked stack, and that nothing is written to the destination.
func TestWorktreeFileHandlerExtractRejectsMaliciousArchivesWithTheErrorEnvelope(t *testing.T) {
	symlinkArchive := func(t *testing.T) []byte {
		t.Helper()
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		header := &zip.FileHeader{Name: "escape-link"}
		header.SetMode(os.ModeSymlink | 0o777)
		w, err := zw.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte("../../etc/passwd")); err != nil {
			t.Fatal(err)
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
		return buf.Bytes()
	}

	tests := []struct {
		name    string
		archive func(t *testing.T) []byte
	}{
		{"parent traversal", func(t *testing.T) []byte { return buildTestZip(t, map[string]string{"../x": "no"}) }},
		{"absolute path", func(t *testing.T) []byte { return buildTestZip(t, map[string]string{"/abs/x": "no"}) }},
		{"nested traversal", func(t *testing.T) []byte { return buildTestZip(t, map[string]string{"a/../../x": "no"}) }},
		{"symlink entry", symlinkArchive},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h, worktreeID, root := newExtractTestHandler(t)

			rec := httptest.NewRecorder()
			h.Extract(rec, extractRequest(t, worktreeID, "dest", tt.archive(t)))

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
			}
			if got := rec.Body.String(); !bytes.Contains([]byte(got), []byte(`"error"`)) {
				t.Errorf("body = %q, want the {\"error\":...} envelope", got)
			}
			entries, err := os.ReadDir(filepath.Join(root, "dest"))
			if err != nil {
				t.Fatalf("read dest: %v", err)
			}
			if len(entries) != 0 {
				t.Errorf("dest not empty after rejected Extract: %v", entries)
			}
		})
	}
}

// TestWorktreeFileHandlerExtractRequiresArchivePart proves a request missing
// the "archive" file part is rejected with the standard envelope rather than
// panicking on a nil MultipartForm.File lookup.
func TestWorktreeFileHandlerExtractRequiresArchivePart(t *testing.T) {
	h, worktreeID, _ := newExtractTestHandler(t)

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	if err := mw.WriteField("path", "dest"); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/worktrees/"+worktreeID+"/files/extract", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.SetPathValue("id", worktreeID)

	rec := httptest.NewRecorder()
	h.Extract(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); !bytes.Contains([]byte(got), []byte(`"error"`)) {
		t.Errorf("body = %q, want the {\"error\":...} envelope", got)
	}
}

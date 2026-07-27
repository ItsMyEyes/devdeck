package handler

import (
	"bytes"
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

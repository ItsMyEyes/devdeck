package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"loom/backend/internal/domain"
)

func TestFsListDirReturnsVisibleFoldersThenFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "zeta"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "alpha"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, ".hidden"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "z.txt"), []byte("z"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/fs/list?path="+url.QueryEscape(root), nil)
	rec := httptest.NewRecorder()
	NewFsHandler().ListDir(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var response struct {
		Entries []domain.FsEntry `json:"entries"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}

	want := []domain.FsEntry{
		{Name: "alpha", IsDir: true},
		{Name: "zeta", IsDir: true},
		{Name: "a.txt", IsDir: false},
		{Name: "z.txt", IsDir: false},
	}
	if len(response.Entries) != len(want) {
		t.Fatalf("entries = %#v, want %#v", response.Entries, want)
	}
	for i := range want {
		got := response.Entries[i]
		if got.Name != want[i].Name || got.IsDir != want[i].IsDir {
			t.Fatalf("entries[%d] = %#v, want %#v", i, got, want[i])
		}
	}
}

func TestFsMkdirCreatesChildFolder(t *testing.T) {
	root := t.TempDir()
	body, err := json.Marshal(map[string]string{"path": root, "name": "child"})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/fs/mkdir", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	NewFsHandler().Mkdir(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	if info, err := os.Stat(filepath.Join(root, "child")); err != nil {
		t.Fatalf("created folder missing: %v", err)
	} else if !info.IsDir() {
		t.Fatalf("created path is not a directory")
	}

	var response struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Path != filepath.Join(root, "child") {
		t.Fatalf("path = %q, want %q", response.Path, filepath.Join(root, "child"))
	}
}

func TestFsMkdirRejectsNestedOrTraversalNames(t *testing.T) {
	root := t.TempDir()
	cases := []string{"..", "../child", "parent/child", `parent\child`}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			body, err := json.Marshal(map[string]string{"path": root, "name": name})
			if err != nil {
				t.Fatal(err)
			}

			req := httptest.NewRequest(http.MethodPost, "/api/fs/mkdir", bytes.NewReader(body))
			rec := httptest.NewRecorder()
			NewFsHandler().Mkdir(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
			}
		})
	}
}

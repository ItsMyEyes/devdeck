package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"devdeck/backend/internal/domain"
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

func TestFsCloneClonesRealRepo(t *testing.T) {
	origin := mustInitGitRepoForFsTest(t)
	target := filepath.Join(t.TempDir(), "checkout")

	body, err := json.Marshal(map[string]string{"repo": origin, "path": target})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/fs/clone", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	NewFsHandler().Clone(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(target, "README.md")); err != nil {
		t.Fatalf("cloned README missing: %v", err)
	}
}

func TestFsCloneRejectsMissingRepo(t *testing.T) {
	body, err := json.Marshal(map[string]string{"path": filepath.Join(t.TempDir(), "checkout")})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/fs/clone", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	NewFsHandler().Clone(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestFsCloneRejectsDestinationThatAlreadyExists(t *testing.T) {
	origin := mustInitGitRepoForFsTest(t)
	target := t.TempDir() // already exists

	body, err := json.Marshal(map[string]string{"repo": origin, "path": target})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/fs/clone", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	NewFsHandler().Clone(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusConflict, rec.Body.String())
	}
}

func TestFsCloneRejectsRelativePath(t *testing.T) {
	origin := mustInitGitRepoForFsTest(t)
	body, err := json.Marshal(map[string]string{"repo": origin, "path": "relative/checkout"})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/fs/clone", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	NewFsHandler().Clone(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestFsCloneRemovesPartialCheckoutOnFailure(t *testing.T) {
	missingOrigin := filepath.Join(t.TempDir(), "does-not-exist")
	target := filepath.Join(t.TempDir(), "checkout")

	body, err := json.Marshal(map[string]string{"repo": missingOrigin, "path": target})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/fs/clone", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	NewFsHandler().Clone(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("target stat = %v, want not exist", err)
	}
}

// mustInitGitRepoForFsTest mirrors internal/service/worktree_test.go's
// mustInitGitRepo/runGit — duplicated here because internal/handler can't
// import internal/service's test-only helpers across packages.
func mustInitGitRepoForFsTest(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	runGitForFsTest(t, dir, "init", "-b", "main")
	runGitForFsTest(t, dir, "config", "user.email", "test@example.com")
	runGitForFsTest(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	runGitForFsTest(t, dir, "add", "README.md")
	runGitForFsTest(t, dir, "commit", "-m", "initial")
	return dir
}

func runGitForFsTest(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

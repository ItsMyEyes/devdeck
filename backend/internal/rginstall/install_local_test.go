package rginstall

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestInstallLocalDownloadsExtractsAndWritesBinaryAtomically(t *testing.T) {
	tarball := buildTestTarGz(t, map[string]string{
		"ripgrep-15.2.0-x86_64-apple-darwin/rg": "fake-rg-binary-contents",
	})

	var assetURL string
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/BurntSushi/ripgrep/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tag_name":"15.2.0","assets":[{"name":"ripgrep-15.2.0-x86_64-apple-darwin.tar.gz","browser_download_url":"` + assetURL + `"}]}`))
	})
	mux.HandleFunc("/download/rg.tar.gz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(tarball)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	assetURL = srv.URL + "/download/rg.tar.gz"
	setGithubAPIBaseURL(t, srv.URL)

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	binPath, version, err := InstallLocal(context.Background(), "darwin", "amd64")
	if err != nil {
		t.Fatalf("InstallLocal failed: %v", err)
	}
	if version != "15.2.0" {
		t.Errorf("version = %q, want 15.2.0", version)
	}
	wantPath := filepath.Join(home, ".local", "bin", "rg")
	if binPath != wantPath {
		t.Errorf("binPath = %q, want %q", binPath, wantPath)
	}
	data, err := os.ReadFile(binPath)
	if err != nil {
		t.Fatalf("read installed binary: %v", err)
	}
	if string(data) != "fake-rg-binary-contents" {
		t.Errorf("installed binary contents = %q, want the extracted rg contents", data)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(binPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o111 == 0 {
			t.Errorf("installed binary is not executable: mode=%v", info.Mode())
		}
	}
}

func TestInstallLocalUsesExeSuffixOnWindows(t *testing.T) {
	zipData := buildTestZip(t, map[string]string{
		"ripgrep-15.2.0-x86_64-pc-windows-msvc/rg.exe": "fake-rg-exe-contents",
	})
	var assetURL string
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/BurntSushi/ripgrep/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tag_name":"15.2.0","assets":[{"name":"ripgrep-15.2.0-x86_64-pc-windows-msvc.zip","browser_download_url":"` + assetURL + `"}]}`))
	})
	mux.HandleFunc("/download/rg.zip", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(zipData)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	assetURL = srv.URL + "/download/rg.zip"
	setGithubAPIBaseURL(t, srv.URL)

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	binPath, _, err := InstallLocal(context.Background(), "windows", "amd64")
	if err != nil {
		t.Fatalf("InstallLocal failed: %v", err)
	}
	if filepath.Base(binPath) != "rg.exe" {
		t.Errorf("binPath = %q, want a rg.exe filename", binPath)
	}
	if _, err := os.ReadFile(binPath); err != nil {
		t.Fatalf("read installed binary: %v", err)
	}
}

// TestInstallLocalRejectsUnsupportedPlatformWithoutNetworkCall proves the
// platform/arch check happens before any GitHub API call — a request to
// this test's httptest.Server would fail the test via t.Fatal.
func TestInstallLocalRejectsUnsupportedPlatformWithoutNetworkCall(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("unexpected network call for an unsupported platform: %s", r.URL.Path)
	}))
	defer srv.Close()
	setGithubAPIBaseURL(t, srv.URL)

	if _, _, err := InstallLocal(context.Background(), "plan9", "amd64"); err == nil {
		t.Fatal("expected an error for an unsupported platform, got nil")
	}
}

func TestInstallLocalPropagatesGithubAPIFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	setGithubAPIBaseURL(t, srv.URL)

	if _, _, err := InstallLocal(context.Background(), "darwin", "amd64"); err == nil {
		t.Fatal("expected an error when the GitHub API call fails, got nil")
	}
}

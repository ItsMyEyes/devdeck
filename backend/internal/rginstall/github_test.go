package rginstall

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// setGithubAPIBaseURL points package-level GitHub API calls at a test
// server for the duration of t, restoring the real API host afterwards —
// same overridable-package-var pattern detect.go's shellPathDirs and
// service.go's resolveRipgrep use, so tests never hit the real network.
func setGithubAPIBaseURL(t *testing.T, url string) {
	t.Helper()
	old := githubAPIBaseURL
	githubAPIBaseURL = url
	t.Cleanup(func() { githubAPIBaseURL = old })
}

func TestLatestReleaseParsesGithubResponseWithoutAuth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/BurntSushi/ripgrep/releases/latest" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("expected no Authorization header for the public ripgrep repo, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tag_name":"15.2.0","assets":[{"name":"ripgrep-15.2.0-x86_64-apple-darwin.tar.gz","browser_download_url":"https://example.invalid/a.tar.gz"}]}`))
	}))
	defer srv.Close()
	setGithubAPIBaseURL(t, srv.URL)

	release, err := LatestRelease(context.Background())
	if err != nil {
		t.Fatalf("LatestRelease failed: %v", err)
	}
	if release.TagName != "15.2.0" {
		t.Errorf("TagName = %q, want 15.2.0", release.TagName)
	}
	if len(release.Assets) != 1 || release.Assets[0].Name != "ripgrep-15.2.0-x86_64-apple-darwin.tar.gz" {
		t.Errorf("unexpected assets: %+v", release.Assets)
	}
}

func TestLatestReleaseReturnsErrorOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	setGithubAPIBaseURL(t, srv.URL)

	if _, err := LatestRelease(context.Background()); err == nil {
		t.Fatal("expected an error on a non-200 response, got nil")
	}
}

func TestDownloadAssetFetchesBrowserDownloadURLDirectlyWithoutAuth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("expected no Authorization header for a public asset download, got %q", got)
		}
		_, _ = w.Write([]byte("binary-data"))
	}))
	defer srv.Close()

	data, err := downloadAsset(context.Background(), Asset{Name: "a.tar.gz", BrowserDownloadURL: srv.URL})
	if err != nil {
		t.Fatalf("downloadAsset failed: %v", err)
	}
	if string(data) != "binary-data" {
		t.Errorf("data = %q, want %q", data, "binary-data")
	}
}

func TestDownloadAssetReturnsErrorOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	if _, err := downloadAsset(context.Background(), Asset{Name: "a.tar.gz", BrowserDownloadURL: srv.URL}); err == nil {
		t.Fatal("expected an error on a non-200 response, got nil")
	}
}

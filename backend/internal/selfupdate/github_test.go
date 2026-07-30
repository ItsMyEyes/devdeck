package selfupdate

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClient_LatestRelease(t *testing.T) {
	var gotAuth, gotAccept string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotAccept = r.Header.Get("Accept")
		if r.URL.Path != "/repos/acme/widget/releases/latest" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Release{
			TagName: "v1.2.3",
			Assets:  []Asset{{Name: "devdeck-linux-amd64", ID: 42}},
		})
	}))
	defer server.Close()

	client := &Client{BaseURL: server.URL, Owner: "acme", Repo: "widget", Token: "test-token"}
	release, err := client.LatestRelease(context.Background())
	if err != nil {
		t.Fatalf("LatestRelease() error = %v", err)
	}
	if release.TagName != "v1.2.3" {
		t.Errorf("TagName = %q, want v1.2.3", release.TagName)
	}
	if len(release.Assets) != 1 || release.Assets[0].Name != "devdeck-linux-amd64" {
		t.Errorf("Assets = %+v, want one devdeck-linux-amd64 asset", release.Assets)
	}
	if gotAuth != "Bearer test-token" {
		t.Errorf("Authorization header = %q, want %q", gotAuth, "Bearer test-token")
	}
	if gotAccept != "application/vnd.github+json" {
		t.Errorf("Accept header = %q, want application/vnd.github+json", gotAccept)
	}
}

func TestClient_LatestRelease_ErrorStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	client := &Client{BaseURL: server.URL, Owner: "acme", Repo: "widget", Token: "bad-token"}
	if _, err := client.LatestRelease(context.Background()); err == nil {
		t.Fatal("LatestRelease() error = nil, want non-nil for a 401 response")
	}
}

func TestClient_DownloadAsset(t *testing.T) {
	var gotAuth, gotAccept, gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotAccept = r.Header.Get("Accept")
		gotPath = r.URL.Path
		w.Write([]byte("binary-contents"))
	}))
	defer server.Close()

	client := &Client{BaseURL: server.URL, Owner: "acme", Repo: "widget", Token: "test-token"}
	data, err := client.DownloadAsset(context.Background(), Asset{Name: "devdeck-linux-amd64", ID: 42})
	if err != nil {
		t.Fatalf("DownloadAsset() error = %v", err)
	}
	if string(data) != "binary-contents" {
		t.Errorf("data = %q, want %q", data, "binary-contents")
	}
	if gotPath != "/repos/acme/widget/releases/assets/42" {
		t.Errorf("path = %q, want /repos/acme/widget/releases/assets/42", gotPath)
	}
	if gotAuth != "Bearer test-token" {
		t.Errorf("Authorization header = %q, want %q", gotAuth, "Bearer test-token")
	}
	if gotAccept != "application/octet-stream" {
		t.Errorf("Accept header = %q, want application/octet-stream", gotAccept)
	}
}

func TestClient_OmitsAuthorizationWhenTokenIsEmpty(t *testing.T) {
	var hadAuth bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, hadAuth = r.Header["Authorization"]
		json.NewEncoder(w).Encode(Release{TagName: "v1.0.0"})
	}))
	defer server.Close()

	client := &Client{BaseURL: server.URL, Owner: "acme", Repo: "widget"} // no Token
	if _, err := client.LatestRelease(context.Background()); err != nil {
		t.Fatalf("LatestRelease() error = %v", err)
	}
	if hadAuth {
		t.Error("Authorization header was sent for an empty token; a public repo must be reachable unauthenticated")
	}
}

func TestClient_ReleaseByTag(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		json.NewEncoder(w).Encode(Release{
			TagName: "v1.2.3",
			Assets:  []Asset{{Name: ChecksumsFileName, ID: 7}},
		})
	}))
	defer server.Close()

	client := &Client{BaseURL: server.URL, Owner: "acme", Repo: "widget"}
	release, err := client.ReleaseByTag(context.Background(), "v1.2.3")
	if err != nil {
		t.Fatalf("ReleaseByTag() error = %v", err)
	}
	if gotPath != "/repos/acme/widget/releases/tags/v1.2.3" {
		t.Errorf("path = %q, want /repos/acme/widget/releases/tags/v1.2.3", gotPath)
	}
	if release.TagName != "v1.2.3" || len(release.Assets) != 1 {
		t.Errorf("release = %+v, want tag v1.2.3 with one asset", release)
	}
}

func TestClient_ReleaseByTagReportsNotFoundDistinctly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	client := &Client{BaseURL: server.URL, Owner: "acme", Repo: "widget"}
	_, err := client.ReleaseByTag(context.Background(), "v9.9.9")
	if !errors.Is(err, ErrReleaseNotFound) {
		t.Fatalf("ReleaseByTag() error = %v, want ErrReleaseNotFound", err)
	}
}

func TestClient_LatestReleaseHintsAtTheTokenOnForbidden(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()

	client := &Client{BaseURL: server.URL, Owner: "acme", Repo: "widget"}
	_, err := client.LatestRelease(context.Background())
	if err == nil {
		t.Fatal("LatestRelease() error = nil, want non-nil for a 403")
	}
	if !strings.Contains(err.Error(), "DEVDECK_GITHUB_TOKEN") {
		t.Errorf("error %q should point at DEVDECK_GITHUB_TOKEN as the likely fix", err)
	}
}

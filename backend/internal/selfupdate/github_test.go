package selfupdate

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
			Assets:  []Asset{{Name: "loom-linux-amd64", ID: 42}},
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
	if len(release.Assets) != 1 || release.Assets[0].Name != "loom-linux-amd64" {
		t.Errorf("Assets = %+v, want one loom-linux-amd64 asset", release.Assets)
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
	data, err := client.DownloadAsset(context.Background(), Asset{Name: "loom-linux-amd64", ID: 42})
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

# CI/CD + Versioned Self-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub Actions CI (unit tests) and CD (build + release), plus a `-updates` flag on `loom-api` that self-updates from the latest tagged GitHub Release — which requires embedding a build-time semver version in the binary.

**Architecture:** A new `backend/internal/version` package holds a build-time-injected version string. A new `backend/internal/selfupdate` package (GitHub API client, semver compare, asset naming, atomic binary replace, orchestration) is wired into `backend/cmd/server/main.go` behind new `-version` / `-updates` / `-github-token` flags. `Makefile` bakes the git-tag version into every build via `-ldflags`. Two GitHub Actions workflows reuse the existing `Makefile` targets: `test.yml` runs `go vet`/`go test`/`npm run typecheck` on every push/PR; `release.yml` runs the same gate then `make portable-all` and publishes a GitHub Release when a `vX.Y.Z` tag is pushed.

**Tech Stack:** Go 1.25 (backend), `golang.org/x/mod/semver` (already indirectly vendored, promoted to a direct dependency), GitHub Actions (`actions/checkout`, `actions/setup-go`, `actions/setup-node`, `softprops/action-gh-release`).

## Global Constraints

- Repo is **private**: `ItsMyEyes/enginer-workspaces`. Self-update auth uses a user-supplied token (`-github-token` / `LOOM_GITHUB_TOKEN`); CI's own release-publishing step uses the workflow's built-in `GITHUB_TOKEN` (sufficient for publishing to the same repo).
- No auto-restart after a self-update — print the new version and exit; the operator restarts Loom.
- Frontend has no test runner configured; its CI gate is `npm run typecheck` only. Do not add a frontend test framework as part of this work (out of scope per spec).
- Follow the existing `envOr`-backed flag pattern in `backend/cmd/server/main.go` for any new flag with an env-var fallback.
- Design doc: `docs/superpowers/specs/2026-07-04-ci-cd-and-self-update-design.md` — read it if anything here is ambiguous.

---

### Task 1: Version package + build-time embedding + `-version` flag

**Files:**
- Create: `backend/internal/version/version.go`
- Modify: `Makefile:1-6` (flags/vars header), `Makefile` `build-api` target, `Makefile` `portable-current` target, `Makefile` `portable-all` target
- Modify: `backend/cmd/server/main.go` (imports + flag)

**Interfaces:**
- Produces: `version.Version` (package `loom/backend/internal/version`, exported `var Version string`, default `"dev"`) — consumed by Task 7 (`selfupdate` wiring in `main.go`).

- [ ] **Step 1: Create the version package**

```go
// backend/internal/version/version.go
package version

// Version is the running build's version string, e.g. "v1.2.3". It defaults
// to "dev" for a plain `go build`/`go run` and is overridden at build time
// via `-ldflags "-X loom/backend/internal/version.Version=vX.Y.Z"` (see
// Makefile), which the release workflow sets from the pushed git tag.
var Version = "dev"
```

- [ ] **Step 2: Add version vars to the Makefile header**

In `Makefile`, after the existing `WINDOWS_EXT` line, add:

```make
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X loom/backend/internal/version.Version=$(VERSION)
```

- [ ] **Step 3: Bake the version into every server build target**

In `Makefile`, change:

```make
build-api: prepare-webui
	cd backend && go build -o loom-api ./cmd/server
```

to:

```make
build-api: prepare-webui
	cd backend && go build -ldflags "$(LDFLAGS)" -o loom-api ./cmd/server
```

Change:

```make
portable-current: prepare-webui
	mkdir -p $(DIST_DIR)
	cd backend && CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) go build -trimpath -o ../$(DIST_DIR)/loom-$(GOOS)-$(GOARCH)$(WINDOWS_EXT) ./cmd/server
```

to:

```make
portable-current: prepare-webui
	mkdir -p $(DIST_DIR)
	cd backend && CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/loom-$(GOOS)-$(GOARCH)$(WINDOWS_EXT) ./cmd/server
```

Change each of the six `portable-all` build lines the same way — e.g.:

```make
	cd backend && CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -o ../$(DIST_DIR)/loom-darwin-amd64 ./cmd/server
```

becomes:

```make
	cd backend && CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(DIST_DIR)/loom-darwin-amd64 ./cmd/server
```

...and likewise for the `darwin/arm64`, `linux/amd64`, `linux/arm64`, `windows/amd64`, and `windows/arm64` lines.

- [ ] **Step 4: Add the `-version` flag to `main.go`**

In `backend/cmd/server/main.go`, add the import (alphabetically among the existing `loom/backend/internal/...` block, after `"loom/backend/internal/terminal"` and before `"loom/backend/internal/webui"`):

```go
	"loom/backend/internal/version"
```

At the very top of `func main()`, before the existing `envFile := flag.String(...)` line, add:

```go
	showVersion := flag.Bool("version", false, "print the loom version and exit")
```

Immediately after the existing `flag.Parse()` call (before the `config.LoadDotEnv` block), add:

```go
	if *showVersion {
		fmt.Println(version.Version)
		return
	}
```

`fmt` is already imported in `main.go`.

- [ ] **Step 5: Verify it builds and reports a version**

Run: `cd /Users/kiyora/Documents/explorer/agent/enginer.kiyora.dev && make build-api`
Expected: builds cleanly, no errors.

Run: `./backend/loom-api --version`
Expected: prints something like `v0.1.0-12-gabc1234` or a bare commit hash (no tags exist in this repo yet) — any non-empty string, not `dev`, confirming the `-ldflags -X` injection worked (a plain `go run`/`go build` without ldflags would print `dev`).

- [ ] **Step 6: Commit**

```bash
git add backend/internal/version/version.go Makefile backend/cmd/server/main.go
git commit -m "feat: embed build-time version and add --version flag"
```

---

### Task 2: selfupdate GitHub API client

**Files:**
- Create: `backend/internal/selfupdate/github.go`
- Test: `backend/internal/selfupdate/github_test.go`

**Interfaces:**
- Produces: `selfupdate.Release{TagName string; Assets []Asset}`, `selfupdate.Asset{Name string; ID int64}`, `selfupdate.Client{HTTPClient *http.Client; BaseURL, Owner, Repo, Token string}` with methods `(*Client) LatestRelease(ctx context.Context) (*Release, error)` and `(*Client) DownloadAsset(ctx context.Context, asset Asset) ([]byte, error)` — consumed by Task 6 (`Run`) via the `releaseFetcher` interface it defines there.

- [ ] **Step 1: Write the failing tests**

```go
// backend/internal/selfupdate/github_test.go
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/selfupdate/... -v`
Expected: FAIL — build error, `package selfupdate` has no `Release`/`Asset`/`Client` etc. defined yet.

- [ ] **Step 3: Implement the client**

```go
// backend/internal/selfupdate/github.go
package selfupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

const defaultAPIBaseURL = "https://api.github.com"

// Release is the subset of the GitHub releases API response this package
// needs.
type Release struct {
	TagName string  `json:"tag_name"`
	Assets  []Asset `json:"assets"`
}

// Asset is one file attached to a Release.
type Asset struct {
	Name string `json:"name"`
	ID   int64  `json:"id"`
}

// Client talks to the GitHub REST API for one owner/repo, authenticating
// with a bearer token (required since the target repo is private).
type Client struct {
	HTTPClient *http.Client
	// BaseURL overrides the GitHub API host; empty means the real API
	// (https://api.github.com). Only ever set in tests.
	BaseURL string
	Owner   string
	Repo    string
	Token   string
}

func (c *Client) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return http.DefaultClient
}

func (c *Client) baseURL() string {
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return defaultAPIBaseURL
}

// LatestRelease fetches the most recent published release for Owner/Repo.
func (c *Client) LatestRelease(ctx context.Context) (*Release, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/releases/latest", c.baseURL(), c.Owner, c.Repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("request latest release: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github: unexpected status %d fetching latest release", resp.StatusCode)
	}

	var release Release
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, fmt.Errorf("decode latest release response: %w", err)
	}
	return &release, nil
}

// DownloadAsset fetches one release asset's raw bytes via the (authenticated)
// asset API endpoint — required for private repos, unlike the plain
// browser_download_url.
func (c *Client) DownloadAsset(ctx context.Context, asset Asset) ([]byte, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/releases/assets/%d", c.baseURL(), c.Owner, c.Repo, asset.ID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "application/octet-stream")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("request asset %s: %w", asset.Name, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github: unexpected status %d downloading asset %s", resp.StatusCode, asset.Name)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read asset %s: %w", asset.Name, err)
	}
	return data, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/selfupdate/... -v`
Expected: PASS — `TestClient_LatestRelease`, `TestClient_LatestRelease_ErrorStatus`, `TestClient_DownloadAsset`.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/selfupdate/github.go backend/internal/selfupdate/github_test.go
git commit -m "feat: add GitHub releases API client for self-update"
```

---

### Task 3: Semver version compare

**Files:**
- Create: `backend/internal/selfupdate/version.go`
- Test: `backend/internal/selfupdate/version_test.go`
- Modify: `backend/go.mod`, `backend/go.sum` (promote `golang.org/x/mod` from indirect to direct)

**Interfaces:**
- Produces: `selfupdate.NeedsUpdate(currentVersion, latestTag string) (bool, error)` — consumed by Task 6 (`Run`).

- [ ] **Step 1: Promote `golang.org/x/mod` to a direct dependency**

`golang.org/x/mod` is already resolved transitively (check: `grep golang.org/x/mod backend/go.sum` shows checksum entries) and cached locally, so this doesn't need network access. Run:

```bash
cd backend && GOPROXY=off GOFLAGS=-mod=mod go get golang.org/x/mod@v0.36.0
```

Expected: `go.mod` gains a top-level `require golang.org/x/mod v0.36.0` line (no longer only in the `// indirect` block), `go.sum` unchanged (checksums already present).

If this fails with a network error, it means the local module cache doesn't have this exact version cached — check `ls $(go env GOMODCACHE)/golang.org/x/mod@v0.36.0` and adjust the version in the `go get` command to whatever version is present there, or run without `GOPROXY=off` if network access is actually available in the execution environment.

- [ ] **Step 2: Write the failing tests**

```go
// backend/internal/selfupdate/version_test.go
package selfupdate

import "testing"

func TestNeedsUpdate(t *testing.T) {
	tests := []struct {
		name    string
		current string
		latest  string
		want    bool
		wantErr bool
	}{
		{name: "newer available", current: "v1.0.0", latest: "v1.1.0", want: true},
		{name: "already latest", current: "v1.0.0", latest: "v1.0.0", want: false},
		{name: "current newer than latest", current: "v1.1.0", latest: "v1.0.0", want: false},
		{name: "missing v prefix on both sides", current: "1.0.0", latest: "1.1.0", want: true},
		{name: "dev build refuses", current: "dev", latest: "v1.0.0", wantErr: true},
		{name: "invalid latest tag", current: "v1.0.0", latest: "not-a-version", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := NeedsUpdate(tt.current, tt.latest)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("NeedsUpdate(%q, %q) error = nil, want non-nil", tt.current, tt.latest)
				}
				return
			}
			if err != nil {
				t.Fatalf("NeedsUpdate(%q, %q) unexpected error: %v", tt.current, tt.latest, err)
			}
			if got != tt.want {
				t.Errorf("NeedsUpdate(%q, %q) = %v, want %v", tt.current, tt.latest, got, tt.want)
			}
		})
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && go test ./internal/selfupdate/... -run TestNeedsUpdate -v`
Expected: FAIL — `NeedsUpdate` undefined.

- [ ] **Step 4: Implement version compare**

```go
// backend/internal/selfupdate/version.go
package selfupdate

import (
	"fmt"

	"golang.org/x/mod/semver"
)

// NeedsUpdate reports whether latestTag is a newer semver version than
// currentVersion. currentVersion "dev" (an unreleased/local build with no
// version tag) is rejected — there's nothing meaningful to compare against.
func NeedsUpdate(currentVersion, latestTag string) (bool, error) {
	if currentVersion == "dev" {
		return false, fmt.Errorf("running a dev build (no version tag) — can't check for updates")
	}

	current := withVPrefix(currentVersion)
	latest := withVPrefix(latestTag)

	if !semver.IsValid(current) {
		return false, fmt.Errorf("current version %q is not a valid semver tag", currentVersion)
	}
	if !semver.IsValid(latest) {
		return false, fmt.Errorf("latest release tag %q is not a valid semver tag", latestTag)
	}

	return semver.Compare(latest, current) > 0, nil
}

func withVPrefix(tag string) string {
	if tag != "" && tag[0] != 'v' {
		return "v" + tag
	}
	return tag
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/selfupdate/... -run TestNeedsUpdate -v`
Expected: PASS — all six subtests.

- [ ] **Step 6: Commit**

```bash
git add backend/go.mod backend/go.sum backend/internal/selfupdate/version.go backend/internal/selfupdate/version_test.go
git commit -m "feat: add semver version compare for self-update"
```

---

### Task 4: Release asset naming and selection

**Files:**
- Create: `backend/internal/selfupdate/asset.go`
- Test: `backend/internal/selfupdate/asset_test.go`

**Interfaces:**
- Consumes: `selfupdate.Asset` (from Task 2).
- Produces: `selfupdate.AssetName(goos, goarch string) string`, `selfupdate.PickAsset(assets []Asset, goos, goarch string) (Asset, error)` — consumed by Task 6 (`Run`).

- [ ] **Step 1: Write the failing tests**

```go
// backend/internal/selfupdate/asset_test.go
package selfupdate

import "testing"

func TestAssetName(t *testing.T) {
	tests := []struct {
		goos, goarch, want string
	}{
		{goos: "darwin", goarch: "amd64", want: "loom-darwin-amd64"},
		{goos: "darwin", goarch: "arm64", want: "loom-darwin-arm64"},
		{goos: "linux", goarch: "amd64", want: "loom-linux-amd64"},
		{goos: "linux", goarch: "arm64", want: "loom-linux-arm64"},
		{goos: "windows", goarch: "amd64", want: "loom-windows-amd64.exe"},
		{goos: "windows", goarch: "arm64", want: "loom-windows-arm64.exe"},
	}
	for _, tt := range tests {
		if got := AssetName(tt.goos, tt.goarch); got != tt.want {
			t.Errorf("AssetName(%q, %q) = %q, want %q", tt.goos, tt.goarch, got, tt.want)
		}
	}
}

func TestPickAsset(t *testing.T) {
	assets := []Asset{
		{Name: "loom-darwin-amd64", ID: 1},
		{Name: "loom-linux-amd64", ID: 2},
	}

	got, err := PickAsset(assets, "linux", "amd64")
	if err != nil {
		t.Fatalf("PickAsset() error = %v", err)
	}
	if got.ID != 2 {
		t.Errorf("PickAsset() ID = %d, want 2", got.ID)
	}

	if _, err := PickAsset(assets, "windows", "arm64"); err == nil {
		t.Fatal("PickAsset() error = nil, want non-nil for a missing platform asset")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/selfupdate/... -run 'TestAssetName|TestPickAsset' -v`
Expected: FAIL — `AssetName`/`PickAsset` undefined.

- [ ] **Step 3: Implement**

```go
// backend/internal/selfupdate/asset.go
package selfupdate

import "fmt"

// AssetName returns the release asset filename for a platform, matching the
// naming `make portable-all` produces (see Makefile's portable-all target).
func AssetName(goos, goarch string) string {
	name := fmt.Sprintf("loom-%s-%s", goos, goarch)
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

// PickAsset finds the asset matching goos/goarch, or an error naming the
// platform if the release doesn't have one (e.g. it was cut without running
// portable-all for that platform combo).
func PickAsset(assets []Asset, goos, goarch string) (Asset, error) {
	name := AssetName(goos, goarch)
	for _, a := range assets {
		if a.Name == name {
			return a, nil
		}
	}
	return Asset{}, fmt.Errorf("no release asset named %q for %s/%s", name, goos, goarch)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/selfupdate/... -run 'TestAssetName|TestPickAsset' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/selfupdate/asset.go backend/internal/selfupdate/asset_test.go
git commit -m "feat: add release asset naming/selection for self-update"
```

---

### Task 5: Atomic binary replace

**Files:**
- Create: `backend/internal/selfupdate/replace.go`
- Test: `backend/internal/selfupdate/replace_test.go`

**Interfaces:**
- Produces: `selfupdate.ReplaceSelf(goos, execPath string, data []byte) error` — consumed by Task 6 (`Run`).

- [ ] **Step 1: Write the failing tests**

```go
// backend/internal/selfupdate/replace_test.go
package selfupdate

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReplaceSelf_Unix(t *testing.T) {
	dir := t.TempDir()
	execPath := filepath.Join(dir, "loom-api")
	if err := os.WriteFile(execPath, []byte("old-contents"), 0o755); err != nil {
		t.Fatalf("seed exec file: %v", err)
	}

	if err := ReplaceSelf("linux", execPath, []byte("new-contents")); err != nil {
		t.Fatalf("ReplaceSelf() error = %v", err)
	}

	got, err := os.ReadFile(execPath)
	if err != nil {
		t.Fatalf("read replaced file: %v", err)
	}
	if string(got) != "new-contents" {
		t.Errorf("content = %q, want %q", got, "new-contents")
	}

	info, err := os.Stat(execPath)
	if err != nil {
		t.Fatalf("stat replaced file: %v", err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Errorf("mode = %v, want an executable bit set", info.Mode())
	}

	assertNoLeftoverTempFiles(t, dir)
}

func TestReplaceSelf_Windows(t *testing.T) {
	dir := t.TempDir()
	execPath := filepath.Join(dir, "loom-api.exe")
	if err := os.WriteFile(execPath, []byte("old-contents"), 0o755); err != nil {
		t.Fatalf("seed exec file: %v", err)
	}

	if err := ReplaceSelf("windows", execPath, []byte("new-contents")); err != nil {
		t.Fatalf("ReplaceSelf() error = %v", err)
	}

	got, err := os.ReadFile(execPath)
	if err != nil {
		t.Fatalf("read replaced file: %v", err)
	}
	if string(got) != "new-contents" {
		t.Errorf("content = %q, want %q", got, "new-contents")
	}

	if _, err := os.Stat(execPath + ".old"); !os.IsNotExist(err) {
		t.Errorf(".old leftover file present or stat error: %v", err)
	}

	assertNoLeftoverTempFiles(t, dir)
}

func assertNoLeftoverTempFiles(t *testing.T, dir string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, ".loom-update-*"))
	if err != nil {
		t.Fatalf("glob temp files: %v", err)
	}
	if len(matches) != 0 {
		t.Errorf("leftover temp files: %v", matches)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/selfupdate/... -run TestReplaceSelf -v`
Expected: FAIL — `ReplaceSelf` undefined.

- [ ] **Step 3: Implement**

```go
// backend/internal/selfupdate/replace.go
package selfupdate

import (
	"fmt"
	"os"
	"path/filepath"
)

// ReplaceSelf atomically swaps the binary at execPath with data. On unix,
// os.Rename over the currently-executing file is safe — the running process
// keeps its old inode open, and the new file is what the next invocation
// sees. On windows, a running .exe can't be overwritten directly, so the
// current file is renamed aside first and best-effort cleaned up after.
//
// goos is passed explicitly (rather than read from runtime.GOOS) so both
// code paths are exercised in tests regardless of the host running them.
func ReplaceSelf(goos, execPath string, data []byte) error {
	dir := filepath.Dir(execPath)
	tmp, err := os.CreateTemp(dir, ".loom-update-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()

	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("write downloaded binary: %w", writeErr)
	}
	if closeErr != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close temp file: %w", closeErr)
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("chmod downloaded binary: %w", err)
	}

	if goos == "windows" {
		oldPath := execPath + ".old"
		os.Remove(oldPath) // best-effort: drop a leftover from a previous update
		if err := os.Rename(execPath, oldPath); err != nil {
			os.Remove(tmpPath)
			return fmt.Errorf("rename current binary aside: %w", err)
		}
		if err := os.Rename(tmpPath, execPath); err != nil {
			return fmt.Errorf("move new binary into place: %w", err)
		}
		os.Remove(oldPath) // best-effort cleanup; ignored if still locked
		return nil
	}

	if err := os.Rename(tmpPath, execPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("replace current binary: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/selfupdate/... -run TestReplaceSelf -v`
Expected: PASS — `TestReplaceSelf_Unix`, `TestReplaceSelf_Windows`.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/selfupdate/replace.go backend/internal/selfupdate/replace_test.go
git commit -m "feat: add atomic binary replace for self-update"
```

---

### Task 6: Orchestration (`Run`)

**Files:**
- Create: `backend/internal/selfupdate/run.go`
- Test: `backend/internal/selfupdate/run_test.go`

**Interfaces:**
- Consumes: `selfupdate.Release`/`Asset` (Task 2), `selfupdate.NeedsUpdate` (Task 3), `selfupdate.AssetName`/`PickAsset` (Task 4), `selfupdate.ReplaceSelf` (Task 5).
- Produces: `selfupdate.Owner`, `selfupdate.Repo` (string consts), `selfupdate.Options{CurrentVersion, ExecPath string}`, `selfupdate.Run(ctx context.Context, client releaseFetcher, opts Options) error` where `releaseFetcher` is an unexported 2-method interface satisfied by `*Client` — consumed by Task 7 (`main.go`).

- [ ] **Step 1: Write the failing tests**

```go
// backend/internal/selfupdate/run_test.go
package selfupdate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type fakeClient struct {
	release        *Release
	releaseErr     error
	assetData      []byte
	downloadCalled bool
}

func (f *fakeClient) LatestRelease(ctx context.Context) (*Release, error) {
	if f.releaseErr != nil {
		return nil, f.releaseErr
	}
	return f.release, nil
}

func (f *fakeClient) DownloadAsset(ctx context.Context, asset Asset) ([]byte, error) {
	f.downloadCalled = true
	return f.assetData, nil
}

func seedExecFile(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "loom-api")
	if err := os.WriteFile(path, []byte("old-contents"), 0o755); err != nil {
		t.Fatalf("seed exec file: %v", err)
	}
	return path
}

func TestRun_InstallsNewerVersion(t *testing.T) {
	execPath := seedExecFile(t)
	assetName := AssetName(runtime.GOOS, runtime.GOARCH)
	client := &fakeClient{
		release: &Release{
			TagName: "v9.9.9",
			Assets:  []Asset{{Name: assetName, ID: 1}},
		},
		assetData: []byte("new-contents"),
	}

	err := Run(context.Background(), client, Options{CurrentVersion: "v1.0.0", ExecPath: execPath})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if !client.downloadCalled {
		t.Error("DownloadAsset was not called")
	}
	got, _ := os.ReadFile(execPath)
	if string(got) != "new-contents" {
		t.Errorf("exec file content = %q, want %q", got, "new-contents")
	}
}

func TestRun_AlreadyLatest(t *testing.T) {
	execPath := seedExecFile(t)
	client := &fakeClient{
		release: &Release{TagName: "v1.0.0"},
	}

	if err := Run(context.Background(), client, Options{CurrentVersion: "v1.0.0", ExecPath: execPath}); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if client.downloadCalled {
		t.Error("DownloadAsset was called even though already on latest")
	}
	got, _ := os.ReadFile(execPath)
	if string(got) != "old-contents" {
		t.Error("exec file was modified even though already on latest")
	}
}

func TestRun_DevBuildErrors(t *testing.T) {
	execPath := seedExecFile(t)
	client := &fakeClient{release: &Release{TagName: "v1.0.0"}}

	if err := Run(context.Background(), client, Options{CurrentVersion: "dev", ExecPath: execPath}); err == nil {
		t.Fatal("Run() error = nil, want non-nil for a dev build")
	}
}

func TestRun_NoMatchingAsset(t *testing.T) {
	execPath := seedExecFile(t)
	client := &fakeClient{
		release: &Release{TagName: "v9.9.9", Assets: []Asset{{Name: "loom-someother-arch", ID: 1}}},
	}

	if err := Run(context.Background(), client, Options{CurrentVersion: "v1.0.0", ExecPath: execPath}); err == nil {
		t.Fatal("Run() error = nil, want non-nil when no asset matches this platform")
	}
}

func TestRun_LatestReleaseFetchError(t *testing.T) {
	execPath := seedExecFile(t)
	client := &fakeClient{releaseErr: errors.New("boom")}

	if err := Run(context.Background(), client, Options{CurrentVersion: "v1.0.0", ExecPath: execPath}); err == nil {
		t.Fatal("Run() error = nil, want non-nil when fetching the latest release fails")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/selfupdate/... -run TestRun -v`
Expected: FAIL — `Run`/`Options` undefined.

- [ ] **Step 3: Implement**

```go
// backend/internal/selfupdate/run.go
package selfupdate

import (
	"context"
	"fmt"
	"log"
	"runtime"
)

// Owner and Repo identify this project's own GitHub repository — self-update
// isn't generic infrastructure, it's this app updating itself, so these are
// not configurable.
const (
	Owner = "ItsMyEyes"
	Repo  = "enginer-workspaces"
)

// releaseFetcher is the subset of *Client that Run depends on, so tests can
// substitute a fake instead of spinning up an HTTP server.
type releaseFetcher interface {
	LatestRelease(ctx context.Context) (*Release, error)
	DownloadAsset(ctx context.Context, asset Asset) ([]byte, error)
}

// Options configures Run.
type Options struct {
	// CurrentVersion is the running binary's embedded version (version.Version).
	CurrentVersion string
	// ExecPath is the path of the currently running executable to replace,
	// e.g. from os.Executable().
	ExecPath string
}

// Run checks the latest GitHub release against opts.CurrentVersion and, if
// newer, downloads and installs it in place of opts.ExecPath. It never
// restarts the process — the caller exits and the operator restarts Loom.
func Run(ctx context.Context, client releaseFetcher, opts Options) error {
	release, err := client.LatestRelease(ctx)
	if err != nil {
		return fmt.Errorf("check latest release: %w", err)
	}

	update, err := NeedsUpdate(opts.CurrentVersion, release.TagName)
	if err != nil {
		return err
	}
	if !update {
		log.Printf("already on latest version %s", opts.CurrentVersion)
		return nil
	}

	asset, err := PickAsset(release.Assets, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}

	log.Printf("downloading %s (%s)...", release.TagName, asset.Name)
	data, err := client.DownloadAsset(ctx, asset)
	if err != nil {
		return fmt.Errorf("download %s: %w", asset.Name, err)
	}

	if err := ReplaceSelf(runtime.GOOS, opts.ExecPath, data); err != nil {
		return fmt.Errorf("install update: %w", err)
	}

	log.Printf("updated to %s — restart loom to use it", release.TagName)
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/selfupdate/... -v`
Expected: PASS — every test in the `selfupdate` package (Tasks 2-6 combined).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/selfupdate/run.go backend/internal/selfupdate/run_test.go
git commit -m "feat: add self-update orchestration (Run)"
```

---

### Task 7: Wire `-updates` / `-github-token` into `main.go`

**Files:**
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `version.Version` (Task 1), `selfupdate.Owner`, `selfupdate.Repo`, `selfupdate.Client`, `selfupdate.Options`, `selfupdate.Run` (Tasks 2-6).

- [ ] **Step 1: Add imports**

In `backend/cmd/server/main.go`, add to the `import` block (alphabetically, after `"loom/backend/internal/registry"` and before `"loom/backend/internal/service"`):

```go
	"loom/backend/internal/selfupdate"
```

Add to the stdlib import group (alphabetically, as the very first entry, before `"crypto/rand"`):

```go
	"context"
```

- [ ] **Step 2: Add the flags**

Immediately after the `showVersion := flag.Bool(...)` line added in Task 1, add:

```go
	updates := flag.Bool("updates", false, "check for and install the latest release, then exit; does not restart the server (requires -github-token / LOOM_GITHUB_TOKEN)")
	githubToken := flag.String("github-token", envOr("LOOM_GITHUB_TOKEN", ""), "GitHub token used to check for and download updates from the private release repo")
```

- [ ] **Step 3: Handle `-updates` right after `-version`**

Immediately after the `if *showVersion { ... return }` block added in Task 1 (still before `config.LoadDotEnv`), add:

```go
	if *updates {
		if *githubToken == "" {
			log.Fatalf("--updates requires --github-token or LOOM_GITHUB_TOKEN")
		}
		execPath, err := os.Executable()
		if err != nil {
			log.Fatalf("--updates: resolve current executable path: %v", err)
		}
		client := &selfupdate.Client{
			Owner: selfupdate.Owner,
			Repo:  selfupdate.Repo,
			Token: *githubToken,
		}
		if err := selfupdate.Run(context.Background(), client, selfupdate.Options{
			CurrentVersion: version.Version,
			ExecPath:       execPath,
		}); err != nil {
			log.Fatalf("--updates: %v", err)
		}
		return
	}
```

- [ ] **Step 4: Verify it builds and the flag paths behave**

Run: `cd /Users/kiyora/Documents/explorer/agent/enginer.kiyora.dev && make build-api`
Expected: builds cleanly.

Run: `./backend/loom-api --updates`
Expected: exits immediately with `--updates requires --github-token or LOOM_GITHUB_TOKEN` (no token supplied) — confirms the flag is wired and the missing-token guard works. (A full real update round-trip isn't verifiable locally — it requires an actual published GitHub release and a valid token; out of scope for this step.)

Run: `go vet ./...` (from `backend/`)
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/server/main.go
git commit -m "feat: wire --updates/--github-token flags into main.go"
```

---

### Task 8: GitHub Actions CI workflow (unit tests)

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/test.yml
name: Test

on:
  push:
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version-file: backend/go.mod

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Go vet
        run: cd backend && go vet ./...

      - name: Go test
        run: cd backend && go test ./...

      - name: Frontend install
        run: cd frontend && npm ci

      - name: Frontend typecheck
        run: cd frontend && npm run typecheck
```

- [ ] **Step 2: Verify the YAML parses**

Run (from repo root):

```bash
mkdir -p /tmp/yamlcheck && cd /tmp/yamlcheck && cat > go.mod <<'EOF'
module yamlcheck

go 1.21

require gopkg.in/yaml.v3 v3.0.1
EOF
cat > main.go <<'EOF'
package main

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

func main() {
	for _, path := range os.Args[1:] {
		data, err := os.ReadFile(path)
		if err != nil {
			fmt.Printf("%s: %v\n", path, err)
			os.Exit(1)
		}
		var out any
		if err := yaml.Unmarshal(data, &out); err != nil {
			fmt.Printf("%s: INVALID: %v\n", path, err)
			os.Exit(1)
		}
		fmt.Printf("%s: OK\n", path)
	}
}
EOF
GOPROXY=off GOFLAGS=-mod=mod go mod tidy
go run . /Users/kiyora/Documents/explorer/agent/enginer.kiyora.dev/.github/workflows/test.yml
```

Expected: `.../test.yml: OK`. (This scratch module is throwaway — it lives in `/tmp`, not the repo — and only checks YAML syntax, not GitHub Actions schema semantics.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add GitHub Actions test workflow"
```

---

### Task 9: GitHub Actions release workflow (build + publish)

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - 'v*.*.*'

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-go@v5
        with:
          go-version-file: backend/go.mod

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Go vet
        run: cd backend && go vet ./...

      - name: Go test
        run: cd backend && go test ./...

      - name: Frontend install
        run: cd frontend && npm ci

      - name: Frontend typecheck
        run: cd frontend && npm run typecheck

      - name: Build release binaries
        run: make portable-all

      - name: Create GitHub release
        uses: softprops/action-gh-release@v2
        with:
          files: dist/loom-*
          generate_release_notes: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`fetch-depth: 0` is required so `git describe --tags` (used by the `Makefile`'s `VERSION` variable) can see the pushed tag rather than a shallow clone with no tag history.

- [ ] **Step 2: Verify the YAML parses**

Run (reusing the scratch checker from Task 8 — recreate it if `/tmp/yamlcheck` was cleaned up):

```bash
cd /tmp/yamlcheck && go run . /Users/kiyora/Documents/explorer/agent/enginer.kiyora.dev/.github/workflows/release.yml
```

Expected: `.../release.yml: OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add GitHub Actions release workflow"
```

---

### Task 10: Documentation

**Files:**
- Modify: `COMMANDS.md`

- [ ] **Step 1: Document the new flags**

In `COMMANDS.md`, after the existing bullet:

```
- `--python-bin` / `--pandoc-bin` / `--mmdc-bin` — external binaries the Tools
  module shells out to (env `LOOM_PYTHON_BIN` / `LOOM_PANDOC_BIN` /
  `LOOM_MMDC_BIN`). `--python-bin` defaults to `./tools/venv/bin/python3` if
  that venv exists (see Tools module setup below), else `python3` on PATH.
```

add:

```
- `--version` — print the running build's version (embedded at build time
  from the git tag, see Versioning below) and exit.
- `--updates` — check the latest GitHub release against the running version
  and, if newer, download and install it in place, then exit (it does not
  restart the server — restart it yourself once it prints the new version).
  Requires `--github-token` / `LOOM_GITHUB_TOKEN` since the release repo is
  private.
- `--github-token` — GitHub token used by `--updates` to read releases and
  download assets from the private repo (env `LOOM_GITHUB_TOKEN`).
```

- [ ] **Step 2: Document the release/versioning flow**

In `COMMANDS.md`, after the existing `## Build` section's closing text:

```
`make build` writes `backend/loom-api`. Portable builds are written to `dist/`.
The executable creates `data/loom.db` beside itself on first launch. Node.js and
Go are build-time dependencies only; end users still need Git and their selected
coding-agent CLI installed.
```

add a new section:

```markdown
## Versioning / releases

Every build embeds a version string via `-ldflags -X
loom/backend/internal/version.Version=...`, computed by the `Makefile` from
`git describe --tags --always --dirty` (falls back to `dev` for an untagged
build). `--version` prints it; `--updates` uses it to decide whether a newer
release is available.

To cut a release: push an annotated semver tag (`git tag -a v1.2.3 -m
v1.2.3 && git push origin v1.2.3`). The `release.yml` GitHub Actions workflow
then runs the test suite, `make portable-all`, and publishes a GitHub Release
for that tag with all 6 platform binaries attached.
```

- [ ] **Step 3: Commit**

```bash
git add COMMANDS.md
git commit -m "docs: document versioning, --updates, and the release flow"
```

---

### Task 11: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `cd backend && go vet ./... && go test ./...`
Expected: all packages pass, including the new `internal/selfupdate` package and every pre-existing package.

- [ ] **Step 2: Run the frontend typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no new errors introduced by this work. (A pre-existing unrelated error in `src/features/screens/OnboardingScreen.tsx` — an unused `loadDemo` variable — may still be present; that's not part of this plan's scope.)

- [ ] **Step 3: Full production build**

Run: `cd /Users/kiyora/Documents/explorer/agent/enginer.kiyora.dev && make build-api`
Expected: builds cleanly; `backend/loom-api --version` prints a non-`dev` string.

- [ ] **Step 4: Confirm portable-all still works end to end**

Run: `make portable-all`
Expected: `dist/` contains all 6 binaries (`loom-darwin-amd64`, `loom-darwin-arm64`, `loom-linux-amd64`, `loom-linux-arm64`, `loom-windows-amd64.exe`, `loom-windows-arm64.exe`), each built with the same injected version.

No commit for this task — it's a verification-only pass over work already committed in Tasks 1-10.

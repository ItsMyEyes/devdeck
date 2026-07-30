# Version, sha256 & Update UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the running build's version and sha256 in the DevDeck UI, let the operator check GitHub for a newer release, and install it per machine.

**Architecture:** Three new auth-gated `/api/self/*` routes on every runtime (version, update-check, update), proxied per-machine by the hub through `machineclient` exactly as `/api/self/restart` already is. The existing `internal/selfupdate` package grows an update *check* (as opposed to install), sha256 verification against the release's `checksums.txt`, and an optional GitHub token. The frontend adds a Version section to `DesktopSettingsDialog` and a version chip + update action to the Machines page.

**Tech Stack:** Go 1.25 (stdlib `crypto/sha256`, `net/http`, `golang.org/x/mod/semver` — all already vendored), React 19 + TanStack Query + zustand + Tailwind v4, `lucide-react` icons, `sonner` toasts.

**Spec:** `docs/superpowers/specs/2026-07-30-version-sha256-update-ui-design.md`

## Global Constraints

- All API responses use the `{"error":"message"}` envelope. Go handlers use `writeErr` / `handleStoreErr`; never return raw errors from the store layer to clients. (`CONTRACTS.md`)
- Go: run `go vet ./...` and `go test ./...` from `backend/` before every commit.
- Frontend: run `npm run typecheck` from `frontend/` before every commit. There is no frontend test runner in this repo — typecheck is the gate.
- Frontend imports use the `@/*` alias. Never relative paths into `src/`.
- `verbatimModuleSyntax` is on — type-only imports must use `import type`.
- Icons come from `lucide-react` only. Toasts come from `sonner`.
- Design is dark-only; use existing `devdeck-*` Tailwind tokens. Copy the class strings from the surrounding component rather than inventing new ones.
- Never hand-edit `frontend/src/routeTree.gen.ts`.
- The GitHub token is read per-process from `--github-token` / `DEVDECK_GITHUB_TOKEN` / `devdeck.yaml: updates.github_token`. It must never be written to the store, sent to the browser, or forwarded hub → runtime. Only the boolean `tokenConfigured` crosses those boundaries.
- Release asset naming is `devdeck-runtime-<goos>-<goarch>` (`.exe` suffix on Windows) — already implemented by `selfupdate.AssetName`. The checksum manifest asset is `checksums.txt`.
- `backend/cmd/server/main.go` and `frontend/src/store/useDevDeckStore.ts` are convergence files (`ORCHESTRATION.md`). Only Task 9 and Task 12 touch them respectively.

---

### Task 1: `version.SelfSHA256()`

**Files:**
- Create: `backend/internal/version/selfhash.go`
- Test: `backend/internal/version/selfhash_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `version.SelfSHA256() (string, error)` — lowercase hex SHA-256 of the running executable, computed once and cached for the process lifetime.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/version/selfhash_test.go`:

```go
package version

import (
	"os"
	"path/filepath"
	"testing"
)

// Known-answer vectors from the SHA-256 spec, so the test proves we hash
// correctly rather than just agreeing with ourselves.
const (
	emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	abcDigest   = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
)

func TestHashFileMatchesKnownDigests(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name     string
		contents string
		want     string
	}{
		{"empty file", "", emptyDigest},
		{"abc", "abc", abcDigest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, tc.name)
			if err := os.WriteFile(path, []byte(tc.contents), 0o600); err != nil {
				t.Fatal(err)
			}
			got, err := hashFile(path)
			if err != nil {
				t.Fatalf("hashFile() error = %v", err)
			}
			if got != tc.want {
				t.Errorf("hashFile() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestHashFileErrorsOnMissingFile(t *testing.T) {
	if _, err := hashFile(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("hashFile() error = nil, want non-nil for a missing file")
	}
}

func TestSelfSHA256IsStableAcrossCalls(t *testing.T) {
	first, err := SelfSHA256()
	if err != nil {
		t.Fatalf("SelfSHA256() error = %v", err)
	}
	if len(first) != 64 {
		t.Fatalf("SelfSHA256() = %q, want 64 hex chars", first)
	}
	second, err := SelfSHA256()
	if err != nil {
		t.Fatalf("second SelfSHA256() error = %v", err)
	}
	if second != first {
		t.Errorf("SelfSHA256() returned %q then %q, want a stable cached value", first, second)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/version/ -run 'HashFile|SelfSHA256' -v`
Expected: FAIL — `undefined: hashFile`, `undefined: SelfSHA256`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/internal/version/selfhash.go`:

```go
package version

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"sync"
)

var (
	selfHashOnce sync.Once
	selfHash     string
	selfHashErr  error
)

// SelfSHA256 returns the lowercase hex SHA-256 of the executable this process
// is running, so the operator can match a deployed binary against the digest
// its release published in checksums.txt.
//
// The digest is computed on first call rather than at startup — a ~60MB binary
// costs ~100ms to hash, and most runs never ask for it — then cached for the
// process lifetime. Caching is also what makes the answer correct across a
// self-update: replacing the binary swaps the directory entry while this
// process keeps executing the old inode, so the first digest keeps describing
// the code actually running until someone restarts.
func SelfSHA256() (string, error) {
	selfHashOnce.Do(func() {
		exe, err := os.Executable()
		if err != nil {
			selfHashErr = fmt.Errorf("resolve executable path: %w", err)
			return
		}
		selfHash, selfHashErr = hashFile(exe)
	})
	return selfHash, selfHashErr
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/version/ -v && go vet ./internal/version/`
Expected: PASS, no vet output.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/version/selfhash.go backend/internal/version/selfhash_test.go
git commit -m "feat(version): add cached SelfSHA256 of the running executable"
```

---

### Task 2: Checksum manifest parsing

**Files:**
- Create: `backend/internal/selfupdate/checksums.go`
- Test: `backend/internal/selfupdate/checksums_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `selfupdate.ChecksumsFileName` = `"checksums.txt"`
  - `selfupdate.ErrChecksumNotListed` — sentinel returned when a name is absent from a manifest
  - `selfupdate.ChecksumFor(manifest []byte, name string) (string, error)`
  - `selfupdate.VerifySHA256(data []byte, wantHex string) error`

- [ ] **Step 1: Write the failing test**

Create `backend/internal/selfupdate/checksums_test.go`:

```go
package selfupdate

import (
	"errors"
	"strings"
	"testing"
)

// Real sha256sum output shape: "<hex>  <name>" (two spaces), with a "*"
// prefix on the name in binary mode.
const manifest = `
9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  devdeck-runtime-linux-amd64
ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad *devdeck-runtime-windows-amd64.exe
not-a-valid-line
`

func TestChecksumForFindsTheNamedEntry(t *testing.T) {
	got, err := ChecksumFor([]byte(manifest), "devdeck-runtime-linux-amd64")
	if err != nil {
		t.Fatalf("ChecksumFor() error = %v", err)
	}
	want := "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
	if got != want {
		t.Errorf("ChecksumFor() = %q, want %q", got, want)
	}
}

func TestChecksumForStripsBinaryModeStar(t *testing.T) {
	got, err := ChecksumFor([]byte(manifest), "devdeck-runtime-windows-amd64.exe")
	if err != nil {
		t.Fatalf("ChecksumFor() error = %v", err)
	}
	want := "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got != want {
		t.Errorf("ChecksumFor() = %q, want %q", got, want)
	}
}

func TestChecksumForReportsAMissingName(t *testing.T) {
	_, err := ChecksumFor([]byte(manifest), "devdeck-runtime-darwin-arm64")
	if !errors.Is(err, ErrChecksumNotListed) {
		t.Fatalf("ChecksumFor() error = %v, want ErrChecksumNotListed", err)
	}
	if !strings.Contains(err.Error(), "devdeck-runtime-darwin-arm64") {
		t.Errorf("error %q should name the asset it looked for", err)
	}
}

func TestVerifySHA256AcceptsAMatch(t *testing.T) {
	// sha256("abc")
	if err := VerifySHA256([]byte("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); err != nil {
		t.Fatalf("VerifySHA256() error = %v, want nil", err)
	}
}

func TestVerifySHA256IsCaseInsensitive(t *testing.T) {
	if err := VerifySHA256([]byte("abc"), "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"); err != nil {
		t.Fatalf("VerifySHA256() error = %v, want nil for an uppercase digest", err)
	}
}

func TestVerifySHA256RejectsAMismatchAndNamesBothDigests(t *testing.T) {
	want := "0000000000000000000000000000000000000000000000000000000000000000"
	err := VerifySHA256([]byte("abc"), want)
	if err == nil {
		t.Fatal("VerifySHA256() error = nil, want non-nil for a mismatched digest")
	}
	if !strings.Contains(err.Error(), want) || !strings.Contains(err.Error(), "ba7816bf") {
		t.Errorf("error %q should name both the expected and the actual digest", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/selfupdate/ -run 'ChecksumFor|VerifySHA256' -v`
Expected: FAIL — `undefined: ChecksumFor`, `undefined: VerifySHA256`, `undefined: ErrChecksumNotListed`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/internal/selfupdate/checksums.go`:

```go
package selfupdate

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// ChecksumsFileName is the sha256 manifest published alongside the binaries by
// .github/workflows/release.yml (`sha256sum devdeck-runtime-* > checksums.txt`).
const ChecksumsFileName = "checksums.txt"

// ErrChecksumNotListed means the manifest parsed fine but has no entry for the
// requested asset — distinct from "the release has no manifest at all", which
// callers treat as a warning rather than a failure.
var ErrChecksumNotListed = errors.New("asset not listed in the checksum manifest")

// ChecksumFor returns the hex digest recorded for name in a sha256sum-format
// manifest. Lines are "<hex>  <name>", with an optional "*" prefix on the name
// in binary mode. Malformed and blank lines are skipped rather than fatal — a
// future release could add a header line without breaking updates.
func ChecksumFor(manifest []byte, name string) (string, error) {
	scanner := bufio.NewScanner(bytes.NewReader(manifest))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 {
			continue
		}
		if strings.TrimPrefix(fields[1], "*") == name {
			return strings.ToLower(fields[0]), nil
		}
	}
	return "", fmt.Errorf("%w: %s", ErrChecksumNotListed, name)
}

// VerifySHA256 reports whether data hashes to wantHex, naming both digests on
// mismatch so a failure says what was expected and what arrived.
func VerifySHA256(data []byte, wantHex string) error {
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	if !strings.EqualFold(got, wantHex) {
		return fmt.Errorf("checksum mismatch: got %s, want %s", got, strings.ToLower(wantHex))
	}
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/selfupdate/ -v && go vet ./internal/selfupdate/`
Expected: PASS (existing selfupdate tests still pass too), no vet output.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/selfupdate/checksums.go backend/internal/selfupdate/checksums_test.go
git commit -m "feat(selfupdate): parse and verify release checksum manifests"
```

---

### Task 3: Optional token + fetch a release by tag

**Files:**
- Modify: `backend/internal/selfupdate/github.go`
- Test: `backend/internal/selfupdate/github_test.go` (append)

**Interfaces:**
- Consumes: `selfupdate.Client`, `selfupdate.Release` (already exist).
- Produces:
  - `Client.ReleaseByTag(ctx context.Context, tag string) (*Release, error)`
  - `selfupdate.ErrReleaseNotFound` — sentinel for a 404 from `ReleaseByTag`
  - `Client` no longer sends an `Authorization` header when `Token` is empty.

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/selfupdate/github_test.go`:

```go
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
```

Add `"errors"` and `"strings"` to that file's import block.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/selfupdate/ -run 'Client_' -v`
Expected: FAIL — `undefined: ErrReleaseNotFound`, `client.ReleaseByTag undefined`, and `TestClient_OmitsAuthorizationWhenTokenIsEmpty` failing because the header is always set.

- [ ] **Step 3: Write minimal implementation**

In `backend/internal/selfupdate/github.go`, add `"errors"` to the imports, then add the sentinel and helper below the `Client` methods that already exist:

```go
// ErrReleaseNotFound means GitHub has no release for the requested tag. It is
// a normal answer, not a failure: a binary built from an untagged commit, or
// from a tag whose release was deleted, simply has nothing to verify against.
var ErrReleaseNotFound = errors.New("release not found")

// authError turns the statuses that mean "you probably need credentials" into
// a message naming the fix, since the repo may be private and the
// unauthenticated API rate limit is only 60 requests/hour.
func authError(status int, what string) error {
	if status == http.StatusUnauthorized || status == http.StatusForbidden || status == http.StatusNotFound {
		return fmt.Errorf("github: status %d %s — the repo may be private or the API rate limit was hit; set --github-token / DEVDECK_GITHUB_TOKEN on this machine", status, what)
	}
	return fmt.Errorf("github: unexpected status %d %s", status, what)
}

// setHeaders applies the standard GitHub API headers. The Authorization
// header is omitted entirely when Token is empty — the repo is public, so an
// unauthenticated request is valid, and sending "Bearer " with nothing after
// it is a malformed credential GitHub may reject outright.
func (c *Client) setHeaders(req *http.Request, accept string) {
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	req.Header.Set("Accept", accept)
}

// ReleaseByTag fetches the release published for exactly this tag, used to
// look up the checksum manifest for the version already running.
func (c *Client) ReleaseByTag(ctx context.Context, tag string) (*Release, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/releases/tags/%s", c.baseURL(), c.Owner, c.Repo, tag)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	c.setHeaders(req, "application/vnd.github+json")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("request release %s: %w", tag, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%w: %s", ErrReleaseNotFound, tag)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, authError(resp.StatusCode, "fetching release "+tag)
	}

	var release Release
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, fmt.Errorf("decode release %s response: %w", tag, err)
	}
	return &release, nil
}
```

Then rewrite the header/status lines in the two existing methods to use the new helpers.

In `LatestRelease`, replace:

```go
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
```

with:

```go
	c.setHeaders(req, "application/vnd.github+json")
```

and replace:

```go
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github: unexpected status %d fetching latest release", resp.StatusCode)
	}
```

with:

```go
	if resp.StatusCode != http.StatusOK {
		return nil, authError(resp.StatusCode, "fetching latest release")
	}
```

In `DownloadAsset`, replace:

```go
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "application/octet-stream")
```

with:

```go
	c.setHeaders(req, "application/octet-stream")
```

and replace:

```go
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github: unexpected status %d downloading asset %s", resp.StatusCode, asset.Name)
	}
```

with:

```go
	if resp.StatusCode != http.StatusOK {
		return nil, authError(resp.StatusCode, "downloading asset "+asset.Name)
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/selfupdate/ -v && go vet ./internal/selfupdate/`
Expected: PASS. The pre-existing `TestClient_LatestRelease` still asserts `Bearer test-token` and must keep passing — that client sets a token.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/selfupdate/github.go backend/internal/selfupdate/github_test.go
git commit -m "feat(selfupdate): make the GitHub token optional and add ReleaseByTag"
```

---

### Task 4: `Check`, verified `Run`, and the `Updater` facade

**Files:**
- Modify: `backend/internal/selfupdate/run.go`
- Test: `backend/internal/selfupdate/run_test.go`

**Interfaces:**
- Consumes: Task 2's `ChecksumFor` / `VerifySHA256` / `ChecksumsFileName` / `ErrChecksumNotListed`; Task 3's `ReleaseByTag` / `ErrReleaseNotFound`.
- Produces:
  - `selfupdate.CheckResult{Current, Latest string; UpdateAvailable bool; ChecksumVerified string; AssetName string}` with JSON tags `current`, `latest`, `updateAvailable`, `checksumVerified`, `assetName`
  - `selfupdate.RunResult{Updated bool; Version string; Warning string}`
  - `selfupdate.Check(ctx, client taggedReleaseFetcher, currentVersion, selfSHA256 string) (*CheckResult, error)`
  - `selfupdate.Run(ctx, client releaseFetcher, opts Options) (*RunResult, error)` — **signature changed**, previously returned only `error`
  - `selfupdate.Updater{Client *Client}` with `Check(ctx, currentVersion, selfSHA256 string) (*CheckResult, error)` and `Install(ctx, currentVersion, execPath string) (*RunResult, error)`
  - `ChecksumVerifiedMatch = "match"`, `ChecksumVerifiedMismatch = "mismatch"`, `ChecksumVerifiedUnknown = "unknown"`

- [ ] **Step 1: Write the failing test**

Replace the `fakeClient` block at the top of `backend/internal/selfupdate/run_test.go` with a version that can serve assets by ID and answer `ReleaseByTag`:

```go
type fakeClient struct {
	release        *Release
	releaseErr     error
	taggedRelease  *Release
	taggedErr      error
	assetData      map[int64][]byte
	downloadCalled bool
}

func (f *fakeClient) LatestRelease(ctx context.Context) (*Release, error) {
	if f.releaseErr != nil {
		return nil, f.releaseErr
	}
	return f.release, nil
}

func (f *fakeClient) ReleaseByTag(ctx context.Context, tag string) (*Release, error) {
	if f.taggedErr != nil {
		return nil, f.taggedErr
	}
	return f.taggedRelease, nil
}

func (f *fakeClient) DownloadAsset(ctx context.Context, asset Asset) ([]byte, error) {
	f.downloadCalled = true
	data, ok := f.assetData[asset.ID]
	if !ok {
		return nil, errors.New("no such asset")
	}
	return data, nil
}

// sha256Hex is the digest helper the release workflow's `sha256sum` produces.
func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// releaseWithChecksums builds a Release carrying the platform binary plus a
// matching checksums.txt, the exact shape release.yml publishes.
func releaseWithChecksums(tag string, binary []byte) (*Release, map[int64][]byte) {
	name := AssetName(runtime.GOOS, runtime.GOARCH)
	manifest := []byte(sha256Hex(binary) + "  " + name + "\n")
	return &Release{
			TagName: tag,
			Assets: []Asset{
				{Name: name, ID: 1},
				{Name: ChecksumsFileName, ID: 2},
			},
		}, map[int64][]byte{
			1: binary,
			2: manifest,
		}
}
```

Add `"crypto/sha256"`, `"encoding/hex"`, and `"strings"` to that file's imports.

Every pre-existing test in this file constructs `fakeClient{assetData: []byte(...)}` and calls `Run(...)` expecting a single `error`. Update each one to the new map-based field and two-value return — the existing assertions stay otherwise identical.

Then append the new tests:

```go
func TestRunVerifiesTheDownloadAgainstChecksums(t *testing.T) {
	execPath := seedExecFile(t)
	release, assets := releaseWithChecksums("v9.9.9", []byte("new-contents"))
	client := &fakeClient{release: release, assetData: assets}

	res, err := Run(context.Background(), client, Options{CurrentVersion: "v1.0.0", ExecPath: execPath})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if !res.Updated || res.Version != "v9.9.9" {
		t.Errorf("result = %+v, want Updated with version v9.9.9", res)
	}
	if res.Warning != "" {
		t.Errorf("Warning = %q, want empty when checksums.txt verified", res.Warning)
	}
	got, err := os.ReadFile(execPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new-contents" {
		t.Errorf("installed binary = %q, want %q", got, "new-contents")
	}
}

func TestRunAbortsOnChecksumMismatchAndLeavesTheBinaryUntouched(t *testing.T) {
	execPath := seedExecFile(t)
	name := AssetName(runtime.GOOS, runtime.GOARCH)
	// A manifest that describes different bytes than the asset actually serves.
	manifest := []byte(sha256Hex([]byte("what-we-expected")) + "  " + name + "\n")
	client := &fakeClient{
		release: &Release{
			TagName: "v9.9.9",
			Assets:  []Asset{{Name: name, ID: 1}, {Name: ChecksumsFileName, ID: 2}},
		},
		assetData: map[int64][]byte{1: []byte("tampered-contents"), 2: manifest},
	}

	_, err := Run(context.Background(), client, Options{CurrentVersion: "v1.0.0", ExecPath: execPath})
	if err == nil {
		t.Fatal("Run() error = nil, want non-nil for a checksum mismatch")
	}
	if !strings.Contains(err.Error(), "checksum mismatch") {
		t.Errorf("error = %v, want it to name the checksum mismatch", err)
	}
	got, err := os.ReadFile(execPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "old-contents" {
		t.Errorf("binary = %q, want the original %q left untouched", got, "old-contents")
	}
	entries, err := os.ReadDir(filepath.Dir(execPath))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Errorf("directory has %d entries, want 1 — a rejected download must leave no temp file", len(entries))
	}
}

func TestRunWarnsWhenTheReleaseHasNoChecksums(t *testing.T) {
	execPath := seedExecFile(t)
	name := AssetName(runtime.GOOS, runtime.GOARCH)
	client := &fakeClient{
		release:   &Release{TagName: "v9.9.9", Assets: []Asset{{Name: name, ID: 1}}},
		assetData: map[int64][]byte{1: []byte("new-contents")},
	}

	res, err := Run(context.Background(), client, Options{CurrentVersion: "v1.0.0", ExecPath: execPath})
	if err != nil {
		t.Fatalf("Run() error = %v, want the install to proceed (matching install.sh)", err)
	}
	if res.Warning == "" {
		t.Error("Warning = empty, want a warning that the release published no checksums.txt")
	}
	got, _ := os.ReadFile(execPath)
	if string(got) != "new-contents" {
		t.Errorf("installed binary = %q, want %q", got, "new-contents")
	}
}

func TestCheckReportsAnAvailableUpdate(t *testing.T) {
	binary := []byte("running-binary")
	tagged, assets := releaseWithChecksums("v1.0.0", binary)
	client := &fakeClient{
		release:       &Release{TagName: "v2.0.0"},
		taggedRelease: tagged,
		assetData:     assets,
	}

	res, err := Check(context.Background(), client, "v1.0.0", sha256Hex(binary))
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if res.Latest != "v2.0.0" || !res.UpdateAvailable {
		t.Errorf("result = %+v, want v2.0.0 available", res)
	}
	if res.ChecksumVerified != ChecksumVerifiedMatch {
		t.Errorf("ChecksumVerified = %q, want %q", res.ChecksumVerified, ChecksumVerifiedMatch)
	}
}

func TestCheckFlagsATamperedLocalBinary(t *testing.T) {
	tagged, assets := releaseWithChecksums("v1.0.0", []byte("what-the-release-published"))
	client := &fakeClient{
		release:       &Release{TagName: "v1.0.0"},
		taggedRelease: tagged,
		assetData:     assets,
	}

	res, err := Check(context.Background(), client, "v1.0.0", sha256Hex([]byte("something-else")))
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if res.UpdateAvailable {
		t.Error("UpdateAvailable = true, want false when already on the latest tag")
	}
	if res.ChecksumVerified != ChecksumVerifiedMismatch {
		t.Errorf("ChecksumVerified = %q, want %q", res.ChecksumVerified, ChecksumVerifiedMismatch)
	}
}

func TestCheckReportsUnknownWhenTheReleaseIsGone(t *testing.T) {
	client := &fakeClient{
		release:   &Release{TagName: "v2.0.0"},
		taggedErr: ErrReleaseNotFound,
	}

	res, err := Check(context.Background(), client, "v1.0.0", strings.Repeat("a", 64))
	if err != nil {
		t.Fatalf("Check() error = %v, want a missing release to be a normal answer", err)
	}
	if res.ChecksumVerified != ChecksumVerifiedUnknown {
		t.Errorf("ChecksumVerified = %q, want %q", res.ChecksumVerified, ChecksumVerifiedUnknown)
	}
}

func TestCheckRejectsADevBuild(t *testing.T) {
	client := &fakeClient{release: &Release{TagName: "v2.0.0"}}
	if _, err := Check(context.Background(), client, "dev", ""); err == nil {
		t.Fatal("Check() error = nil, want non-nil for a dev build")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/selfupdate/ -v`
Expected: FAIL — `undefined: Check`, `undefined: ChecksumVerifiedMatch`, and `Run(...) used as value` where the tests take two return values.

- [ ] **Step 3: Write minimal implementation**

Rewrite `backend/internal/selfupdate/run.go` below the existing `Owner`/`Repo` constants:

```go
// Checksum verification outcomes for the running binary, compared against the
// manifest its own release published. "unknown" is a normal answer — a dev
// build, a deleted release, or a release cut without checksums.txt all land
// there — never an error.
const (
	ChecksumVerifiedMatch    = "match"
	ChecksumVerifiedMismatch = "mismatch"
	ChecksumVerifiedUnknown  = "unknown"
)

// releaseFetcher is the subset of *Client that Run depends on, so tests can
// substitute a fake instead of spinning up an HTTP server.
type releaseFetcher interface {
	LatestRelease(ctx context.Context) (*Release, error)
	DownloadAsset(ctx context.Context, asset Asset) ([]byte, error)
}

// taggedReleaseFetcher adds the by-tag lookup Check needs to find the manifest
// for the version already running.
type taggedReleaseFetcher interface {
	releaseFetcher
	ReleaseByTag(ctx context.Context, tag string) (*Release, error)
}

// Options configures Run.
type Options struct {
	// CurrentVersion is the running binary's embedded version (version.Version).
	CurrentVersion string
	// ExecPath is the path of the currently running executable to replace,
	// e.g. from os.Executable().
	ExecPath string
}

// CheckResult describes what a check found, without changing anything.
type CheckResult struct {
	Current         string `json:"current"`
	Latest          string `json:"latest"`
	UpdateAvailable bool   `json:"updateAvailable"`
	// ChecksumVerified compares the running binary against the manifest its
	// own release published: match, mismatch, or unknown.
	ChecksumVerified string `json:"checksumVerified"`
	AssetName        string `json:"assetName"`
}

// RunResult describes what an install did.
type RunResult struct {
	Updated bool   `json:"updated"`
	Version string `json:"version"`
	// Warning is non-empty when the install completed but something about it
	// deserves the operator's attention — today, only a release that published
	// no checksums.txt.
	Warning string `json:"warning"`
}

// Updater binds a Client to the package's two operations, so callers (the
// HTTP handler) depend on a small interface instead of package functions.
type Updater struct {
	Client *Client
}

// Check reports what the latest release is and whether the running binary
// matches what its own release published.
func (u *Updater) Check(ctx context.Context, currentVersion, selfSHA256 string) (*CheckResult, error) {
	return Check(ctx, u.Client, currentVersion, selfSHA256)
}

// Install downloads and installs the latest release over execPath.
func (u *Updater) Install(ctx context.Context, currentVersion, execPath string) (*RunResult, error) {
	return Run(ctx, u.Client, Options{CurrentVersion: currentVersion, ExecPath: execPath})
}

// Check compares currentVersion against the latest published release and, when
// currentVersion is a real tag, verifies selfSHA256 against that tag's
// checksums.txt. It downloads nothing and writes nothing.
func Check(ctx context.Context, client taggedReleaseFetcher, currentVersion, selfSHA256 string) (*CheckResult, error) {
	release, err := client.LatestRelease(ctx)
	if err != nil {
		return nil, fmt.Errorf("check latest release: %w", err)
	}

	update, err := NeedsUpdate(currentVersion, release.TagName)
	if err != nil {
		return nil, err
	}

	return &CheckResult{
		Current:          currentVersion,
		Latest:           release.TagName,
		UpdateAvailable:  update,
		ChecksumVerified: verifySelf(ctx, client, currentVersion, selfSHA256),
		AssetName:        AssetName(runtime.GOOS, runtime.GOARCH),
	}, nil
}

// verifySelf looks up the release for the running tag and compares its
// manifest entry against selfSHA256. Every failure along the way — no digest
// to compare, release deleted, no manifest, asset not listed — is "unknown"
// rather than an error: an unverifiable binary is a weaker claim, not a
// broken check.
func verifySelf(ctx context.Context, client taggedReleaseFetcher, currentVersion, selfSHA256 string) string {
	if selfSHA256 == "" {
		return ChecksumVerifiedUnknown
	}
	release, err := client.ReleaseByTag(ctx, currentVersion)
	if err != nil {
		return ChecksumVerifiedUnknown
	}
	want, err := expectedChecksum(ctx, client, release)
	if err != nil {
		return ChecksumVerifiedUnknown
	}
	if strings.EqualFold(want, selfSHA256) {
		return ChecksumVerifiedMatch
	}
	return ChecksumVerifiedMismatch
}

// expectedChecksum downloads a release's checksums.txt and returns the digest
// it records for this platform's asset. ErrChecksumNotListed passes through
// unwrapped so callers can tell "no manifest" from "manifest without us".
func expectedChecksum(ctx context.Context, client releaseFetcher, release *Release) (string, error) {
	var manifestAsset Asset
	for _, a := range release.Assets {
		if a.Name == ChecksumsFileName {
			manifestAsset = a
			break
		}
	}
	if manifestAsset.Name == "" {
		return "", fmt.Errorf("%w: release %s publishes no %s", ErrChecksumNotListed, release.TagName, ChecksumsFileName)
	}
	manifest, err := client.DownloadAsset(ctx, manifestAsset)
	if err != nil {
		return "", fmt.Errorf("download %s: %w", ChecksumsFileName, err)
	}
	return ChecksumFor(manifest, AssetName(runtime.GOOS, runtime.GOARCH))
}

// Run checks the latest GitHub release against opts.CurrentVersion and, if
// newer, downloads it, verifies it against the release's checksums.txt, and
// installs it in place of opts.ExecPath. It never restarts the process — the
// caller decides when the new binary takes effect.
func Run(ctx context.Context, client releaseFetcher, opts Options) (*RunResult, error) {
	release, err := client.LatestRelease(ctx)
	if err != nil {
		return nil, fmt.Errorf("check latest release: %w", err)
	}

	update, err := NeedsUpdate(opts.CurrentVersion, release.TagName)
	if err != nil {
		return nil, err
	}
	if !update {
		return &RunResult{Updated: false, Version: release.TagName}, nil
	}

	asset, err := PickAsset(release.Assets, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return nil, err
	}

	log.Printf("downloading %s (%s)...", release.TagName, asset.Name)
	data, err := client.DownloadAsset(ctx, asset)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", asset.Name, err)
	}

	// Verify before touching disk. A release with no manifest is a warning,
	// not a failure — install.sh and install.ps1 already treat it that way,
	// and diverging would make the same release installable by the install
	// script but not by self-update.
	warning := ""
	want, err := expectedChecksum(ctx, client, release)
	switch {
	case errors.Is(err, ErrChecksumNotListed):
		warning = fmt.Sprintf("release %s published no verifiable %s — installed without checksum verification", release.TagName, ChecksumsFileName)
		log.Printf("warning: %s", warning)
	case err != nil:
		return nil, fmt.Errorf("verify %s: %w", asset.Name, err)
	default:
		if err := VerifySHA256(data, want); err != nil {
			return nil, fmt.Errorf("verify %s: %w", asset.Name, err)
		}
	}

	if err := ReplaceSelf(runtime.GOOS, opts.ExecPath, data); err != nil {
		return nil, fmt.Errorf("install update: %w", err)
	}

	log.Printf("updated to %s — restart devdeck to use it", release.TagName)
	return &RunResult{Updated: true, Version: release.TagName, Warning: warning}, nil
}
```

Set the import block to:

```go
import (
	"context"
	"errors"
	"fmt"
	"log"
	"runtime"
	"strings"
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/selfupdate/ -v && go vet ./internal/selfupdate/`
Expected: PASS. `cd backend && go build ./...` will still fail at `cmd/server/main.go` because `Run` now returns two values — Task 9 fixes that caller. That is the only expected build break.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/selfupdate/run.go backend/internal/selfupdate/run_test.go
git commit -m "feat(selfupdate): add Check, verify downloads against checksums.txt"
```

---

### Task 5: `terminal.ActiveSessionCount()`

**Files:**
- Modify: `backend/internal/terminal/kill.go`, `backend/internal/terminal/registry.go`
- Test: `backend/internal/terminal/kill_test.go` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `terminal.ActiveSessionCount() int` — live PTY sessions in this process, `0` when no terminal server ever started.

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/terminal/kill_test.go`:

```go
func TestActiveSessionCountIsZeroWithoutARegistry(t *testing.T) {
	orig := activeRegistry
	t.Cleanup(func() { activeRegistry = orig })

	activeRegistry = nil
	if got := ActiveSessionCount(); got != 0 {
		t.Errorf("ActiveSessionCount() = %d, want 0 on a process with no terminal server", got)
	}
}

func TestActiveSessionCountTracksRegisteredSessions(t *testing.T) {
	orig := activeRegistry
	t.Cleanup(func() { activeRegistry = orig })

	activeRegistry = newRegistry()
	if got := ActiveSessionCount(); got != 0 {
		t.Errorf("ActiveSessionCount() = %d, want 0 for an empty registry", got)
	}

	activeRegistry.sessions["wt-1"] = &ptySession{}
	activeRegistry.sessions["wt-1::term-2"] = &ptySession{}
	if got := ActiveSessionCount(); got != 2 {
		t.Errorf("ActiveSessionCount() = %d, want 2", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/terminal/ -run ActiveSessionCount -v`
Expected: FAIL — `undefined: ActiveSessionCount`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/internal/terminal/registry.go`:

```go
// count reports how many sessions are currently registered.
func (r *registry) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sessions)
}
```

Append to `backend/internal/terminal/kill.go`:

```go
// ActiveSessionCount reports how many PTY sessions this process is currently
// running, so the UI can warn how many terminals a restart will disconnect.
// A process that never started a terminal server (a pure --role hub) has a nil
// registry and reports 0, matching how KillSession guards the same var.
func ActiveSessionCount() int {
	if activeRegistry == nil {
		return 0
	}
	return activeRegistry.count()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/terminal/ -v && go vet ./internal/terminal/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/terminal/kill.go backend/internal/terminal/registry.go backend/internal/terminal/kill_test.go
git commit -m "feat(terminal): expose the live PTY session count"
```

---

### Task 6: `/api/self/version`, `/api/self/update-check`, `/api/self/update`

**Files:**
- Modify: `backend/internal/handler/self.go`
- Test: `backend/internal/handler/self_test.go` (append)

**Interfaces:**
- Consumes: Task 1's `version.SelfSHA256()`, Task 4's `selfupdate.CheckResult` / `RunResult` / `Updater`, Task 5's `terminal.ActiveSessionCount()`.
- Produces:
  - `handler.NewSelfHandler(managed bool, ver string, tokenConfigured bool, up UpdateService) *SelfHandler` — **signature changed**, previously `NewSelfHandler(managed bool)`
  - `handler.UpdateService` interface: `Check(ctx, currentVersion, selfSHA256 string) (*selfupdate.CheckResult, error)`; `Install(ctx, currentVersion, execPath string) (*selfupdate.RunResult, error)`
  - `(*SelfHandler).GetVersion`, `.GetUpdateCheck`, `.PostUpdate` — `http.HandlerFunc`s

**Response shapes (the frontend contract):**

```jsonc
// GET /api/self/version
{"version": "v1.4.2", "sha256": "a3f9…"}          // sha256 is "" when unreadable

// GET /api/self/update-check  (always 200, even on failure)
{"current": "v1.4.2", "latest": "v1.5.0", "updateAvailable": true,
 "checksumVerified": "match", "tokenConfigured": false,
 "activeSessions": 3, "managed": false, "error": ""}

// POST /api/self/update
{"status": "updated", "version": "v1.5.0", "warning": ""}   // or status "up-to-date"
```

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/handler/self_test.go`:

```go
// fakeUpdater stands in for selfupdate.Updater so these tests never reach
// GitHub or touch the running binary.
type fakeUpdater struct {
	check      *selfupdate.CheckResult
	checkErr   error
	install    *selfupdate.RunResult
	installErr error
	installed  bool
}

func (f *fakeUpdater) Check(ctx context.Context, currentVersion, selfSHA256 string) (*selfupdate.CheckResult, error) {
	if f.checkErr != nil {
		return nil, f.checkErr
	}
	return f.check, nil
}

func (f *fakeUpdater) Install(ctx context.Context, currentVersion, execPath string) (*selfupdate.RunResult, error) {
	f.installed = true
	if f.installErr != nil {
		return nil, f.installErr
	}
	return f.install, nil
}

func TestGetVersionReportsTheBuildAndItsDigest(t *testing.T) {
	h := NewSelfHandler(false, "v1.4.2", false, &fakeUpdater{})
	rec := httptest.NewRecorder()
	h.GetVersion(rec, httptest.NewRequest(http.MethodGet, "/api/self/version", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Version string `json:"version"`
		SHA256  string `json:"sha256"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Version != "v1.4.2" {
		t.Errorf("version = %q, want v1.4.2", body.Version)
	}
	if len(body.SHA256) != 64 {
		t.Errorf("sha256 = %q, want 64 hex chars for the test binary", body.SHA256)
	}
}

func TestGetUpdateCheckReportsTheCheckResult(t *testing.T) {
	up := &fakeUpdater{check: &selfupdate.CheckResult{
		Current:          "v1.4.2",
		Latest:           "v1.5.0",
		UpdateAvailable:  true,
		ChecksumVerified: selfupdate.ChecksumVerifiedMatch,
	}}
	h := NewSelfHandler(false, "v1.4.2", true, up)
	rec := httptest.NewRecorder()
	h.GetUpdateCheck(rec, httptest.NewRequest(http.MethodGet, "/api/self/update-check", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Latest           string `json:"latest"`
		UpdateAvailable  bool   `json:"updateAvailable"`
		ChecksumVerified string `json:"checksumVerified"`
		TokenConfigured  bool   `json:"tokenConfigured"`
		Managed          bool   `json:"managed"`
		Error            string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Latest != "v1.5.0" || !body.UpdateAvailable {
		t.Errorf("body = %+v, want v1.5.0 available", body)
	}
	if body.ChecksumVerified != selfupdate.ChecksumVerifiedMatch {
		t.Errorf("checksumVerified = %q, want match", body.ChecksumVerified)
	}
	if !body.TokenConfigured {
		t.Error("tokenConfigured = false, want true")
	}
	if body.Error != "" {
		t.Errorf("error = %q, want empty", body.Error)
	}
}

func TestGetUpdateCheckReportsFailureInTheBodyNotTheStatus(t *testing.T) {
	h := NewSelfHandler(false, "dev", false, &fakeUpdater{checkErr: errors.New("running a dev build (no version tag)")})
	rec := httptest.NewRecorder()
	h.GetUpdateCheck(rec, httptest.NewRequest(http.MethodGet, "/api/self/update-check", nil))

	// 200 with an error string: one machine's broken check must not blank the
	// whole Machines page.
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 even when the check fails", rec.Code)
	}
	var body struct {
		Error           string `json:"error"`
		UpdateAvailable bool   `json:"updateAvailable"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error == "" {
		t.Error("error = empty, want the check failure reported in the body")
	}
	if body.UpdateAvailable {
		t.Error("updateAvailable = true, want false when the check failed")
	}
}

func TestPostUpdateRefusesOnAManagedProcess(t *testing.T) {
	up := &fakeUpdater{install: &selfupdate.RunResult{Updated: true, Version: "v1.5.0"}}
	h := NewSelfHandler(true, "v1.4.2", false, up)
	rec := httptest.NewRecorder()
	h.PostUpdate(rec, httptest.NewRequest(http.MethodPost, "/api/self/update", nil))

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 for a supervised process", rec.Code)
	}
	if up.installed {
		t.Error("Install was called on a managed process; replacing a bundled sidecar breaks its signed bundle")
	}
	if !strings.Contains(rec.Body.String(), "desktop") {
		t.Errorf("body = %s, want it to point at the desktop installer", rec.Body.String())
	}
}

func TestPostUpdateInstallsAndReportsTheNewVersion(t *testing.T) {
	up := &fakeUpdater{install: &selfupdate.RunResult{Updated: true, Version: "v1.5.0", Warning: "no checksums"}}
	h := NewSelfHandler(false, "v1.4.2", false, up)
	rec := httptest.NewRecorder()
	h.PostUpdate(rec, httptest.NewRequest(http.MethodPost, "/api/self/update", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Status  string `json:"status"`
		Version string `json:"version"`
		Warning string `json:"warning"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Status != "updated" || body.Version != "v1.5.0" {
		t.Errorf("body = %+v, want status updated at v1.5.0", body)
	}
	if body.Warning != "no checksums" {
		t.Errorf("warning = %q, want it forwarded to the client", body.Warning)
	}
}

func TestPostUpdateSurfacesAnInstallFailure(t *testing.T) {
	h := NewSelfHandler(false, "v1.4.2", false, &fakeUpdater{installErr: errors.New("checksum mismatch")})
	rec := httptest.NewRecorder()
	h.PostUpdate(rec, httptest.NewRequest(http.MethodPost, "/api/self/update", nil))

	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502 for a failed install", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "checksum mismatch") {
		t.Errorf("body = %s, want the underlying reason", rec.Body.String())
	}
}
```

Set that file's import block to:

```go
import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"devdeck/backend/internal/selfupdate"
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/handler/ -run 'GetVersion|GetUpdateCheck|PostUpdate' -v`
Expected: FAIL — `too many arguments in call to NewSelfHandler`, `h.GetVersion undefined`.

- [ ] **Step 3: Write minimal implementation**

In `backend/internal/handler/self.go`, extend the imports to:

```go
import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"time"

	"devdeck/backend/internal/selfupdate"
	"devdeck/backend/internal/terminal"
	"devdeck/backend/internal/version"
)
```

Replace the `SelfHandler` struct and its constructor with:

```go
// UpdateService is the subset of selfupdate.Updater this handler needs, so
// tests can substitute a fake instead of reaching GitHub and overwriting the
// test binary.
type UpdateService interface {
	Check(ctx context.Context, currentVersion, selfSHA256 string) (*selfupdate.CheckResult, error)
	Install(ctx context.Context, currentVersion, execPath string) (*selfupdate.RunResult, error)
}

// SelfHandler exposes this process's own version, update, restart, and stop
// lifecycle over HTTP, so the hub's Machines page can inspect and control a
// registered machine's process directly instead of the operator doing it by
// hand on that machine. See
// docs/superpowers/specs/2026-07-21-runtime-restart-stop-design.md and
// docs/superpowers/specs/2026-07-30-version-sha256-update-ui-design.md.
type SelfHandler struct {
	// managed is true when an external supervisor (the Tauri desktop's
	// sidecar respawn loop) already owns this process's respawn lifecycle
	// — set via --managed/DEVDECK_MANAGED. A managed process must never
	// spawn its own replacement (the supervisor would end up spawning a
	// second one too), must refuse to stop (the supervisor would just
	// silently relaunch it, which is worse than a clear error), and must
	// refuse to update (it is a binary bundled inside a signed desktop
	// app; overwriting it invalidates that bundle).
	managed bool
	// ver is this build's embedded version string (version.Version).
	ver string
	// tokenConfigured records whether a GitHub token was supplied to this
	// process. Only the boolean crosses the API boundary — never the token.
	tokenConfigured bool
	updater         UpdateService
}

// NewSelfHandler creates a self-management handler.
func NewSelfHandler(managed bool, ver string, tokenConfigured bool, updater UpdateService) *SelfHandler {
	return &SelfHandler{managed: managed, ver: ver, tokenConfigured: tokenConfigured, updater: updater}
}

// GetVersion handles GET /api/self/version. It touches no network, so the
// Machines page can call it for every row. An unreadable executable yields an
// empty sha256 rather than an error — the version is still worth reporting.
func (h *SelfHandler) GetVersion(w http.ResponseWriter, r *http.Request) {
	sum, _ := version.SelfSHA256()
	writeJSON(w, http.StatusOK, map[string]any{"version": h.ver, "sha256": sum})
}

// GetUpdateCheck handles GET /api/self/update-check. It answers 200 even when
// the check itself failed, reporting the reason in the body: the hub fans this
// out across every machine, and one unreachable GitHub must not blank the page.
func (h *SelfHandler) GetUpdateCheck(w http.ResponseWriter, r *http.Request) {
	sum, _ := version.SelfSHA256()
	body := map[string]any{
		"current":          h.ver,
		"latest":           "",
		"updateAvailable":  false,
		"checksumVerified": selfupdate.ChecksumVerifiedUnknown,
		"tokenConfigured":  h.tokenConfigured,
		"activeSessions":   terminal.ActiveSessionCount(),
		"managed":          h.managed,
		"error":            "",
	}

	res, err := h.updater.Check(r.Context(), h.ver, sum)
	if err != nil {
		body["error"] = err.Error()
		writeJSON(w, http.StatusOK, body)
		return
	}
	body["latest"] = res.Latest
	body["updateAvailable"] = res.UpdateAvailable
	body["checksumVerified"] = res.ChecksumVerified
	writeJSON(w, http.StatusOK, body)
}

// PostUpdate handles POST /api/self/update: download the latest release,
// verify it, and swap this binary. It never restarts — the caller decides
// when, since a restart drops every live terminal on this machine.
func (h *SelfHandler) PostUpdate(w http.ResponseWriter, r *http.Request) {
	if h.managed {
		writeErr(w, http.StatusConflict, "this runtime is supervised by its desktop app — update it by installing a new desktop release")
		return
	}
	exe, err := os.Executable()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "resolve current executable path: "+err.Error())
		return
	}
	res, err := h.updater.Install(r.Context(), h.ver, exe)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	status := "updated"
	if !res.Updated {
		status = "up-to-date"
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": status, "version": res.Version, "warning": res.Warning})
}
```

Leave `PostRestart` and `PostStop` exactly as they are.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/handler/ -v && go vet ./internal/handler/`
Expected: PASS. Existing `self_test.go` tests that call `NewSelfHandler(false)` must be updated to `NewSelfHandler(false, "v0.0.0-test", false, &fakeUpdater{})` — do that as part of this step.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handler/self.go backend/internal/handler/self_test.go
git commit -m "feat(handler): add self version, update-check, and update endpoints"
```

---

### Task 7: `machineclient` raw self-JSON calls

**Files:**
- Modify: `backend/internal/machineclient/client.go`
- Test: `backend/internal/machineclient/client_test.go` (append)

**Interfaces:**
- Consumes: `domain.Machine`, the file's existing `extractErrorMessage`.
- Produces:
  - `machineclient.Version(ctx, m) (json.RawMessage, error)`
  - `machineclient.UpdateCheck(ctx, m) (json.RawMessage, error)`
  - `machineclient.Update(ctx, m) (json.RawMessage, error)`

Raw JSON, not a typed struct: the runtime handler already defines this schema and the frontend already consumes it, so re-declaring it here would be a third copy to keep in sync for no gain.

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/machineclient/client_test.go`:

```go
func TestVersionReturnsTheRuntimesRawJSON(t *testing.T) {
	var gotPath, gotMethod, gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod, gotAuth = r.URL.Path, r.Method, r.Header.Get("Authorization")
		w.Write([]byte(`{"version":"v1.4.2","sha256":"abc"}`))
	}))
	defer server.Close()

	body, err := Version(context.Background(), domain.Machine{ID: "m1", URL: server.URL, Key: "k"})
	if err != nil {
		t.Fatalf("Version() error = %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/api/self/version" || gotAuth != "Bearer k" {
		t.Errorf("got method=%s path=%s auth=%s, want GET /api/self/version with Bearer k", gotMethod, gotPath, gotAuth)
	}
	if !strings.Contains(string(body), `"v1.4.2"`) {
		t.Errorf("body = %s, want the runtime's JSON forwarded verbatim", body)
	}
}

func TestUpdateCheckPostsToTheRightPath(t *testing.T) {
	var gotPath, gotMethod string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod = r.URL.Path, r.Method
		w.Write([]byte(`{"updateAvailable":false}`))
	}))
	defer server.Close()

	if _, err := UpdateCheck(context.Background(), domain.Machine{ID: "m1", URL: server.URL, Key: "k"}); err != nil {
		t.Fatalf("UpdateCheck() error = %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/api/self/update-check" {
		t.Errorf("got method=%s path=%s, want GET /api/self/update-check", gotMethod, gotPath)
	}
}

func TestUpdatePostsToTheRightPath(t *testing.T) {
	var gotPath, gotMethod string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod = r.URL.Path, r.Method
		w.Write([]byte(`{"status":"updated","version":"v1.5.0"}`))
	}))
	defer server.Close()

	if _, err := Update(context.Background(), domain.Machine{ID: "m1", URL: server.URL, Key: "k"}); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/api/self/update" {
		t.Errorf("got method=%s path=%s, want POST /api/self/update", gotMethod, gotPath)
	}
}

func TestUpdateUnwrapsTheRuntimesErrorEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"error":"this runtime is supervised by its desktop app"}`))
	}))
	defer server.Close()

	_, err := Update(context.Background(), domain.Machine{ID: "m1", URL: server.URL, Key: "k"})
	if err == nil {
		t.Fatal("Update() error = nil, want non-nil for a 409")
	}
	if !strings.Contains(err.Error(), "supervised by its desktop app") {
		t.Errorf("error = %v, want the runtime's own reason", err)
	}
}
```

Ensure that file imports `"strings"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/machineclient/ -run 'Version|UpdateCheck|Update' -v`
Expected: FAIL — `undefined: Version`, `undefined: UpdateCheck`, `undefined: Update`.

- [ ] **Step 3: Write minimal implementation**

In `backend/internal/machineclient/client.go`, add the timeouts next to `requestTimeout`:

```go
// updateCheckTimeout covers a round trip to the GitHub API, which the 3s
// requestTimeout for machine-local calls is far too tight for.
const updateCheckTimeout = 30 * time.Second

// updateTimeout covers downloading a release binary (tens of MB) over
// whatever link the runtime has.
const updateTimeout = 10 * time.Minute
```

Append below `postSelf`:

```go
// Version reads a machine's own build info from its /api/self/version.
func Version(ctx context.Context, m domain.Machine) (json.RawMessage, error) {
	return selfJSON(ctx, m, http.MethodGet, "version", requestTimeout)
}

// UpdateCheck asks a machine to check GitHub for a newer release. The machine
// answers 200 with an "error" field when the check itself failed, so a
// non-error return here does not mean the check succeeded.
func UpdateCheck(ctx context.Context, m domain.Machine) (json.RawMessage, error) {
	return selfJSON(ctx, m, http.MethodGet, "update-check", updateCheckTimeout)
}

// Update tells a machine to download and install the latest release. It does
// not restart the machine — callers do that separately, so a failed install
// never triggers a restart.
func Update(ctx context.Context, m domain.Machine) (json.RawMessage, error) {
	return selfJSON(ctx, m, http.MethodPost, "update", updateTimeout)
}

// selfJSON calls one of a machine's /api/self/* endpoints and returns its
// response body untouched, so the hub can forward a runtime's answer verbatim
// instead of re-declaring its schema here.
func selfJSON(ctx context.Context, m domain.Machine, method, action string, timeout time.Duration) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	url := strings.TrimRight(m.URL, "/") + "/api/self/" + action
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+m.Key)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("machine %s unreachable: %w", m.ID, err)
	}
	defer resp.Body.Close()

	body, readErr := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("machine %s: %s", m.ID, extractErrorMessage(body, resp.StatusCode))
	}
	if readErr != nil {
		return nil, fmt.Errorf("machine %s: read response: %w", m.ID, readErr)
	}
	return json.RawMessage(body), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/machineclient/ -v && go vet ./internal/machineclient/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/machineclient/client.go backend/internal/machineclient/client_test.go
git commit -m "feat(machineclient): add self version, update-check, and update calls"
```

---

### Task 8: Hub proxy endpoints

**Files:**
- Modify: `backend/internal/handler/machine.go`
- Test: `backend/internal/handler/machine_test.go` (append)

**Interfaces:**
- Consumes: Task 7's `machineclient.Version` / `UpdateCheck` / `Update`.
- Produces: `(*MachineHandler).GetMachineVersion`, `.GetMachineUpdateCheck`, `.PostMachineUpdate` — `http.HandlerFunc`s for `/api/machines/{id}/version`, `/api/machines/{id}/update-check`, `/api/machines/{id}/update`.

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/handler/machine_test.go`:

```go
func TestGetMachineVersionForwardsTheRuntimesAnswer(t *testing.T) {
	var gotPath string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Write([]byte(`{"version":"v1.4.2","sha256":"abc123"}`))
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("builder", backend.URL, "k", false)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/machines/{id}/version", h.GetMachineVersion)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/machines/"+m.ID+"/version", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/api/self/version" {
		t.Errorf("backend received path %q, want /api/self/version", gotPath)
	}
	if !strings.Contains(rec.Body.String(), `"v1.4.2"`) {
		t.Errorf("body = %s, want the runtime's JSON forwarded verbatim", rec.Body.String())
	}
}

func TestGetMachineUpdateCheckHitsTheRuntimesCheck(t *testing.T) {
	var gotPath string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Write([]byte(`{"updateAvailable":true,"latest":"v1.5.0"}`))
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("builder", backend.URL, "k", false)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/machines/{id}/update-check", h.GetMachineUpdateCheck)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/machines/"+m.ID+"/update-check", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/api/self/update-check" {
		t.Errorf("backend received path %q, want /api/self/update-check", gotPath)
	}
}

func TestPostMachineUpdateHitsTheRuntimesUpdate(t *testing.T) {
	var gotPath, gotMethod string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod = r.URL.Path, r.Method
		w.Write([]byte(`{"status":"updated","version":"v1.5.0"}`))
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("builder", backend.URL, "k", false)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/machines/{id}/update", h.PostMachineUpdate)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/machines/"+m.ID+"/update", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if gotMethod != http.MethodPost || gotPath != "/api/self/update" {
		t.Errorf("backend received %s %s, want POST /api/self/update", gotMethod, gotPath)
	}
}

func TestPostMachineUpdateSurfacesTheRuntimesRefusal(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"error":"this runtime is supervised by its desktop app"}`))
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("local", backend.URL, "k", true)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/machines/{id}/update", h.PostMachineUpdate)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/machines/"+m.ID+"/update", nil))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "supervised by its desktop app") {
		t.Errorf("body = %s, want the runtime's own reason", rec.Body.String())
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/handler/ -run 'MachineVersion|MachineUpdate' -v`
Expected: FAIL — `h.GetMachineVersion undefined`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/internal/handler/machine.go`, after `PostMachineStop`:

```go
// GetMachineVersion handles GET /api/machines/{id}/version, forwarding the
// target machine's own build info. Cheap and network-free on the target, so
// the Machines page calls it for every row.
func (h *MachineHandler) GetMachineVersion(w http.ResponseWriter, r *http.Request) {
	h.proxySelf(w, r, machineclient.Version)
}

// GetMachineUpdateCheck handles GET /api/machines/{id}/update-check. The
// target reaches GitHub, so this is operator-initiated only — never polled.
func (h *MachineHandler) GetMachineUpdateCheck(w http.ResponseWriter, r *http.Request) {
	h.proxySelf(w, r, machineclient.UpdateCheck)
}

// PostMachineUpdate handles POST /api/machines/{id}/update: the target
// downloads, verifies, and installs the latest release. It does not restart —
// the frontend issues a separate restart so a failed install never triggers
// one.
func (h *MachineHandler) PostMachineUpdate(w http.ResponseWriter, r *http.Request) {
	h.proxySelf(w, r, machineclient.Update)
}

// proxySelf looks a machine up and forwards its /api/self/* response body
// verbatim, so the runtime stays the single source of truth for these
// schemas. A failure is a 502 carrying the target's own message, matching
// PostMachineRestart.
func (h *MachineHandler) proxySelf(w http.ResponseWriter, r *http.Request, call func(context.Context, domain.Machine) (json.RawMessage, error)) {
	m, err := h.st.MachineByID(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	body, err := call(r.Context(), m)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, body)
}
```

Add `"context"`, `"encoding/json"`, and `"devdeck/backend/internal/domain"` to that file's imports if they are not already there.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/handler/ -v && go vet ./internal/handler/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handler/machine.go backend/internal/handler/machine_test.go
git commit -m "feat(handler): proxy machine version, update-check, and update"
```

---

### Task 9: Wire it up in `main.go`

**Files:**
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: Tasks 4, 6, 8.
- Produces: six live routes; `--updates` no longer requires a token.

This is the convergence step — it is the only task that touches `main.go`.

- [ ] **Step 1: Verify the build is currently broken in exactly one place**

Run: `cd backend && go build ./... 2>&1 | head`
Expected: errors only in `cmd/server/main.go` — `selfupdate.Run(...) used as value` and `not enough arguments in call to handler.NewSelfHandler`. Anything else means an earlier task is incomplete.

- [ ] **Step 2: Make `--updates` work without a token**

In `backend/cmd/server/main.go`, replace the `if *updates { … }` block (around line 122) with:

```go
	if *updates {
		execPath, err := os.Executable()
		if err != nil {
			log.Fatalf("--updates: resolve current executable path: %v", err)
		}
		client := &selfupdate.Client{
			Owner: selfupdate.Owner,
			Repo:  selfupdate.Repo,
			Token: *githubToken,
		}
		res, err := selfupdate.Run(context.Background(), client, selfupdate.Options{
			CurrentVersion: version.Version,
			ExecPath:       execPath,
		})
		if err != nil {
			log.Fatalf("--updates: %v", err)
		}
		if res.Warning != "" {
			log.Printf("warning: %s", res.Warning)
		}
		if !res.Updated {
			log.Printf("already on latest version %s", version.Version)
		}
		return
	}
```

Update the two flag descriptions on lines 87–88 so they no longer claim a token is required:

```go
	updates := flag.Bool("updates", false, "check for and install the latest release, then exit; does not restart the server")
	githubToken := flag.String("github-token", envOr("DEVDECK_GITHUB_TOKEN", config.Pick(cfg.Updates.GitHubToken, "")), "GitHub token for update checks and downloads; only needed if the release repo is private or the unauthenticated API rate limit is a problem (devdeck.yaml: updates.github_token)")
```

- [ ] **Step 3: Construct the updater and pass it to `NewSelfHandler`**

Replace line 292's `selfH := handler.NewSelfHandler(managed)` with:

```go
	updater := &selfupdate.Updater{Client: &selfupdate.Client{
		Owner: selfupdate.Owner,
		Repo:  selfupdate.Repo,
		Token: *githubToken,
	}}
	selfH := handler.NewSelfHandler(managed, version.Version, *githubToken != "", updater)
```

- [ ] **Step 4: Register the six routes**

After line 387's `mux.HandleFunc("POST /api/self/stop", selfH.PostStop)`, add:

```go
	mux.HandleFunc("GET /api/self/version", selfH.GetVersion)
	mux.HandleFunc("GET /api/self/update-check", selfH.GetUpdateCheck)
	mux.HandleFunc("POST /api/self/update", selfH.PostUpdate)
```

The machine routes live inside the `if !isRuntime { … }` (hub-only) block, around line 520, on the handler named `machineH`. Add the three new ones directly after `POST /api/machines/{id}/stop`, inside that same block — a runtime has no machine catalog to proxy for, so these belong on the hub only:

```go
		mux.HandleFunc("GET /api/machines/{id}/version", machineH.GetMachineVersion)
		mux.HandleFunc("GET /api/machines/{id}/update-check", machineH.GetMachineUpdateCheck)
		mux.HandleFunc("POST /api/machines/{id}/update", machineH.PostMachineUpdate)
```

Note the indentation: one extra tab, since these sit inside the `if` block.

- [ ] **Step 5: Verify the whole backend builds and passes**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: build clean, no vet output, all tests PASS.

- [ ] **Step 6: Smoke-test the new routes against a real process**

```bash
cd backend && go run ./cmd/server --role both --key devkey --addr 127.0.0.1:8899 &
sleep 3
curl -s -H 'Authorization: Bearer devkey' http://127.0.0.1:8899/api/self/version
curl -s -H 'Authorization: Bearer devkey' http://127.0.0.1:8899/api/self/update-check
kill %1
```

Expected: `/api/self/version` returns a `version` of `dev` and a 64-char `sha256`. `/api/self/update-check` returns 200 with `"error"` mentioning the dev build, `"tokenConfigured": false`, and `"activeSessions": 0`.

- [ ] **Step 7: Commit**

```bash
git add backend/cmd/server/main.go
git commit -m "feat(server): register version and update routes, drop the token requirement"
```

---

### Task 10: Frontend API client and query hooks

**Files:**
- Modify: `frontend/src/lib/api.ts`, `frontend/src/features/data/keys.ts`, `frontend/src/features/data/queries.ts`

**Interfaces:**
- Consumes: Task 9's six routes.
- Produces:
  - `MachineVersion { version: string; sha256: string }`
  - `MachineUpdateCheck { current, latest, checksumVerified, error: string; updateAvailable, tokenConfigured, managed: boolean; activeSessions: number }`
  - `MachineUpdateResult { status: 'updated' | 'up-to-date'; version: string; warning: string }`
  - `fetchMachineVersion(id)`, `fetchMachineUpdateCheck(id)`, `updateMachine_(id)` → named `installMachineUpdate(id)` to avoid colliding with the existing `updateMachine` PATCH helper
  - `qk.machineVersion(id)`, `qk.machineUpdateCheck(id)`
  - `useMachineVersion(id)`, `useMachineUpdateCheck(id)`, `useInstallMachineUpdate()`

- [ ] **Step 1: Add types and fetchers**

In `frontend/src/lib/api.ts`, next to the existing `MachineHealth` interface, add:

```ts
export interface MachineVersion {
  version: string
  sha256: string
}

/** Result of a manual update check. `error` is non-empty when the check itself
 *  failed — the request still succeeds with 200 so one broken machine doesn't
 *  blank the page. */
export interface MachineUpdateCheck {
  current: string
  latest: string
  updateAvailable: boolean
  checksumVerified: 'match' | 'mismatch' | 'unknown'
  tokenConfigured: boolean
  activeSessions: number
  managed: boolean
  error: string
}

export interface MachineUpdateResult {
  status: 'updated' | 'up-to-date'
  version: string
  warning: string
}
```

And next to `fetchMachineHealth`:

```ts
export function fetchMachineVersion(id: string): Promise<MachineVersion> {
  return request<MachineVersion>('GET', `/machines/${id}/version`)
}

export function fetchMachineUpdateCheck(id: string): Promise<MachineUpdateCheck> {
  return request<MachineUpdateCheck>('GET', `/machines/${id}/update-check`)
}

/** Installs the latest release on a machine. Named to avoid colliding with
 *  `updateMachine`, which PATCHes a machine's name/url/key. */
export function installMachineUpdate(id: string): Promise<MachineUpdateResult> {
  return request<MachineUpdateResult>('POST', `/machines/${id}/update`)
}
```

- [ ] **Step 2: Add query keys**

In `frontend/src/features/data/keys.ts`, below `machineHealth`:

```ts
  machineVersion: (id: string) => ['machines', id, 'version'] as const,
  machineUpdateCheck: (id: string) => ['machines', id, 'updateCheck'] as const,
```

- [ ] **Step 3: Add the hooks**

In `frontend/src/features/data/queries.ts`, below `useMachineHealth`, add:

```ts
/** A machine's build info. Network-free on the runtime and immutable until it
 *  restarts, so this is cached hard rather than polled. */
export function useMachineVersion(id: string | undefined) {
  return useQuery({
    queryKey: qk.machineVersion(id ?? ''),
    queryFn: () => fetchMachineVersion(id!),
    enabled: !!id,
    staleTime: 5 * 60_000,
  })
}

/** An update check against GitHub. Deliberately never automatic: the
 *  unauthenticated GitHub API allows 60 requests/hour, which polling per
 *  machine would exhaust in minutes. Call `refetch()` from a button. */
export function useMachineUpdateCheck(id: string | undefined) {
  return useQuery({
    queryKey: qk.machineUpdateCheck(id ?? ''),
    queryFn: () => fetchMachineUpdateCheck(id!),
    enabled: false,
    staleTime: 60_000,
    retry: false,
  })
}

export function useInstallMachineUpdate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => installMachineUpdate(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: qk.machineVersion(id) })
      queryClient.invalidateQueries({ queryKey: qk.machineUpdateCheck(id) })
    },
  })
}
```

Add `fetchMachineVersion`, `fetchMachineUpdateCheck`, and `installMachineUpdate` to that file's existing `@/lib/api` import.

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/features/data/keys.ts frontend/src/features/data/queries.ts
git commit -m "feat(frontend): add machine version and update API client + hooks"
```

---

### Task 11: Version section in `DesktopSettingsDialog`

**Files:**
- Create: `frontend/src/features/overlays/VersionSection.tsx`
- Modify: `frontend/src/features/overlays/DesktopSettingsDialog.tsx`

**Interfaces:**
- Consumes: Task 10's `useMachineVersion`, `useMachineUpdateCheck`.
- Produces: `<VersionSection machineId={string | undefined} />`

A separate file because `DesktopSettingsDialog.tsx` is already 145 lines of four unrelated sections; the version block carries its own query state, copy handler, and three-way checksum rendering, and would roughly double it.

The dialog needs the local machine's id. Read `useMachines()` and pick `machines.find((m) => m.isLocal)?.id` — the desktop's local runtime always self-registers with `isLocal: true`.

- [ ] **Step 1: Write the component**

Create `frontend/src/features/overlays/VersionSection.tsx`:

```tsx
import { Check, Copy, Loader2, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useMachineUpdateCheck, useMachineVersion } from '@/features/data/queries'

function shortDigest(sha: string): string {
  return sha.length > 20 ? `${sha.slice(0, 12)}…${sha.slice(-8)}` : sha
}

/** Build info for one machine, plus an operator-initiated update check.
 *  Rendered in DesktopSettingsDialog for the device's own local runtime. */
export function VersionSection({ machineId }: { machineId: string | undefined }) {
  const build = useMachineVersion(machineId)
  const check = useMachineUpdateCheck(machineId)
  const [copied, setCopied] = useState(false)

  function copyDigest() {
    const sha = build.data?.sha256
    if (!sha) return
    void navigator.clipboard.writeText(sha)
    setCopied(true)
    toast.success('Copied')
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="mb-5">
      <div className="mb-1.5 text-[12.5px] font-semibold text-devdeck-fg-2">Version</div>

      {build.isLoading ? (
        <p className="font-mono text-[11px] text-devdeck-dim-2">checking…</p>
      ) : build.isError || !build.data ? (
        <p className="font-mono text-[11px] text-devdeck-red-soft">Build info unavailable.</p>
      ) : (
        <>
          <p className="font-mono text-[11px] text-devdeck-fg">{build.data.version}</p>
          {build.data.sha256 ? (
            <div className="mt-1 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-devdeck-dim-2">
                {shortDigest(build.data.sha256)}
              </span>
              <button
                type="button"
                aria-label="Copy sha256"
                onClick={copyDigest}
                className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted hover:bg-devdeck-popover hover:text-devdeck-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
          ) : (
            <p className="mt-1 font-mono text-[10.5px] text-devdeck-dim-2">sha256 unavailable</p>
          )}
        </>
      )}

      {check.data?.checksumVerified === 'match' ? (
        <p className="mt-1 font-mono text-[10.5px] text-devdeck-green-soft">
          ✓ matches release {check.data.current}
        </p>
      ) : null}
      {check.data?.checksumVerified === 'mismatch' ? (
        <p className="mt-1 inline-flex items-center gap-1.5 font-mono text-[10.5px] text-devdeck-red-soft">
          <ShieldAlert size={12} />
          does not match release {check.data.current}
        </p>
      ) : null}

      <div className="mt-2.5">
        {check.data?.managed ? (
          <p className="font-mono text-[10.5px] text-devdeck-dim-2">
            Supervised by the desktop app — update by installing a new desktop release.
          </p>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => void check.refetch()} disabled={check.isFetching || !machineId}>
            {check.isFetching && <Loader2 size={13} className="animate-spin" />}
            Check for updates
          </Button>
        )}
      </div>

      {check.data ? (
        <p className="mt-2 font-mono text-[10.5px] text-devdeck-dim-2">
          {check.data.error
            ? check.data.error
            : check.data.updateAvailable
              ? `${check.data.latest} available`
              : 'up to date'}
          {check.data.tokenConfigured ? '' : ' · token: not set'}
        </p>
      ) : null}
      {check.isError ? (
        <p className="mt-2 font-mono text-[10.5px] text-devdeck-red-soft">
          Couldn&apos;t reach this machine to check for updates.
        </p>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2: Mount it in the dialog**

In `frontend/src/features/overlays/DesktopSettingsDialog.tsx`:

Add to the imports:

```tsx
import { useMachines } from '@/features/data/queries'
import { VersionSection } from './VersionSection'
```

(If `useTailscaleStatus` is already imported from `@/features/data/queries`, add `useMachines` to that same import rather than adding a second one.)

Inside the component, above the `return`:

```tsx
  const machines = useMachines()
  const localMachineId = machines.data?.find((m) => m.isLocal)?.id
```

Then render it as the first section, immediately after the `<DialogDescription …/>` line and before the `Hub mode` block:

```tsx
      <VersionSection machineId={localMachineId} />
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors. (`useMachines` is defined at `frontend/src/features/data/queries.ts:241` and returns a `UseQueryResult<Machine[]>`.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/overlays/VersionSection.tsx frontend/src/features/overlays/DesktopSettingsDialog.tsx
git commit -m "feat(frontend): show version, sha256, and update check in desktop settings"
```

---

### Task 12: Machines page version chip and update action

**Files:**
- Modify: `frontend/src/store/useDevDeckStore.ts`, `frontend/src/features/overlays/ConfirmMachineActionDialog.tsx`, `frontend/src/features/machines/MachinesModule.tsx`

**Interfaces:**
- Consumes: Task 10's hooks, Task 11's nothing.
- Produces: `MachineAction` gains `'update'`; `confirmMachineAction` gains an optional `version` and `activeSessions` so the dialog can name what the update installs and what it will disconnect.

This is the second convergence step — the only task that touches `useDevDeckStore.ts`.

- [ ] **Step 1: Widen the store's action type**

In `frontend/src/store/useDevDeckStore.ts`, line 32:

```ts
export type MachineAction = 'restart' | 'stop' | 'update'
```

Line 217 — carry the extra context the update copy needs:

```ts
  confirmMachineAction: {
    action: MachineAction
    id: string
    name: string
    /** Target release tag, set only for 'update'. */
    version?: string
    /** Live PTY sessions that a restart will disconnect, from the update check. */
    activeSessions?: number
  } | null
```

Line 331 — widen the setter:

```ts
  askMachineAction: (
    action: MachineAction,
    id: string,
    name: string,
    extra?: { version?: string; activeSessions?: number },
  ) => void
```

Line 688 — thread it through:

```ts
      askMachineAction: (action, id, name, extra) =>
        set((s) => void (s.confirmMachineAction = { action, id, name, ...extra })),
```

- [ ] **Step 2: Add the update branch to the confirm dialog**

In `frontend/src/features/overlays/ConfirmMachineActionDialog.tsx`, add to `COPY`:

```ts
  update: {
    title: 'Update runtime',
    body: (name: string) => `This updates the runtime on "${name}".`,
    confirmLabel: 'Update & restart',
    iconClassName: 'text-devdeck-yellow-soft',
    confirmVariant: 'warning' as const,
  },
```

Import the install hook alongside the existing ones:

```tsx
import { useInstallMachineUpdate, useRestartMachine, useStopMachine } from '@/features/data/queries'
```

Add the mutation and widen `pending`:

```tsx
  const installUpdate = useInstallMachineUpdate()
  const pending = restartMachine.isPending || stopMachine.isPending || installUpdate.isPending
```

Replace `onConfirm` with a version that handles all three actions — update installs first, then restarts, so a failed swap never restarts the machine:

```tsx
  function onConfirm() {
    if (!confirm) return
    const { action, id, name } = confirm

    if (action === 'update') {
      installUpdate.mutate(id, {
        onSuccess: (res) => {
          if (res.warning) showToast(res.warning)
          if (res.status === 'up-to-date') {
            cancel()
            showToast(`"${name}" is already on ${res.version}`)
            return
          }
          // Restart separately: a failed install must never restart, and a
          // failed restart still leaves the new binary staged for the next one.
          restartMachine.mutate(id, {
            onSuccess: () => {
              cancel()
              showToast(`Updated "${name}" to ${res.version} — restarting`)
            },
            onError: () => {
              cancel()
              showToast(`Updated "${name}" to ${res.version} — restart it to apply`)
            },
          })
        },
        onError: (err) => showToast(err instanceof Error ? err.message : `Failed to update "${name}"`),
      })
      return
    }

    const mutation = action === 'restart' ? restartMachine : stopMachine
    mutation.mutate(id, {
      onSuccess: () => {
        cancel()
        showToast(`${action === 'restart' ? 'Restarting' : 'Stopping'} "${name}"`)
      },
      onError: (err) => showToast(err instanceof Error ? err.message : `Failed to ${action} "${name}"`),
    })
  }
```

Replace the `<DialogDescription>` body so the update case names the version and the sessions at risk. Zero sessions drops the sentence entirely rather than reading "0 active terminals":

```tsx
  const sessions = confirm?.activeSessions ?? 0
  const description =
    confirm?.action === 'update'
      ? `Updating "${confirm.name}"${confirm.version ? ` to ${confirm.version}` : ''} restarts its runtime process.` +
        (sessions > 0
          ? ` ${sessions} active terminal${sessions === 1 ? '' : 's'} on this machine will disconnect and reconnect once it's back.`
          : '')
      : confirm && copy
        ? copy.body(confirm.name)
        : ''
```

and render `{description}` in place of the existing expression.

- [ ] **Step 3: Show the version chip and update button on each row**

In `frontend/src/features/machines/MachinesModule.tsx`, add to the imports:

```tsx
import { Download, Monitor, Plus, Power, RefreshCw, RotateCw, Server, Settings2, Trash2 } from 'lucide-react'
import { useMachineUpdateCheck, useMachineVersion, useMachineHealth, useMachines } from '@/features/data/queries'
```

Keep the existing icon and hook imports that are already there; only add `Download`, `RefreshCw`, `useMachineUpdateCheck`, and `useMachineVersion`.

Inside `MachineRow`, above the `return`:

```tsx
  const build = useMachineVersion(machine.id)
  const check = useMachineUpdateCheck(machine.id)
  const canUpdate = check.data?.updateAvailable === true && check.data.managed === false
```

In the actions row, immediately before the existing restart `<button>`, add:

```tsx
          {build.data?.version ? (
            <span className="flex-none rounded-md border border-devdeck-border-card bg-devdeck-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] text-devdeck-dim-2">
              {build.data.version}
            </span>
          ) : null}
          {canUpdate ? (
            <button
              type="button"
              aria-label={`Update ${machine.name} to ${check.data?.latest}`}
              onClick={() =>
                askMachineAction('update', machine.id, machine.name, {
                  version: check.data?.latest,
                  activeSessions: check.data?.activeSessions,
                })
              }
              className="flex h-7 cursor-pointer items-center gap-1 rounded-md bg-devdeck-surface-2 px-1.5 font-mono text-[9.5px] text-devdeck-green-soft hover:bg-devdeck-popover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Download size={12} />
              {check.data?.latest}
            </button>
          ) : null}
```

- [ ] **Step 4: Add the fan-out check button to the module header**

`MachineRow` cannot trigger its own check — `useMachineUpdateCheck` is `enabled: false`. The module header drives all rows at once. In `MachinesModule`, where the machines list and the "Add machine" button are rendered, add a sibling button:

```tsx
  const queryClient = useQueryClient()
  const [checking, setChecking] = useState(false)

  async function checkAllForUpdates() {
    setChecking(true)
    try {
      await Promise.all(
        (machines.data ?? []).map((m) =>
          queryClient.refetchQueries({ queryKey: qk.machineUpdateCheck(m.id) }),
        ),
      )
    } finally {
      setChecking(false)
    }
  }
```

```tsx
        <Button variant="secondary" size="sm" onClick={() => void checkAllForUpdates()} disabled={checking}>
          <RefreshCw size={13} className={checking ? 'animate-spin' : undefined} />
          Check for updates
        </Button>
```

Add the supporting imports:

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { qk } from '@/features/data/keys'
```

`MachinesModule` already calls `useMachines()` (imported at the top of the file today) — reuse that existing result rather than calling the hook a second time; read the component's opening lines to find the variable it assigns it to.

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Full build**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/store/useDevDeckStore.ts frontend/src/features/overlays/ConfirmMachineActionDialog.tsx frontend/src/features/machines/MachinesModule.tsx
git commit -m "feat(frontend): show machine versions and add a confirmed update action"
```

---

## Final Verification

- [ ] `cd backend && go vet ./... && go test ./...` — all pass
- [ ] `cd frontend && npm run typecheck && npm run build` — both clean
- [ ] Launch `go run ./cmd/server --role both --key devkey`, open the Machines page, confirm each row shows a version chip
- [ ] Click "Check for updates" — on a `dev` build every row reports the dev-build message and no update button appears (correct: a dev build has nothing to compare against)
- [ ] Open desktop settings and confirm the Version section renders version, sha256, and a working copy button

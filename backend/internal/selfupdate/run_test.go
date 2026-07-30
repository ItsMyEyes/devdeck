package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

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

func seedExecFile(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "devdeck-api")
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
		assetData: map[int64][]byte{1: []byte("new-contents")},
	}

	res, err := Run(context.Background(), client, Options{CurrentVersion: "v1.0.0", ExecPath: execPath})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if !res.Updated || res.Version != "v9.9.9" {
		t.Errorf("result = %+v, want Updated at v9.9.9", res)
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

	res, err := Run(context.Background(), client, Options{CurrentVersion: "v1.0.0", ExecPath: execPath})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if res.Updated {
		t.Error("result.Updated = true, want false when already on latest")
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

	if _, err := Run(context.Background(), client, Options{CurrentVersion: "dev", ExecPath: execPath}); err == nil {
		t.Fatal("Run() error = nil, want non-nil for a dev build")
	}
}

func TestRun_NoMatchingAsset(t *testing.T) {
	execPath := seedExecFile(t)
	client := &fakeClient{
		release: &Release{TagName: "v9.9.9", Assets: []Asset{{Name: "devdeck-someother-arch", ID: 1}}},
	}

	if _, err := Run(context.Background(), client, Options{CurrentVersion: "v1.0.0", ExecPath: execPath}); err == nil {
		t.Fatal("Run() error = nil, want non-nil when no asset matches this platform")
	}
}

func TestRun_LatestReleaseFetchError(t *testing.T) {
	execPath := seedExecFile(t)
	client := &fakeClient{releaseErr: errors.New("boom")}

	if _, err := Run(context.Background(), client, Options{CurrentVersion: "v1.0.0", ExecPath: execPath}); err == nil {
		t.Fatal("Run() error = nil, want non-nil when fetching the latest release fails")
	}
}

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

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

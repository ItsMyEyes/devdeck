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

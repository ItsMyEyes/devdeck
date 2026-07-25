package rginstall

import "testing"

// TestPickAssetMatchesEachSupportedPlatform locks in the exact ripgrep
// release-asset naming convention verified against the live GitHub API
// (BurntSushi/ripgrep, version 15.2.0): "ripgrep-<version>-<target>.<ext>".
// Both a musl and a gnu linux asset are included per arch to prove musl is
// preferred (portability across distros/glibc versions), matching the
// design's explicit call-out.
func TestPickAssetMatchesEachSupportedPlatform(t *testing.T) {
	assets := []Asset{
		{Name: "ripgrep-15.2.0-aarch64-apple-darwin.tar.gz", BrowserDownloadURL: "https://example.invalid/darwin-arm64.tar.gz"},
		{Name: "ripgrep-15.2.0-x86_64-apple-darwin.tar.gz", BrowserDownloadURL: "https://example.invalid/darwin-amd64.tar.gz"},
		{Name: "ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz", BrowserDownloadURL: "https://example.invalid/linux-amd64-musl.tar.gz"},
		{Name: "ripgrep-15.2.0-x86_64-unknown-linux-gnu.tar.gz", BrowserDownloadURL: "https://example.invalid/linux-amd64-gnu.tar.gz"},
		{Name: "ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz", BrowserDownloadURL: "https://example.invalid/linux-arm64-musl.tar.gz"},
		{Name: "ripgrep-15.2.0-aarch64-unknown-linux-gnu.tar.gz", BrowserDownloadURL: "https://example.invalid/linux-arm64-gnu.tar.gz"},
		{Name: "ripgrep-15.2.0-x86_64-pc-windows-msvc.zip", BrowserDownloadURL: "https://example.invalid/windows-amd64.zip"},
		{Name: "ripgrep-15.2.0-aarch64-pc-windows-msvc.zip", BrowserDownloadURL: "https://example.invalid/windows-arm64.zip"},
	}

	cases := []struct {
		goos, goarch, wantURL string
	}{
		{"darwin", "arm64", "https://example.invalid/darwin-arm64.tar.gz"},
		{"darwin", "amd64", "https://example.invalid/darwin-amd64.tar.gz"},
		{"linux", "amd64", "https://example.invalid/linux-amd64-musl.tar.gz"},
		{"linux", "arm64", "https://example.invalid/linux-arm64-musl.tar.gz"},
		{"windows", "amd64", "https://example.invalid/windows-amd64.zip"},
		{"windows", "arm64", "https://example.invalid/windows-arm64.zip"},
	}
	for _, tc := range cases {
		t.Run(tc.goos+"/"+tc.goarch, func(t *testing.T) {
			asset, err := PickAsset(assets, tc.goos, tc.goarch)
			if err != nil {
				t.Fatalf("PickAsset(%s/%s) failed: %v", tc.goos, tc.goarch, err)
			}
			if asset.BrowserDownloadURL != tc.wantURL {
				t.Fatalf("PickAsset(%s/%s) = %q, want %q (musl must be preferred over gnu on linux)", tc.goos, tc.goarch, asset.BrowserDownloadURL, tc.wantURL)
			}
		})
	}
}

func TestPickAssetRejectsUnsupportedPlatform(t *testing.T) {
	if _, err := PickAsset(nil, "freebsd", "amd64"); err == nil {
		t.Fatal("expected an error for an unsupported platform, got nil")
	}
}

// TestPickAssetReportsMissingAssetForSupportedPlatform covers a supported
// platform whose expected asset simply isn't in the release (a malformed or
// incomplete release) — it must error, not silently fall back to some
// unrelated asset.
func TestPickAssetReportsMissingAssetForSupportedPlatform(t *testing.T) {
	assets := []Asset{{Name: "ripgrep-15.2.0-x86_64-apple-darwin.tar.gz", BrowserDownloadURL: "https://example.invalid/darwin.tar.gz"}}
	if _, err := PickAsset(assets, "linux", "amd64"); err == nil {
		t.Fatal("expected an error when the expected asset is missing, got nil")
	}
}

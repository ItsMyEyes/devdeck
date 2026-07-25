package rginstall

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// InstallLocal downloads ripgrep's latest GitHub release for goos/goarch
// and atomically installs the extracted "rg"/"rg.exe" binary at
// ~/.local/bin — already one of detect.ResolveBinary's fallback search
// dirs on macOS/Linux (see detect.go's fallbackDirs), so the very next Grep
// call picks it up with no extra server-side state to track. goos/goarch
// are passed explicitly (rather than read from runtime.GOOS/GOARCH) so
// callers control exactly which platform's asset gets installed, mirroring
// selfupdate.ReplaceSelf's goos parameter.
func InstallLocal(ctx context.Context, goos, goarch string) (binPath string, version string, err error) {
	if !supportedPlatform(goos, goarch) {
		return "", "", fmt.Errorf("rginstall: unsupported platform %s/%s", goos, goarch)
	}

	release, err := LatestRelease(ctx)
	if err != nil {
		return "", "", err
	}
	asset, err := PickAsset(release.Assets, goos, goarch)
	if err != nil {
		return "", "", err
	}
	data, err := downloadAsset(ctx, asset)
	if err != nil {
		return "", "", err
	}
	binData, err := extractBinary(asset.Name, data, goos)
	if err != nil {
		return "", "", err
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", fmt.Errorf("resolve home directory: %w", err)
	}
	binName := "rg"
	if goos == "windows" {
		binName = "rg.exe"
	}
	binPath = filepath.Join(home, ".local", "bin", binName)
	if err := writeExecutable(binPath, binData); err != nil {
		return "", "", err
	}
	return binPath, strings.TrimPrefix(release.TagName, "v"), nil
}

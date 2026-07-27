package rginstall

import (
	"context"
	"fmt"
	"path"
	"strings"

	"github.com/pkg/sftp"

	"devdeck/backend/internal/sshmgr"
)

// InstallOverSSH probes connectionID's remote OS/arch (via `uname -s -m`
// over the sshmgr exec primitive), downloads and extracts the matching
// ripgrep release asset on the hub (reusing the same fetch/extract helpers
// InstallLocal uses), then writes the extracted binary to the remote
// host's ~/.local/bin/rg over the already-open pooled SFTP client and
// marks it executable — so a firewalled remote host never needs outbound
// internet access itself. SSH remote hosts are assumed POSIX (see the
// design's scope note), so only the darwin/linux rows of the asset table
// ever apply here.
func InstallOverSSH(ctx context.Context, pool *sshmgr.FilePool, connectionID string) (version string, err error) {
	goos, goarch, err := remoteOSArch(ctx, pool, connectionID)
	if err != nil {
		return "", err
	}

	release, err := LatestRelease(ctx)
	if err != nil {
		return "", err
	}
	asset, err := PickAsset(release.Assets, goos, goarch)
	if err != nil {
		return "", err
	}
	data, err := downloadAsset(ctx, asset)
	if err != nil {
		return "", err
	}
	binData, err := extractBinary(asset.Name, data, goos)
	if err != nil {
		return "", err
	}

	if err := writeRemoteExecutable(ctx, pool, connectionID, binData); err != nil {
		return "", err
	}
	return strings.TrimPrefix(release.TagName, "v"), nil
}

// remoteOSArch runs `uname -s -m` over connectionID's pooled SSH connection
// and maps its output to a goos/goarch pair matching PickAsset's platform
// table. Remote hosts are assumed POSIX, so only "Darwin"/"Linux" and
// "x86_64"/"arm64"/"aarch64" are ever expected here.
func remoteOSArch(ctx context.Context, pool *sshmgr.FilePool, connectionID string) (goos, goarch string, err error) {
	stdout, stderr, runErr := sshmgr.RunCommand(ctx, pool, connectionID, []string{"uname", "-s", "-m"})
	if runErr != nil {
		return "", "", fmt.Errorf("probe remote platform: %s", firstLine(string(stderr)))
	}
	fields := strings.Fields(string(stdout))
	if len(fields) != 2 {
		return "", "", fmt.Errorf("rginstall: unrecognized uname output: %q", strings.TrimSpace(string(stdout)))
	}

	switch fields[0] {
	case "Darwin":
		goos = "darwin"
	case "Linux":
		goos = "linux"
	default:
		return "", "", fmt.Errorf("rginstall: unsupported remote OS %q", fields[0])
	}

	switch fields[1] {
	case "x86_64":
		goarch = "amd64"
	case "arm64", "aarch64":
		goarch = "arm64"
	default:
		return "", "", fmt.Errorf("rginstall: unsupported remote architecture %q", fields[1])
	}
	return goos, goarch, nil
}

// writeRemoteExecutable writes data to connectionID's remote
// ~/.local/bin/rg over the pooled SFTP client (creating ~/.local/bin if
// needed) and marks it executable. SFTP has no atomic rename-over-existing
// guarantee as strong as a local os.Rename, so this writes directly rather
// than via writeExecutable's local temp-file dance.
func writeRemoteExecutable(ctx context.Context, pool *sshmgr.FilePool, connectionID string, data []byte) error {
	_, err := sshmgr.WithSFTPClient(ctx, pool, connectionID, func(client *sftp.Client) (struct{}, error) {
		home, err := client.Getwd()
		if err != nil {
			return struct{}{}, fmt.Errorf("resolve remote home directory: %s", firstLine(err.Error()))
		}
		binDir := path.Join(home, ".local", "bin")
		if err := client.MkdirAll(binDir); err != nil {
			return struct{}{}, fmt.Errorf("create remote install directory: %s", firstLine(err.Error()))
		}
		binPath := path.Join(binDir, "rg")
		f, err := client.Create(binPath)
		if err != nil {
			return struct{}{}, fmt.Errorf("create remote ripgrep binary: %s", firstLine(err.Error()))
		}
		_, writeErr := f.Write(data)
		closeErr := f.Close()
		if writeErr != nil {
			return struct{}{}, fmt.Errorf("write remote ripgrep binary: %s", firstLine(writeErr.Error()))
		}
		if closeErr != nil {
			return struct{}{}, fmt.Errorf("close remote ripgrep binary: %s", firstLine(closeErr.Error()))
		}
		if err := client.Chmod(binPath, 0o755); err != nil {
			return struct{}{}, fmt.Errorf("chmod remote ripgrep binary: %s", firstLine(err.Error()))
		}
		return struct{}{}, nil
	})
	return err
}

// firstLine returns s's first line, trimmed — never leak a multi-line raw
// subprocess/HTTP error detail beyond a short, safe message, matching
// internal/handler/tools.go's firstLine/ToolUnavailableError convention.
func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return s
}

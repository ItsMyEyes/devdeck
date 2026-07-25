// Package rginstall downloads and installs ripgrep from its public GitHub
// releases (see docs/superpowers/specs/2026-07-17-content-search-design.md,
// "Ripgrep auto-install") — for the local hub/runtime process
// (InstallLocal) and for a saved SSH connection's remote host
// (InstallOverSSH), which downloads on the hub and pushes the binary over
// the already-open pooled SFTP connection so a firewalled remote host never
// needs outbound internet access itself.
package rginstall

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

const defaultGithubAPIBaseURL = "https://api.github.com"

// githubAPIBaseURL is the GitHub REST API host, overridable in tests via
// direct reassignment (same pattern as detect.go's shellPathDirs and
// service.go's resolveRipgrep) so tests never hit the real network.
var githubAPIBaseURL = defaultGithubAPIBaseURL

// httpClient is used for both the GitHub API call and the asset download;
// overridable in tests for the same reason.
var httpClient = http.DefaultClient

// Release is the subset of the GitHub releases API response this package
// needs.
type Release struct {
	TagName string  `json:"tag_name"`
	Assets  []Asset `json:"assets"`
}

// Asset is one file attached to a Release.
type Asset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// LatestRelease fetches ripgrep's most recent published GitHub release.
// Unlike internal/selfupdate's Client (which authenticates against Loom's
// own private release repo), this hits the public, unauthenticated GitHub
// API — BurntSushi/ripgrep is a public repo and needs no token.
func LatestRelease(ctx context.Context) (*Release, error) {
	url := fmt.Sprintf("%s/repos/BurntSushi/ripgrep/releases/latest", githubAPIBaseURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request latest ripgrep release: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github: unexpected status %d fetching latest ripgrep release", resp.StatusCode)
	}

	var release Release
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, fmt.Errorf("decode latest ripgrep release response: %w", err)
	}
	return &release, nil
}

// downloadAsset fetches asset's raw bytes via a plain HTTPS GET on its
// BrowserDownloadURL — no auth needed for a public repo's release asset,
// unlike selfupdate's private-repo asset-by-ID API endpoint.
func downloadAsset(ctx context.Context, asset Asset) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.BrowserDownloadURL, nil)
	if err != nil {
		return nil, err
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download asset %s: %w", asset.Name, err)
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

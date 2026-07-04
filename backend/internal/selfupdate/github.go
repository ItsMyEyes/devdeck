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

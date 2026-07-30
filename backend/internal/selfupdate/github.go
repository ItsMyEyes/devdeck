package selfupdate

import (
	"context"
	"encoding/json"
	"errors"
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
	c.setHeaders(req, "application/vnd.github+json")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("request latest release: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, authError(resp.StatusCode, "fetching latest release")
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
	c.setHeaders(req, "application/octet-stream")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("request asset %s: %w", asset.Name, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, authError(resp.StatusCode, "downloading asset "+asset.Name)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read asset %s: %w", asset.Name, err)
	}
	return data, nil
}

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

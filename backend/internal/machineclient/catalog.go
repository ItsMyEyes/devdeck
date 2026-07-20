package machineclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"devdeck/backend/internal/domain"
)

// FetchCatalog pulls this runtime's slice of the hub catalog. It authenticates
// with the runtime's *own* key rather than the hub key: the hub resolves which
// machine is asking from the credential itself, so there is no way to express
// a request for another machine's catalog.
func FetchCatalog(ctx context.Context, hubURL, machineKey string) (domain.CatalogSnapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	url := strings.TrimRight(hubURL, "/") + "/api/runtime/catalog"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return domain.CatalogSnapshot{}, err
	}
	req.Header.Set("Authorization", "Bearer "+machineKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return domain.CatalogSnapshot{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return domain.CatalogSnapshot{}, fmt.Errorf("hub returned status %d for GET %s", resp.StatusCode, url)
	}

	var snap domain.CatalogSnapshot
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
		return domain.CatalogSnapshot{}, fmt.Errorf("decode catalog: %w", err)
	}
	return snap, nil
}

// ErrWorkspaceGone means the hub rejected a replayed project because its
// workspace no longer exists there. Distinct from a transient network/5xx
// failure: the caller should record why, not just retry silently forever.
var ErrWorkspaceGone = errors.New("workspace no longer exists on the hub")

type replayProjectBody struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name"`
	Path        string `json:"path"`
	Repo        string `json:"repo"`
}

// ReplayProject pushes one project this runtime created while the hub was
// unreachable. Like FetchCatalog, it authenticates with the runtime's own
// key; machineId is never sent — the hub derives it from that key.
func ReplayProject(ctx context.Context, hubURL, machineKey string, p domain.Project) (domain.Project, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	body, err := json.Marshal(replayProjectBody{
		ID:          p.ID,
		WorkspaceID: p.WorkspaceID,
		Name:        p.Name,
		Path:        p.Path,
		Repo:        p.Repo,
	})
	if err != nil {
		return domain.Project{}, err
	}

	url := strings.TrimRight(hubURL, "/") + "/api/runtime/projects"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return domain.Project{}, err
	}
	req.Header.Set("Authorization", "Bearer "+machineKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return domain.Project{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict {
		return domain.Project{}, ErrWorkspaceGone
	}
	if resp.StatusCode != http.StatusOK {
		return domain.Project{}, fmt.Errorf("hub returned status %d for POST %s", resp.StatusCode, url)
	}

	var got domain.Project
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		return domain.Project{}, fmt.Errorf("decode replayed project: %w", err)
	}
	return got, nil
}

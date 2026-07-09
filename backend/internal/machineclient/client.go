// Package machineclient is the hub's server-to-server client for talking to
// registered runtime machines directly (hub and runtimes share one
// Tailscale tailnet — see docs/superpowers/specs/2026-07-09-hub-runtime-tauri-design.md).
// It is used to federate live, runtime-owned data (worktrees) into the
// hub's own responses; it is not the client/proxy path browsers use.
package machineclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"loom/backend/internal/domain"
)

const requestTimeout = 3 * time.Second

// FetchWorktrees lists a project's worktrees directly from the machine that
// owns it. Any failure (unreachable machine, non-200, bad JSON) is returned
// as an error — callers decide how to degrade (see service/workspace.go,
// which treats this as "worktrees unknown for now", not a fatal error).
func FetchWorktrees(ctx context.Context, m domain.Machine, projectID string) ([]domain.Worktree, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	url := strings.TrimRight(m.URL, "/") + "/api/projects/" + projectID + "/worktrees"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+m.Key)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("machine %s unreachable: %w", m.ID, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("machine %s returned status %d", m.ID, resp.StatusCode)
	}

	var worktrees []domain.Worktree
	if err := json.NewDecoder(resp.Body).Decode(&worktrees); err != nil {
		return nil, fmt.Errorf("machine %s: decode worktrees: %w", m.ID, err)
	}
	return worktrees, nil
}

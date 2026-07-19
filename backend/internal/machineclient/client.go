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

	"devdeck/backend/internal/domain"
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

// HealthStatus is the result of pinging a machine's /api/health endpoint.
type HealthStatus struct {
	Status    string // "online" or "offline"
	LatencyMs int64  // only meaningful when Status == "online"
}

// CheckHealth pings m's /api/health with a short timeout. Offline is a
// normal result (not an error) — the same design as the hub's per-machine
// health badge always had, just reusable outside the handler package now
// (see MachineHealthCache in package service).
func CheckHealth(ctx context.Context, m domain.Machine) HealthStatus {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(m.URL, "/")+"/api/health", nil)
	if err != nil {
		return HealthStatus{Status: "offline"}
	}
	req.Header.Set("Authorization", "Bearer "+m.Key)

	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		return HealthStatus{Status: "offline"}
	}
	resp.Body.Close()
	return HealthStatus{Status: "online", LatencyMs: time.Since(start).Milliseconds()}
}

// Probe verifies a machine is reachable at rawURL and that key is accepted
// by its key-gated routes. Unlike /api/health (deliberately open — see
// RequireKey/RequireAuth's public-path allowlists), /api/whoami enforces
// the normal auth middleware, so a 200 here proves both reachability and a
// correct key. A 401 is reported distinctly from other failures so callers
// (PostMachine, before registering a new machine) can tell "wrong key" from
// "machine unreachable".
func Probe(ctx context.Context, rawURL, key string) error {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(rawURL, "/")+"/api/whoami", nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+key)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("machine unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("machine rejected the key")
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("machine returned status %d", resp.StatusCode)
	}
	return nil
}

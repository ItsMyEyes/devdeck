package machineclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

// SelfRegisterConfig describes a runtime's identity for self-registration
// with a hub, so an operator doesn't have to add each machine by hand
// through the Machines UI. See
// docs/superpowers/specs/2026-07-09-runtime-self-registration-design.md.
type SelfRegisterConfig struct {
	HubURL    string // hub base URL, e.g. https://hub.tail-xxxx.ts.net:8989
	HubKey    string // hub's bearer key, used to authenticate this call
	PublicURL string // this runtime's own reachable URL
	Name      string // display name in the hub's Machines UI
	Key       string // this runtime's own static API key
	// IsLocal marks this entry as a same-process, self-registered machine
	// (a --role both process registering itself) so the hub protects it
	// from accidental edit/delete the same way it already protects the
	// Tauri desktop's embedded runtime entry. Zero value (false) is exactly
	// today's behavior for a runtime self-registering with a remote hub.
	IsLocal bool
}

// hubMachine mirrors domain.Machine's JSON shape for decoding the hub's
// GET /api/machines response; kept local (not imported from domain) since
// this package already depends on domain.Worktree/Machine for the
// hub->runtime direction and this is the inverse, runtime->hub direction.
type hubMachine struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	URL     string `json:"url"`
	Key     string `json:"key"`
	IsLocal bool   `json:"isLocal"`
}

// SelfRegister upserts this runtime's entry in the hub's machine registry
// by URL: an existing entry whose url matches cfg.PublicURL is PATCHed if
// its name/key differ (a no-op if already correct); no match creates a new
// entry. It reuses the hub's existing GET/POST/PATCH /api/machines
// endpoints — no hub-side change was needed for this.
func SelfRegister(ctx context.Context, cfg SelfRegisterConfig) error {
	machines, err := listHubMachines(ctx, cfg)
	if err != nil {
		return fmt.Errorf("list hub machines: %w", err)
	}

	for _, m := range machines {
		if m.URL != cfg.PublicURL {
			continue
		}
		if m.Name == cfg.Name && m.Key == cfg.Key && m.IsLocal == cfg.IsLocal {
			return nil
		}
		return patchHubMachine(ctx, cfg, m.ID)
	}
	return createHubMachine(ctx, cfg)
}

// RunSelfRegisterLoop retries SelfRegister on retryEvery until it succeeds
// once, then returns. A failure is logged, never fatal — the caller (the
// runtime's main goroutine) keeps serving regardless of registration
// status. Returns early if ctx is cancelled.
func RunSelfRegisterLoop(ctx context.Context, cfg SelfRegisterConfig, retryEvery time.Duration) {
	for {
		if err := SelfRegister(ctx, cfg); err != nil {
			log.Printf("self-register: %v; retrying in %s", err, retryEvery)
		} else {
			log.Printf("self-register: registered with hub as %q (%s)", cfg.Name, cfg.PublicURL)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(retryEvery):
		}
	}
}

func listHubMachines(ctx context.Context, cfg SelfRegisterConfig) ([]hubMachine, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(cfg.HubURL, "/")+"/api/machines", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.HubKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("hub returned status %d", resp.StatusCode)
	}
	var machines []hubMachine
	if err := json.NewDecoder(resp.Body).Decode(&machines); err != nil {
		return nil, fmt.Errorf("decode machines: %w", err)
	}
	return machines, nil
}

func createHubMachine(ctx context.Context, cfg SelfRegisterConfig) error {
	body, err := json.Marshal(struct {
		Name    string `json:"name"`
		URL     string `json:"url"`
		Key     string `json:"key"`
		IsLocal bool   `json:"isLocal,omitempty"`
	}{Name: cfg.Name, URL: cfg.PublicURL, Key: cfg.Key, IsLocal: cfg.IsLocal})
	if err != nil {
		return err
	}
	return doHubMachineRequest(ctx, cfg, http.MethodPost, strings.TrimRight(cfg.HubURL, "/")+"/api/machines", body)
}

func patchHubMachine(ctx context.Context, cfg SelfRegisterConfig, id string) error {
	body, err := json.Marshal(struct {
		Name    string `json:"name"`
		Key     string `json:"key"`
		IsLocal bool   `json:"isLocal,omitempty"`
	}{Name: cfg.Name, Key: cfg.Key, IsLocal: cfg.IsLocal})
	if err != nil {
		return err
	}
	return doHubMachineRequest(ctx, cfg, http.MethodPatch, strings.TrimRight(cfg.HubURL, "/")+"/api/machines/"+id, body)
}

func doHubMachineRequest(ctx context.Context, cfg SelfRegisterConfig, method, url string, body []byte) error {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.HubKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("hub returned status %d for %s %s", resp.StatusCode, method, url)
	}
	return nil
}

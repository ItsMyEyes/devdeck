package machineclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"devdeck/backend/internal/domain"
)

// ProxyStartResult is the bound address of a machine's on-demand forward
// proxy, decoded from POST /api/proxy/start (see service.ProxyStartResult,
// which this mirrors — not reused directly to avoid service importing back
// into machineclient).
type ProxyStartResult struct {
	HTTPProxyAddr string `json:"httpProxyAddr"`
}

// StartProxy idempotently starts m's forward proxy and returns its bound
// HTTP proxy address, tailnet-reachable from the hub the same way
// FetchWorktrees/CheckHealth reach the machine directly. Used by
// FaviconService to fetch a bookmarked page through the machine that can
// actually resolve it (localhost dev servers, tailnet-internal hosts).
func StartProxy(ctx context.Context, m domain.Machine) (ProxyStartResult, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	url := strings.TrimRight(m.URL, "/") + "/api/proxy/start"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return ProxyStartResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+m.Key)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ProxyStartResult{}, fmt.Errorf("machine %s unreachable: %w", m.ID, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ProxyStartResult{}, fmt.Errorf("machine %s returned status %d starting proxy", m.ID, resp.StatusCode)
	}

	var result ProxyStartResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return ProxyStartResult{}, fmt.Errorf("machine %s: decode proxy/start response: %w", m.ID, err)
	}
	if result.HTTPProxyAddr == "" {
		return ProxyStartResult{}, fmt.Errorf("machine %s: proxy/start returned no httpProxyAddr", m.ID)
	}
	return result, nil
}

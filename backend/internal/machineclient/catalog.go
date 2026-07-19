package machineclient

import (
	"context"
	"encoding/json"
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

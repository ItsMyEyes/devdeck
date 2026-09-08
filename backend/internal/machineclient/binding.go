package machineclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"devdeck/backend/internal/domain"
)

type bindingRequest struct {
	HubURL    string `json:"hubUrl"`
	MachineID string `json:"machineId"`
}

type bindingResponse struct {
	Adopted bool   `json:"adopted"`
	Reason  string `json:"reason,omitempty"`
}

// PushBinding tells m's own runtime process this hub's URL and m's
// hub-assigned id, via PUT /api/runtime/binding, authenticated with m's own
// key exactly like every other hub-to-machine call in this package. The
// runtime adopts it unless it already has an explicit --hub-url of its own —
// see service.RuntimeBinder.Bind, whose refusal comes back here as
// (false, reason) rather than an error.
func PushBinding(ctx context.Context, m domain.Machine, hubURL string) (adopted bool, reason string, err error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	body, err := json.Marshal(bindingRequest{HubURL: hubURL, MachineID: m.ID})
	if err != nil {
		return false, "", err
	}

	url := strings.TrimRight(m.URL, "/") + "/api/runtime/binding"
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(body))
	if err != nil {
		return false, "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+m.Key)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, "", fmt.Errorf("machine %s unreachable: %w", m.ID, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, "", fmt.Errorf("machine %s returned status %d", m.ID, resp.StatusCode)
	}

	var out bindingResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return false, "", fmt.Errorf("machine %s: decode binding response: %w", m.ID, err)
	}
	return out.Adopted, out.Reason, nil
}

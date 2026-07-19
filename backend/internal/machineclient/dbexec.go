package machineclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"devdeck/backend/internal/domain"
)

// dbRequestTimeout bounds one hub→runtime database call. It is far longer than
// requestTimeout (used for health pings and quick reads) because the runtime
// has to dial the database, possibly through an SSH tunnel, and then run a
// statement that is itself allowed 30 seconds. The slack above that covers the
// dial and the round trip; without it the hub would give up on queries the
// runtime is about to answer.
const dbRequestTimeout = 45 * time.Second

// RunDBRequest posts a database operation to a runtime machine and decodes the
// reply into out.
//
// The body carries a port.DSNDescriptor with DECRYPTED credentials, which is
// why this only ever runs against a machine whose URL passed
// service.ValidateExecutorURL and why the body is never logged — not on
// success, not on failure, not in an error message. Only the machine id and
// the path appear in errors.
//
// Follows CloneOnMachine (clone.go): bearer the machine's own key, and read
// the standard {"error":"..."} envelope back off a non-2xx response so the
// runtime's message survives the hop.
func RunDBRequest(ctx context.Context, m domain.Machine, path string, body any, out any) error {
	ctx, cancel := context.WithTimeout(ctx, dbRequestTimeout)
	defer cancel()

	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("machine %s: encode request: %w", m.ID, err)
	}
	url := strings.TrimRight(m.URL, "/") + path
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+m.Key)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("machine %s unreachable: %w", m.ID, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var envelope struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&envelope)
		if envelope.Error == "" {
			return fmt.Errorf("machine %s returned status %d", m.ID, resp.StatusCode)
		}
		return fmt.Errorf("machine %s: %s", m.ID, envelope.Error)
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("machine %s: decode response from %s: %w", m.ID, path, err)
	}
	return nil
}

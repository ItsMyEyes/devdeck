package machineclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"devdeck/backend/internal/domain"
)

// cloneTimeout is generous compared to requestTimeout (used for quick reads
// like FetchWorktrees) because a real `git clone` can legitimately take much
// longer than 3 seconds.
const cloneTimeout = 2 * time.Minute

// ErrConflict indicates the machine reported (HTTP 409) that the clone
// destination already exists. Distinguished from other CloneOnMachine
// failures so ProjectService.Clone can map it to its own ErrConflict
// (HTTP 409) instead of ErrValidation (HTTP 400) — matching the status
// code the local (non-machine) clone path already returns for the same
// condition.
var ErrConflict = errors.New("clone destination already exists")

// CloneOnMachine asks the machine m to clone repo into path on its own
// filesystem, via its POST /api/fs/clone endpoint (see
// backend/internal/handler/fs.go Clone). Used by ProjectService.Clone when a
// project is being created with a non-empty machineId, so the actual git
// clone happens on the machine that will own the project, not on the hub.
func CloneOnMachine(ctx context.Context, m domain.Machine, repo, path string) error {
	ctx, cancel := context.WithTimeout(ctx, cloneTimeout)
	defer cancel()

	payload, err := json.Marshal(map[string]string{"repo": repo, "path": path})
	if err != nil {
		return err
	}
	url := strings.TrimRight(m.URL, "/") + "/api/fs/clone"
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
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		var body struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&body)
		msg := body.Error
		if msg == "" {
			msg = fmt.Sprintf("machine %s returned status %d", m.ID, resp.StatusCode)
		}
		if resp.StatusCode == http.StatusConflict {
			return fmt.Errorf("%s: %w", msg, ErrConflict)
		}
		return fmt.Errorf("%s", msg)
	}
	return nil
}

// sshsecret.go runs BACKWARDS relative to most of this package, the same way
// memory.go does: a runtime calling back to the hub with its own machine key,
// rather than the hub calling out to a runtime.
//
// It exists because DevOps chat runs entirely on the executor runtime now —
// the agent process and the SSH tool calls it makes — so the process that
// completes the SSH handshake is the runtime, while the credential lives
// encrypted on the hub, keyed by a master key the runtime does not have.
package machineclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"devdeck/backend/internal/sshmgr"
)

// sshSecretTimeout bounds one credential fetch. Short on purpose: this sits
// directly in the path of an SSH dial, which has its own 10s budget
// (sshmgr.dialTimeout), so a hub that is not answering must fail fast enough
// to leave room for the dial itself to report something useful.
const sshSecretTimeout = 5 * time.Second

// HubSecretSource satisfies sshmgr.SecretSource on a runtime by asking the
// hub to decrypt one of THIS machine's connections' credentials.
//
// The hub authorizes every call against the connection's ExecutorMachineID
// (handler.RuntimeSSHHandler.PostSecret), so this type carries no
// authorization logic of its own — it must not, or there would be two answers
// to the same question and only the hub's is enforceable.
//
// Values are cached briefly. sshmgr.Dialer calls Get once per credential kind
// per dial, and a jump-host chain multiplies that by its depth; without a
// cache, one bastion-hopped connect is four or more round trips to the hub
// before the first byte moves. The TTL is deliberately short — this is a
// dial-time cache, not a credential store — so an operator who rotates a
// password sees it take effect in seconds rather than needing a restart.
type HubSecretSource struct {
	hubURL     string
	machineKey string

	mu     sync.Mutex
	cache  map[string]cachedSecret
	ttl    time.Duration
	nowFn  func() time.Time
	client *http.Client
}

type cachedSecret struct {
	value string
	found bool
	at    time.Time
}

// NewHubSecretSource builds the runtime-side SecretSource. hubURL and
// machineKey are the process's own --hub-url and --key.
func NewHubSecretSource(hubURL, machineKey string) *HubSecretSource {
	return &HubSecretSource{
		hubURL:     hubURL,
		machineKey: machineKey,
		cache:      make(map[string]cachedSecret),
		ttl:        30 * time.Second,
		nowFn:      time.Now,
		client:     &http.Client{},
	}
}

type sshSecretBody struct {
	ConnectionID string `json:"connectionId"`
	Kind         string `json:"kind"`
}

type sshSecretResult struct {
	Found bool   `json:"found"`
	Value string `json:"value"`
}

// Get implements sshmgr.SecretSource.
//
// A "not found" answer is cached alongside a found one: a connection that
// authenticates by key is asked for a password on every single dial, and
// without caching the negative that is a guaranteed round trip per dial for a
// credential that will never exist.
//
// Neither the value nor the response body is ever logged — see
// handler.RuntimeSSHHandler's doc comment for the rule this follows.
func (s *HubSecretSource) Get(connectionID, kind string) (string, bool, error) {
	key := connectionID + "|" + kind
	if v, ok := s.lookup(key); ok {
		return v.value, v.found, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), sshSecretTimeout)
	defer cancel()

	body, err := json.Marshal(sshSecretBody{ConnectionID: connectionID, Kind: kind})
	if err != nil {
		return "", false, err
	}
	url := strings.TrimRight(s.hubURL, "/") + "/api/runtime/ssh/secret"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", false, err
	}
	req.Header.Set("Authorization", "Bearer "+s.machineKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		// Wrapped without the body: the request carries no secret, but the
		// response would, and an error string is the likeliest thing to end up
		// in a log or a transcript.
		return "", false, fmt.Errorf("hub unreachable while reading SSH credentials: %w", err)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusNotFound:
		// The hub does not consider this connection ours to execute. Reported
		// as an error rather than "no credential", because silently dialing on
		// with no password would surface as a confusing auth failure instead of
		// the real, fixable problem.
		return "", false, fmt.Errorf("this runtime is not the executor for SSH connection %s", connectionID)
	case resp.StatusCode == http.StatusUnauthorized:
		return "", false, fmt.Errorf("this runtime's key was rejected by the hub")
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		return "", false, fmt.Errorf("hub returned status %d while reading SSH credentials", resp.StatusCode)
	}

	var out sshSecretResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", false, fmt.Errorf("could not decode the hub's credential response: %w", err)
	}
	s.store(key, cachedSecret{value: out.Value, found: out.Found, at: s.nowFn()})
	return out.Value, out.Found, nil
}

func (s *HubSecretSource) lookup(key string) (cachedSecret, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.cache[key]
	if !ok || s.nowFn().Sub(v.at) > s.ttl {
		return cachedSecret{}, false
	}
	return v, true
}

func (s *HubSecretSource) store(key string, v cachedSecret) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cache[key] = v
}

var _ sshmgr.SecretSource = (*HubSecretSource)(nil)

// Package setupui implements `devdeck setup`, the interactive wizard that
// writes devdeck.yaml. This file holds the wizard's side effects — Tailscale
// detection, hub reachability, key generation — as plain functions with their
// dependencies passed in, so tests fake them without mutable package globals.
// The Bubble Tea model wraps each one in a tea.Cmd; nothing here imports
// Bubble Tea.
package setupui

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"devdeck/backend/internal/detect"
)

// Reasons Tailscale detection can fail. They are detect.TailscaleSelfURL's
// strings, re-exported so the wizard can branch on them without importing
// detect; ProbeTailscaleReasonsMatchDetect guards the two staying in step.
const (
	// ReasonNotInstalled — the tailscale CLI isn't anywhere detect looks.
	ReasonNotInstalled = "not_installed"
	// ReasonNotReady — the CLI is there but this device has no tailnet name
	// (logged out, or MagicDNS off).
	ReasonNotReady = "not_ready"
)

// TailscaleProbe is the seam for wizard step 6: detect.TailscaleSelfURL's
// signature, taken as a parameter rather than kept in a package var so tests
// in different packages cannot race each other.
type TailscaleProbe func() (url string, reason string)

// TailscaleResult is what step 6 learned about this machine's tailnet
// identity. Exactly one of URL and Reason is ever set.
type TailscaleResult struct {
	URL    string // "https://<dnsname>", or "" when detection failed
	Reason string // "" on success, else ReasonNotInstalled/ReasonNotReady
}

// Found reports whether this machine has a tailnet-reachable URL.
func (r TailscaleResult) Found() bool { return r.URL != "" }

// Message is the one-line status the wizard shows under the Public URL field.
func (r TailscaleResult) Message() string {
	switch {
	case r.Found():
		return "Tailscale: " + r.URL
	case r.Reason == ReasonNotInstalled:
		return "Tailscale is not installed — using the listen address instead"
	case r.Reason == ReasonNotReady:
		return "Tailscale is installed but this machine is not on a tailnet yet"
	default:
		return "Tailscale detection failed: " + r.Reason
	}
}

// PublicURL is the value to pre-fill wizard step 6 with: the tailnet URL when
// there is one, otherwise http://<listen addr>. It returns "" when neither is
// known, so the caller never suggests a URL it made up.
func (r TailscaleResult) PublicURL(addr string) string {
	if r.Found() {
		return r.URL
	}
	if addr = strings.TrimSpace(addr); addr != "" {
		return "http://" + addr
	}
	return ""
}

// ProbeTailscale detects this machine's tailnet URL for real.
func ProbeTailscale() TailscaleResult {
	return ProbeTailscaleWith(detect.TailscaleSelfURL)
}

// ProbeTailscaleWith is ProbeTailscale with the detection injected. A nil
// probe reports ReasonNotInstalled rather than panicking — the wizard must
// degrade to http://<addr>, never crash, when Tailscale cannot be consulted.
func ProbeTailscaleWith(probe TailscaleProbe) TailscaleResult {
	if probe == nil {
		return TailscaleResult{Reason: ReasonNotInstalled}
	}
	u, reason := probe()
	u = strings.TrimSpace(u)
	if u != "" {
		return TailscaleResult{URL: u} // a URL wins; a reason alongside it is meaningless
	}
	if reason == "" {
		reason = ReasonNotReady // no URL and no explanation is still a failure
	}
	return TailscaleResult{Reason: reason}
}

// HubStatus is the outcome of the wizard's live hub check (step 8).
type HubStatus int

const (
	// HubUnknown is the zero value: the check has not run. It is deliberately
	// not HubOK, so a wizard that has not probed yet cannot render a ✓.
	HubUnknown HubStatus = iota
	// HubOK — the hub answered and accepted the key.
	HubOK
	// HubBadKey — the hub answered but rejected the key (401/403).
	HubBadKey
	// HubUnreachable — no usable answer: bad URL, refused, timed out.
	HubUnreachable
)

// String renders the status for logs and test failures.
func (s HubStatus) String() string {
	switch s {
	case HubOK:
		return "ok"
	case HubBadKey:
		return "bad_key"
	case HubUnreachable:
		return "unreachable"
	default:
		return "unknown"
	}
}

// HubResult is the hub check's verdict plus the line the wizard shows next to
// it. Detail always carries the actual error text — the whole point of the
// check is that a wrong hub key fails loudly here rather than silently 30
// seconds after boot as a "Never synced with the hub" notice.
type HubResult struct {
	Status HubStatus
	Detail string
}

// OK reports whether the hub answered and accepted the key.
func (r HubResult) OK() bool { return r.Status == HubOK }

// hubProbeTimeout bounds the hub check. The wizard is interactive: a wrong or
// unroutable hub URL must come back as an error in seconds, never hang.
const hubProbeTimeout = 5 * time.Second

// whoamiPath is the hub endpoint the check hits. It requires the bearer key,
// so a 401/403 from it is exactly the "wrong hub key" signal.
const whoamiPath = "/api/whoami"

// CheckHub probes GET <hubURL>/api/whoami with key as a bearer token, using a
// client bounded by hubProbeTimeout. A shorter deadline on ctx still wins.
func CheckHub(ctx context.Context, hubURL, key string) HubResult {
	return CheckHubWith(ctx, &http.Client{Timeout: hubProbeTimeout}, hubURL, key)
}

// CheckHubWith is CheckHub with the HTTP client injected, so tests can fake
// the transport instead of standing up a server.
func CheckHubWith(ctx context.Context, client *http.Client, hubURL, key string) HubResult {
	endpoint, err := whoamiURL(hubURL)
	if err != nil {
		return HubResult{Status: HubUnreachable, Detail: err.Error()}
	}
	if client == nil {
		client = &http.Client{Timeout: hubProbeTimeout}
	}

	ctx, cancel := context.WithTimeout(ctx, hubProbeTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return HubResult{Status: HubUnreachable, Detail: err.Error()}
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}

	resp, err := client.Do(req)
	if err != nil {
		// url.Error already names the URL it failed to reach; keep it verbatim.
		return HubResult{Status: HubUnreachable, Detail: err.Error()}
	}
	if resp.Body != nil {
		// Drain a little so the connection can be reused, then always close.
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	}

	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return HubResult{
			Status: HubBadKey,
			Detail: fmt.Sprintf("hub rejected the key (HTTP %d from %s)", resp.StatusCode, endpoint),
		}
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return HubResult{
			Status: HubOK,
			Detail: fmt.Sprintf("hub reachable, key accepted (HTTP %d from %s)", resp.StatusCode, endpoint),
		}
	default:
		return HubResult{
			Status: HubUnreachable,
			Detail: fmt.Sprintf("hub answered HTTP %d from %s", resp.StatusCode, endpoint),
		}
	}
}

// whoamiURL turns an operator-typed hub URL into the whoami endpoint,
// tolerating a trailing slash and rejecting anything that is not an absolute
// http(s) URL — the same shape the hub's Add machine dialog demands.
func whoamiURL(hubURL string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(hubURL), "/")
	if trimmed == "" {
		return "", fmt.Errorf("hub URL is empty")
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("hub URL %q is not a URL: %w", hubURL, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("hub URL %q must start with http:// or https://", hubURL)
	}
	if u.Host == "" {
		return "", fmt.Errorf("hub URL %q has no host", hubURL)
	}
	return trimmed + whoamiPath, nil
}

// GenerateKey mints this machine's API key: 32 bytes from crypto/rand, hex
// encoded, matching the format of every other key DevDeck issues.
func GenerateKey() string {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand.Read never returns an error on any supported platform;
		// if the system entropy source is broken, a silently weak API key is
		// far worse than stopping.
		panic("setupui: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(buf[:])
}

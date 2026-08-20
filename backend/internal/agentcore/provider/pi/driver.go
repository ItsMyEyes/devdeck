// Package pi implements the provider.Driver and provider.Adapter for the Pi
// CLI (pi.dev). Pi is spawned in `--mode rpc` — JSON Lines over stdin/stdout,
// documented at pi.dev/docs/latest/rpc — which is the closest analogue to
// claude's `stream-json` transport: a long-lived process, one per thread,
// that accepts commands on stdin and streams lifecycle events on stdout.
//
// Unlike claude, this package was built and verified against a live
// `pi --mode rpc` session (binary v0.78.1) rather than the CLI's --help/docs
// alone — the published docs undersell the real wire shape (e.g. text
// deltas are actually text_start/text_delta/text_end, not a single delta
// type; thinking deltas are named "thinking_*", not "reasoning_*"). See
// parse.go's package comment for what was and wasn't captured live, and
// re-verify against a newer CLI before trusting an untested code path.
package pi

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/detect"
)

// Kind is this driver's provider.Kind. See the InstanceID comment in
// provider/provider.go — routing happens on InstanceID, never on Kind.
const Kind provider.Kind = "pi"

// Config is the pi driver's validated instance configuration. Mirrors
// claude.Config's shape deliberately, for the same reasons documented there.
type Config struct {
	BinaryName string   `json:"binaryName"`
	HomeDir    string   `json:"homeDir,omitempty"`
	ExtraArgs  []string `json:"extraArgs,omitempty"`
}

func (Config) ProviderKind() provider.Kind { return Kind }

// Driver is the pi provider.Driver: a declarative value with no live process
// state.
type Driver struct{}

// NewDriver constructs the pi driver.
func NewDriver() provider.Driver { return Driver{} }

func (Driver) Kind() provider.Kind { return Kind }

func (Driver) DefaultConfig() json.RawMessage {
	return json.RawMessage(`{"binaryName":"pi"}`)
}

func (Driver) DecodeConfig(raw json.RawMessage) (provider.Config, error) {
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("pi: invalid config: %w", err)
	}
	if c.BinaryName == "" {
		c.BinaryName = "pi"
	}
	return c, nil
}

// Probe reports whether the pi CLI is usable on this machine. Kept cheap and
// side-effect free like claude's — no RPC process is spawned here, only
// `pi --version`.
func (Driver) Probe(ctx context.Context, cfg provider.Config) (provider.Snapshot, error) {
	c, ok := cfg.(Config)
	if !ok {
		return provider.Snapshot{}, fmt.Errorf("pi: probe received config of type %T, want pi.Config", cfg)
	}

	bin, err := detect.ResolveBinary(c.BinaryName)
	if err != nil {
		return provider.Snapshot{
			Kind:      Kind,
			Available: false,
			Detail:    "pi CLI not found on PATH",
		}, nil
	}

	vctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(vctx, bin, "--version").Output()
	if err != nil {
		return provider.Snapshot{
			Kind:       Kind,
			Available:  false,
			BinaryPath: bin,
			Detail:     fmt.Sprintf("pi --version failed: %v", err),
		}, nil
	}

	return provider.Snapshot{
		Kind:       Kind,
		Available:  true,
		Version:    strings.TrimSpace(string(out)),
		BinaryPath: bin,
	}, nil
}

// Create builds a live adapter. ctx binds the adapter's lifetime: when it is
// cancelled, every session process this adapter spawned must die too.
func (Driver) Create(ctx context.Context, spec provider.InstanceSpec) (provider.Adapter, error) {
	c, ok := spec.Config.(Config)
	if !ok {
		return nil, fmt.Errorf("pi: create received config of type %T, want pi.Config", spec.Config)
	}
	return newAdapter(ctx, spec.InstanceID, c, spec.Env), nil
}

var _ provider.Driver = Driver{}

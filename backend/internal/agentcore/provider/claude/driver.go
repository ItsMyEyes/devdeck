// Package claude implements the provider.Driver and provider.Adapter for the
// Claude Code CLI. It is the one concrete provider built in spec 1; see
// gg/HANDOFF.md sections 4 and 8 for why Driver and Adapter are split and
// what is deliberately still missing (approvals, resume-after-restart).
package claude

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

// Kind is this driver's provider.Kind. Every claude instance's InstanceID
// still looks like "claude:default" — routing always happens on InstanceID,
// never on Kind. See the InstanceID comment in provider/provider.go; this is
// the exact mistake t3code paid to migrate away from.
const Kind provider.Kind = "claude"

// Config is the claude driver's validated instance configuration.
type Config struct {
	// BinaryName is a CLI name to resolve via detect.ResolveBinary (e.g.
	// "claude"), not an absolute path — so the same config works across
	// machines with different install locations.
	BinaryName string `json:"binaryName"`
	// HomeDir, when set, isolates this instance's credentials and session
	// state from every other instance by overriding HOME for the spawned
	// process. Without it, two Claude instances (e.g. two accounts) would
	// share, and clobber, one another's ~/.claude state — see HANDOFF
	// section 4, "state per-instance harus terisolasi".
	HomeDir string `json:"homeDir,omitempty"`
	// ExtraArgs are appended after buildArgs' own flags, as an escape hatch
	// for CLI flags this driver does not model directly.
	ExtraArgs []string `json:"extraArgs,omitempty"`
}

func (Config) ProviderKind() provider.Kind { return Kind }

// Driver is the claude provider.Driver: a declarative value with no live
// process state, so the settings screen can show "claude v2.1.224,
// installed" without spawning an agent.
type Driver struct{}

// NewDriver constructs the claude driver.
func NewDriver() provider.Driver { return Driver{} }

func (Driver) Kind() provider.Kind { return Kind }

func (Driver) DefaultConfig() json.RawMessage {
	return json.RawMessage(`{"binaryName":"claude"}`)
}

// DecodeConfig validates raw instance config. Errors surface directly to the
// settings UI, so they must explain what is wrong in terms an operator
// understands rather than a bare decode failure.
func (Driver) DecodeConfig(raw json.RawMessage) (provider.Config, error) {
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("claude: invalid config: %w", err)
	}
	if c.BinaryName == "" {
		c.BinaryName = "claude"
	}
	return c, nil
}

// Probe reports whether the claude CLI is usable on this machine. A missing
// binary is a normal STATUS, not an error — Probe must never fail just
// because the agent isn't installed, since the settings UI needs to show
// "not installed" without treating that as a failure of the probe itself.
func (Driver) Probe(ctx context.Context, cfg provider.Config) (provider.Snapshot, error) {
	c, ok := cfg.(Config)
	if !ok {
		return provider.Snapshot{}, fmt.Errorf("claude: probe received config of type %T, want claude.Config", cfg)
	}

	bin, err := detect.ResolveBinary(c.BinaryName)
	if err != nil {
		return provider.Snapshot{
			Kind:      Kind,
			Available: false,
			Detail:    "claude CLI not found on PATH",
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
			Detail:     fmt.Sprintf("claude --version failed: %v", err),
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
		return nil, fmt.Errorf("claude: create received config of type %T, want claude.Config", spec.Config)
	}
	return newAdapter(ctx, spec.InstanceID, c, spec.Env), nil
}

var _ provider.Driver = Driver{}

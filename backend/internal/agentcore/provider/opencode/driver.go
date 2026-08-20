// Package opencode implements the provider.Driver and provider.Adapter for
// the OpenCode CLI, spoken over `opencode serve` — an HTTP API plus a
// per-session SSE stream.
//
// # Verified against the binary, not the docs
//
// Built and checked against opencode 1.18.18, three ways:
//
//   - `opencode serve --port N` prints `opencode server listening on <url>` on
//     stdout, which is how readiness is detected (t3code keys off the same
//     string).
//   - The server publishes its own OpenAPI 3.1 document at `GET /doc` — 162
//     paths. Every route this package calls came from there, not from
//     documentation.
//   - A live session was created and prompted, and its SSE stream captured, to
//     pin the event names and payloads.
//
// That third step mattered: t3code's own OpenCode adapter switches on
// `message.part.delta` / `message.part.updated`, and against 1.18.18 none of
// those fire — the real stream is `session.next.*`. See parse.go.
//
// # Shape
//
// One `opencode serve` process per instance, hosting many sessions — the same
// arrangement as codex, and unlike claude/pi's process-per-thread. Each
// DevDeck thread maps onto an OpenCode session id and gets its own SSE
// subscription, so no cross-thread demultiplexing is needed.
package opencode

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

// Kind is this driver's provider.Kind. Routing happens on InstanceID, never on
// Kind — see the InstanceID comment in provider/provider.go.
const Kind provider.Kind = "opencode"

// Config is the opencode driver's validated instance configuration.
type Config struct {
	BinaryName string   `json:"binaryName"`
	HomeDir    string   `json:"homeDir,omitempty"`
	ExtraArgs  []string `json:"extraArgs,omitempty"`
}

func (Config) ProviderKind() provider.Kind { return Kind }

// Driver is the opencode provider.Driver: a declarative value with no live
// process state.
type Driver struct{}

// NewDriver constructs the opencode driver.
func NewDriver() provider.Driver { return Driver{} }

func (Driver) Kind() provider.Kind { return Kind }

func (Driver) DefaultConfig() json.RawMessage {
	return json.RawMessage(`{"binaryName":"opencode"}`)
}

func (Driver) DecodeConfig(raw json.RawMessage) (provider.Config, error) {
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("opencode: invalid config: %w", err)
	}
	if c.BinaryName == "" {
		c.BinaryName = "opencode"
	}
	return c, nil
}

// Probe reports whether the OpenCode CLI is usable on this machine. Cheap and
// side-effect free: `opencode --version` only, never a server.
//
// A missing binary is a STATUS, not an error — the settings screen must be
// able to say "not installed" without spawning anything.
func (Driver) Probe(ctx context.Context, cfg provider.Config) (provider.Snapshot, error) {
	c, ok := cfg.(Config)
	if !ok {
		return provider.Snapshot{}, fmt.Errorf("opencode: probe received config of type %T, want opencode.Config", cfg)
	}

	bin, err := detect.ResolveBinary(c.BinaryName)
	if err != nil {
		return provider.Snapshot{
			Kind:      Kind,
			Available: false,
			Detail:    "opencode CLI not found on PATH",
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
			Detail:     fmt.Sprintf("opencode --version failed: %v", err),
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
// cancelled, the server process this adapter spawned must die too.
func (Driver) Create(ctx context.Context, spec provider.InstanceSpec) (provider.Adapter, error) {
	c, ok := spec.Config.(Config)
	if !ok {
		return nil, fmt.Errorf("opencode: create received config of type %T, want opencode.Config", spec.Config)
	}
	return newAdapter(ctx, spec.InstanceID, c, spec.Env), nil
}

var _ provider.Driver = Driver{}

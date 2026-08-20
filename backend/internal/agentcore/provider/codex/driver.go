// Package codex implements the provider.Driver and provider.Adapter for
// OpenAI's Codex CLI, spoken over `codex app-server` — JSON-RPC 2.0 on
// stdin/stdout.
//
// # Verified, not guessed
//
// Every wire shape in this package came from the installed binary itself
// (codex-cli 0.145.0), two ways:
//
//   - `codex app-server generate-json-schema --out <dir>` emits the protocol's
//     own JSON Schema — 39 files, including ClientRequest, ServerNotification
//     and ServerRequest. That is the authoritative type list, generated from
//     the CLI's own Rust types rather than from documentation.
//   - A live session was driven end to end (initialize → thread/start →
//     turn/start) and its stdout captured, which is what pinned the handshake
//     ORDER and the notification payloads the schema alone does not imply.
//
// Re-verify both against a newer CLI before trusting an untested path; the
// subcommand is still marked `[experimental]` in `codex --help`.
//
// # One process, many threads
//
// This is the structural difference from the claude and pi drivers, and it is
// deliberate on Codex's side: `codex app-server` is a single long-lived server
// that hosts many threads, each created by a `thread/start` request. claude
// and pi instead get one CLI process per thread.
//
// So this adapter runs ONE process per instance and maps DevDeck's threadID
// onto a Codex thread id, rather than spawning a process per session. The
// consequence to keep in mind: a crash here takes every thread on the instance
// with it, which is why `Events()` reports SessionExited for all of them.
package codex

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
const Kind provider.Kind = "codex"

// Config is the codex driver's validated instance configuration. Mirrors
// claude.Config and pi.Config deliberately, for the same reasons documented
// there.
type Config struct {
	BinaryName string   `json:"binaryName"`
	HomeDir    string   `json:"homeDir,omitempty"`
	ExtraArgs  []string `json:"extraArgs,omitempty"`
}

func (Config) ProviderKind() provider.Kind { return Kind }

// Driver is the codex provider.Driver: a declarative value with no live
// process state.
type Driver struct{}

// NewDriver constructs the codex driver.
func NewDriver() provider.Driver { return Driver{} }

func (Driver) Kind() provider.Kind { return Kind }

func (Driver) DefaultConfig() json.RawMessage {
	return json.RawMessage(`{"binaryName":"codex"}`)
}

func (Driver) DecodeConfig(raw json.RawMessage) (provider.Config, error) {
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("codex: invalid config: %w", err)
	}
	if c.BinaryName == "" {
		c.BinaryName = "codex"
	}
	return c, nil
}

// Probe reports whether the Codex CLI is usable on this machine. Cheap and
// side-effect free, like the other drivers': it runs `codex --version` and
// never starts an app-server.
//
// A missing binary is a STATUS, not an error — the settings screen has to be
// able to say "not installed" without an agent ever being spawned.
func (Driver) Probe(ctx context.Context, cfg provider.Config) (provider.Snapshot, error) {
	c, ok := cfg.(Config)
	if !ok {
		return provider.Snapshot{}, fmt.Errorf("codex: probe received config of type %T, want codex.Config", cfg)
	}

	bin, err := detect.ResolveBinary(c.BinaryName)
	if err != nil {
		return provider.Snapshot{
			Kind:      Kind,
			Available: false,
			Detail:    "codex CLI not found on PATH",
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
			Detail:     fmt.Sprintf("codex --version failed: %v", err),
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
// cancelled, the app-server process this adapter spawned must die too.
func (Driver) Create(ctx context.Context, spec provider.InstanceSpec) (provider.Adapter, error) {
	c, ok := spec.Config.(Config)
	if !ok {
		return nil, fmt.Errorf("codex: create received config of type %T, want codex.Config", spec.Config)
	}
	return newAdapter(ctx, spec.InstanceID, c, spec.Env), nil
}

var _ provider.Driver = Driver{}

// Package antigravity runs one agy headless process per turn, resuming only
// the explicit conversation owned by the DevDeck thread.
package antigravity

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"

	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/detect"
)

const Kind provider.Kind = "antigravity"

type Config struct {
	BinaryName string `json:"binaryName"`
	HomeDir    string `json:"homeDir,omitempty"`
}

func (Config) ProviderKind() provider.Kind { return Kind }

type Driver struct{}

func NewDriver() provider.Driver              { return Driver{} }
func (Driver) Kind() provider.Kind            { return Kind }
func (Driver) DefaultConfig() json.RawMessage { return json.RawMessage(`{"binaryName":"agy"}`) }

func (Driver) DecodeConfig(raw json.RawMessage) (provider.Config, error) {
	if raw = bytes.TrimSpace(raw); len(raw) == 0 || raw[0] != '{' {
		return nil, fmt.Errorf("antigravity: config must be a JSON object")
	}
	var c Config
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&c); err != nil {
		return nil, fmt.Errorf("antigravity: invalid config: %w", err)
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("antigravity: config must contain one JSON object")
	}
	if c.BinaryName == "" {
		c.BinaryName = "agy"
	}
	return c, nil
}

func (Driver) Probe(ctx context.Context, cfg provider.Config) (provider.Snapshot, error) {
	c, ok := cfg.(Config)
	if !ok {
		return provider.Snapshot{}, fmt.Errorf("antigravity: expected Config, got %T", cfg)
	}
	if c.BinaryName == "" {
		c.BinaryName = "agy"
	}
	bin, err := detect.ResolveBinary(c.BinaryName)
	snap := provider.Snapshot{Kind: Kind, BinaryPath: bin}
	if err != nil {
		snap.Detail = "Antigravity CLI not found on PATH"
		return snap, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "--version")
	cmd.Env = buildEnv(c, nil, nil)
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		snap.Detail = fmt.Sprintf("agy --version failed: %v", err)
		return snap, nil
	}
	snap.Available = true
	snap.Version = strings.TrimSpace(string(out))
	// A version probe says nothing about cached authentication.
	return snap, nil
}

func (Driver) Create(ctx context.Context, spec provider.InstanceSpec) (provider.Adapter, error) {
	c, ok := spec.Config.(Config)
	if !ok {
		return nil, fmt.Errorf("antigravity: expected Config, got %T", spec.Config)
	}
	if c.BinaryName == "" {
		c.BinaryName = "agy"
	}
	return newAdapter(ctx, spec.InstanceID, c, spec.Env), nil
}

func buildEnv(cfg Config, instance, session map[string]string) []string {
	env := detect.AugmentedEnv()
	for _, overrides := range []map[string]string{instance, session} {
		for k, v := range overrides {
			env = append(env, k+"="+v)
		}
	}
	if cfg.HomeDir != "" {
		env = append(env, "HOME="+cfg.HomeDir, "USERPROFILE="+cfg.HomeDir)
	}
	return env
}

var _ provider.Driver = Driver{}

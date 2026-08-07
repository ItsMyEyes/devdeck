package claude

import (
	"context"
	"encoding/json"
	"testing"

	"devdeck/backend/internal/agentcore/provider"
)

func TestDriverKindAndDefaults(t *testing.T) {
	d := NewDriver()
	if d.Kind() != "claude" {
		t.Fatalf("kind = %s, want claude", d.Kind())
	}
	cfg, err := d.DecodeConfig(d.DefaultConfig())
	if err != nil {
		t.Fatalf("default config must decode: %v", err)
	}
	if cfg.ProviderKind() != "claude" {
		t.Fatalf("config kind = %s", cfg.ProviderKind())
	}
}

// A missing binary is a STATUS, not an error. Probe must report it so the UI
// can show "not installed" instead of swallowing an error, and the settings
// screen must never need to spawn an agent to find out.
func TestProbeReportsMissingBinaryAsStatus(t *testing.T) {
	d := NewDriver()
	cfg, err := d.DecodeConfig(json.RawMessage(`{"binaryName":"definitely-not-a-real-binary-xyz"}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	snap, err := d.Probe(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Probe must not error for a missing binary, got: %v", err)
	}
	if snap.Available {
		t.Fatal("snapshot should report Available=false")
	}
	if snap.Detail == "" {
		t.Fatal("snapshot must explain why it is unavailable")
	}
}

func TestDecodeConfigRejectsGarbage(t *testing.T) {
	d := NewDriver()
	if _, err := d.DecodeConfig(json.RawMessage(`{"homeDir":123}`)); err == nil {
		t.Fatal("type-mismatched config should error — this message reaches the settings UI")
	}
}

var _ provider.Driver = NewDriver()

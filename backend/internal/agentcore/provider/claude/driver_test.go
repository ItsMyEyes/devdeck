package claude

import (
	"context"
	"encoding/json"
	"strings"
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

// Regression: buildArgs omitted --verbose, and the CLI refuses to start
// without it ("When using --print, --output-format=stream-json requires
// --verbose"). Every session died the instant it spawned; the only symptom
// the user ever saw was a later "thread has no active session" from SendTurn,
// because stderr was going nowhere. Six sent messages produced silence.
func TestBuildArgsCarriesTheFlagsTheCLIDemands(t *testing.T) {
	args := buildArgs(Config{}, provider.SessionStartInput{})

	joined := strings.Join(args, " ")
	for _, required := range []string{
		"--print",
		"--output-format stream-json",
		"--input-format stream-json",
		"--verbose",
	} {
		if !strings.Contains(joined, required) {
			t.Errorf("buildArgs missing %q; got: %s", required, joined)
		}
	}
}

func TestBuildArgsMapsModesToASinglePermissionFlag(t *testing.T) {
	// Plan mode is itself a --permission-mode value, so it must not stack a
	// second flag on top of the RuntimeMode mapping.
	args := buildArgs(Config{}, provider.SessionStartInput{
		Interact: provider.InteractionPlan,
		Mode:     provider.ModeFullAccess,
	})
	count := 0
	for _, a := range args {
		if a == "--permission-mode" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("--permission-mode appeared %d times, want exactly 1: %v", count, args)
	}
	if !strings.Contains(strings.Join(args, " "), "--permission-mode plan") {
		t.Fatalf("plan mode should win over runtime mode; got: %v", args)
	}
}

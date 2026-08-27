package pi

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/detect"
)

func TestDriverKindAndDefaults(t *testing.T) {
	d := NewDriver()
	if d.Kind() != "pi" {
		t.Fatalf("kind = %s, want pi", d.Kind())
	}
	cfg, err := d.DecodeConfig(d.DefaultConfig())
	if err != nil {
		t.Fatalf("default config must decode: %v", err)
	}
	if cfg.ProviderKind() != "pi" {
		t.Fatalf("config kind = %s", cfg.ProviderKind())
	}
}

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

// pi is a Node script (`#!/usr/bin/env node`), so a spawned pi process must
// find `node` on PATH. A GUI-launched backend inherits a minimal PATH without
// the nvm/volta node dir — the exact reason Pi vanished from the model picker
// in a desktop build while working in a terminal-launched dev build. buildEnv
// must therefore start from detect.AugmentedEnv (which adds those dirs), not
// the bare process env: every dir AugmentedEnv contributes has to survive into
// the spawned process's PATH.
func TestBuildEnvPATHIncludesAugmentedDirs(t *testing.T) {
	sep := string(os.PathListSeparator)
	inPath := func(env []string) map[string]bool {
		set := map[string]bool{}
		for _, kv := range env {
			if k, v, ok := strings.Cut(kv, "="); ok && strings.EqualFold(k, "PATH") {
				for _, dir := range strings.Split(v, sep) {
					if dir != "" {
						set[dir] = true
					}
				}
			}
		}
		return set
	}

	built := inPath(buildEnv(nil, Config{}))
	for _, kv := range detect.AugmentedEnv() {
		if k, v, ok := strings.Cut(kv, "="); ok && strings.EqualFold(k, "PATH") {
			for _, dir := range strings.Split(v, sep) {
				if dir != "" && !built[dir] {
					t.Errorf("buildEnv PATH is missing augmented dir %q — a Node-based pi process would fail to find node under a GUI-launched minimal PATH", dir)
				}
			}
		}
	}
}

func TestBuildArgsUsesRPCMode(t *testing.T) {
	args := buildArgs(Config{}, provider.SessionStartInput{})
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--mode rpc") {
		t.Errorf("missing --mode rpc; got: %s", joined)
	}
}

func TestBuildArgsPassesModelThrough(t *testing.T) {
	args := buildArgs(Config{}, provider.SessionStartInput{
		Model: provider.ModelSelection{Model: "ollama/glm-5.2:cloud"},
	})
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--model ollama/glm-5.2:cloud") {
		t.Errorf("missing --model; got: %s", joined)
	}
}

// piThinkingLevel's four accepted values (off/minimal/low/medium/high/xhigh)
// come straight from `pi --help`; "max" and "ultrathink" are Claude-only
// additions to the composer's shared Reasoning vocabulary and must be
// dropped rather than forwarded as a value Pi doesn't recognize.
func TestBuildArgsTranslatesEffortToThinkingLevel(t *testing.T) {
	args := buildArgs(Config{}, provider.SessionStartInput{
		Model: provider.ModelSelection{Options: map[string]any{"effort": "xhigh"}},
	})
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--thinking xhigh") {
		t.Errorf("missing --thinking xhigh; got: %s", joined)
	}
}

func TestBuildArgsDropsUnsupportedEffortLevels(t *testing.T) {
	for _, effort := range []string{"max", "ultrathink", ""} {
		args := buildArgs(Config{}, provider.SessionStartInput{
			Model: provider.ModelSelection{Options: map[string]any{"effort": effort}},
		})
		if strings.Contains(strings.Join(args, " "), "--thinking") {
			t.Errorf("effort %q should not produce --thinking; got: %v", effort, args)
		}
	}
}

func TestBuildArgsIgnoresNonStringEffort(t *testing.T) {
	args := buildArgs(Config{}, provider.SessionStartInput{
		Model: provider.ModelSelection{Options: map[string]any{"effort": 3}},
	})
	if strings.Contains(strings.Join(args, " "), "--thinking") {
		t.Fatalf("non-string effort must be ignored, not forwarded; got: %v", args)
	}
}

func TestBuildArgsResumesWithSessionFlag(t *testing.T) {
	cursor, _ := json.Marshal("01a000de-b810-7482-bbaf-718e08c38c3e")
	args := buildArgs(Config{}, provider.SessionStartInput{ResumeCursor: cursor})
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--session 01a000de-b810-7482-bbaf-718e08c38c3e") {
		t.Errorf("missing --session resume flag; got: %s", joined)
	}
}

func TestBuildArgsAppendsExtraArgsLast(t *testing.T) {
	args := buildArgs(Config{ExtraArgs: []string{"--offline"}}, provider.SessionStartInput{})
	if args[len(args)-1] != "--offline" {
		t.Fatalf("extra args must be appended last; got: %v", args)
	}
}

// TestSendTurn_WithAttachments_Errors: pi has no way to carry attachments
// (unlike claude — see claude/adapter.go's image content-block support). A
// turn that arrives with one or more attachments must fail explicitly,
// before any side effect — no stdin write, no TurnStarted event — so the
// caller gets a clean error rather than a half-started turn the reactor then
// has to settle.
func TestSendTurn_WithAttachments_Errors(t *testing.T) {
	var buf bytes.Buffer
	st := newParseState("w-abc", "pi:default")
	sess := &session{threadID: "w-abc", stdinEnc: json.NewEncoder(&buf), state: st}
	a := &adapter{instanceID: "pi:default", sessions: map[string]*session{"w-abc": sess}, events: make(chan event.Event, 4)}

	in := provider.SendTurnInput{
		ThreadID:    "w-abc",
		TurnID:      "turn-1",
		Text:        "look at this",
		Attachments: []provider.Attachment{{Kind: "image", MIME: "image/png"}},
	}

	_, err := a.SendTurn(context.Background(), in)
	if err == nil {
		t.Fatal("SendTurn with attachments must error, got nil")
	}
	if !strings.Contains(err.Error(), "cannot carry attachments") {
		t.Fatalf("error = %q, want it to mention that pi cannot carry attachments", err.Error())
	}

	if buf.Len() != 0 {
		t.Fatalf("SendTurn wrote to stdin before erroring: %s", buf.String())
	}

	select {
	case ev := <-a.events:
		t.Fatalf("SendTurn emitted an event before erroring: %+v", ev)
	default:
	}
}

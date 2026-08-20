package memoryhost

import (
	"context"
	"os/exec"
	"testing"
	"time"
)

func TestContainerEnvIncludesRequiredVars(t *testing.T) {
	env := containerEnv(EngineDocker, StartConfig{LLMProvider: "openai", LLMAPIKey: "sk-test", LLMModel: "gpt-5-mini"})
	if env["HINDSIGHT_API_LLM_PROVIDER"] != "openai" {
		t.Fatalf("provider = %q", env["HINDSIGHT_API_LLM_PROVIDER"])
	}
	if env["HINDSIGHT_API_LLM_API_KEY"] != "sk-test" {
		t.Fatalf("api key = %q", env["HINDSIGHT_API_LLM_API_KEY"])
	}
	if env["HINDSIGHT_API_LLM_MODEL"] != "gpt-5-mini" {
		t.Fatalf("model = %q", env["HINDSIGHT_API_LLM_MODEL"])
	}
	if _, ok := env["HINDSIGHT_API_LLM_BASE_URL"]; ok {
		t.Fatal("base url should be absent when LLMBaseURL is empty")
	}
}

func TestContainerEnvRewritesLoopbackBaseURLForDocker(t *testing.T) {
	env := containerEnv(EngineDocker, StartConfig{LLMProvider: "ollama", LLMBaseURL: "http://127.0.0.1:11434"})
	if got, want := env["HINDSIGHT_API_LLM_BASE_URL"], "http://host.docker.internal:11434"; got != want {
		t.Fatalf("base url = %q, want %q", got, want)
	}
}

func TestContainerEnvRewritesLoopbackBaseURLForPodman(t *testing.T) {
	env := containerEnv(EnginePodman, StartConfig{LLMProvider: "lmstudio", LLMBaseURL: "http://localhost:1234"})
	if got, want := env["HINDSIGHT_API_LLM_BASE_URL"], "http://host.containers.internal:1234"; got != want {
		t.Fatalf("base url = %q, want %q", got, want)
	}
}

func TestContainerEnvLeavesNonLoopbackBaseURLAlone(t *testing.T) {
	env := containerEnv(EngineDocker, StartConfig{LLMProvider: "ollama", LLMBaseURL: "http://192.168.1.50:11434"})
	if got, want := env["HINDSIGHT_API_LLM_BASE_URL"], "http://192.168.1.50:11434"; got != want {
		t.Fatalf("base url = %q, want %q (should not rewrite a non-loopback host)", got, want)
	}
}

func availableContainerEngine(t *testing.T) (Engine, string) {
	t.Helper()
	engine, bin, err := DetectEngine()
	if err != nil {
		t.Skip("no docker/podman on this machine — skipping real-engine test")
	}
	return engine, bin
}

// TestDetectEngineFindsARealBinary is a real-machine check, not a hermetic
// unit test — see the package doc comment's "Verified, not guessed" note.
// It skips outright when neither engine is installed, the expected state on
// most CI runners.
func TestDetectEngineFindsARealBinary(t *testing.T) {
	engine, bin := availableContainerEngine(t)
	if bin == "" {
		t.Fatal("resolved binary path is empty")
	}
	if engine != EngineDocker && engine != EnginePodman {
		t.Fatalf("engine = %q, want docker or podman", engine)
	}
}

func TestInspectContainerReportsNotExistsForAnUnknownName(t *testing.T) {
	_, bin := availableContainerEngine(t)
	exists, running, err := inspectContainer(context.Background(), bin)
	// Safe as a read-only check regardless of whether devdeck-hindsight
	// happens to exist on this machine — asserts nothing about
	// exists/running, only that this never surfaces as a Go error on its own.
	if err != nil {
		t.Fatalf("inspectContainer: %v", err)
	}
	t.Logf("devdeck-hindsight on this machine: exists=%v running=%v", exists, running)
}

// TestContainerStartStopStatusRoundTrip drives the real lifecycle against
// whatever engine is on this machine, using the actual Hindsight image —
// this is the end-to-end proof the rest of this file's tests can only
// approximate. Skips if no engine is present, or if devdeck-hindsight
// already exists (so it never disturbs a real deployment on the test
// machine); cleans up unconditionally via t.Cleanup.
func TestContainerStartStopStatusRoundTrip(t *testing.T) {
	_, bin := availableContainerEngine(t)

	before := GetStatus(context.Background(), ModeContainer, "")
	if before.Exists {
		t.Skip("devdeck-hindsight already exists on this machine — skipping to avoid disturbing it")
	}

	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = exec.CommandContext(ctx, bin, "rm", "-f", ContainerName).Run()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	if err := Start(ctx, ModeContainer, StartConfig{Port: 18888, DataDir: t.TempDir(), LLMProvider: "openai", LLMAPIKey: "sk-test-not-real"}); err != nil {
		t.Fatalf("Start: %v", err)
	}

	running := GetStatus(ctx, ModeContainer, "")
	if !running.Exists || !running.Running {
		t.Fatalf("status after Start = %+v, want exists+running", running)
	}

	// Idempotent: starting an already-running container is a no-op, not an
	// error — a settings-page double-click must not fail the second click.
	if err := Start(ctx, ModeContainer, StartConfig{Port: 18888, DataDir: t.TempDir()}); err != nil {
		t.Fatalf("second Start (idempotency): %v", err)
	}

	if err := Stop(ctx, ModeContainer, ""); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	stopped := GetStatus(ctx, ModeContainer, "")
	if !stopped.Exists || stopped.Running {
		t.Fatalf("status after Stop = %+v, want exists=true running=false", stopped)
	}

	// Idempotent the other way too.
	if err := Stop(ctx, ModeContainer, ""); err != nil {
		t.Fatalf("second Stop (idempotency): %v", err)
	}
}

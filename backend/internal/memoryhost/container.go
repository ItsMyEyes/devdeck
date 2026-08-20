// containerRuntime drives docker or podman to run the official Hindsight
// image — memoryhost.ModeContainer.
//
// # Verified, not guessed
//
// `inspect --format '{{.State.Running}}'`, its "no such object" error text
// and exit code 125 for a container that has never been created, and
// `image inspect`'s exit code as an image-presence check were all run
// against a live podman installation before being written here. Docker's
// own CLI shares this exact command surface (both are Docker-CLI-compatible
// by design), but only podman was exercised directly — re-verify against
// Docker Desktop specifically before trusting this path on a
// Docker-Desktop-only machine.
package memoryhost

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"devdeck/backend/internal/detect"
)

// DefaultImage is the Hindsight server image DevDeck runs when
// StartConfig.Image is empty. Pinned to :latest deliberately, like the
// project's own quick-start docs — an operator who wants a specific version
// can switch to "manual" hosting and run their own. Overridable mainly so
// tests can point Start at a small, fast, always-cached image instead of
// pulling the real multi-hundred-MB Hindsight image on every run.
const DefaultImage = "ghcr.io/vectorize-io/hindsight:latest"

// ContainerName is fixed so this package can always find the same container
// again across DevDeck restarts, rather than needing to persist a container
// ID anywhere itself — the name IS the persisted handle.
const ContainerName = "devdeck-hindsight"

// containerAPIPort is the port Hindsight's OWN process listens on inside the
// image — fixed by the image itself, never configurable. Only the HOST-side
// port (StartConfig.Port) varies.
const containerAPIPort = "8888"

// Engine names a container CLI this package knows how to drive.
type Engine string

const (
	EngineDocker Engine = "docker"
	EnginePodman Engine = "podman"
)

// DetectEngine finds a container engine on this machine. Prefers docker —
// more operators have Docker Desktop than Podman installed — and falls back
// to podman. Uses detect.ResolveBinary, not a bare exec.LookPath: see that
// function's doc comment for why a hub launched as a background
// service/Tauri sidecar often does not inherit an interactive shell's PATH.
func DetectEngine() (Engine, string, error) {
	if p, err := detect.ResolveBinary("docker"); err == nil {
		return EngineDocker, p, nil
	}
	if p, err := detect.ResolveBinary("podman"); err == nil {
		return EnginePodman, p, nil
	}
	return "", "", fmt.Errorf("memoryhost: neither docker nor podman found on PATH or in common install locations")
}

type containerRuntime struct{}

// dataDir is unused here — a container's identity is ContainerName, not a
// directory. Accepted only to satisfy the shared runtime interface; see its
// doc comment for why bareMetalRuntime needs it.
func (containerRuntime) status(ctx context.Context, _ string) Status {
	engine, bin, err := DetectEngine()
	if err != nil {
		return Status{Available: false}
	}
	status := Status{Available: true, Detected: string(engine), BinaryPath: bin}

	exists, running, err := inspectContainer(ctx, bin)
	if err != nil {
		status.Detail = err.Error()
		return status
	}
	status.Exists = exists
	status.Running = running
	return status
}

func (containerRuntime) start(ctx context.Context, cfg StartConfig) error {
	engine, bin, err := DetectEngine()
	if err != nil {
		return err
	}
	image := cfg.Image
	if image == "" {
		image = DefaultImage
	}

	exists, running, err := inspectContainer(ctx, bin)
	if err != nil {
		return err
	}
	if running {
		return nil
	}
	if exists {
		_, err := run(ctx, commandTimeout, bin, "start", ContainerName)
		return err
	}

	if err := ensureImage(ctx, bin, image); err != nil {
		return err
	}
	// Both engines require the HOST side of a bind mount to already exist —
	// confirmed live: podman fails the whole `run` with a bare "statfs ...
	// no such file or directory" otherwise, rather than creating it.
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return fmt.Errorf("memoryhost: create data dir: %w", err)
	}

	args := []string{
		"run", "-d",
		"--name", ContainerName,
		"--restart", "unless-stopped",
		"-p", fmt.Sprintf("127.0.0.1:%d:%s", cfg.Port, containerAPIPort),
		"-v", cfg.DataDir + ":/home/hindsight/.pg0",
	}
	for k, v := range containerEnv(engine, cfg) {
		if v == "" {
			continue
		}
		args = append(args, "-e", k+"="+v)
	}
	args = append(args, image)
	_, err = run(ctx, commandTimeout, bin, args...)
	return err
}

func (containerRuntime) stop(ctx context.Context, _ string) error {
	_, bin, err := DetectEngine()
	if err != nil {
		return err
	}
	exists, running, err := inspectContainer(ctx, bin)
	if err != nil {
		return err
	}
	if !exists || !running {
		return nil
	}
	_, err = run(ctx, commandTimeout, bin, "stop", ContainerName)
	return err
}

func (containerRuntime) logs(ctx context.Context, tail int, _ string) (string, error) {
	_, bin, err := DetectEngine()
	if err != nil {
		return "", err
	}
	return run(ctx, commandTimeout, bin, "logs", "--tail", strconv.Itoa(tail), ContainerName)
}

// inspectContainer reports whether ContainerName exists at all, and whether
// it is currently running. "no such object" (verified exit code 125 against
// a real podman) is the ONE inspect failure this package treats as
// exists=false rather than a real error — every other failure (engine
// daemon down, permission denied) is returned as an error so start/stop/
// status surface it instead of silently reporting "not created".
func inspectContainer(ctx context.Context, bin string) (exists, running bool, err error) {
	out, err := run(ctx, commandTimeout, bin, "inspect", "--format", "{{.State.Running}}", ContainerName)
	if err != nil {
		if strings.Contains(strings.ToLower(out), "no such") || strings.Contains(strings.ToLower(err.Error()), "no such") {
			return false, false, nil
		}
		return false, false, err
	}
	return true, strings.TrimSpace(out) == "true", nil
}

// ensureImage pulls image only when it is not already present locally —
// `image inspect` (not the podman-only `image exists`) is the check, since
// it is the one image-presence command confirmed to exist on both engines.
func ensureImage(ctx context.Context, bin, image string) error {
	checkCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	if err := exec.CommandContext(checkCtx, bin, "image", "inspect", image).Run(); err == nil {
		return nil
	}
	_, err := run(ctx, pullTimeout, bin, "pull", image)
	return err
}

// containerEnv builds the container's environment from StartConfig,
// rewriting a loopback LLMBaseURL — any provider the OPERATOR reaches at
// 127.0.0.1 from their own machine, whether that's an ollama/lmstudio
// server or an openai-compatible proxy/gateway bound to loopback — to the
// engine-specific DNS name that resolves to the host from INSIDE the
// container. Otherwise "127.0.0.1" inside the container means the
// container itself, not the host running it, and every fact-extraction
// call would fail to connect. A non-loopback URL (a real hostname, a
// LAN/VPN address) passes through untouched — nothing to rewrite.
// HINDSIGHT_API_LLM_BASE_URL follows the same naming convention as the
// three variables envCommon sets, but — unlike those three — was NOT
// independently verified against a live server; check Hindsight's docs if
// a custom base URL doesn't get picked up.
func containerEnv(engine Engine, cfg StartConfig) map[string]string {
	env := envCommon(cfg)
	if cfg.LLMBaseURL != "" {
		env["HINDSIGHT_API_LLM_BASE_URL"] = rewriteLoopbackForContainer(cfg.LLMBaseURL, engine)
	}
	return env
}

func rewriteLoopbackForContainer(url string, engine Engine) string {
	host := "host.docker.internal"
	if engine == EnginePodman {
		host = "host.containers.internal"
	}
	url = strings.Replace(url, "127.0.0.1", host, 1)
	url = strings.Replace(url, "localhost", host, 1)
	return url
}

var _ hostRuntime = containerRuntime{}

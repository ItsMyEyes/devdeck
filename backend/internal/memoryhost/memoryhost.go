// Package memoryhost runs and supervises exactly one Hindsight process on
// THIS machine — the "self-hosted on this device" paths in Settings →
// Memory (domain.MemoryConfig.Hosting == "container" or "baremetal") — so an
// operator never has to open a terminal to run `docker run ...` or
// `uvx hindsight-api` themselves.
//
// Two independent mechanisms share one lifecycle contract (the runtime
// interface below: status/start/stop/logs), so the rest of DevDeck — the
// service layer, the HTTP handlers, the Settings UI — never has to branch on
// which one is active:
//
//   - "container" (container.go): docker or podman runs the official
//     Hindsight image. Preferred when available — no Python toolchain
//     involved at all.
//   - "baremetal" (baremetal.go): a plain OS process, either an
//     already-installed `hindsight-api` binary or `uvx hindsight-api` (uv's
//     equivalent of npx — fetches and caches the package on first run with
//     no manual `pip install` step). This is the fallback for a machine with
//     neither docker nor podman, matching the vendor's own documented
//     non-Docker quick start.
//
// Both are entirely optional external tools, detected the same way the rest
// of DevDeck detects pandoc/mmdc/ripgrep: report a clear "not available"
// status, never fail the hub's own boot over it, never assume something is
// installed just because its package manager exists.
//
// # docker vs podman: exec.Command sees neither's shell alias
//
// A `docker` command on the operator's own machine may be nothing but a
// shell alias or wrapper script pointing at podman (confirmed on this
// project's dev machine — `alias docker=podman` in the interactive shell).
// os/exec never goes through a shell, so it cannot see that alias; it can
// only find a real, resolvable binary on PATH (or in the fallback locations
// detect.ResolveBinary already knows about, for exactly this
// "spawned-without-a-login-shell's-PATH" reason).
//
// # Verified, not guessed
//
// Every subcommand and env var this package depends on was checked against
// a live installation before being written here — see container.go and
// baremetal.go's own doc comments for exactly what was and wasn't
// independently confirmed. Re-verify before trusting an unconfirmed path.
package memoryhost

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Mode selects which mechanism manages the process. Only ever "container" or
// "baremetal" — memoryhost is never invoked at all for domain.MemoryConfig's
// third hosting value, "manual", since that path is just an operator-typed
// BaseURL the service layer uses directly.
type Mode string

const (
	ModeContainer  Mode = "container"
	ModeBareMetal  Mode = "baremetal"
)

const (
	pullTimeout    = 10 * time.Minute // covers a cold image pull or a cold uvx package fetch
	commandTimeout = 20 * time.Second
)

// StartConfig is what Start needs, all of it sourced from the stored
// domain.MemoryConfig by the caller (see service.MemoryService.LocalStart) —
// this package itself knows nothing about settings storage.
type StartConfig struct {
	// Image overrides container.DefaultImage when non-empty. Ignored in
	// baremetal mode.
	Image string
	// Port is the loopback port the process/container's API is published
	// on — this is a local-machine convenience feature, never meant to be
	// reachable from the network.
	Port int
	// DataDir is a host path where persistent state lives (a container's
	// bind-mounted Postgres volume, or a bare process's working directory
	// and pidfile), so a stop/start or a DevDeck upgrade does not lose every
	// retained memory. Created if it does not already exist.
	DataDir string

	LLMProvider string
	LLMModel    string
	// LLMBaseURL overrides the LLM provider's default endpoint — valid for
	// any provider, not only ollama/lmstudio's local servers (an
	// openai/anthropic/gemini/groq operator may point this at a proxy or
	// gateway). Empty means "use the provider's own default".
	LLMBaseURL string
	LLMAPIKey  string
}

// Status is a snapshot of the locally managed process's state, degrading
// gracefully through every stage an operator might find it in: no
// engine/toolchain installed, an engine but nothing ever started, something
// created-but-stopped, or a running one.
type Status struct {
	// Available reports whether the prerequisite for this mode was found at
	// all (a container engine; hindsight-api or uvx).
	Available bool `json:"available"`
	// Detected names what was actually found — "docker"/"podman" for
	// container mode, "hindsight-api"/"uvx" for baremetal — so the settings
	// screen can say exactly what it's going to use.
	Detected   string `json:"detected,omitempty"`
	BinaryPath string `json:"binaryPath,omitempty"`
	// Exists reports whether something has been created before (a container,
	// a pidfile) — distinct from Running, since a stopped-but-still-present
	// container/process restarts instead of being recreated from scratch.
	Exists  bool   `json:"exists"`
	Running bool   `json:"running"`
	Detail  string `json:"detail,omitempty"` // set on a real (non-"not found") error only
}

// runtime is the one seam that differs between hosting modes. Every other
// concern — StartConfig's shape, Status's shape, the exported dispatch
// functions below — is shared.
//
// dataDir is threaded through status/stop/logs, not just start: the
// container runtime ignores it (a fixed ContainerName is identity enough),
// but the bare-metal runtime has no other way to find ITS instance again —
// there is no daemon to ask "is a process named X alive", only a pidfile
// this package itself wrote under a caller-chosen directory. Passing it
// uniformly keeps the interface — and every caller above it — mode-agnostic.
type hostRuntime interface {
	status(ctx context.Context, dataDir string) Status
	start(ctx context.Context, cfg StartConfig) error
	stop(ctx context.Context, dataDir string) error
	logs(ctx context.Context, tail int, dataDir string) (string, error)
}

func runtimeFor(mode Mode) hostRuntime {
	if mode == ModeBareMetal {
		return bareMetalRuntime{}
	}
	return containerRuntime{}
}

// GetStatus reports the current state without side effects. Never returns a
// Go error for "not installed" or "nothing created yet" — those are STATUSES
// the settings screen has to render without an agent-visible error, the same
// convention provider.Driver.Probe and detect's own functions use.
func GetStatus(ctx context.Context, mode Mode, dataDir string) Status {
	return runtimeFor(mode).status(ctx, dataDir)
}

// Start makes the process reach the running state, however it currently
// sits: a no-op if already running, resumes an existing-but-stopped
// container/process (preserving whatever it was created with) rather than
// recreating it, and only pulls/fetches the very first time. Every branch is
// what makes repeated calls (a double-click, a retry after a transient
// failure, a boot-time re-establish racing a manual click) safe.
func Start(ctx context.Context, mode Mode, cfg StartConfig) error {
	return runtimeFor(mode).start(ctx, cfg)
}

// Stop stops without destroying persisted state — Start after Stop resumes
// rather than re-fetching and re-creating. Stopping something that was never
// created is not an error: that is already the desired end state.
func Stop(ctx context.Context, mode Mode, dataDir string) error {
	return runtimeFor(mode).stop(ctx, dataDir)
}

// Logs returns the last `tail` lines — a fallback for an operator debugging
// a failed retain without leaving DevDeck's own UI.
func Logs(ctx context.Context, mode Mode, tail int, dataDir string) (string, error) {
	return runtimeFor(mode).logs(ctx, tail, dataDir)
}

// envCommon is the slice of StartConfig every mode injects the same way —
// HINDSIGHT_API_LLM_PROVIDER/API_KEY/MODEL are the three variables confirmed
// directly against hindsight-api's own PyPI-rendered README, and apply
// identically whether the server process runs in a container or bare metal
// (same underlying application, same env contract). LLMBaseURL is
// deliberately NOT included here — container.go and baremetal.go each need
// to treat "the operator's own loopback address" differently (a container
// needs it rewritten to reach the host; a bare process on this same machine
// does not), so each builds that one variable itself.
func envCommon(cfg StartConfig) map[string]string {
	env := map[string]string{
		"HINDSIGHT_API_LLM_PROVIDER": cfg.LLMProvider,
		"HINDSIGHT_API_LLM_API_KEY":  cfg.LLMAPIKey,
	}
	if cfg.LLMModel != "" {
		env["HINDSIGHT_API_LLM_MODEL"] = cfg.LLMModel
	}
	return env
}

// run executes one command with a bounded timeout and returns its combined
// output — callers inspect that output (not just the error) because a
// failed command's real explanation is almost always on stderr, and
// container.go's "no such object" detection depends on seeing it.
func run(ctx context.Context, timeout time.Duration, bin string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(cctx, bin, args...).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return string(out), fmt.Errorf("%s %s: %s", bin, strings.Join(args, " "), msg)
	}
	return string(out), nil
}

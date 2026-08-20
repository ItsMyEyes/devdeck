// bareMetalRuntime runs Hindsight as a plain OS process — the fallback for
// a machine with neither docker nor podman — memoryhost.ModeBareMetal.
//
// # Verified, not guessed
//
// The package name, its console-script command name (both "hindsight-api",
// NOT "hindsight-server" — a name that appeared in one vendor blog post but
// does not exist on PyPI, confirmed by a live `uvx hindsight-server` failing
// dependency resolution during this feature's development), its CLI flags,
// and its HINDSIGHT_API_HOST/HINDSIGHT_API_PORT/HINDSIGHT_API_DATABASE_URL
// env vars were all read directly from https://pypi.org/pypi/hindsight-api/json
// — the package's own README, the same trust tier as a GitHub README. `uvx
// hindsight-api --help` itself could not be exercised live in this
// environment (a sandboxed network blocked the underlying dependency
// fetch), so the exact flag/env behavior is confirmed from the package's own
// documentation, not a captured process — re-verify before depending on
// something not explicitly listed above.
//
// # Why a pidfile
//
// Unlike a container (which a daemon keeps track of independently — `docker
// ps` still finds it after DevDeck itself restarts), a plain child process
// spawned via exec.Command is NOT remembered by the OS in any way this
// package can query by name alone. The pidfile under StartConfig.DataDir is
// this package's own durable record of "which PID is my instance", written
// right after a successful spawn and read back on every status/stop call —
// including after a DevDeck restart, which is exactly when this matters.
package memoryhost

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"devdeck/backend/internal/detect"
)

// bareMetalPackage is both the PyPI package name and its console-script
// command name.
const bareMetalPackage = "hindsight-api"

const stopGracePeriod = 5 * time.Second

type bareMetalRuntime struct{}

// detectBareMetal finds a way to run hindsight-api: either the binary
// itself, already installed on PATH (an operator who ran
// `pip install hindsight-api` themselves), or `uvx` — uv's equivalent of
// npx, which fetches and caches the package into an isolated environment on
// first run with no manual install step at all. The direct binary is
// preferred: it starts faster (no uv resolution step) and needs no network
// access to uv's package index just to begin.
func detectBareMetal() (detected, bin string, err error) {
	if p, err := detect.ResolveBinary(bareMetalPackage); err == nil {
		return bareMetalPackage, p, nil
	}
	if p, err := detect.ResolveBinary("uvx"); err == nil {
		return "uvx", p, nil
	}
	return "", "", fmt.Errorf("memoryhost: neither %s nor uvx found on PATH or in common install locations", bareMetalPackage)
}

func pidFilePath(dataDir string) string { return filepath.Join(dataDir, "hindsight.pid") }
func logFilePath(dataDir string) string { return filepath.Join(dataDir, "hindsight.log") }

func (bareMetalRuntime) status(_ context.Context, dataDir string) Status {
	detected, bin, err := detectBareMetal()
	if err != nil {
		return Status{Available: false}
	}
	status := Status{Available: true, Detected: detected, BinaryPath: bin}

	pid, ok := readPidFile(dataDir)
	if !ok {
		return status
	}
	status.Exists = true
	status.Running = processAlive(pid)
	return status
}

func (bareMetalRuntime) start(ctx context.Context, cfg StartConfig) error {
	detected, bin, err := detectBareMetal()
	if err != nil {
		return err
	}

	if pid, ok := readPidFile(cfg.DataDir); ok {
		if processAlive(pid) {
			return nil
		}
		// Stale pidfile from a process that died or was killed outside
		// DevDeck (e.g. the machine losing power) — clear it and fall
		// through to a fresh spawn rather than erroring forever.
		_ = os.Remove(pidFilePath(cfg.DataDir))
	}

	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return fmt.Errorf("memoryhost: create data dir: %w", err)
	}

	args := []string{}
	if detected == "uvx" {
		args = append(args, bareMetalPackage)
	}

	logFile, err := os.OpenFile(logFilePath(cfg.DataDir), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("memoryhost: open log file: %w", err)
	}
	defer logFile.Close()

	// Deliberately exec.Command, NOT exec.CommandContext: CommandContext
	// kills the process the instant ctx is done, which for an HTTP
	// handler's request context means the moment the response is written —
	// exactly when this process is supposed to keep running.
	cmd := exec.Command(bin, args...)
	cmd.Dir = cfg.DataDir // hindsight-api's embedded Postgres path (HINDSIGHT_API_DATABASE_URL default "pg0") resolves relative to the working directory — this is what makes it land in DataDir rather than wherever the hub process happened to start from.
	cmd.Env = append(os.Environ(), bareMetalEnvPairs(cfg)...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Stdin = nil
	setDetached(cmd)

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("memoryhost: start %s: %w", bin, err)
	}
	pid := cmd.Process.Pid
	// Reap asynchronously rather than calling Process.Release(): this
	// process is still the child's OS-level parent (Setsid changes its
	// session, not its parent), and skipping Wait() entirely leaves a
	// zombie sitting in the process table from the moment the child exits
	// until this hub process itself restarts. A background goroutine that
	// just blocks on Wait() reaps it whenever that happens — soon after a
	// clean stop(), or whenever a crashed process dies — without blocking
	// Start's own return. Confirmed live: without this, a killed child never
	// actually leaves the process table and syscall.Kill(pid, 0) keeps
	// reporting it alive forever.
	go func() { _ = cmd.Wait() }()
	if err := writePidFile(cfg.DataDir, pid); err != nil {
		return fmt.Errorf("memoryhost: write pidfile: %w", err)
	}
	return nil
}

func (bareMetalRuntime) stop(_ context.Context, dataDir string) error {
	pid, ok := readPidFile(dataDir)
	if !ok {
		return nil
	}
	if !processAlive(pid) {
		_ = os.Remove(pidFilePath(dataDir))
		return nil
	}
	terminateGracefully(pid, stopGracePeriod)
	_ = os.Remove(pidFilePath(dataDir))
	return nil
}

func (bareMetalRuntime) logs(_ context.Context, tail int, dataDir string) (string, error) {
	data, err := os.ReadFile(logFilePath(dataDir))
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) > tail {
		lines = lines[len(lines)-tail:]
	}
	return strings.Join(lines, "\n"), nil
}

// bareMetalEnvPairs mirrors container.go's containerEnv, minus the loopback
// rewrite: a bare process runs in the SAME network namespace as the hub
// itself, so "127.0.0.1" in an operator's LLMBaseURL already means exactly
// what they intend — nothing to rewrite. HINDSIGHT_API_HOST is pinned to
// loopback for the same reason container mode only ever publishes to
// 127.0.0.1: this is a local-machine convenience, never meant to be
// reachable from the network.
func bareMetalEnvPairs(cfg StartConfig) []string {
	env := envCommon(cfg)
	env["HINDSIGHT_API_HOST"] = "127.0.0.1"
	env["HINDSIGHT_API_PORT"] = strconv.Itoa(cfg.Port)
	if cfg.LLMBaseURL != "" {
		env["HINDSIGHT_API_LLM_BASE_URL"] = cfg.LLMBaseURL
	}
	pairs := make([]string, 0, len(env))
	for k, v := range env {
		if v == "" {
			continue
		}
		pairs = append(pairs, k+"="+v)
	}
	return pairs
}

func readPidFile(dataDir string) (pid int, ok bool) {
	data, err := os.ReadFile(pidFilePath(dataDir))
	if err != nil {
		return 0, false
	}
	pid, err = strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

func writePidFile(dataDir string, pid int) error {
	return os.WriteFile(pidFilePath(dataDir), []byte(strconv.Itoa(pid)), 0o600)
}

var _ hostRuntime = bareMetalRuntime{}

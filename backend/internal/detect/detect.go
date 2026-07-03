// Package detect probes the local machine for installed agent CLIs and reads
// their configuration (skills, models) from well-known config directories.
package detect

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// AgentBinary maps agent IDs to the CLI binary that must be resolvable.
var AgentBinary = map[string]string{
	"claude":   "claude",
	"codex":    "codex",
	"pi":       "pi",
	"opencode": "opencode",
	"gemini":   "gemini",
}

// Installed checks whether an agent's CLI binary can be resolved.
func Installed(agentID string) bool {
	_, err := Resolve(agentID)
	return err == nil
}

// Resolve returns the absolute path to an agent's CLI binary. It checks
// $PATH first, then falls back to well-known per-OS install locations.
// This matters because the backend process is often started without the
// PATH a user's interactive login shell would have (nvm/homebrew/~/.local/bin
// live in shell rc files, not in a bare GUI/service environment), so callers
// that only need to know whether a binary is installed shouldn't rely on
// $PATH alone, and callers that launch the binary should use the resolved
// absolute path instead of trusting a spawned shell to find it.
func Resolve(agentID string) (string, error) {
	bin, ok := AgentBinary[agentID]
	if !ok {
		return "", fmt.Errorf("detect: unknown agent %q", agentID)
	}
	return ResolveBinary(bin)
}

// ResolveBinary returns the absolute path to any CLI binary by name, using
// the same PATH + fallback-dir + login-shell-PATH search Resolve uses for
// agent binaries. Exported so callers that need a non-agent tool (e.g. the
// code-server integration) can reuse the same install-location probing
// instead of trusting a bare $PATH lookup.
func ResolveBinary(bin string) (string, error) {
	if p, err := exec.LookPath(bin); err == nil {
		return p, nil
	}
	for _, dir := range append(fallbackDirs(), shellPathDirs()...) {
		for _, name := range binNames(bin) {
			p := filepath.Join(dir, name)
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				return p, nil
			}
		}
	}
	return "", fmt.Errorf("detect: %s: not found on PATH or in common install locations", bin)
}

// binNames returns the filename(s) to probe for a binary in a fallback
// directory. npm installs its shims as .cmd (and .ps1) on Windows rather
// than a bare executable, so the plain name alone won't match there.
func binNames(bin string) []string {
	if runtime.GOOS == "windows" {
		return []string{bin + ".cmd", bin + ".exe", bin}
	}
	return []string{bin}
}

// fallbackDirs returns common per-OS locations where CLI tools (npm global
// installs, standalone installers) end up when they're not on $PATH.
func fallbackDirs() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}

	var dirs []string
	switch runtime.GOOS {
	case "windows":
		dirs = []string{
			filepath.Join(home, "AppData", "Roaming", "npm"),
		}
	case "darwin":
		dirs = []string{
			filepath.Join(home, ".local", "bin"),
			"/opt/homebrew/bin",
			"/usr/local/bin",
		}
	default: // linux and other unix-likes
		dirs = []string{
			filepath.Join(home, ".local", "bin"),
			"/usr/local/bin",
		}
	}

	dirs = append(dirs,
		filepath.Join(home, ".npm-global", "bin"),
		filepath.Join(home, ".volta", "bin"),
		filepath.Join(home, ".bun", "bin"),
	)

	if nodeVersions, err := filepath.Glob(filepath.Join(home, ".nvm", "versions", "node", "*", "bin")); err == nil {
		dirs = append(dirs, nodeVersions...)
	}

	return dirs
}

// shellPathDirs returns the PATH directories the user's interactive login
// shell would have, sourced by actually invoking it. The hardcoded
// fallbackDirs list only covers well-known install locations; a binary
// installed via a custom npm prefix, pipx, mise, asdf, or anything else that
// only lands on PATH through .zshrc/.bashrc would otherwise never be found,
// since GUI/service-launched processes don't source shell rc files. Result
// is memoized (login shell startup can be slow) and overridable in tests via
// direct reassignment, bypassing the memoization.
var shellPathDirs = sync.OnceValue(loginShellPath)

func loginShellPath() []string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, shell, "-ilc", "echo -n \"$PATH\"").Output()
	if err != nil {
		return nil
	}
	path := strings.TrimSpace(string(out))
	if path == "" {
		return nil
	}
	return strings.Split(path, string(os.PathListSeparator))
}

// ProbeAll probes every known agent and returns the set of installed agent IDs.
// Call once at startup; results do not change at runtime.
func ProbeAll() map[string]bool {
	result := make(map[string]bool, len(AgentBinary))
	for id := range AgentBinary {
		result[id] = Installed(id)
	}
	return result
}

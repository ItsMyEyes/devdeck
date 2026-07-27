// Package detect probes the local machine for installed agent CLIs and reads
// their configuration (skills, models) from well-known config directories.
package detect

import (
	"context"
	"encoding/json"
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
// other local integrations can reuse the same install-location probing
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
		filepath.Join(home, ".cargo", "bin"),
		goBinDir(home),
	)

	if nodeVersions, err := filepath.Glob(filepath.Join(home, ".nvm", "versions", "node", "*", "bin")); err == nil {
		dirs = append(dirs, nodeVersions...)
	}

	return dirs
}

// goBinDir returns the directory `go install` places built binaries in
// (e.g. gopls): $GOPATH/bin if GOPATH is set, otherwise Go's default
// $HOME/go/bin. The backend process doesn't inherit a login shell's
// GOPATH-on-PATH export, so without this, any go-installed tool is
// invisible to ResolveBinary even when it's exactly where `go install`
// put it.
func goBinDir(home string) string {
	if gopath := os.Getenv("GOPATH"); gopath != "" {
		return filepath.Join(gopath, "bin")
	}
	return filepath.Join(home, "go", "bin")
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

// tailscaleExtraPaths lists well-known Tailscale CLI locations beyond
// ResolveBinary's generic PATH/fallback-dir/login-shell search — notably the
// official macOS Tailscale.app, which (unlike a Homebrew or npm install)
// does not symlink a `tailscale` shim onto PATH unless the operator
// explicitly runs its "Install Tailscale command line tool" menu action.
// Overridable in tests, same pattern as shellPathDirs.
var tailscaleExtraPaths = defaultTailscaleExtraPaths

func defaultTailscaleExtraPaths() []string {
	if runtime.GOOS != "darwin" {
		return nil
	}
	return []string{"/Applications/Tailscale.app/Contents/MacOS/Tailscale"}
}

// ResolveTailscale returns the absolute path to the tailscale CLI. It tries
// ResolveBinary("tailscale") first (PATH, then the same fallback dirs and
// login-shell PATH every other tool here uses), then tailscaleExtraPaths —
// needed because a GUI-installed Tailscale commonly has no CLI shim on PATH
// at all, unlike the npm-installed agent CLIs ResolveBinary was built for.
func ResolveTailscale() (string, error) {
	if p, err := ResolveBinary("tailscale"); err == nil {
		return p, nil
	}
	for _, p := range tailscaleExtraPaths() {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p, nil
		}
	}
	return "", fmt.Errorf("detect: tailscale: not found on PATH or in common install locations")
}

// tailscaleSelfStatus is the subset of `tailscale status --self --json` that
// TailscaleSelfURL reads.
type tailscaleSelfStatus struct {
	Self struct {
		DNSName string `json:"DNSName"`
	} `json:"Self"`
}

// TailscaleSelfURL runs `tailscale status --self --json` and derives this
// device's tailnet-reachable URL, mirroring
// frontend/src-tauri/src/tailscale.rs's parse_dns_name/public_url.
//
// On success url is "https://<DNSName>" with the trailing dot stripped and
// reason is "". Otherwise url is "" and reason says why:
//
//	"not_installed" — the tailscale CLI isn't anywhere ResolveTailscale looks
//	"not_ready"     — the CLI failed, printed unparseable JSON, or reported an
//	                  empty DNSName (logged out, or MagicDNS off)
func TailscaleSelfURL() (url string, reason string) {
	return TailscaleSelfURLWith(ResolveTailscale)
}

// TailscaleSelfURLWith is TailscaleSelfURL with the CLI lookup injected, so
// callers can fake the "not installed" branch instead of depending on what's
// actually resolvable (PATH, fallback dirs, login shell, macOS app bundle) on
// the machine running their tests.
func TailscaleSelfURLWith(resolve func() (string, error)) (url string, reason string) {
	bin, err := resolve()
	if err != nil {
		return "", "not_installed"
	}
	out, err := exec.Command(bin, "status", "--self", "--json").Output()
	if err != nil {
		return "", "not_ready"
	}
	var status tailscaleSelfStatus
	if err := json.Unmarshal(out, &status); err != nil {
		return "", "not_ready"
	}
	dns := strings.TrimSuffix(status.Self.DNSName, ".")
	if dns == "" {
		return "", "not_ready"
	}
	return "https://" + dns, ""
}

// projectLanguageMarkers maps a project-root marker filename to the LSP
// language ID it implies. Keys match backend/internal/lsp's languageServers
// map, so a caller can go straight from ProjectLanguages' result to a
// serverSpec lookup there.
var projectLanguageMarkers = map[string]string{
	"go.mod":           "go",
	"package.json":     "typescript",
	"pyproject.toml":   "python",
	"requirements.txt": "python",
	"setup.py":         "python",
	"Pipfile":          "python",
	"Cargo.toml":       "rust",
	"pom.xml":          "java",
	"build.gradle":     "java",
	"build.gradle.kts": "java",
}

// ProjectLanguages returns the distinct set of LSP languages implied by
// marker files (go.mod, package.json, pyproject.toml, ...) found directly in
// root. It only looks at root's immediate contents, not subdirectories —
// project markers live at the repository/worktree root by convention, and a
// deep walk would be needlessly slow and prone to false positives from
// vendored dependencies. Returns nil (not an error) for a missing directory
// or one with no recognized markers, since this is a best-effort hint for
// proactive language-server installation, not a required signal.
func ProjectLanguages(root string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	seen := make(map[string]bool, len(projectLanguageMarkers))
	var languages []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		lang, ok := projectLanguageMarkers[entry.Name()]
		if !ok || seen[lang] {
			continue
		}
		seen[lang] = true
		languages = append(languages, lang)
	}
	return languages
}

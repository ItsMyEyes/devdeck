package lsp

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"devdeck/backend/internal/detect"
)

// DependencyStatus is one tool the editor needs: a language server, or the
// prerequisite that installs and powers it.
type DependencyStatus struct {
	Name      string `json:"name"`
	Installed bool   `json:"installed"`
	Path      string `json:"path,omitempty"`
	Version   string `json:"version,omitempty"`
}

// LanguageDependencies pairs a language server with the toolchain it depends
// on. The distinction matters: a server that is installed but whose
// prerequisite is missing looks healthy in a naive "is the binary there?"
// check, yet cannot do its job — gopls without a reachable `go` silently
// degrades to loading each file as a standalone package.
type LanguageDependencies struct {
	Label        string           `json:"label"`
	Server       DependencyStatus `json:"server"`
	Prerequisite DependencyStatus `json:"prerequisite"`
	// Installable is false when this platform has no install strategy, in
	// which case Blocker explains why.
	Installable bool   `json:"installable"`
	Blocker     string `json:"blocker,omitempty"`
}

// DependencyReport is the whole picture for one machine.
type DependencyReport struct {
	Languages []LanguageDependencies `json:"languages"`
	// SpawnPath is the PATH a language server is actually started with. It is
	// reported because the failure it explains is invisible otherwise: the
	// backend can resolve a binary through detect's fallback directories and
	// still hand the child a PATH that cannot reach the toolchain.
	SpawnPath string `json:"spawnPath"`
	OS        string `json:"os"`
}

// dependencyGroups is ordered (not derived from the languageServers map) so
// the report renders in a stable order rather than Go's randomised map order.
// One entry per server binary — languageServers maps eight language ids onto
// five binaries, and listing typescript-language-server four times would be
// noise.
var dependencyGroups = []struct {
	label  string
	binary string
}{
	{"Go", "gopls"},
	{"TypeScript / JavaScript", "typescript-language-server"},
	{"Python", "pyright-langserver"},
	{"Rust", "rust-analyzer"},
	{"Java", "jdtls"},
}

// versionArgs is what each tool wants in order to print its version. There is
// no convention here: gopls and the go tool use a bare `version` subcommand,
// everything else uses a flag.
var versionArgs = map[string][]string{
	"gopls":                      {"version"},
	"go":                         {"version"},
	"typescript-language-server": {"--version"},
	"pyright-langserver":         {"--version"},
	"rust-analyzer":              {"--version"},
	"jdtls":                      {"--version"},
	"npm":                        {"--version"},
	"rustup":                     {"--version"},
	"brew":                       {"--version"},
}

const versionTimeout = 5 * time.Second

// probeVersion is overridable in tests so the suite never depends on which
// toolchains happen to be installed on the machine running it.
var probeVersion = func(path string, args []string) string {
	ctx, cancel := context.WithTimeout(context.Background(), versionTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = detect.AugmentedEnv()
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	// Tools differ in how much they print; the first line is the version on
	// every one of them, and jdtls prints a banner after it.
	line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	return strings.TrimSpace(line)
}

// resolveDependency reports whether one binary is present, and where.
func resolveDependency(binary string) DependencyStatus {
	status := DependencyStatus{Name: binary}
	path, err := detect.ResolveBinary(binary)
	if err != nil {
		return status
	}
	status.Installed = true
	status.Path = path
	if args, ok := versionArgs[binary]; ok {
		status.Version = probeVersion(path, args)
	}
	return status
}

// Report probes every supported language server and its prerequisite on this
// machine. It is deliberately read-only — nothing is installed as a
// side-effect of asking.
func Report() DependencyReport {
	report := DependencyReport{
		OS:        runtime.GOOS,
		SpawnPath: spawnPath(),
		Languages: make([]LanguageDependencies, 0, len(dependencyGroups)),
	}

	for _, group := range dependencyGroups {
		entry := LanguageDependencies{
			Label:  group.label,
			Server: resolveDependency(group.binary),
		}

		spec, ok := installSpecs[group.binary]
		if ok {
			entry.Prerequisite = resolveDependency(spec.prereq)
			switch {
			case spec.supported != nil && !spec.supported():
				entry.Blocker = "not supported on " + runtime.GOOS
			case !entry.Prerequisite.Installed:
				entry.Blocker = spec.prereq + " is required to install " + group.binary
			default:
				entry.Installable = true
			}
		}

		report.Languages = append(report.Languages, entry)
	}

	return report
}

// spawnPath extracts PATH from the environment a language server is started
// with, so the UI can show the same string the child process sees.
func spawnPath() string {
	for _, entry := range detect.AugmentedEnv() {
		name, value, found := strings.Cut(entry, "=")
		if found && strings.EqualFold(name, "PATH") {
			return value
		}
	}
	return os.Getenv("PATH")
}

// InstallBinary installs one language server by name. Returns an error for a
// binary that has no install strategy, so a caller cannot silently no-op.
func (i *Installer) InstallBinary(ctx context.Context, binary string) error {
	return i.EnsureInstalled(ctx, binary, nil)
}

// KnownBinary reports whether binary is one this package manages, so a handler
// can reject arbitrary strings before they reach an exec call.
func KnownBinary(binary string) bool {
	for _, group := range dependencyGroups {
		if group.binary == binary {
			return true
		}
	}
	return false
}

package lsp

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"devdeck/backend/internal/detect"
)

// installSpec describes how to install a language-server binary that
// detect.ResolveBinary couldn't find: which prerequisite tool must already
// be resolvable, and what arguments to run it with.
type installSpec struct {
	prereq    string
	args      []string
	supported func() bool // optional OS gate; nil means always supported
}

// installSpecs is a var (not a const map literal inline) so tests can swap
// it out, the same pattern languageServers already uses in server_test.go.
var installSpecs = map[string]installSpec{
	"gopls": {
		prereq: "go",
		args:   []string{"install", "golang.org/x/tools/gopls@latest"},
	},
	"typescript-language-server": {
		prereq: "npm",
		args:   []string{"install", "-g", "typescript-language-server", "typescript"},
	},
	"pyright-langserver": {
		prereq: "npm",
		args:   []string{"install", "-g", "pyright"},
	},
	"rust-analyzer": {
		prereq: "rustup",
		args:   []string{"component", "add", "rust-analyzer"},
	},
	"jdtls": {
		prereq:    "brew",
		args:      []string{"install", "jdtls"},
		supported: func() bool { return runtime.GOOS == "darwin" },
	},
}

const installTimeout = 10 * time.Minute

// runInstallCommand executes a resolved prerequisite binary with args.
// Overridable in tests so they never invoke a real package manager or touch
// the network.
var runInstallCommand = func(ctx context.Context, prereqPath string, args []string) error {
	ctx, cancel := context.WithTimeout(ctx, installTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, prereqPath, args...)
	// `go install` / `npm install -g` shell out to git and to their own
	// toolchains, so the child needs the same augmented PATH the server spawn
	// gets — see detect.AugmentedEnv.
	cmd.Env = detect.AugmentedEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w: %s", prereqPath, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

type installState struct {
	done chan struct{}
	err  error
}

// Installer auto-installs missing language-server binaries on demand,
// deduplicating concurrent requests for the same binary so two connections
// that both need (say) gopls trigger exactly one `go install`.
type Installer struct {
	mu     sync.Mutex
	states map[string]*installState
}

func NewInstaller() *Installer {
	return &Installer{states: make(map[string]*installState)}
}

// EnsureInstalled resolves binary, installing it first via its installSpec
// if it's currently missing. onInstalling, if non-nil, is called once for
// every caller (whether it started the install or joined one already in
// flight) right before waiting on the result, so each caller can notify its
// own client that an install is in progress. Concurrent EnsureInstalled
// calls for the same binary share a single install attempt.
func (i *Installer) EnsureInstalled(ctx context.Context, binary string, onInstalling func()) error {
	if _, err := detect.ResolveBinary(binary); err == nil {
		return nil
	}

	spec, ok := installSpecs[binary]
	if !ok {
		return fmt.Errorf("lsp: no install strategy for %s", binary)
	}
	if spec.supported != nil && !spec.supported() {
		return fmt.Errorf("lsp: %s cannot be auto-installed on %s", binary, runtime.GOOS)
	}

	i.mu.Lock()
	state, exists := i.states[binary]
	if !exists {
		state = &installState{done: make(chan struct{})}
		i.states[binary] = state
	}
	i.mu.Unlock()

	if onInstalling != nil {
		onInstalling()
	}

	if !exists {
		state.err = i.install(ctx, binary, spec)
		close(state.done)
		return state.err
	}

	select {
	case <-state.done:
		return state.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (i *Installer) install(ctx context.Context, binary string, spec installSpec) error {
	prereqPath, err := detect.ResolveBinary(spec.prereq)
	if err != nil {
		return fmt.Errorf("lsp: %s is required to install %s but was not found", spec.prereq, binary)
	}
	if err := runInstallCommand(ctx, prereqPath, spec.args); err != nil {
		return fmt.Errorf("lsp: install %s: %w", binary, err)
	}
	if _, err := detect.ResolveBinary(binary); err != nil {
		return fmt.Errorf("lsp: %s still not found after install", binary)
	}
	return nil
}

package codex

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/provider"
)

// fakeBinary writes an executable shell script and returns its absolute path.
// ResolveBinary defers to exec.LookPath, which returns a path containing a
// separator as-is, so a Config.BinaryName holding this path resolves to
// exactly this script without touching PATH.
func fakeBinary(t *testing.T, script string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake binary is POSIX-only")
	}
	path := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatalf("write fake binary: %v", err)
	}
	return path
}

// An app-server that dies at startup must be reported as what it is.
//
// This is the real-world failure: a codex build without the `app-server`
// subcommand treats "app-server" as a PROMPT, tries to open the TUI, prints
// "Error: stdin is not a terminal" and exits 1 — before writing a single byte
// of JSON. The adapter never reaped the process and never failed the pending
// RPC on stdout close, so the operator waited the full rpcTimeout and was told
// "codex: initialize: codex: initialize timed out after 30s" — which describes
// the adapter's timer, not the CLI's complaint, and named neither the exit code
// nor the one line of stderr that explains everything.
func TestEnsureProcessReportsStartupExitInsteadOfTimingOut(t *testing.T) {
	bin := fakeBinary(t, "echo 'Error: stdin is not a terminal' >&2\nexit 1\n")

	a := newAdapter(context.Background(), "codex:default", Config{BinaryName: bin}, nil)

	start := time.Now()
	err := a.ensureProcess(nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("ensureProcess must fail when the app-server exits at startup")
	}
	if elapsed >= rpcTimeout {
		t.Fatalf("ensureProcess waited %s for a process that exited immediately; it must fail as soon as the process is gone", elapsed)
	}
	if strings.Contains(err.Error(), "timed out") {
		t.Errorf("error reports a timeout, not the exit: %v", err)
	}
	if !strings.Contains(err.Error(), "stdin is not a terminal") {
		t.Errorf("error must carry the app-server's own stderr; got: %v", err)
	}
}

// The cached-failure half of the same report. ensureProcess is guarded by
// startOnce, so once the first attempt fails every later send returns that
// same error instantly — which is why the operator saw two identical errors
// 13s apart, both rendered as "0s", for a timeout that is 30s long. The
// message must therefore stand on its own: it is shown long after, and for
// attempts that never ran a process at all.
func TestStartErrIsCachedAcrossAttempts(t *testing.T) {
	bin := fakeBinary(t, "echo 'boom' >&2\nexit 3\n")

	a := newAdapter(context.Background(), "codex:default", Config{BinaryName: bin}, nil)

	first := a.ensureProcess(nil)
	if first == nil {
		t.Fatal("first attempt must fail")
	}

	start := time.Now()
	second := a.ensureProcess(nil)
	if second == nil {
		t.Fatal("second attempt must keep failing")
	}
	if time.Since(start) > time.Second {
		t.Fatal("second attempt must return the cached error immediately")
	}
	if second.Error() != first.Error() {
		t.Fatalf("cached error changed: %q then %q", first, second)
	}
}

var _ provider.Config = Config{}

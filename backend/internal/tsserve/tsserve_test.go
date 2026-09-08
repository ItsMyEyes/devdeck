package tsserve

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeTailscale writes a stub CLI that blocks forever on `serve <port>` (the
// real one runs in the foreground for the life of the mapping) and returns
// immediately for anything else, matching `serve --https=443 off`.
func fakeTailscale(t *testing.T) func() (string, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tailscale")
	script := "#!/bin/sh\nif [ \"$2\" = \"--https=443\" ]; then exit 0; fi\nwhile true; do sleep 0.05; done\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake tailscale: %v", err)
	}
	return func() (string, error) { return path, nil }
}

// newTestController shortens the start grace so tests do not pay the real
// 700ms wait on every Start.
func newTestController(t *testing.T, resolve func() (string, error)) *Controller {
	t.Helper()
	c := New(resolve)
	c.grace = 20 * time.Millisecond
	return c
}

// failingTailscale writes a stub whose `serve` exits 1 after printing the
// message the real CLI produces when another process already holds 443.
func failingTailscale(t *testing.T) func() (string, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tailscale")
	script := "#!/bin/sh\nif [ \"$2\" = \"--https=443\" ]; then exit 1; fi\n" +
		"echo '2026/08/28 14:20:04 sending serve config: updating config: listener already exists for port 443'\nexit 1\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write failing tailscale: %v", err)
	}
	return func() (string, error) { return path, nil }
}

// waitFor polls until cond holds, so tests never depend on a fixed sleep for
// the Wait goroutine to observe a killed child.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestStartThenStop(t *testing.T) {
	c := newTestController(t, fakeTailscale(t))
	if running, _ := c.Status(); running {
		t.Fatal("a fresh controller must report stopped")
	}
	if err := c.Start("8989"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	running, port := c.Status()
	if !running || port != "8989" {
		t.Fatalf("Status() = %v/%q, want true/8989", running, port)
	}
	if err := c.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if running, _ := c.Status(); running {
		t.Fatal("Status must report stopped immediately after Stop")
	}
}

func TestStopIsANoOpWhenNothingRuns(t *testing.T) {
	c := newTestController(t, fakeTailscale(t))
	if err := c.Stop(); err != nil {
		t.Fatalf("Stop on an idle controller must succeed, got %v", err)
	}
}

// Re-Starting the same port must not spawn a second child — the UI can send
// the same request twice (double click, a refetch racing a toggle).
func TestStartIsIdempotentForTheSamePort(t *testing.T) {
	c := newTestController(t, fakeTailscale(t))
	if err := c.Start("8989"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	c.mu.Lock()
	first := c.cmd
	c.mu.Unlock()

	if err := c.Start("8989"); err != nil {
		t.Fatalf("second Start: %v", err)
	}
	c.mu.Lock()
	second := c.cmd
	c.mu.Unlock()
	if first != second {
		t.Fatal("Start on the same port must reuse the running child")
	}
	_ = c.Stop()
}

// The port changes whenever the hub rebinds (an OS-assigned fallback), so
// Start must replace rather than refuse or leak the old child.
func TestStartOnANewPortReplacesTheChild(t *testing.T) {
	c := newTestController(t, fakeTailscale(t))
	if err := c.Start("8989"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	c.mu.Lock()
	first := c.cmd
	c.mu.Unlock()

	if err := c.Start("54103"); err != nil {
		t.Fatalf("Start on a new port: %v", err)
	}
	running, port := c.Status()
	if !running || port != "54103" {
		t.Fatalf("Status() = %v/%q, want true/54103", running, port)
	}
	waitFor(t, "the replaced child to exit", func() bool {
		return first.ProcessState != nil
	})
	// The replaced child's Wait goroutine must NOT clear the new one.
	if running, port := c.Status(); !running || port != "54103" {
		t.Fatalf("after the old child was reaped Status() = %v/%q, want true/54103", running, port)
	}
	_ = c.Stop()
}

// A serve child that dies on its own (tailscaled restart, operator kill) must
// leave the controller reporting stopped, not a phantom mapping.
func TestStatusClearsWhenTheChildDies(t *testing.T) {
	c := newTestController(t, fakeTailscale(t))
	if err := c.Start("8989"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	c.mu.Lock()
	cmd := c.cmd
	c.mu.Unlock()
	if err := cmd.Process.Kill(); err != nil {
		t.Fatalf("kill: %v", err)
	}
	waitFor(t, "Status to clear", func() bool {
		running, _ := c.Status()
		return !running
	})
}

// The regression: a fork that succeeds proves nothing. `tailscale serve`
// reports "listener already exists for port 443" — what a SECOND DevDeck on
// the machine hits — by exiting just after a clean fork, so Start used to
// return success for an already-dead child and the UI toggle sprang back with
// tailscale's explanation shown nowhere.
func TestStartReportsAChildThatDiesImmediately(t *testing.T) {
	c := newTestController(t, failingTailscale(t))
	err := c.Start("8989")
	if err == nil {
		t.Fatal("Start must fail when the serve child exits immediately")
	}
	if !strings.Contains(err.Error(), "listener already exists for port 443") {
		t.Fatalf("err = %v, want tailscale's own message", err)
	}
	if strings.Contains(err.Error(), "2026/08/28") {
		t.Fatalf("err = %v, want the log timestamp stripped", err)
	}
	if running, _ := c.Status(); running {
		t.Fatal("a child that died must not be reported as running")
	}
}

func TestStartReportsAMissingCLI(t *testing.T) {
	c := New(func() (string, error) { return "", errors.New("not found") })
	err := c.Start("8989")
	if err == nil {
		t.Fatal("Start must fail when the CLI cannot be resolved")
	}
	if running, _ := c.Status(); running {
		t.Fatal("a failed Start must not report running")
	}
}

func TestStartRejectsAnEmptyPort(t *testing.T) {
	c := newTestController(t, fakeTailscale(t))
	if err := c.Start(""); err == nil {
		t.Fatal("Start must reject an empty port")
	}
}

func TestClearArgsIsScopedTo443(t *testing.T) {
	got := clearArgs()
	want := []string{"serve", "--https=443", "off"}
	if len(got) != len(want) {
		t.Fatalf("clearArgs() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("clearArgs() = %v, want %v (never `serve reset` — it drops mappings devdeck does not own)", got, want)
		}
	}
}

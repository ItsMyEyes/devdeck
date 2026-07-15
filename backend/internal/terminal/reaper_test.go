package terminal

import (
	"os/exec"
	"runtime"
	"testing"
	"time"
)

// longLivedCommand returns a process that stays alive well past any test
// timeout, so the test controls when (and whether) it dies.
func longLivedCommand() *exec.Cmd {
	if runtime.GOOS == "windows" {
		return exec.Command("ping.exe", "-n", "100", "127.0.0.1")
	}
	return exec.Command("sleep", "100")
}

// shortLivedCommand returns a process that exits on its own within a few
// hundred ms, standing in for an agent task that finishes.
func shortLivedCommand() *exec.Cmd {
	if runtime.GOOS == "windows" {
		return exec.Command("ping.exe", "-n", "1", "127.0.0.1")
	}
	return exec.Command("sleep", "0.3")
}

// TestFinishedSessionIsReclaimedEvenWithReapingDisabled proves the "never reap"
// policy does NOT leak: a detached session whose process exits on its own is
// still automatically dropped from the registry (spawn's cmd.Wait goroutine ->
// sess.close() -> r.discard()), which closes the PTY, unblocks the pump/reader
// goroutines, and reaps the child. So a completed agent task frees everything;
// only a still-running one is deliberately kept.
func TestFinishedSessionIsReclaimedEvenWithReapingDisabled(t *testing.T) {
	reg := newRegistry() // graceTTL == 0, reaping disabled
	session := testSessionID(t)

	sess, err := reg.spawn(session, shortLivedCommand(), 80, 24)
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	pid := sess.cmd.Process.Pid

	if !reg.detach(session, nil) {
		t.Fatal("detach returned false for a live session")
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if reg.get(session) == nil && !processAlive(pid) {
			return // process exited and the session was auto-reclaimed — no leak
		}
		time.Sleep(20 * time.Millisecond)
	}
	if reg.get(session) != nil {
		t.Error("session still registered after its process exited; it leaked instead of being auto-discarded")
	}
	if processAlive(pid) {
		t.Errorf("process %d still alive well past its expected exit", pid)
	}
}

// TestDetachDoesNotReapLiveSessionByDefault is the regression guard for the
// "never reap live agents" policy: detaching the last WebSocket from a session
// whose child process is still running must NOT schedule that process to be
// killed. A background agent task (claude -p "...") has to survive the operator
// closing the tab and coming back much later — the session lives until the
// process exits on its own or the worktree is explicitly deleted.
func TestDetachDoesNotReapLiveSessionByDefault(t *testing.T) {
	reg := newRegistry()
	session := testSessionID(t)

	sess, err := reg.spawn(session, longLivedCommand(), 80, 24)
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	t.Cleanup(func() { reg.kill(session) })
	pid := sess.cmd.Process.Pid

	// sess.conn is nil right after spawn, so detach(session, nil) matches the
	// "currently attached" connection and runs the detach path.
	if !reg.detach(session, nil) {
		t.Fatal("detach returned false for a session with a live process")
	}

	sess.mu.Lock()
	armed := sess.killTimer != nil
	sess.mu.Unlock()
	if armed {
		t.Error("detach armed a kill timer with reaping disabled; a live background agent would be killed after the grace window")
	}

	// Give any (erroneously armed) short timer a chance to fire.
	time.Sleep(300 * time.Millisecond)

	if reg.get(session) == nil {
		t.Error("session was removed from the registry after detach; a reattaching client would spawn a fresh shell instead of resuming its task")
	}
	if !processAlive(pid) {
		t.Errorf("process %d was killed after detach despite reaping being disabled", pid)
	}
}

// TestDetachReapsLiveSessionWhenGraceEnabled guards the opt-in reaper: when a
// registry sets a positive graceTTL, detaching the last connection must kill
// the (still-running) process after that window and drop the session. This is
// the behavior deliberately disabled by default above; the seam stays covered
// so re-enabling it behind a flag needs no new tests.
func TestDetachReapsLiveSessionWhenGraceEnabled(t *testing.T) {
	reg := newRegistry()
	reg.graceTTL = 50 * time.Millisecond
	session := testSessionID(t)

	sess, err := reg.spawn(session, longLivedCommand(), 80, 24)
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	t.Cleanup(func() { reg.kill(session) })
	pid := sess.cmd.Process.Pid

	if !reg.detach(session, nil) {
		t.Fatal("detach returned false for a session with a live process")
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) && reg.get(session) == nil {
			return // reaped as expected
		}
		time.Sleep(20 * time.Millisecond)
	}
	if processAlive(pid) {
		t.Errorf("process %d still alive after grace window; reaper did not fire", pid)
	}
	if reg.get(session) != nil {
		t.Error("session still registered after grace window; reaper did not remove it")
	}
}

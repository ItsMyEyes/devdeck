package terminal

import (
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

func testSessionID(t *testing.T) string {
	t.Helper()
	return "kill-test-" + strings.ReplaceAll(strings.ReplaceAll(t.Name(), "/", "-"), " ", "-")
}

func TestKillSessionTerminatesRunningProcess(t *testing.T) {
	activeRegistry = newRegistry()
	session := testSessionID(t)

	sess, err := activeRegistry.spawn(session, exec.Command("sleep", "100"), 80, 24)
	if err != nil {
		t.Fatalf("failed to spawn test session: %v", err)
	}
	pid := sess.cmd.Process.Pid

	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatalf("spawned process %d is not alive: %v", pid, err)
	}

	if err := KillSession(session); err != nil {
		t.Fatalf("KillSession returned error: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if syscall.Kill(pid, 0) != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := syscall.Kill(pid, 0); err == nil {
		t.Errorf("process %d is still alive after KillSession", pid)
	}
	if activeRegistry.get(session) != nil {
		t.Errorf("expected session %s to be removed from the registry", session)
	}
}

func TestKillSessionNoopWhenNotRunning(t *testing.T) {
	activeRegistry = newRegistry()
	session := testSessionID(t)
	if err := KillSession(session); err != nil {
		t.Fatalf("KillSession on a session with no running process should be a no-op, got error: %v", err)
	}
}

package terminal

import (
	"os/exec"
	"runtime"
	"strings"
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

	var command *exec.Cmd
	if runtime.GOOS == "windows" {
		command = exec.Command("ping.exe", "-n", "100", "127.0.0.1")
	} else {
		command = exec.Command("sleep", "100")
	}
	sess, err := activeRegistry.spawn(session, command, 80, 24)
	if err != nil {
		t.Fatalf("failed to spawn test session: %v", err)
	}
	pid := sess.cmd.Process.Pid

	if !processAlive(pid) {
		t.Fatalf("spawned process %d is not alive", pid)
	}

	if err := KillSession(session); err != nil {
		t.Fatalf("KillSession returned error: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if processAlive(pid) {
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

package terminal

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
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

func TestActiveSessionCountIsZeroWithoutARegistry(t *testing.T) {
	orig := activeRegistry
	t.Cleanup(func() { activeRegistry = orig })

	activeRegistry = nil
	if got := ActiveSessionCount(); got != 0 {
		t.Errorf("ActiveSessionCount() = %d, want 0 on a process with no terminal server", got)
	}
}

// TestKillWithAttachedConnStillTerminatesProcess exercises the conn != nil
// branch of kill() — no other test in this package attaches a connection
// before killing, so the bounded-notice-write path (killNoticeWriteTimeout)
// was previously untouched by any test. Guards that, against a live and
// perfectly normal peer, kill() still writes the notice, still returns
// promptly, and still reaches sess.close()/terminateProcess.
func TestKillWithAttachedConnStillTerminatesProcess(t *testing.T) {
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

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		sess.attachConn(conn, 80, 24, nil)
		time.Sleep(2 * time.Second)
	}))
	defer srv.Close()

	dialCtx, dialCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer dialCancel()
	clientConn, _, err := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { clientConn.CloseNow() })

	// Wait until attachConn has actually run so sess.conn is set before kill().
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		sess.mu.Lock()
		attached := sess.conn != nil
		sess.mu.Unlock()
		if attached {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	killDone := make(chan struct{})
	go func() {
		activeRegistry.kill(session)
		close(killDone)
	}()

	select {
	case <-killDone:
	case <-time.After(5 * time.Second):
		t.Fatal("kill() did not return within 5s against a normal, responsive attached connection")
	}

	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if processAlive(pid) {
		t.Errorf("process %d still alive after kill() with an attached connection", pid)
	}
	if activeRegistry.get(session) != nil {
		t.Errorf("session %s still registered after kill()", session)
	}
}

func TestActiveSessionCountTracksRegisteredSessions(t *testing.T) {
	orig := activeRegistry
	t.Cleanup(func() { activeRegistry = orig })

	activeRegistry = newRegistry()
	if got := ActiveSessionCount(); got != 0 {
		t.Errorf("ActiveSessionCount() = %d, want 0 for an empty registry", got)
	}

	activeRegistry.sessions["wt-1"] = &ptySession{}
	activeRegistry.sessions["wt-1::term-2"] = &ptySession{}
	if got := ActiveSessionCount(); got != 2 {
		t.Errorf("ActiveSessionCount() = %d, want 2", got)
	}
}

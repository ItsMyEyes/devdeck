package terminal

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/creack/pty"
	"nhooyr.io/websocket"
)

// ptyAvailable checks if we can spawn a PTY.
func ptyAvailable() bool {
	shell := pickShell()
	cmd := exec.Command(shell, "-c", "echo ok")
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		return false
	}
	f.Close()
	cmd.Wait()
	return true
}

// resolveWorkDir expands a leading ~ (os/exec does not expand it for cmd.Dir)
// and falls back to the user's home directory when workDir is empty.
func resolveWorkDir(workDir string) string {
	if workDir == "" {
		home, _ := os.UserHomeDir()
		return home
	}
	if strings.HasPrefix(workDir, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(workDir, "~"))
		}
	}
	return workDir
}

// buildSessionCmd constructs the command to run under the PTY for a session.
// Agent worktree sessions run the agent binary directly as the PTY's
// foreground process, so its stdin/stdout are the persistent PTY itself
// rather than a backgrounded job typed into a throwaway shell — the agent
// stays reachable via stdin, and keeps running, across WS disconnects.
// Plain sessions get an interactive shell.
func buildSessionCmd(session, agentBin, workDir string, args []string) *exec.Cmd {
	var cmd *exec.Cmd
	if agentBin != "" {
		cmd = exec.Command(agentBin, args...)
	} else {
		cmd = exec.Command(pickShell())
	}
	cmd.Dir = resolveWorkDir(workDir)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "LOOM_SESSION="+session)
	return cmd
}

// attachPTY attaches conn to session's PTY: it creates the PTY on the first
// connection for a given session id, or reattaches — replaying buffered
// output — if the session is already running from an earlier connection.
// The PTY (and, for agent sessions, the agent process) lives in the
// package-level registry and is not torn down when conn closes; it is only
// killed after a grace period with nobody attached (see registry.detach).
func (s *Server) attachPTY(ctx context.Context, conn *websocket.Conn, session string, cols, rows int, agentBin, workDir string, args []string) error {
	sess := s.registry.get(session)
	if sess == nil {
		cmd := buildSessionCmd(session, agentBin, workDir, args)
		var err error
		sess, err = s.registry.spawn(session, cmd, cols, rows)
		if err != nil {
			return fmt.Errorf("pty start: %w", err)
		}
		log.Printf("terminal: session %s spawned %s (pid %d)", session, cmd.Path, cmd.Process.Pid)
	} else {
		log.Printf("terminal: session %s reattached (pid %d)", session, sess.cmd.Process.Pid)
	}

	buffered := sess.attachConn(conn, cols, rows)

	shellLabel := agentBin
	if shellLabel == "" {
		shellLabel = pickShell()
	}
	writeBanner(ctx, conn, session, shellLabel, true)
	if len(buffered) > 0 {
		_ = conn.Write(ctx, websocket.MessageBinary, buffered)
	}

	go keepalive(ctx, conn)

	// WebSocket -> PTY (user stdin / resize), until this connection closes.
	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			break
		}
		var f frame
		if err := json.Unmarshal(msg, &f); err != nil {
			continue
		}
		if f.T == "i" {
			sess.write([]byte(f.D))
		} else if f.T == "r" {
			newCols := clampInt(fmt.Sprint(f.Cols), cols, 1, 500)
			newRows := clampInt(fmt.Sprint(f.Rows), rows, 1, 300)
			sess.resize(newCols, newRows)
		}
	}

	s.registry.detach(session, conn)
	log.Printf("terminal: session %s detached (process continues in background)", session)
	return nil
}

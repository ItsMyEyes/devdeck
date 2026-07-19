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

	crosspty "github.com/aymanbagabas/go-pty"
	"nhooyr.io/websocket"
)

// ptyAvailable checks whether the host can create a native PTY. On Windows
// this probes ConPTY, which requires Windows 10 version 1809 or newer.
func ptyAvailable() bool {
	ptmx, err := crosspty.New()
	if err != nil {
		return false
	}
	defer ptmx.Close()
	return ptmx.Resize(80, 24) == nil
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
		cmd = platformCommand(agentBin, args...)
	} else {
		cmd = platformCommand(pickShell())
	}
	cmd.Dir = resolveWorkDir(workDir)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "DEVDECK_SESSION="+session)
	return cmd
}

// attachPTY attaches conn to session's PTY: it creates the PTY on the first
// connection for a given session id, or reattaches — replaying buffered
// output — if the session is already running from an earlier connection.
// The PTY (and, for agent sessions, the agent process) lives in the
// package-level registry and is not torn down when conn closes: a detached
// session keeps running (see registry.detach) so a background agent survives
// the operator closing the tab, and is reclaimed only when its process exits
// or it's killed explicitly (worktree deletion / spawned-pane tab close).
func (s *Server) attachPTY(ctx context.Context, conn *websocket.Conn, session string, cols, rows int, agentBin, workDir string, args []string) error {
	sess := s.registry.get(session)
	if sess == nil {
		cmd := buildSessionCmd(session, agentBin, workDir, args)
		var err error
		sess, err = s.registry.spawn(session, cmd, cols, rows)
		if err != nil {
			return fmt.Errorf("pty start: %w", err)
		}
		log.Printf("terminal: session %s spawned %s (pid %d)", session, sess.cmd.Path, sess.cmd.Process.Pid)
	} else {
		log.Printf("terminal: session %s reattached (pid %d)", session, sess.cmd.Process.Pid)
	}

	shellLabel := agentBin
	if shellLabel == "" {
		shellLabel = pickShell()
	}
	// The banner and buffered-history replay are delivered by the pump's
	// coalescing writer (see registry.pump), not written here, so they can't
	// interleave with live output racing in from the PTY.
	sess.attachConn(conn, cols, rows, []byte(bannerText(session, shellLabel, true)))

	go keepalive(ctx, conn)

	// WebSocket -> PTY (user stdin / resize), until this connection closes.
	var readErr error
	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			readErr = err
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

	// Close status says who ended the connection and why: 1000/1001 is a
	// deliberate client close, -1 with a net error is a transport drop
	// (proxy/tunnel/mobile network), 1002/1007/1009 is a protocol or data
	// complaint from the peer.
	log.Printf("terminal: session %s read loop ended: closeStatus=%d err=%v",
		session, websocket.CloseStatus(readErr), readErr)

	if s.registry.detach(session, conn) {
		log.Printf("terminal: session %s detached (process continues in background)", session)
	} else {
		log.Printf("terminal: session %s connection closed (process already terminated)", session)
	}
	return nil
}

package sshmgr

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"golang.org/x/crypto/ssh"
	"nhooyr.io/websocket"
)

// frame mirrors the PTY WebSocket protocol in internal/terminal:
// {"t":"i","d":"..."} for stdin, {"t":"r","cols":N,"rows":N} for resize.
// Output travels as raw frames, so the frontend's existing xterm wiring
// works unchanged against this endpoint.
type frame struct {
	T    string `json:"t"`
	D    string `json:"d,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

// Server upgrades /ws/ssh requests into interactive SSH shells.
type Server struct {
	dialer *Dialer
}

func NewServer(dialer *Dialer) *Server {
	return &Server{dialer: dialer}
}

func clampInt(raw string, def, min, max int) int {
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

// HandleWS runs one SSH shell per WebSocket connection. Unlike the local
// terminal server there is no reattach registry (yet): the remote shell's
// lifetime is the socket's lifetime, and a reconnect starts a fresh shell.
func (s *Server) HandleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		// permessage-deflate breaks WebKit's WebSocket client under
		// sustained output — same hard-won setting as terminal.HandleWS.
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		log.Printf("ssh: websocket accept: %v", err)
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)

	q := r.URL.Query()
	connectionID := q.Get("connection")
	cols := clampInt(q.Get("cols"), 80, 1, 500)
	rows := clampInt(q.Get("rows"), 24, 1, 300)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	if connectionID == "" {
		writeText(ctx, conn, "\r\n[ssh error: missing connection id]\r\n")
		return
	}
	if err := s.runShell(ctx, cancel, conn, connectionID, cols, rows); err != nil {
		log.Printf("ssh: connection %s session failed: %v", connectionID, err)
		writeText(ctx, conn, fmt.Sprintf("\r\n[ssh error: %v]\r\n", err))
	}
}

// runShell dials the saved connection, opens a PTY-backed shell session,
// and bridges it to the WebSocket until either side ends.
func (s *Server) runShell(ctx context.Context, cancel context.CancelFunc, conn *websocket.Conn, connectionID string, cols, rows int) error {
	client, err := s.dialer.Dial(ctx, connectionID)
	if err != nil {
		return err
	}
	defer client.Close()

	sess, err := client.NewSession()
	if err != nil {
		return fmt.Errorf("open session: %w", err)
	}
	defer sess.Close()

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		return fmt.Errorf("request pty: %w", err)
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		return fmt.Errorf("open stdin: %w", err)
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		return fmt.Errorf("open stdout: %w", err)
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		return fmt.Errorf("open stderr: %w", err)
	}
	if err := sess.Shell(); err != nil {
		return fmt.Errorf("start shell: %w", err)
	}

	go keepalive(ctx, conn)
	go pumpOutput(ctx, conn, stdout)
	go pumpOutput(ctx, conn, stderr)
	go func() {
		_ = sess.Wait() // remote shell exited (or the transport died)
		writeText(ctx, conn, "\r\n[ssh session ended]\r\n")
		cancel() // unblock the frame loop below
	}()

	// WebSocket -> remote shell (stdin / resize), until either side closes.
	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			return nil // client closed, or the shell-exit goroutine cancelled ctx
		}
		var f frame
		if err := json.Unmarshal(msg, &f); err != nil {
			continue
		}
		if f.T == "i" {
			if _, err := stdin.Write([]byte(f.D)); err != nil {
				return nil
			}
		} else if f.T == "r" && f.Cols > 0 && f.Rows > 0 {
			newCols := clampInt(fmt.Sprint(f.Cols), cols, 1, 500)
			newRows := clampInt(fmt.Sprint(f.Rows), rows, 1, 300)
			_ = sess.WindowChange(newRows, newCols)
		}
	}
}

// pumpOutput copies remote output to the socket as binary frames. Binary
// (not text) avoids invalid-UTF-8 frames when raw terminal bytes split
// mid-rune; the frontend's xterm onmessage handles both.
func pumpOutput(ctx context.Context, conn *websocket.Conn, r io.Reader) {
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if werr := conn.Write(ctx, websocket.MessageBinary, buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func writeText(ctx context.Context, conn *websocket.Conn, s string) {
	_ = conn.Write(ctx, websocket.MessageText, []byte(s))
}

// keepalive pings every 30s and returns when the peer stops answering —
// same tuning as internal/terminal's keepalive.
func keepalive(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := conn.Ping(ctx); err != nil {
				return
			}
		}
	}
}

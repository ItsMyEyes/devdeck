package terminal

import (
	"context"
	"os/exec"
	"sync"
	"time"

	crosspty "github.com/aymanbagabas/go-pty"
	"nhooyr.io/websocket"
)

const (
	// ringBufferMaxBytes caps how much recent PTY output is kept in memory
	// per session, so a reattaching client can replay history it missed.
	ringBufferMaxBytes = 64 * 1024
	// sessionGraceTTL is how long a session's PTY stays alive with nobody
	// attached before it's killed. Mirrors trash/term's SESSION_GRACE_MS.
	sessionGraceTTL = 10 * time.Minute
)

// ringBuffer is a byte-capped rolling buffer of recent PTY output.
type ringBuffer struct {
	mu     sync.Mutex
	chunks [][]byte
	total  int
	max    int
}

func newRingBuffer(max int) *ringBuffer {
	return &ringBuffer{max: max}
}

func (b *ringBuffer) append(p []byte) {
	if len(p) == 0 {
		return
	}
	cp := append([]byte(nil), p...)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.chunks = append(b.chunks, cp)
	b.total += len(cp)
	for b.total > b.max && len(b.chunks) > 1 {
		b.total -= len(b.chunks[0])
		b.chunks = b.chunks[1:]
	}
}

func (b *ringBuffer) contents() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]byte, 0, b.total)
	for _, c := range b.chunks {
		out = append(out, c...)
	}
	return out
}

// ptySession is a live PTY whose lifetime is decoupled from any single
// WebSocket connection, so a client that reattaches (e.g. after navigating
// away and back) resumes the same shell/agent process instead of a fresh
// one losing scrollback and stdin routing.
type ptySession struct {
	id   string
	ptmx crosspty.Pty
	cmd  *crosspty.Cmd
	buf  *ringBuffer

	mu        sync.Mutex
	conn      *websocket.Conn
	cols      int
	rows      int
	killTimer *time.Timer
	closeOnce sync.Once
}

func (sess *ptySession) write(p []byte) {
	_, _ = sess.ptmx.Write(p)
}

func (sess *ptySession) close() {
	sess.closeOnce.Do(func() {
		_ = sess.ptmx.Close()
	})
}

func (sess *ptySession) resize(cols, rows int) {
	sess.mu.Lock()
	sess.cols, sess.rows = cols, rows
	sess.mu.Unlock()
	_ = sess.ptmx.Resize(cols, rows)
}

// attachConn binds conn as the session's active socket, cancels any pending
// grace-period kill, and returns buffered output for the caller to replay.
func (sess *ptySession) attachConn(conn *websocket.Conn, cols, rows int) []byte {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.killTimer != nil {
		sess.killTimer.Stop()
		sess.killTimer = nil
	}
	sess.conn = conn
	if cols != sess.cols || rows != sess.rows {
		sess.cols, sess.rows = cols, rows
		_ = sess.ptmx.Resize(cols, rows)
	}
	return sess.buf.contents()
}

// registry holds live PTY sessions keyed by session id, so they can survive
// individual WebSocket disconnects.
type registry struct {
	mu       sync.Mutex
	sessions map[string]*ptySession
}

func newRegistry() *registry {
	return &registry{sessions: make(map[string]*ptySession)}
}

func (r *registry) get(id string) *ptySession {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sessions[id]
}

// spawn starts a new PTY session for cmd (not yet started) and registers it.
func (r *registry) spawn(id string, source *exec.Cmd, cols, rows int) (*ptySession, error) {
	ptmx, err := crosspty.New()
	if err != nil {
		return nil, err
	}
	if err := ptmx.Resize(cols, rows); err != nil {
		_ = ptmx.Close()
		return nil, err
	}

	args := source.Args
	if len(args) > 0 {
		args = args[1:]
	}
	cmd := ptmx.Command(source.Path, args...)
	cmd.Dir = source.Dir
	cmd.Env = source.Env
	cmd.SysProcAttr = source.SysProcAttr
	if err := cmd.Start(); err != nil {
		_ = ptmx.Close()
		return nil, err
	}

	// The parent must not keep the Unix slave end open or the master never
	// receives EOF after the child exits. ConPTY exposes separate pipe ends.
	if unixPTY, ok := ptmx.(crosspty.UnixPty); ok {
		_ = unixPTY.Slave().Close()
	}

	sess := &ptySession{
		id:   id,
		ptmx: ptmx,
		cmd:  cmd,
		buf:  newRingBuffer(ringBufferMaxBytes),
		cols: cols,
		rows: rows,
	}

	r.mu.Lock()
	r.sessions[id] = sess
	r.mu.Unlock()

	go r.pump(sess)
	// Reap the child once it exits (naturally or via kill), otherwise it
	// stays a zombie. Closing the PTY also unblocks the output pump.
	go func() {
		_ = cmd.Wait()
		sess.close()
		r.discard(sess)
	}()
	return sess, nil
}

// pump continuously reads PTY output into the session's ring buffer and
// forwards it to whichever connection is currently attached, if any. It runs
// for the life of the session — independent of any single WS connection —
// so output keeps accumulating (and an agent's stdin stays live) across
// disconnect/reattach cycles.
func (r *registry) pump(sess *ptySession) {
	buf := make([]byte, 4096)
	for {
		n, err := sess.ptmx.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			sess.buf.append(chunk)
			sess.mu.Lock()
			conn := sess.conn
			sess.mu.Unlock()
			if conn != nil {
				_ = conn.Write(context.Background(), websocket.MessageBinary, chunk)
			}
		}
		if err != nil {
			r.discard(sess)
			return
		}
	}
}

// detach clears the attached socket (if it's still the one that's closing —
// a newer connection may have already replaced it) and schedules the
// session to be killed after a grace period with nobody attached.
func (r *registry) detach(id string, conn *websocket.Conn) {
	sess := r.get(id)
	if sess == nil {
		return
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.conn != conn {
		return
	}
	sess.conn = nil
	sess.killTimer = time.AfterFunc(sessionGraceTTL, func() {
		r.kill(id)
	})
}

// discard removes this exact session after its process or PTY exits. Comparing
// pointers prevents a late goroutine from deleting a newer session with the
// same id.
func (r *registry) discard(sess *ptySession) {
	r.mu.Lock()
	current, ok := r.sessions[sess.id]
	if ok && current == sess {
		delete(r.sessions, sess.id)
	} else {
		ok = false
	}
	r.mu.Unlock()
	if !ok {
		return
	}
	sess.mu.Lock()
	if sess.killTimer != nil {
		sess.killTimer.Stop()
	}
	sess.mu.Unlock()
}

// kill terminates a session's process group and removes it from the
// registry. Safe to call on an unknown or already-gone id (no-op).
func (r *registry) kill(id string) {
	r.mu.Lock()
	sess, ok := r.sessions[id]
	if ok {
		delete(r.sessions, id)
	}
	r.mu.Unlock()
	if !ok {
		return
	}

	sess.mu.Lock()
	if sess.killTimer != nil {
		sess.killTimer.Stop()
	}
	conn := sess.conn
	sess.mu.Unlock()

	if conn != nil {
		_ = conn.Write(context.Background(), websocket.MessageText,
			[]byte("\r\n\x1b[38;5;102m■ [process terminated]\x1b[0m\r\n"))
	}

	// Closing a ConPTY tears down the attached console. Unix additionally
	// signals the process group; Windows kills the attached process directly.
	sess.close()
	terminateProcess(sess.cmd)
}

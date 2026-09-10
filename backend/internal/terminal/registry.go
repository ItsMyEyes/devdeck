package terminal

import (
	"context"
	"log"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	crosspty "github.com/aymanbagabas/go-pty"
	"nhooyr.io/websocket"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/procgroup"
)

const (
	// ringBufferMaxBytes caps how much recent PTY output is kept in memory
	// per session, so a reattaching client can replay history it missed.
	// Was 64 KiB; bumped to 1 MiB — a session left idle for a while (agent
	// producing verbose output, user away from the tab) could blow past 64
	// KiB in seconds and silently evict history the client had never seen,
	// which read as "messages disappearing" on reattach.
	ringBufferMaxBytes = 1024 * 1024
	// ptyReadBufBytes is the PTY read chunk size. Interactive TUIs can emit
	// bursts far larger than 4 KB; a bigger buffer means fewer reads and
	// fewer downstream frames.
	ptyReadBufBytes = 64 * 1024
	// flushInterval bounds how long PTY output may sit in the coalescing
	// buffer before it must be flushed as one WebSocket frame. Well below
	// human perception, but long enough to fold a TUI redraw's hundreds of
	// tiny writes into a handful of frames — per-frame overhead is what
	// kills throughput on high-latency links (production behind a tunnel).
	flushInterval = 8 * time.Millisecond
	// flushMaxBytes flushes early once a batch grows this large, keeping
	// individual frames bounded.
	flushMaxBytes = 64 * 1024
	// connWriteTimeout caps a single WebSocket write. A connection that
	// can't accept a frame within this window is dead or hopelessly backed
	// up; it gets closed so the client reconnects and replays history.
	connWriteTimeout = 15 * time.Second
	// killNoticeWriteTimeout bounds the best-effort "[process terminated]"
	// banner kill() writes before tearing down the PTY. It is deliberately
	// much shorter than connWriteTimeout: this isn't stream data a client
	// needs delivered intact, it's a courtesy notice, and it sits on a
	// synchronous teardown path that killByWorktree walks once per pane —
	// an unbounded (or 15s-bounded) write here against one dead/stalled peer
	// would stall worktree deletion for every remaining pane behind it.
	killNoticeWriteTimeout = 2 * time.Second
	// replayChunkBytes caps how much goes into any one WebSocket message, so
	// connWriteTimeout always covers a bounded payload. Writing a whole
	// reattach replay at once put the entire ring buffer — up to
	// ringBufferMaxBytes — under a single deadline, which made the throughput
	// a client needed just to stay attached a function of how much history
	// happened to be buffered (~68 KB/s for a full 1 MiB buffer). Below that
	// the write timed out, the pump closed the connection, and the client
	// reconnected into the byte-for-byte identical replay: a livelock that
	// saturated the link and never recovered. Per-chunk deadlines drop the
	// floor to ~2 KB/s and make partial delivery count as progress, because a
	// client that accepted one chunk has demonstrated it can take the next.
	replayChunkBytes          = 32 * 1024
	terminalExitedFrame       = `{"t":"x"}`
	terminalExitedCloseReason = "terminal exited"
)

// writeChunked sends p as a sequence of WebSocket messages no larger than
// replayChunkBytes, each under its own connWriteTimeout, stopping at the first
// failure. Terminal output is a byte stream, so splitting it across messages is
// transparent to the client; what it buys is that a slow link is judged on
// whether it can carry one chunk rather than the whole backlog at once. Small
// payloads — the interactive path, where pending is well under the cap — take
// exactly one write, unchanged.
func writeChunked(conn *websocket.Conn, p []byte) error {
	for len(p) > 0 {
		n := min(len(p), replayChunkBytes)
		ctx, cancel := context.WithTimeout(context.Background(), connWriteTimeout)
		err := conn.Write(ctx, websocket.MessageBinary, p[:n])
		cancel()
		if err != nil {
			return err
		}
		p = p[n:]
	}
	return nil
}

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

// size reports the buffer's current byte occupancy under its own lock,
// rather than making callers reach into the unexported total field directly.
func (b *ringBuffer) size() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.total
}

// ptySession is a live PTY whose lifetime is decoupled from any single
// WebSocket connection, so a client that reattaches (e.g. after navigating
// away and back) resumes the same shell/agent process instead of a fresh
// one losing scrollback and stdin routing.
type ptySession struct {
	id   string
	ptmx crosspty.Pty
	cmd  *crosspty.Cmd
	// job groups cmd's process with every process it goes on to spawn, so
	// kill() can tear down the whole tree instead of leaking a shell
	// wrapper's real child. See procgroup's package doc.
	job procgroup.Handle
	buf *ringBuffer
	// flushCh nudges the pump's coalescing writer to flush immediately,
	// e.g. so a freshly attached connection gets its replay without waiting
	// out the flush interval.
	flushCh chan struct{}
	// startedAt is when spawn started this session's process. Set once in
	// spawn before the session is published to the registry, so — unlike
	// lastOutput — it's immutable for the life of the session and safe to
	// read without sess.mu.
	startedAt time.Time

	mu        sync.Mutex
	conn      *websocket.Conn
	cols      int
	rows      int
	killTimer *time.Timer
	closeOnce sync.Once
	// replay is banner + buffered history queued by attachConn for the
	// pump's writer to send before any live output, so a reattaching client
	// sees history and new output in order on a single writer.
	replay []byte
	// lastOutput is when the session last flushed newly-read PTY output into
	// the ring buffer. Zero means the session has never produced output —
	// distinct from "produced output at the zero time" (see
	// domain.TerminalSession.LastOutputAt). Stamped only for real output, not
	// for a reattach's replay of already-buffered history.
	lastOutput time.Time
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
// grace-period kill, and queues banner + buffered output for the pump's
// coalescing writer to deliver. Routing the replay through that single
// writer (instead of writing here) means history and live output can never
// be sent out of order or duplicated.
func (sess *ptySession) attachConn(conn *websocket.Conn, cols, rows int, banner []byte) {
	sess.mu.Lock()
	if sess.killTimer != nil {
		sess.killTimer.Stop()
		sess.killTimer = nil
	}
	sess.conn = conn
	if cols != sess.cols || rows != sess.rows {
		sess.cols, sess.rows = cols, rows
		_ = sess.ptmx.Resize(cols, rows)
	}
	sess.replay = append(append([]byte(nil), banner...), sess.buf.contents()...)
	sess.mu.Unlock()
	sess.nudgeFlush()
}

// nudgeFlush asks the pump's writer to flush now; drops the signal if one is
// already pending.
func (sess *ptySession) nudgeFlush() {
	select {
	case sess.flushCh <- struct{}{}:
	default:
	}
}

func (sess *ptySession) notifyExit() {
	sess.mu.Lock()
	conn := sess.conn
	sess.mu.Unlock()
	if conn == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), connWriteTimeout)
	_ = conn.Write(ctx, websocket.MessageText, []byte(terminalExitedFrame))
	cancel()
	_ = conn.Close(websocket.StatusNormalClosure, terminalExitedCloseReason)
}

// registry holds live PTY sessions keyed by session id, so they can survive
// individual WebSocket disconnects.
type registry struct {
	mu       sync.Mutex
	sessions map[string]*ptySession
	// graceTTL is how long a session's PTY stays alive with nobody attached
	// before it's reaped. Zero (the default) disables reaping entirely: a
	// session lives until its child process exits on its own or it's killed
	// explicitly (worktree deletion, spawned-pane tab close). This keeps a
	// long-running background agent — the whole point of decoupling the PTY
	// from any single WebSocket (see attachPTY) — from being SIGTERM'd mid-task
	// just because the operator closed the tab and stepped away. Kept as a
	// field rather than a constant so the reaper path stays exercisable in
	// tests and could be re-enabled behind a flag without new plumbing.
	graceTTL time.Duration
}

func newRegistry() *registry {
	return &registry{sessions: make(map[string]*ptySession)}
}

func (r *registry) get(id string) *ptySession {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sessions[id]
}

// count reports how many sessions are currently registered.
func (r *registry) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sessions)
}

// snapshot returns every live session's current observable state, sorted by
// ID for a stable UI order.
//
// Lock order: r.mu is held only long enough to copy the session pointers
// into a local slice, then released — so a slow reader here can never block
// spawn/kill/detach on the registry lock. Each session's own fields are then
// read under that session's own sess.mu (never while r.mu is also held).
// sess.buf.size() is called from inside that same sess.mu critical section;
// that nests sess.mu -> buf.mu, which is the same order flush() and
// attachConn() already use elsewhere in this file (sess.buf.append/contents
// while holding sess.mu), so it introduces no new lock-ordering edge and
// cannot deadlock against them.
func (r *registry) snapshot() []domain.TerminalSession {
	r.mu.Lock()
	sessions := make([]*ptySession, 0, len(r.sessions))
	for _, sess := range r.sessions {
		sessions = append(sessions, sess)
	}
	r.mu.Unlock()

	out := make([]domain.TerminalSession, 0, len(sessions))
	for _, sess := range sessions {
		out = append(out, sess.toDomain())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// toDomain reads this session's own fields under sess.mu and builds the
// external observability snapshot. See registry.snapshot for the lock-order
// rationale (sess.mu, with buf.size() nested inside it).
func (sess *ptySession) toDomain() domain.TerminalSession {
	sess.mu.Lock()
	defer sess.mu.Unlock()

	var pid int
	var command string
	if sess.cmd != nil {
		command = sess.cmd.Path
		if sess.cmd.Process != nil {
			pid = sess.cmd.Process.Pid
		}
	}

	var worktreeID string
	if strings.HasPrefix(sess.id, "w-") {
		worktreeID = sess.id
		if idx := strings.Index(sess.id, "::"); idx != -1 {
			worktreeID = sess.id[:idx]
		}
	}

	var lastOutputAt *time.Time
	if !sess.lastOutput.IsZero() {
		t := sess.lastOutput
		lastOutputAt = &t
	}

	var bufferBytes int
	if sess.buf != nil {
		bufferBytes = sess.buf.size()
	}

	return domain.TerminalSession{
		ID:           sess.id,
		PID:          pid,
		Command:      command,
		WorktreeID:   worktreeID,
		Primary:      !strings.Contains(sess.id, "::"),
		Attached:     sess.conn != nil,
		StartedAt:    sess.startedAt,
		LastOutputAt: lastOutputAt,
		BufferBytes:  bufferBytes,
	}
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

	// Best-effort: groups cmd's process tree so a later kill() (or this
	// backend itself dying) cannot leave an orphan behind. A no-op on Unix,
	// where the process-group signalling below already covers this; see
	// procgroup's package doc for why Windows needs it.
	job, jobErr := procgroup.Attach(cmd.Process)
	if jobErr != nil {
		log.Printf("terminal: session %s: process group: %v", id, jobErr)
	}

	// The parent must not keep the Unix slave end open or the master never
	// receives EOF after the child exits. ConPTY exposes separate pipe ends.
	if unixPTY, ok := ptmx.(crosspty.UnixPty); ok {
		_ = unixPTY.Slave().Close()
	}

	sess := &ptySession{
		id:        id,
		ptmx:      ptmx,
		cmd:       cmd,
		job:       job,
		buf:       newRingBuffer(ringBufferMaxBytes),
		flushCh:   make(chan struct{}, 1),
		cols:      cols,
		rows:      rows,
		startedAt: time.Now(),
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
		// Release the job handle so it doesn't leak (no-op on Unix, and safe
		// even if kill() already called Terminate on this same session).
		// cmd has exited, so the job is normally empty by now — but closing
		// its last handle also kills any descendant that outlived it, which
		// is exactly the orphan this package exists to prevent.
		sess.job.Release()
		r.discard(sess)
	}()
	return sess, nil
}

// pump continuously reads PTY output into the session's ring buffer and
// forwards it to whichever connection is currently attached, if any. It runs
// for the life of the session — independent of any single WS connection —
// so output keeps accumulating (and an agent's stdin stays live) across
// disconnect/reattach cycles.
// A dedicated reader goroutine drains the PTY while pump itself coalesces
// chunks for up to flushInterval (or flushMaxBytes) before sending a single
// WebSocket frame — sending each PTY read as its own frame swamps
// high-latency links with per-frame overhead. Bytes enter the ring buffer
// only when flushed, so attachConn's replay snapshot and the writer's live
// stream partition the output exactly: every byte is delivered once, in
// order, to whichever connection is (or next becomes) attached.
func (r *registry) pump(sess *ptySession) {
	chunks := make(chan []byte, 64)
	go func() {
		defer close(chunks)
		buf := make([]byte, ptyReadBufBytes)
		for {
			n, err := sess.ptmx.Read(buf)
			if n > 0 {
				chunks <- append([]byte(nil), buf[:n]...)
			}
			if err != nil {
				return
			}
		}
	}()

	var pending []byte
	timer := time.NewTimer(flushInterval)
	timer.Stop()

	flush := func() {
		sess.mu.Lock()
		conn := sess.conn
		replay := sess.replay
		sess.replay = nil
		if len(pending) > 0 {
			sess.buf.append(pending)
			// Real output only — a reattach's replay of history already in
			// the buffer must not look like fresh activity.
			sess.lastOutput = time.Now()
		}
		sess.mu.Unlock()

		if conn != nil && (len(replay) > 0 || len(pending) > 0) {
			// Each payload gets its own per-chunk deadline budget: a large
			// replay must not consume the window the live output needs, and
			// neither may be written as one unbounded frame.
			err := error(nil)
			if len(replay) > 0 {
				err = writeChunked(conn, replay)
			}
			if err == nil && len(pending) > 0 {
				err = writeChunked(conn, pending)
			}
			if err != nil {
				// Dead or hopelessly backed-up connection: close it so the
				// client reconnects and replays from the ring buffer instead
				// of stalling the pump.
				log.Printf("terminal: session %s output write failed, closing conn: %v", sess.id, err)
				_ = conn.CloseNow()
			}
		}
		pending = pending[:0]
	}

	for {
		select {
		case chunk, ok := <-chunks:
			if !ok {
				flush()
				sess.notifyExit()
				r.discard(sess)
				return
			}
			if len(pending) == 0 {
				timer.Reset(flushInterval)
			}
			pending = append(pending, chunk...)
			if len(pending) >= flushMaxBytes {
				timer.Stop()
				flush()
			}
		case <-timer.C:
			flush()
		case <-sess.flushCh:
			timer.Stop()
			flush()
		}
	}
}

// detach clears the attached socket (if it's still the one that's closing —
// a newer connection may have already replaced it) and, when reaping is
// enabled (graceTTL > 0), schedules the session to be killed after that grace
// period with nobody attached. With reaping disabled (the default) the session
// is left running so a background agent survives the disconnect; it's reclaimed
// only when its process exits (the cmd.Wait goroutine in spawn) or it's killed
// explicitly. Returns false if the session was already gone (e.g. killed
// directly, as WorktreeService.Delete does) so the caller doesn't log that it's
// still running in the background when it isn't.
func (r *registry) detach(id string, conn *websocket.Conn) bool {
	sess := r.get(id)
	if sess == nil {
		return false
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.conn != conn {
		return false
	}
	sess.conn = nil
	if r.graceTTL > 0 {
		sess.killTimer = time.AfterFunc(r.graceTTL, func() {
			r.kill(id)
		})
	}
	return true
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
		// Bounded write, not context.Background(): a dead or stalled peer
		// (mobile network drop, tunnel stall) must not block this notice
		// forever. sess.close()/terminateProcess below run unconditionally
		// after this — regardless of whether the write succeeds, times out,
		// or the peer is simply gone — because the session was already
		// deleted from r.sessions above; if teardown didn't happen here, the
		// PTY and its child process would leak with nothing left able to
		// reach them again.
		ctx, cancel := context.WithTimeout(context.Background(), killNoticeWriteTimeout)
		_ = conn.Write(ctx, websocket.MessageText,
			[]byte("\r\n\x1b[38;5;102m■ [process terminated]\x1b[0m\r\n"))
		cancel()
	}

	// Closing a ConPTY tears down the attached console. Unix additionally
	// signals the process group; Windows tears down the whole job (see
	// sess.job's doc) so a shell-wrapped CLI's real child cannot survive as
	// an orphan. terminateProcess still runs after, and on Unix it does the
	// real work exactly as before — but note it is not a Windows fallback:
	// go-pty adopts the child via os.FindProcess, whose handle carries no
	// PROCESS_TERMINATE, so Process.Kill() there fails in DuplicateHandle
	// with access denied. On Windows the job is the only thing that actually
	// kills a PTY session, which is why attaching it is worth doing even
	// though the call below looks like it already covers this.
	sess.close()
	sess.job.Terminate()
	terminateProcess(sess.cmd)
}

// killByWorktree kills every session belonging to worktreeID: the primary
// session (id == worktreeID) plus any extra terminal-pane sessions using the
// "<worktreeID>::term-N" suffix scheme. Sessions to kill are snapshotted
// under the lock, then killed individually — kill() takes the lock itself.
func (r *registry) killByWorktree(worktreeID string) {
	r.mu.Lock()
	prefix := worktreeID + "::"
	var ids []string
	for id := range r.sessions {
		if id == worktreeID || strings.HasPrefix(id, prefix) {
			ids = append(ids, id)
		}
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.kill(id)
	}
}

// killAll kills every currently registered session and returns how many were
// killed. Ids are snapshotted under r.mu, then killed CONCURRENTLY — not in
// the sequential style of killByWorktree — because terminateProcess waits up
// to 2s per session for SIGTERM before escalating to SIGKILL: killing, say,
// 20 sessions one at a time on a shutdown path would take up to 40s. Each
// kill() call takes r.mu itself again internally, so releasing r.mu before
// fanning out is required, not just an optimization.
func (r *registry) killAll() int {
	r.mu.Lock()
	ids := make([]string, 0, len(r.sessions))
	for id := range r.sessions {
		ids = append(ids, id)
	}
	r.mu.Unlock()

	var wg sync.WaitGroup
	wg.Add(len(ids))
	for _, id := range ids {
		go func(id string) {
			defer wg.Done()
			r.kill(id)
		}(id)
	}
	wg.Wait()
	return len(ids)
}

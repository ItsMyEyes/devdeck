package claude

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/detect"
)

// eventBufferSize bounds the adapter's single instance-wide events channel.
// emit never blocks the readLoop that feeds it: a slow consumer drops
// events rather than stalling stdout reads, because a stalled stdout read
// eventually blocks the agent process itself (its stdout pipe fills up).
const eventBufferSize = 256

// session is the live state for one thread's claude process. One session
// exists per thread; the adapter itself is instance-wide and can host many
// concurrent sessions.
type session struct {
	threadID  string
	cmd       *exec.Cmd
	stdinEnc  *json.Encoder
	state     *parseState
	cancel    context.CancelFunc
	startedAt int64
	model     string
	// stderr holds what the process wrote to stderr, so a fatal startup error
	// can be reported instead of surfacing only as "no active session" later.
	stderr *boundedBuffer
}

// stderrCaptureBytes bounds per-session stderr retention. Only the head is
// kept: a fatal argument or auth error is printed first, and a chatty process
// should not be able to grow this for the life of a long session.
const stderrCaptureBytes = 8 << 10

// boundedBuffer is an io.Writer that keeps at most the first `limit` bytes and
// silently discards the rest. Safe for concurrent use because exec writes to
// cmd.Stderr from its own goroutine while readLoop may read String() at exit.
type boundedBuffer struct {
	limit int
	mu    sync.Mutex
	buf   bytes.Buffer
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if room := b.limit - b.buf.Len(); room > 0 {
		if len(p) > room {
			p = p[:room]
		}
		b.buf.Write(p)
	}
	// Always report a full write: reporting short would make exec treat a
	// deliberate truncation as an I/O error and tear the process down.
	return len(p), nil
}

func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// adapter is the claude provider.Adapter. It is created once per configured
// instance (e.g. "claude:default") and lives for that instance's lifetime.
type adapter struct {
	instanceID provider.InstanceID
	cfg        Config
	env        map[string]string
	ctx        context.Context

	events chan event.Event
	// readers counts live readLoop goroutines. The events channel must not be
	// closed while any of them can still call emit — that is a send on a
	// closed channel, i.e. a panic in production and a data race under -race.
	readers sync.WaitGroup

	mu       sync.Mutex
	sessions map[string]*session
}

// newAdapter constructs a claude adapter bound to ctx: when ctx is
// cancelled, every session this adapter spawned is killed and the events
// channel is closed, which is the shutdown signal every consumer of
// Events() must honor.
func newAdapter(ctx context.Context, id provider.InstanceID, cfg Config, env map[string]string) *adapter {
	a := &adapter{
		instanceID: id,
		cfg:        cfg,
		env:        env,
		ctx:        ctx,
		events:     make(chan event.Event, eventBufferSize),
		sessions:   make(map[string]*session),
	}
	go func() {
		<-ctx.Done()
		// Kill the processes first, so every readLoop sees EOF and returns,
		// THEN wait for them, and only then close. Closing before the readers
		// have finished raced with emit and could panic outright; StopAll
		// alone is not enough, because a readLoop may still be draining
		// stdout that was already buffered when the process died.
		_ = a.StopAll(context.Background())
		a.readers.Wait()
		close(a.events)
	}()
	return a
}

func (a *adapter) Kind() provider.Kind             { return Kind }
func (a *adapter) InstanceID() provider.InstanceID { return a.instanceID }
func (a *adapter) Events() <-chan event.Event      { return a.events }

func (a *adapter) Capabilities() provider.Capabilities {
	return provider.Capabilities{
		SessionModelSwitch: provider.ModelSwitchInSession,
		SupportsPlanMode:   true,
		SupportsResume:     true,
		SupportsMCP:        true,
	}
}

// buildArgs is the ONLY place RuntimeMode and InteractionMode are translated
// into claude CLI flags — see gg/HANDOFF.md section 6, "RuntimeMode vs
// InteractionMode". Every other function in this package stays mode-
// agnostic. The full RuntimeMode x InteractionMode permission matrix (and
// the approval broker that backs approval-required mode) lands in spec 2;
// spec 1 only needs the CLI's own --permission-mode flag wired through.
func buildArgs(cfg Config, in provider.SessionStartInput) []string {
	args := []string{
		"--print",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		// Required, not optional. Without it the CLI refuses to start —
		// "When using --print, --output-format=stream-json requires
		// --verbose" — and exits immediately, so every session died the
		// instant it spawned. The only symptom that reached the user was a
		// later "thread has no active session" from SendTurn, because the
		// process's stderr was going nowhere (see startProcess).
		"--verbose",
		"--include-partial-messages",
	}

	switch {
	case in.Interact == provider.InteractionPlan:
		// Plan mode is itself one of the CLI's --permission-mode values, so
		// it takes precedence over the RuntimeMode mapping below rather than
		// stacking a second --permission-mode flag.
		args = append(args, "--permission-mode", "plan")
	case in.Mode == provider.ModeAutoAcceptEdits:
		args = append(args, "--permission-mode", "acceptEdits")
	case in.Mode == provider.ModeFullAccess:
		args = append(args, "--permission-mode", "bypassPermissions")
	case in.Mode == provider.ModeAuto:
		args = append(args, "--permission-mode", "auto")
	default:
		// approval-required: leave the CLI's default in place, every tool
		// call asks for approval. The broker that answers those requests is
		// spec 2 (backend/internal/agentcore/approval); until then the
		// adapter still asks, it just has nothing to say yes with.
	}

	if in.Model.Model != "" {
		args = append(args, "--model", in.Model.Model)
	}

	if len(in.ResumeCursor) > 0 {
		var sid string
		if json.Unmarshal(in.ResumeCursor, &sid) == nil && sid != "" {
			args = append(args, "--resume", sid)
		}
	}

	if in.MCPEndpoint != nil {
		mcpCfg, _ := json.Marshal(map[string]any{
			"mcpServers": map[string]any{
				in.MCPEndpoint.Name: map[string]any{
					"type": "http",
					"url":  in.MCPEndpoint.URL,
					"headers": map[string]string{
						"Authorization": "Bearer " + in.MCPEndpoint.Token,
					},
				},
			},
		})
		args = append(args, "--mcp-config", string(mcpCfg))
	}

	args = append(args, cfg.ExtraArgs...)
	return args
}

// buildEnv starts from the parent process's own environment (the spawned
// CLI still needs PATH, and whatever else its own subprocesses rely on),
// layers the instance's configured overrides on top, then applies HomeDir
// last so it always wins. HomeDir isolation is what stops two instances
// (e.g. two accounts) from clobbering each other's ~/.claude credentials.
func buildEnv(overrides map[string]string, cfg Config) []string {
	merged := make(map[string]string, len(overrides)+1)
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			merged[k] = v
		}
	}
	for k, v := range overrides {
		merged[k] = v
	}
	if cfg.HomeDir != "" {
		merged["HOME"] = cfg.HomeDir
	}
	out := make([]string, 0, len(merged))
	for k, v := range merged {
		out = append(out, k+"="+v)
	}
	return out
}

// StartSession spawns one claude CLI process per thread, in in.Cwd, and
// starts the goroutine that turns its stdout into canonical events. The
// process is bound to the adapter's own ctx (not the caller's context.Context
// parameter) so it keeps running after this call returns and only dies when
// the whole instance is stopped or the session is stopped individually —
// mirroring how a worktree's terminal PTY survives the tab that opened it.
func (a *adapter) StartSession(ctx context.Context, in provider.SessionStartInput) (provider.Session, error) {
	bin, err := detect.ResolveBinary(a.cfg.BinaryName)
	if err != nil {
		return provider.Session{}, fmt.Errorf("claude: %w", err)
	}

	sctx, cancel := context.WithCancel(a.ctx)

	cmd := exec.CommandContext(sctx, bin, buildArgs(a.cfg, in)...)
	cmd.Dir = in.Cwd
	cmd.Env = buildEnv(a.env, a.cfg)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return provider.Session{}, fmt.Errorf("claude: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return provider.Session{}, fmt.Errorf("claude: stdout pipe: %w", err)
	}
	// Capture stderr. The CLI reports fatal argument errors there and then
	// exits, so discarding it turns "wrong flags" into a silent instant death
	// whose only visible symptom is a later "thread has no active session".
	// Bounded because this is held for the process's whole life.
	stderr := &boundedBuffer{limit: stderrCaptureBytes}
	cmd.Stderr = stderr

	if err := cmd.Start(); err != nil {
		cancel()
		return provider.Session{}, fmt.Errorf("claude: spawn: %w", err)
	}

	sess := &session{
		threadID:  in.ThreadID,
		cmd:       cmd,
		stderr:    stderr,
		stdinEnc:  json.NewEncoder(stdin),
		state:     newParseState(in.ThreadID, a.instanceID),
		cancel:    cancel,
		startedAt: time.Now().UnixMilli(),
		model:     in.Model.Model,
	}

	a.mu.Lock()
	a.sessions[in.ThreadID] = sess
	a.mu.Unlock()

	a.readers.Add(1)
	go a.readLoop(sess, stdout)

	return provider.Session{ThreadID: in.ThreadID, StartedAt: sess.startedAt, Model: sess.model}, nil
}

// readLoop is the adapter's heart: native NDJSON -> canonical events. All
// knowledge of the wire shape stops in parseLine (parse.go); this function
// owns only process lifecycle around it. It never blocks on a slow consumer
// (emit drops instead) so a stalled subscriber cannot stall the CLI's own
// stdout pipe.
func (a *adapter) readLoop(sess *session, stdout io.Reader) {
	defer a.readers.Done()
	sc := bufio.NewScanner(stdout)
	// A tool result can embed an entire file's contents; the scanner's
	// default 64KB buffer is nowhere near enough for that.
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)

	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		for _, ev := range parseLine(append([]byte(nil), line...), sess.state) {
			a.emit(ev)
		}
	}
	if err := sc.Err(); err != nil {
		log.Printf("claude: instance %s thread %s: stdout scan: %v", a.instanceID, sess.threadID, err)
	}

	waitErr := sess.cmd.Wait()
	exitCode := -1
	if sess.cmd.ProcessState != nil {
		exitCode = sess.cmd.ProcessState.ExitCode()
	}
	detail := ""
	if waitErr != nil {
		detail = waitErr.Error()
	}
	// Prefer what the process actually said over Go's generic "exit status 1".
	if msg := strings.TrimSpace(sess.stderr.String()); msg != "" {
		if detail == "" {
			detail = msg
		} else {
			detail = detail + ": " + msg
		}
	}

	a.emit(event.Event{
		Type:       event.SessionExited,
		Provider:   string(Kind),
		InstanceID: string(a.instanceID),
		ThreadID:   sess.threadID,
		CreatedAt:  time.Now().UTC(),
		Payload: &event.SessionExitedPayload{
			Reason:   "process exited",
			ExitCode: &exitCode,
			Detail:   detail,
		},
	})

	a.mu.Lock()
	delete(a.sessions, sess.threadID)
	a.mu.Unlock()
}

// SendTurn writes one user turn to the session's stdin. setTurnID is called
// before the write reaches the process: every event readLoop parses from
// this point on is stamped with in.TurnID until the next SendTurn call.
func (a *adapter) SendTurn(ctx context.Context, in provider.SendTurnInput) (provider.TurnStartResult, error) {
	a.mu.Lock()
	sess, ok := a.sessions[in.ThreadID]
	a.mu.Unlock()
	if !ok {
		return provider.TurnStartResult{}, fmt.Errorf("claude: thread %s has no active session", in.ThreadID)
	}

	sess.state.setTurnID(in.TurnID)

	a.emit(event.Event{
		Type:       event.TurnStarted,
		Provider:   string(Kind),
		InstanceID: string(a.instanceID),
		ThreadID:   in.ThreadID,
		TurnID:     in.TurnID,
		CreatedAt:  time.Now().UTC(),
		Payload:    &event.TurnStartedPayload{Model: in.Model.Model},
	})

	msg := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": []map[string]any{{"type": "text", "text": in.Text}},
		},
	}
	if err := sess.stdinEnc.Encode(msg); err != nil {
		return provider.TurnStartResult{}, fmt.Errorf("claude: write turn: %w", err)
	}

	return provider.TurnStartResult{TurnID: in.TurnID}, nil
}

// InterruptTurn asks the running process to stop the current turn via the
// stream-json control channel. It is a best-effort request, not a kill —
// StopSession is the hard stop.
func (a *adapter) InterruptTurn(ctx context.Context, threadID, turnID string) error {
	a.mu.Lock()
	sess, ok := a.sessions[threadID]
	a.mu.Unlock()
	if !ok {
		return nil
	}
	return sess.stdinEnc.Encode(map[string]any{
		"type":    "control_request",
		"request": map[string]any{"subtype": "interrupt"},
	})
}

// RespondToRequest is a no-op in spec 1: no adapter opens a request yet (see
// approval.NoopBroker), but the Reactor (Task 9) calls this path
// unconditionally for every provider by design, so it must return nil
// rather than an error. The real implementation — sending a control_response
// back over stdin — lands in spec 2.
func (a *adapter) RespondToRequest(ctx context.Context, threadID, requestID string, d event.Decision) error {
	return nil
}

// RespondToUserInput is a no-op in spec 1, for the same reason as
// RespondToRequest.
func (a *adapter) RespondToUserInput(ctx context.Context, threadID, requestID string, answers map[string]any) error {
	return nil
}

func (a *adapter) StopSession(ctx context.Context, threadID string) error {
	a.mu.Lock()
	sess, ok := a.sessions[threadID]
	delete(a.sessions, threadID)
	a.mu.Unlock()
	if !ok {
		return nil
	}
	sess.cancel()
	return nil
}

func (a *adapter) StopAll(ctx context.Context) error {
	a.mu.Lock()
	ids := make([]string, 0, len(a.sessions))
	for id := range a.sessions {
		ids = append(ids, id)
	}
	a.mu.Unlock()
	for _, id := range ids {
		_ = a.StopSession(ctx, id)
	}
	return nil
}

func (a *adapter) HasSession(threadID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	_, ok := a.sessions[threadID]
	return ok
}

func (a *adapter) ListSessions() []provider.Session {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]provider.Session, 0, len(a.sessions))
	for _, sess := range a.sessions {
		out = append(out, provider.Session{ThreadID: sess.threadID, StartedAt: sess.startedAt, Model: sess.model})
	}
	return out
}

// ReadThread and RollbackThread are unimplemented in spec 1 — thread
// persistence and checkpointing are out of scope (gg/HANDOFF.md section 10).
func (a *adapter) ReadThread(ctx context.Context, threadID string) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{ThreadID: threadID}, nil
}

func (a *adapter) RollbackThread(ctx context.Context, threadID string, turns int) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, fmt.Errorf("claude: rollback not supported")
}

// emit must never block: it is called from the readLoop goroutine that is
// simultaneously the only reader of the CLI's stdout pipe. Blocking here
// would stall that read, which would eventually stall the CLI process
// itself once its own stdout buffer filled. A full events channel means a
// slow subscriber, and dropping is the deliberate trade-off — the same one
// provider.Adapter.Events' doc comment describes.
func (a *adapter) emit(ev event.Event) {
	select {
	case a.events <- ev:
	default:
		log.Printf("claude: instance %s: events channel full, dropping %s for thread %s", a.instanceID, ev.Type, ev.ThreadID)
	}
}

var _ provider.Adapter = (*adapter)(nil)

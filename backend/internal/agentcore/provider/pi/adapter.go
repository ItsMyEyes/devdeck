package pi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/detect"
)

// eventBufferSize bounds the adapter's single instance-wide events channel.
// See claude/adapter.go's identical constant for why emit must never block.
const eventBufferSize = 256

// session is the live state for one thread's pi process.
type session struct {
	threadID  string
	cmd       *exec.Cmd
	stdinEnc  *json.Encoder
	state     *parseState
	cancel    context.CancelFunc
	startedAt int64
	// model is the model string this session was last told to use — the
	// value passed at spawn via --model, updated by SendTurn's set_model
	// switch. Compared against each turn's requested model to decide
	// whether a switch is needed at all.
	model  string
	stderr *boundedBuffer
	// stopped mirrors claude/adapter.go's session.stopped: set by StopSession
	// before the kill, so readLoop reports SessionExited only for a process
	// that died on its own — never for a stop (or an in-place restart for new
	// start-time flags) that orchestration asked for and settles itself.
	stopped atomic.Bool
}

const stderrCaptureBytes = 8 << 10

// boundedBuffer is an io.Writer that keeps at most the first `limit` bytes.
// See claude/adapter.go's identical type for the concurrency contract.
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
	return len(p), nil
}

func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// adapter is the pi provider.Adapter. One per configured instance (e.g.
// "pi:default"), living for that instance's lifetime.
type adapter struct {
	instanceID provider.InstanceID
	cfg        Config
	env        map[string]string
	ctx        context.Context

	events  chan event.Event
	readers sync.WaitGroup

	mu       sync.Mutex
	sessions map[string]*session
}

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
		// Pi's RPC set_model command genuinely switches the live process's
		// model mid-session — see SendTurn's switchModelIfNeeded.
		SessionModelSwitch: provider.ModelSwitchInSession,
		// Plan mode exists only as an optional extension (`--plan`, per
		// `pi --help`'s "Extensions can register additional flags" note),
		// not a guaranteed core capability — not claimed here.
		SupportsPlanMode: false,
		// Sessions persist to disk by default (see buildArgs) and --session
		// <id> reopens one.
		SupportsResume: true,
		// No MCP wiring in this integration — Pi's Agent Management surface
		// (skills/models) doesn't expose it for pi either.
		SupportsMCP: false,
	}
}

// piThinkingLevel maps the composer's Reasoning picker vocabulary onto Pi's
// --thinking levels (confirmed via `pi --help`: off, minimal, low, medium,
// high, xhigh). "max" and "ultrathink" — Claude-specific extensions to that
// shared vocabulary — have no Pi equivalent and return "", telling the
// caller to omit the flag rather than forward a value Pi does not know.
func piThinkingLevel(effort string) string {
	switch effort {
	case "off", "minimal", "low", "medium", "high", "xhigh":
		return effort
	default:
		return ""
	}
}

// buildArgs is the only place SessionStartInput is translated into pi CLI
// flags.
func buildArgs(cfg Config, in provider.SessionStartInput) []string {
	args := []string{"--mode", "rpc"}

	if in.Model.Model != "" {
		args = append(args, "--model", in.Model.Model)
	}

	if effort, ok := in.Model.Options["effort"].(string); ok {
		if level := piThinkingLevel(effort); level != "" {
			args = append(args, "--thinking", level)
		}
	}

	// RuntimeMode/InteractionMode: deliberately NOT translated. As of pi
	// v0.78.1's own --help, the core CLI has no per-tool-call
	// permission-mode flag family the way claude has --permission-mode (and
	// no -a/--approve either, despite older pi.dev docs describing one) —
	// built-in tools run unmediated once RPC mode is up. Every RuntimeMode
	// therefore behaves like claude's full-access today; there is nothing
	// to gate it with until Pi ships a flag for it.

	if len(in.ResumeCursor) > 0 {
		var sid string
		if json.Unmarshal(in.ResumeCursor, &sid) == nil && sid != "" {
			args = append(args, "--session", sid)
		}
	}

	// in.MCPEndpoint is intentionally unused — see Capabilities.SupportsMCP.

	args = append(args, cfg.ExtraArgs...)
	return args
}

// mergedSessionEnv mirrors claude/adapter.go's identical function: it layers
// one session's own overrides (provider.SessionStartInput.Env) on top of the
// instance's, mutating neither.
func mergedSessionEnv(instance, session map[string]string) map[string]string {
	if len(session) == 0 {
		return instance
	}
	out := make(map[string]string, len(instance)+len(session))
	for k, v := range instance {
		out[k] = v
	}
	for k, v := range session {
		out[k] = v
	}
	return out
}

// buildEnv mirrors claude/adapter.go's function, with one deliberate
// divergence: it starts from detect.AugmentedEnv() rather than os.Environ().
// pi is a Node script, so a spawned `pi --mode rpc` process must find `node`
// on PATH — and a GUI-launched backend's inherited PATH does not include the
// nvm/volta node dir (the same reason Probe augments its --version exec). Using
// the bare parent env here would let Pi pass its probe yet fail every session
// spawn with `env: node: No such file or directory`. See detect.AugmentedEnv.
func buildEnv(overrides map[string]string, cfg Config) []string {
	merged := make(map[string]string, len(overrides)+1)
	for _, kv := range detect.AugmentedEnv() {
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

// StartSession spawns one pi CLI process per thread in RPC mode. It mirrors
// claude/adapter.go's StartSession closely; the one addition is the init
// get_state request, needed because pi's RPC mode announces nothing
// unprompted (see initRequestID's doc comment).
func (a *adapter) StartSession(ctx context.Context, in provider.SessionStartInput) (provider.Session, error) {
	bin, err := detect.ResolveBinary(a.cfg.BinaryName)
	if err != nil {
		return provider.Session{}, fmt.Errorf("pi: %w", err)
	}

	sctx, cancel := context.WithCancel(a.ctx)

	cmd := exec.CommandContext(sctx, bin, buildArgs(a.cfg, in)...)
	cmd.Dir = in.Cwd
	cmd.Env = buildEnv(mergedSessionEnv(a.env, in.Env), a.cfg)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return provider.Session{}, fmt.Errorf("pi: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return provider.Session{}, fmt.Errorf("pi: stdout pipe: %w", err)
	}
	stderr := &boundedBuffer{limit: stderrCaptureBytes}
	cmd.Stderr = stderr

	if err := cmd.Start(); err != nil {
		cancel()
		return provider.Session{}, fmt.Errorf("pi: spawn: %w", err)
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

	// Learn the native session id up front so Refs/resume work from the
	// first turn onward, not just after a session that happened to include
	// one already. Best-effort: if the write fails the process is already
	// dead and readLoop's own SessionExited will report that.
	_ = sess.stdinEnc.Encode(map[string]any{"id": initRequestID, "type": "get_state"})

	return provider.Session{ThreadID: in.ThreadID, StartedAt: sess.startedAt, Model: sess.model}, nil
}

func (a *adapter) readLoop(sess *session, stdout io.Reader) {
	defer a.readers.Done()
	sc := bufio.NewScanner(stdout)
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
		log.Printf("pi: instance %s thread %s: stdout scan: %v", a.instanceID, sess.threadID, err)
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
	if msg := strings.TrimSpace(sess.stderr.String()); msg != "" {
		if detail == "" {
			detail = msg
		} else {
			detail = detail + ": " + msg
		}
	}

	a.mu.Lock()
	// Only if this is still the thread's session — after a restart the map
	// already holds the replacement process.
	if a.sessions[sess.threadID] == sess {
		delete(a.sessions, sess.threadID)
	}
	a.mu.Unlock()

	// A stop DevDeck asked for is not a death — see session.stopped.
	if sess.stopped.Load() {
		return
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
}

// SendTurn writes one user turn as a `prompt` command. Mirrors
// claude/adapter.go's SendTurn: TurnStarted is emitted synchronously here,
// not parsed off the wire, so the UI has immediate feedback regardless of
// how long pi takes to acknowledge the command.
func (a *adapter) SendTurn(ctx context.Context, in provider.SendTurnInput) (provider.TurnStartResult, error) {
	a.mu.Lock()
	sess, ok := a.sessions[in.ThreadID]
	a.mu.Unlock()
	if !ok {
		return provider.TurnStartResult{}, fmt.Errorf("pi: thread %s has no active session", in.ThreadID)
	}

	// Pi has no way to carry attachments — unlike claude/adapter.go's image
	// content-block support. Fail before any side effect: no stdin write, no
	// TurnStarted emit, so the reactor never has a half-started turn to
	// settle.
	if len(in.Attachments) > 0 {
		return provider.TurnStartResult{}, fmt.Errorf("pi: this provider cannot carry attachments")
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

	a.switchModelIfNeeded(sess, in.Model.Model)

	msg := map[string]any{"type": "prompt", "message": in.Text}
	if err := sess.stdinEnc.Encode(msg); err != nil {
		return provider.TurnStartResult{}, fmt.Errorf("pi: write turn: %w", err)
	}

	return provider.TurnStartResult{TurnID: in.TurnID}, nil
}

// switchModelIfNeeded sends set_model when the turn asks for a different
// model than the session is currently running. Only attempted in explicit
// "provider/id" form: set_model's schema takes provider and modelId as
// separate fields, and a bare id can't be split into those without guessing
// which of Pi's providers it belongs to. A bare id therefore leaves the
// session on its current model rather than risk a wrong guess; the turn still
// runs, just not on the requested model. detect.ReadModels always yields the
// qualified form, so this is a guard against hand-entered ids, not the norm.
//
// Cut takes the FIRST slash on purpose — an openrouter id contains one of its
// own ("openrouter/aion-labs/aion-2.0" is provider "openrouter", modelId
// "aion-labs/aion-2.0"), which is exactly what set_model expects.
func (a *adapter) switchModelIfNeeded(sess *session, model string) {
	if model == "" || model == sess.model {
		return
	}
	providerName, modelID, ok := strings.Cut(model, "/")
	if !ok || providerName == "" || modelID == "" {
		return
	}
	if err := sess.stdinEnc.Encode(map[string]any{
		"type":     "set_model",
		"provider": providerName,
		"modelId":  modelID,
	}); err != nil {
		log.Printf("pi: instance %s thread %s: set_model write: %v", a.instanceID, sess.threadID, err)
		return
	}
	sess.model = model
}

// InterruptTurn asks the running process to abort. Best-effort, like
// claude's: it returns nil both when the abort was written AND when no
// session exists for the thread — callers must not treat that nil as proof
// the agent actually stopped (see the "agent thread must settle" note on
// Reactor.reportError/EvtThreadTurnInterruptRequested, which dispatch the
// idle status themselves rather than trust this return value).
func (a *adapter) InterruptTurn(ctx context.Context, threadID, turnID string) error {
	a.mu.Lock()
	sess, ok := a.sessions[threadID]
	a.mu.Unlock()
	if !ok {
		return nil
	}
	return sess.stdinEnc.Encode(map[string]any{"type": "abort"})
}

// RespondToRequest is a no-op: Pi's extension_ui_request dialogs are
// arbitrary select/confirm prompts with no fixed schema this package can
// safely translate a bare event.Decision into (see parseExtensionUIRequest).
// The request is still surfaced as a RequestOpened event so a blocked agent
// is visible rather than silently hanging — resolving it for real is future
// work, matching claude's identical spec-1 scope for its own control_request.
func (a *adapter) RespondToRequest(ctx context.Context, threadID, requestID string, d event.Decision) error {
	return nil
}

func (a *adapter) RespondToUserInput(ctx context.Context, threadID, requestID string, answers map[string]any) error {
	return nil
}

// SetInteractionMode is a no-op: as of pi v0.78.1's own --help, Pi has no
// per-tool-call permission-mode flag family, let alone a live-session
// control command to change one (see buildArgs' identical note on
// RuntimeMode/InteractionMode). Capabilities.SupportsPlanMode is already
// false, so this path should not normally be reached — but the interface
// must still be satisfied safely, mirroring RespondToRequest's doc-commented
// reason above for returning nil rather than an error.
func (a *adapter) SetInteractionMode(ctx context.Context, threadID string, mode provider.InteractionMode) error {
	return nil
}

// SetRuntimeMode is a no-op for the same reason buildArgs never translates
// RuntimeMode into a flag: Pi has no per-tool-call permission-mode family to
// switch, live or otherwise. Every RuntimeMode already behaves like
// full-access for Pi (see buildArgs' comment), so there is no live gate this
// call could tighten or loosen.
func (a *adapter) SetRuntimeMode(ctx context.Context, threadID string, mode provider.RuntimeMode) error {
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
	// Before cancel, so readLoop can never observe the exit first.
	sess.stopped.Store(true)
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

func (a *adapter) ReadThread(ctx context.Context, threadID string) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{ThreadID: threadID}, nil
}

func (a *adapter) RollbackThread(ctx context.Context, threadID string, turns int) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, fmt.Errorf("pi: rollback not supported")
}

func (a *adapter) emit(ev event.Event) {
	select {
	case a.events <- ev:
	default:
		log.Printf("pi: instance %s: events channel full, dropping %s for thread %s", a.instanceID, ev.Type, ev.ThreadID)
	}
}

var _ provider.Adapter = (*adapter)(nil)

package claude

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/detect"
	"devdeck/backend/internal/procgroup"
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

	// stdinMu serializes every write to the CLI's stdin. Before this task
	// SendTurn/InterruptTurn were the only writers and both ran on the
	// Reactor's single goroutine; the auto-deny drain below writes from
	// readLoop's goroutine instead, so two goroutines can now interleave on
	// one json.Encoder without it — a corrupt NDJSON line the CLI can't
	// parse, which takes the whole session down.
	stdinMu sync.Mutex

	// stopped is set by StopSession before it kills the process, so readLoop
	// can tell a stop DevDeck asked for from the process dying on its own.
	// Only the latter is reported as SessionExited: orchestration settles a
	// deliberate stop itself (Reactor's EvtThreadSessionStopRequested case),
	// and — the reason this exists — it also restarts a session in place to
	// apply new start-time flags, where the old process's exit landing a
	// moment after the new one's first turn would flip the thread to
	// "stopped" under a turn that is running fine.
	stopped atomic.Bool
}

// writeControlResponse is the one place this package writes a
// control_response. Reused unmodified by A2's RespondToRequest.
func (s *session) writeControlResponse(requestID string, response map[string]any) error {
	s.stdinMu.Lock()
	defer s.stdinMu.Unlock()
	return s.stdinEnc.Encode(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "success",
			"request_id": requestID,
			"response":   response,
		},
	})
}

// applyModel switches the running session's model when the operator's pick
// differs from what the session is actually using, and records the new value.
//
// This exists because `--model` is a session-START flag (buildArgs) and the
// session starts on thread.created — before the operator has picked anything.
// Without it every later pick was dropped: the thread silently kept running
// the model it was born with while the composer's pill claimed otherwise.
//
// `set_model` is the CLI's own control request, verified live against 2.1.233
// — with it the session's reported model changed to the requested one, without
// it it did not. Caller must NOT already hold stdinMu.
func (s *session) applyModel(model string) error {
	s.stdinMu.Lock()
	defer s.stdinMu.Unlock()
	if model == "" || model == s.model {
		return nil
	}
	if err := s.stdinEnc.Encode(map[string]any{
		"type":       "control_request",
		"request_id": newControlRequestID("set-model-"),
		"request":    map[string]any{"subtype": "set_model", "model": model},
	}); err != nil {
		return err
	}
	// Recorded only after the write succeeds, so a failed switch is retried on
	// the next turn rather than remembered as done.
	s.model = model
	return nil
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

// allowBypassPermissionsFlag is what makes provider.ModeFullAccess reachable
// on a session that did not start in it. See its use in buildArgs for the
// captured refusal it prevents.
const allowBypassPermissionsFlag = "--allow-dangerously-skip-permissions"

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
		// Required in every mode, unconditionally: AskUserQuestion is not
		// offered to the model without it (verified: system/init's tool list
		// differs by exactly AskUserQuestion/EnterPlanMode/ExitPlanMode
		// between a run with and without this flag), and the modes that
		// never prompt (auto, bypassPermissions, dontAsk) are unaffected by
		// its presence.
		// Corrected belief: without this flag, approval-required does not
		// "ask but have nothing to say yes with" — it silently denies every
		// tool call (system/permission_denied, dropped entirely pre-parser).
		// This flag is what turns that into a real ask.
		"--permission-prompt-tool", "stdio",
	}

	// Without this, a subagent is a black box: the CLI forwards its spawn and
	// its final result and NOTHING in between, so a Task/Agent call that runs
	// for ten minutes is ten minutes of a chat pane showing one motionless
	// tool row. The flag's own help text is exact about what it buys —
	// "Forward subagent text and thinking blocks as assistant/user messages
	// with parent_tool_use_id set (only works with --print and
	// --output-format=stream-json)" — and both of those conditions are
	// already true above. Probed, never assumed: see
	// supportsForwardSubagentText for why an unknown flag here would be an
	// outage rather than a missing feature.
	if supportsForwardSubagentText(cfg.BinaryName) {
		args = append(args, forwardSubagentTextFlag)
	}

	// Unconditional, in every mode — including the modes that do not want
	// bypass right now. The Permission pill is a LIVE control: whatever mode a
	// session is spawned in, the operator can switch it to Full access a minute
	// later, and the CLI decides whether that switch is even permitted from how
	// the PROCESS was launched, not from what is asked at the time. Without this
	// flag SetRuntimeMode's set_permission_mode comes back refused —
	//
	//	{"type":"control_response","response":{"subtype":"error","error":
	//	 "Cannot set permission mode to bypassPermissions because the session
	//	  was not launched with --dangerously-skip-permissions"}}
	//
	// — the process keeps enforcing the mode it started with, and the operator
	// sits in front of a pill that reads "Full access" while every single Bash
	// call still raises an approval card. That refusal was invisible on top of
	// it: nothing here read control_response until parseControlResponse.
	//
	// It is the ALLOW flag, deliberately, not --dangerously-skip-permissions:
	// this one "enable[s] bypassing all permission checks as an option, without
	// it being enabled by default" (its own --help text). Live-verified against
	// 2.1.247 — with it present and no --permission-mode, `system/init` still
	// reports permissionMode "default", so a thread in approval-required is
	// gated exactly as before and nothing is widened until the operator says so.
	// Probed for the same reason --forward-subagent-text is (see
	// supportsFlag): an older CLI exits 1 on an unknown option, which would
	// trade one broken mode for every session on that machine.
	if supportsFlag(cfg.BinaryName, allowBypassPermissionsFlag) {
		args = append(args, allowBypassPermissionsFlag)
	}

	switch {
	case in.Interact == provider.InteractionPlan:
		// Plan mode is itself one of the CLI's --permission-mode values, so
		// it takes precedence over the RuntimeMode mapping below rather than
		// stacking a second --permission-mode flag.
		args = append(args, "--permission-mode", "plan")
	case in.Mode == provider.ModeAutoAcceptEdits, in.Mode == provider.ModeFullAccess, in.Mode == provider.ModeAuto:
		args = append(args, "--permission-mode", claudePermissionMode(in.Mode))
	default:
		// approval-required: the CLI's own default, now a REAL ask (see the
		// flag's comment above). parse.go's auto-denier answers every
		// can_use_tool it does not yet route to a real decision (everything
		// except AskUserQuestion); A2 replaces that branch with a real
		// broker. AskUserQuestion itself is answered for real, below.
	}

	if in.Model.Model != "" {
		args = append(args, "--model", in.Model.Model)
	}

	// effort/contextWindow: the composer's Reasoning/Context Window picker
	// (ComposerControls.tsx). Both are real CLI flags, confirmed against
	// `claude --help`, not passed through untranslated — this file is the
	// one place that boundary crosses (see this function's own doc comment).
	// Neither is validated here: --effort degrades gracefully on a bad value
	// (a stderr warning, falls back to the default) so there is nothing to
	// guard, and --autocompact's value already went through the composer's
	// own validation before it ever reached Options (that flag, unlike
	// --effort, HARD-FAILS session startup on anything outside 100k-1M or
	// "auto" — see ContextWindowPicker.tsx's clamp).
	if effort, ok := in.Model.Options["effort"].(string); ok && effort != "" {
		args = append(args, "--effort", effort)
	}
	if window, ok := in.Model.Options["contextWindow"].(string); ok && window != "" {
		args = append(args, "--autocompact", window)
	}

	if len(in.ResumeCursor) > 0 {
		var sid string
		if json.Unmarshal(in.ResumeCursor, &sid) == nil && sid != "" {
			args = append(args, "--resume", sid)
		}
	}

	if len(in.MCPEndpoints) > 0 {
		servers := map[string]any{}
		for _, ep := range in.MCPEndpoints {
			if ep.Command != "" {
				servers[ep.Name] = map[string]any{
					"command": ep.Command,
					"args":    ep.Args,
				}
				continue
			}
			servers[ep.Name] = map[string]any{
				"type": "http",
				"url":  ep.URL,
				"headers": map[string]string{
					"Authorization": "Bearer " + ep.Token,
				},
			}
		}
		mcpCfg, _ := json.Marshal(map[string]any{"mcpServers": servers})
		args = append(args, "--mcp-config", string(mcpCfg))
	}

	args = append(args, cfg.ExtraArgs...)
	return args
}

// mergedSessionEnv layers one session's own overrides
// (provider.SessionStartInput.Env) on top of the instance's, mutating
// neither. Session wins: it is the more specific of the two, and it is how an
// SSH chat thread puts the devdeck-ssh helper on its agent's PATH.
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
	cmd.Env = buildEnv(mergedSessionEnv(a.env, in.Env), a.cfg)

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

	// Best-effort: groups the CLI's process tree so a shell-wrapped install
	// (an npm .cmd shim) cannot leave its real Node process orphaned when
	// this session is stopped, or when this backend itself dies with
	// nothing left alive to signal it. No-op on Unix, where cmd's own
	// process-group signalling already covers this. See procgroup's package
	// doc — same fix as internal/terminal and internal/lsp apply already.
	job, jobErr := procgroup.Attach(cmd.Process)
	if jobErr != nil {
		log.Printf("claude: instance %s thread %s: process group: %v", a.instanceID, in.ThreadID, jobErr)
	}
	go func() {
		<-sctx.Done()
		job.Terminate()
	}()

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
		a.drainAutoDenies(sess)
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

	a.mu.Lock()
	// Only if this is still the thread's session: after StopSession (or a
	// restart, which is StopSession then StartSession) the map may already
	// hold the replacement, and deleting that would orphan a live process.
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

// drainAutoDenies writes back a "deny" control_response for every
// control_request the parser queued an auto-deny for on the most recent
// parseLine call — every can_use_tool this package does not yet route to a
// real decision (AskUserQuestion is the one exception; it goes through
// RespondToUserInput instead). This is the backstop that keeps a request
// class this parser has never special-cased from hanging the session
// forever: the capture that motivated this task measured NO CLI-side
// timeout on an unanswered control_request. Factored out of readLoop's own
// loop so it is unit-testable without a live subprocess (readLoop's tail
// calls sess.cmd.Wait(), which a hand-built *session in a test cannot
// satisfy).
func (a *adapter) drainAutoDenies(sess *session) {
	for _, d := range sess.state.takeAutoDenies() {
		if err := sess.writeControlResponse(d.requestID, map[string]any{
			"behavior": "deny",
			"message":  d.message,
		}); err != nil {
			log.Printf("claude: instance %s thread %s: auto-deny write: %v", a.instanceID, sess.threadID, err)
		}
	}
}

// supportedImageMIMETypes mirrors t3code's ClaudeAdapter.ts
// SUPPORTED_CLAUDE_IMAGE_MIME_TYPES — the exact set claude's CLI accepts as
// an image content block's media_type. Anything else fails the turn
// outright in SendTurn rather than being silently dropped.
var supportedImageMIMETypes = map[string]bool{
	"image/gif":  true,
	"image/jpeg": true,
	"image/png":  true,
	"image/webp": true,
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

	content := []map[string]any{{"type": "text", "text": in.Text}}
	for _, att := range in.Attachments {
		if !supportedImageMIMETypes[att.MIME] {
			return provider.TurnStartResult{}, fmt.Errorf("claude: unsupported attachment MIME type %q", att.MIME)
		}
		content = append(content, map[string]any{
			"type": "image",
			"source": map[string]any{
				"type":       "base64",
				"media_type": att.MIME,
				"data":       base64.StdEncoding.EncodeToString(att.Data),
			},
		})
	}

	// Before the message, not after: the CLI applies the model to whatever it
	// processes next, so switching afterwards would run THIS turn on the old
	// model and only take effect on the following one.
	if err := sess.applyModel(in.Model.Model); err != nil {
		return provider.TurnStartResult{}, fmt.Errorf("claude: switch model: %w", err)
	}

	msg := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": content,
		},
	}
	sess.stdinMu.Lock()
	err := sess.stdinEnc.Encode(msg)
	sess.stdinMu.Unlock()
	if err != nil {
		return provider.TurnStartResult{}, fmt.Errorf("claude: write turn: %w", err)
	}

	return provider.TurnStartResult{TurnID: in.TurnID}, nil
}

// InterruptTurn asks the running process to stop the current turn via the
// stream-json control channel. It is a best-effort request, not a kill —
// StopSession is the hard stop.
// Interrupting the TURN is not the whole of stopping the AGENT, and that gap
// was a real bug: the CLI keeps a queue of user messages behind the running
// turn, and `interrupt` alone aborts only the turn in flight. Live capture
// against 2.1.241 (a second message sent while the first was streaming, then
// an interrupt) shows the abort land — `aborted:true`, `[Request interrupted by
// user]`, a `result` with `terminal_reason:"aborted_streaming"` — and then, 200
// milliseconds later and with no further input, a fresh `system/init` and the
// queued message running to completion. From the operator's seat the thread
// genuinely stopped and then started again by itself.
//
// `cancel_queued` is the CLI's own answer, gated behind the
// `interrupt_cancel_queued_v1` capability it announces on system/init. The same
// capture with the flag set returns `{"still_queued":[],"cancelled":[]}` and
// the session stays silent — no second turn. Sent only when the capability is
// present so an older build keeps receiving the exact frame it has always
// understood; a Stop that a strict schema rejected outright would be a far
// worse failure than the one this fixes.
//
// The request_id is new too. It was always absent here (the CLI answers a
// bare interrupt fine), but the control envelope documents request_id as the
// key its control_response echoes, and without one the receipt cannot be
// correlated to this request at all.
func (a *adapter) InterruptTurn(ctx context.Context, threadID, turnID string) error {
	a.mu.Lock()
	sess, ok := a.sessions[threadID]
	a.mu.Unlock()
	if !ok {
		return nil
	}
	request := map[string]any{"subtype": "interrupt"}
	if sess.state.hasCapability(capInterruptCancelQueued) {
		request["cancel_queued"] = true
	}
	sess.stdinMu.Lock()
	defer sess.stdinMu.Unlock()
	return sess.stdinEnc.Encode(map[string]any{
		"type":       "control_request",
		"request_id": newControlRequestID("interrupt-"),
		"request":    request,
	})
}

// newControlRequestID mints a request_id for an outbound control_request
// this package does not otherwise correlate an answer to (unlike
// RespondToRequest's requestID, which comes FROM the CLI). Uniqueness only
// needs to hold within one process's lifetime; a fixed-width random suffix
// is enough and avoids pulling in a UUID dependency for one call site.
func newControlRequestID(prefix string) string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand.Read does not fail on any supported platform; this is
		// an unreachable-in-practice fallback, not a real collision risk.
		return prefix + fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return prefix + hex.EncodeToString(b)
}

// SetInteractionMode switches an already-running session's live permission
// mode via the stream-json control channel — verified live in T1's capture
// (capture/README.md "Open question 2"): `set_permission_mode` is accepted
// on an already-running session, in both directions, and applies
// immediately (confirmed by the `system/status` line that follows echoing
// the new `permissionMode`). No restart, no lost conversation — this is why
// spec §4's path (a) shipped instead of the StopSession/Unbind/StartSession
// fallback (b).
//
// Best-effort like InterruptTurn: a nil return when no session exists for
// the thread is not an error, it means there is nothing left to reach.
// provider.InteractionMode's two values ("default"/"plan") ARE the CLI's own
// mode names, so no translation table is needed here — buildArgs already
// relies on that same identity for the initial --permission-mode flag.
func (a *adapter) SetInteractionMode(ctx context.Context, threadID string, mode provider.InteractionMode) error {
	a.mu.Lock()
	sess, ok := a.sessions[threadID]
	a.mu.Unlock()
	if !ok {
		return nil
	}
	sess.stdinMu.Lock()
	defer sess.stdinMu.Unlock()
	return sess.stdinEnc.Encode(map[string]any{
		"type":       "control_request",
		"request_id": newControlRequestID("setmode-"),
		"request": map[string]any{
			"subtype": "set_permission_mode",
			"mode":    string(mode),
		},
	})
}

// claudePermissionMode maps a RuntimeMode onto the CLI's own --permission-mode
// value, for the three modes that need an explicit flag (approval-required is
// the CLI's own default, and Plan mode — itself a --permission-mode value —
// is handled separately by buildArgs/SetInteractionMode). Shared by buildArgs
// (session start) and SetRuntimeMode (an already-running session's live
// mid-run switch, below) so the two can never map a mode two different ways.
func claudePermissionMode(mode provider.RuntimeMode) string {
	switch mode {
	case provider.ModeAutoAcceptEdits:
		return "acceptEdits"
	case provider.ModeFullAccess:
		return "bypassPermissions"
	case provider.ModeAuto:
		return "auto"
	default:
		return "default"
	}
}

// SetRuntimeMode pushes a changed Permission-pill mode into an already-running
// session, over the identical set_permission_mode control_request
// SetInteractionMode uses above. Without this, RuntimeMode only ever reached
// the CLI at StartSession (buildArgs): the composer's Permission pill updated
// DevDeck's own thread state and released any of DevDeck's OWN pending
// approval cards (approval.Gate.ReleasePending), but the live claude process
// kept enforcing whichever --permission-mode it was launched with for the
// rest of the session — an operator switching to auto or full access kept
// getting asked by the CLI itself, no matter what the pill now said.
func (a *adapter) SetRuntimeMode(ctx context.Context, threadID string, mode provider.RuntimeMode) error {
	a.mu.Lock()
	sess, ok := a.sessions[threadID]
	a.mu.Unlock()
	if !ok {
		return nil
	}
	sess.stdinMu.Lock()
	defer sess.stdinMu.Unlock()
	return sess.stdinEnc.Encode(map[string]any{
		"type":       "control_request",
		"request_id": newControlRequestID("setmode-"),
		"request": map[string]any{
			"subtype": "set_permission_mode",
			"mode":    claudePermissionMode(mode),
		},
	})
}

// permissionResult maps a Decision onto the CLI's PermissionResult shape —
// identical to t3code (ClaudeAdapter.ts:4033-4051), verified byte-for-byte
// against captures e2, e14, e3.
func permissionResult(d event.Decision, input, suggestions json.RawMessage) map[string]any {
	switch d {
	case event.DecisionAccept, event.DecisionAcceptForSession:
		out := map[string]any{"behavior": "allow", "updatedInput": json.RawMessage(input)}
		if d == event.DecisionAcceptForSession && len(suggestions) > 0 && string(suggestions) != "null" {
			out["updatedPermissions"] = json.RawMessage(suggestions)
		}
		return out
	case event.DecisionCancel:
		return map[string]any{"behavior": "deny", "message": "User cancelled tool execution."}
	default: // decline
		return map[string]any{"behavior": "deny", "message": "User declined tool execution."}
	}
}

// RespondToRequest answers a pending can_use_tool approval — the operator's
// accept/acceptForSession/decline/cancel decision, mapped by
// permissionResult onto the CLI's PermissionResult shape and written back
// over stdin as a control_response. The pending entry is retired first, so a
// double-tap (a second device, or a cancel racing this call) is a benign
// no-op rather than a second stdin write.
func (a *adapter) RespondToRequest(ctx context.Context, threadID, requestID string, d event.Decision) error {
	a.mu.Lock()
	sess, ok := a.sessions[threadID]
	a.mu.Unlock()
	if !ok {
		return nil
	}
	p, found := sess.state.takePending(requestID)
	if !found {
		return nil
	}
	return sess.writeControlResponse(requestID, permissionResult(d, p.input, p.suggestions))
}

// RespondToUserInput answers a pending AskUserQuestion. The original
// questions array must be echoed verbatim (spec §1.5) — this is why the
// pending map exists even in A1: the raw input arrives minutes before the
// answer does.
func (a *adapter) RespondToUserInput(ctx context.Context, threadID, requestID string, answers map[string]any) error {
	a.mu.Lock()
	sess, ok := a.sessions[threadID]
	a.mu.Unlock()
	if !ok {
		return nil
	}
	p, found := sess.state.takePending(requestID)
	if !found {
		// Already resolved or cancelled — a double-tap from a second device,
		// or a cancel that raced this call. Benign, mirrors ErrUnknownRequest.
		return nil
	}
	if err := sess.writeControlResponse(requestID, map[string]any{
		"behavior": "allow",
		"updatedInput": map[string]any{
			"questions": json.RawMessage(p.input),
			"answers":   answers,
		},
	}); err != nil {
		return err
	}
	a.emit(event.Event{
		Type: event.UserInputResolved, Provider: string(Kind), InstanceID: string(a.instanceID),
		ThreadID: threadID, RequestID: requestID, CreatedAt: time.Now().UTC(),
	})
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

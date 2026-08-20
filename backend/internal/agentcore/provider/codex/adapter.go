package codex

import (
	"bufio"
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

// eventBufferSize bounds the adapter's instance-wide events channel. emit
// never blocks the read loop: a slow consumer drops events rather than
// stalling stdout, because a stalled stdout read eventually blocks the
// app-server process itself once its pipe fills.
const eventBufferSize = 256

// rpcTimeout bounds a single JSON-RPC round trip. The app-server answers
// initialize/thread/start in well under a second locally; anything past this
// means the process is wedged, and failing loudly beats a caller hanging
// forever with no signal.
const rpcTimeout = 30 * time.Second

// session is one DevDeck thread mapped onto a Codex thread. There is no
// process here: the process belongs to the adapter (see the package comment on
// why Codex is one server hosting many threads).
type session struct {
	threadID  string
	codexID   string
	state     *parseState
	startedAt int64
	model     string
}

type adapter struct {
	instanceID provider.InstanceID
	cfg        Config
	env        map[string]string
	ctx        context.Context

	events chan event.Event

	// startOnce guards lazy process start: the app-server is spawned by the
	// first StartSession, not by Create, so an instance that is configured but
	// never used costs nothing.
	startOnce sync.Once
	startErr  error

	cmd     *exec.Cmd
	stdinMu sync.Mutex
	stdinEn *json.Encoder

	mu       sync.Mutex
	sessions map[string]*session // DevDeck threadID -> session
	byCodex  map[string]*session // Codex thread id -> session
	nextID   int64
	pending  map[int64]chan rpcResult

	readers sync.WaitGroup
}

type rpcResult struct {
	result json.RawMessage
	err    error
}

func newAdapter(ctx context.Context, id provider.InstanceID, cfg Config, env map[string]string) *adapter {
	a := &adapter{
		instanceID: id,
		cfg:        cfg,
		env:        env,
		ctx:        ctx,
		events:     make(chan event.Event, eventBufferSize),
		sessions:   map[string]*session{},
		byCodex:    map[string]*session{},
		pending:    map[int64]chan rpcResult{},
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

func (a *adapter) Capabilities() provider.Capabilities {
	return provider.Capabilities{
		// `turn/start` takes a per-turn model, so switching mid-thread needs no
		// restart — verified in the protocol schema's TurnStartParams.
		SessionModelSwitch: provider.ModelSwitchInSession,
		SupportsResume:     true,
		SupportsMCP:        true,
	}
}

func (a *adapter) emit(e event.Event) {
	select {
	case a.events <- e:
	default:
		log.Printf("agentcore: codex event dropped, type=%s thread=%s", e.Type, e.ThreadID)
	}
}

func (a *adapter) Events() <-chan event.Event { return a.events }

// ensureProcess spawns `codex app-server` and completes the `initialize`
// handshake exactly once per adapter. mcpEndpoints comes from whichever
// StartSession call happens to be first — since Codex is one process for
// every thread on this instance (see the package comment), MCP config is an
// instance-wide, start-time concern, not a per-thread one like claude's
// --mcp-config flag.
func (a *adapter) ensureProcess(mcpEndpoints []provider.MCPEndpoint) error {
	a.startOnce.Do(func() {
		bin, err := detect.ResolveBinary(a.cfg.BinaryName)
		if err != nil {
			a.startErr = fmt.Errorf("codex: binary not found: %w", err)
			return
		}

		// Must happen before cmd.Start(): app-server reads config.toml (and
		// the bearer-token env vars configureMCP returns) once, at its own
		// startup.
		tokenEnv := configureMCP(bin, a.cfg, mcpEndpoints)
		env := a.env
		if len(tokenEnv) > 0 {
			env = make(map[string]string, len(a.env)+len(tokenEnv))
			for k, v := range a.env {
				env[k] = v
			}
			for k, v := range tokenEnv {
				env[k] = v
			}
		}

		args := append([]string{"app-server"}, a.cfg.ExtraArgs...)
		cmd := exec.CommandContext(a.ctx, bin, args...)
		cmd.Env = buildEnv(env, a.cfg)

		stdin, err := cmd.StdinPipe()
		if err != nil {
			a.startErr = fmt.Errorf("codex: stdin pipe: %w", err)
			return
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			a.startErr = fmt.Errorf("codex: stdout pipe: %w", err)
			return
		}
		// stderr is where the app-server logs; it is noisy (config warnings on
		// every start) and never carries protocol, so it is drained to the log
		// rather than parsed. Draining matters: an unread pipe eventually
		// blocks the process.
		stderr, err := cmd.StderrPipe()
		if err != nil {
			a.startErr = fmt.Errorf("codex: stderr pipe: %w", err)
			return
		}

		if err := cmd.Start(); err != nil {
			a.startErr = fmt.Errorf("codex: start app-server: %w", err)
			return
		}

		a.cmd = cmd
		a.stdinEn = json.NewEncoder(stdin)

		a.readers.Add(2)
		go func() { defer a.readers.Done(); a.readLoop(stdout) }()
		go func() { defer a.readers.Done(); drain(stderr) }()

		if _, err := a.call(a.ctx, "initialize", map[string]any{
			"clientInfo": map[string]any{"name": "devdeck", "title": "DevDeck", "version": "0.1.0"},
		}); err != nil {
			a.startErr = fmt.Errorf("codex: initialize: %w", err)
		}
	})
	return a.startErr
}

func drain(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		// Kept at debug volume on purpose: the app-server logs a config warning
		// on every start, and echoing those as errors trains people to ignore
		// the log.
		_ = sc.Text()
	}
}

// readLoop demultiplexes the single stdout stream: lines carrying an `id` are
// responses to our requests, everything else is a server notification that
// becomes canonical events.
func (a *adapter) readLoop(stdout io.Reader) {
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 256*1024), 8*1024*1024)

	for sc.Scan() {
		line := append([]byte(nil), sc.Bytes()...)
		if len(line) == 0 {
			continue
		}

		// ID is decoded as raw JSON, not *int64: the app-server's own
		// RequestId schema is `string | int64`, and a server->client REQUEST
		// (see below) can legally carry either. Unmarshalling straight into
		// *int64 silently dropped the whole line — via readLoop's err!=nil
		// `continue` — the one time it actually mattered: a string id on a
		// request we then never even tried to answer.
		var head struct {
			ID     json.RawMessage `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
			Method string          `json:"method"`
		}
		if err := json.Unmarshal(line, &head); err != nil {
			continue
		}
		hasID := len(head.ID) > 0 && string(head.ID) != "null"

		// A line with an id and NO method is a RESPONSE to one of our own
		// requests — a.call always sends integer ids, so this is always safe
		// to decode as int64.
		if hasID && head.Method == "" {
			var id int64
			if err := json.Unmarshal(head.ID, &id); err == nil {
				a.resolve(id, head.Result, head.Error)
			}
			continue
		}

		// A line with BOTH id and method is a server->client REQUEST —
		// approvals and the (experimental) user-input prompt arrive this way,
		// and the app-server blocks the turn until a matching JSON-RPC
		// response comes back on this same id. Routing this into
		// dispatchNotification (the old behaviour) meant it was recognised at
		// best as an "unrecognized notification" warning and NEVER answered:
		// the app-server sat there forever waiting for a reply, the turn
		// never reached turn/completed, and the thread stayed "running" with
		// nothing further to show for it. See dispatchServerRequest.
		if hasID && head.Method != "" {
			a.dispatchServerRequest(line, head.ID, head.Method)
			continue
		}

		a.dispatchNotification(line, head.Method)
	}

	// stdout closed: the app-server is gone, and every thread on it with it.
	a.mu.Lock()
	sessions := make([]*session, 0, len(a.sessions))
	for _, s := range a.sessions {
		sessions = append(sessions, s)
	}
	a.mu.Unlock()
	for _, s := range sessions {
		e := s.state.envelope(event.SessionExited)
		e.Payload = &event.SessionExitedPayload{Reason: "codex app-server exited"}
		a.emit(e)
	}
}

func (a *adapter) resolve(id int64, result, rpcErr json.RawMessage) {
	a.mu.Lock()
	ch, ok := a.pending[id]
	delete(a.pending, id)
	a.mu.Unlock()
	if !ok {
		return
	}
	if len(rpcErr) > 0 && string(rpcErr) != "null" {
		ch <- rpcResult{err: fmt.Errorf("codex rpc error: %s", rpcErr)}
		return
	}
	ch <- rpcResult{result: result}
}

// dispatchNotification routes a notification to the session it names. Every
// notification carries `threadId` (directly or inside `thread`), which is the
// only way to tell whose events these are on a shared process.
func (a *adapter) dispatchNotification(line []byte, method string) {
	var ids struct {
		ThreadID string `json:"threadId"`
		Thread   struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	var wrapper struct {
		Params json.RawMessage `json:"params"`
	}
	_ = json.Unmarshal(line, &wrapper)
	_ = json.Unmarshal(wrapper.Params, &ids)

	codexID := ids.ThreadID
	if codexID == "" {
		codexID = ids.Thread.ID
	}

	a.mu.Lock()
	s := a.byCodex[codexID]
	a.mu.Unlock()
	if s == nil {
		// Server-wide chatter (configWarning, remoteControl status) arrives
		// before any thread exists and belongs to no session. Dropping it is
		// correct — it is not any thread's transcript.
		return
	}

	for _, e := range parseNotification(wrapper.Params, s.state) {
		// parseNotification decodes params; re-stamp the method so a warning's
		// Raw names what produced it.
		if e.Raw != nil {
			e.Raw.Method = method
		}
		a.emit(e)
	}
}

// dispatchServerRequest routes a server->client REQUEST to the session it
// names (same threadId-in-params routing as dispatchNotification) and
// answers it: parseServerRequest either opens a real DevDeck approval card
// (RespondToRequest/RespondToUserInput reply later, once a decision exists)
// or reports that this method has no UI yet, in which case it is declined
// immediately — never left for the app-server to wait on forever.
func (a *adapter) dispatchServerRequest(line []byte, rpcID json.RawMessage, method string) {
	var wrapper struct {
		Params json.RawMessage `json:"params"`
	}
	_ = json.Unmarshal(line, &wrapper)

	var ids struct {
		ThreadID string `json:"threadId"`
	}
	_ = json.Unmarshal(wrapper.Params, &ids)

	a.mu.Lock()
	s := a.byCodex[ids.ThreadID]
	a.mu.Unlock()
	if s == nil {
		// No DevDeck thread to raise a card on — the request names a thread
		// this adapter never started or has already forgotten. Declining is
		// the only sound answer; there is nobody left to ask.
		a.replyDecline(rpcID, "codex: no active thread for this request")
		return
	}

	evts, needsAutoDecline := parseServerRequest(rpcID, method, wrapper.Params, s.state)
	for _, e := range evts {
		a.emit(e)
	}
	if needsAutoDecline {
		a.replyDecline(rpcID, fmt.Sprintf("codex: DevDeck cannot answer %q yet", method))
	}
}

// replyDecline answers a server->client REQUEST with a JSON-RPC error rather
// than a typed `result` — valid for ANY request method regardless of that
// method's own response schema, which is what makes it usable as a universal
// fallback for approval families this adapter has no typed reply for.
func (a *adapter) replyDecline(rpcID json.RawMessage, message string) {
	a.stdinMu.Lock()
	defer a.stdinMu.Unlock()
	_ = a.stdinEn.Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(rpcID),
		"error":   map[string]any{"code": -32001, "message": message},
	})
}

// replyResult answers a server->client REQUEST with a typed `result` —
// RespondToRequest/RespondToUserInput call this once a real decision exists.
func (a *adapter) replyResult(rpcID json.RawMessage, result any) error {
	a.stdinMu.Lock()
	defer a.stdinMu.Unlock()
	return a.stdinEn.Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(rpcID),
		"result":  result,
	})
}

// call sends a JSON-RPC request and waits for its response.
func (a *adapter) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	a.mu.Lock()
	a.nextID++
	id := a.nextID
	ch := make(chan rpcResult, 1)
	a.pending[id] = ch
	a.mu.Unlock()

	a.stdinMu.Lock()
	err := a.stdinEn.Encode(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": method, "params": params,
	})
	a.stdinMu.Unlock()
	if err != nil {
		a.mu.Lock()
		delete(a.pending, id)
		a.mu.Unlock()
		return nil, fmt.Errorf("codex: write %s: %w", method, err)
	}

	timeout := time.NewTimer(rpcTimeout)
	defer timeout.Stop()
	select {
	case res := <-ch:
		return res.result, res.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timeout.C:
		a.mu.Lock()
		delete(a.pending, id)
		a.mu.Unlock()
		return nil, fmt.Errorf("codex: %s timed out after %s", method, rpcTimeout)
	}
}

func (a *adapter) StartSession(ctx context.Context, in provider.SessionStartInput) (provider.Session, error) {
	if err := a.ensureProcess(in.MCPEndpoints); err != nil {
		return provider.Session{}, err
	}

	params := map[string]any{}
	if in.Cwd != "" {
		params["cwd"] = in.Cwd
	}
	if policy := approvalPolicyFor(in.Mode); policy != "" {
		params["approvalPolicy"] = policy
	}

	raw, err := a.call(ctx, "thread/start", params)
	if err != nil {
		return provider.Session{}, err
	}
	var res struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return provider.Session{}, fmt.Errorf("codex: thread/start response: %w", err)
	}
	if res.Thread.ID == "" {
		return provider.Session{}, fmt.Errorf("codex: thread/start returned no thread id")
	}

	s := &session{
		threadID:  in.ThreadID,
		codexID:   res.Thread.ID,
		state:     newParseState(in.ThreadID, res.Thread.ID, a.instanceID),
		startedAt: time.Now().UnixMilli(),
		model:     in.Model.Model,
	}
	a.mu.Lock()
	a.sessions[in.ThreadID] = s
	a.byCodex[res.Thread.ID] = s
	a.mu.Unlock()

	e := s.state.envelope(event.SessionStarted)
	e.Payload = &event.SessionStartedPayload{Resume: mustJSON(map[string]string{"codexThreadId": res.Thread.ID})}
	a.emit(e)

	return provider.Session{ThreadID: in.ThreadID, StartedAt: s.startedAt, Model: s.model}, nil
}

// approvalPolicyFor maps DevDeck's RuntimeMode onto Codex's AskForApproval.
// This is the ONLY place the two vocabularies meet — the same rule
// claude/adapter.go's buildArgs follows for its own flags.
func approvalPolicyFor(mode provider.RuntimeMode) string {
	switch mode {
	case provider.ModeFullAccess:
		return "never"
	case provider.ModeAutoAcceptEdits, provider.ModeAuto:
		return "on-request"
	default:
		return "untrusted"
	}
}

func (a *adapter) SendTurn(ctx context.Context, in provider.SendTurnInput) (provider.TurnStartResult, error) {
	a.mu.Lock()
	s := a.sessions[in.ThreadID]
	a.mu.Unlock()
	if s == nil {
		return provider.TurnStartResult{}, fmt.Errorf("codex: thread %s has no active session", in.ThreadID)
	}

	params := map[string]any{
		"threadId": s.codexID,
		"input":    []map[string]any{{"type": "text", "text": in.Text}},
	}
	// Per-turn, so a model switch needs no restart — unlike claude, where the
	// model is a session-start flag and switching required a control request.
	if in.Model.Model != "" {
		params["model"] = in.Model.Model
		s.model = in.Model.Model
	}

	e := s.state.envelope(event.TurnStarted)
	e.Payload = &event.TurnStartedPayload{Model: in.Model.Model}
	a.emit(e)

	if _, err := a.call(ctx, "turn/start", params); err != nil {
		return provider.TurnStartResult{}, err
	}
	return provider.TurnStartResult{TurnID: in.TurnID}, nil
}

func (a *adapter) InterruptTurn(ctx context.Context, threadID, turnID string) error {
	a.mu.Lock()
	s := a.sessions[threadID]
	a.mu.Unlock()
	if s == nil {
		return nil
	}
	_, err := a.call(ctx, "turn/interrupt", map[string]any{"threadId": s.codexID})
	return err
}

// approvalDecision maps DevDeck's event.Decision onto Codex's own
// CommandExecutionApprovalDecision / FileChangeApprovalDecision — both
// verified (via `codex app-server generate-json-schema` on 0.145.0) to use
// the exact same four simple-string variants DevDeck's own vocabulary
// already spells the same way, so this is a pass-through with a safe default
// for anything RespondToRequest's caller should never actually send.
func approvalDecision(d event.Decision) string {
	if d.Valid() {
		return string(d)
	}
	return string(event.DecisionDecline)
}

// RespondToRequest answers a pending command-execution or file-change
// approval — the two server->client REQUEST methods parseServerRequest opens
// a real card for. Until 2026-08-18 this was a no-op (see git history): the
// approvalPolicy sent at StartSession was assumed to be enough to keep a
// thread from ever needing one, which is false for every policy except
// "never" (ModeFullAccess) — DevDeck's own default thread mode maps to
// "untrusted", which asks for approval on ordinary commands. A thread that
// hit one before this fix sat on ThreadRunning forever: the request was
// never answered, so the app-server never moved the turn to turn/completed.
func (a *adapter) RespondToRequest(ctx context.Context, threadID, requestID string, d event.Decision) error {
	a.mu.Lock()
	s := a.sessions[threadID]
	a.mu.Unlock()
	if s == nil {
		return nil
	}
	p, ok := s.state.takePending(requestID)
	if !ok {
		// Already answered (a double-tap, or the gate's own timeout beat the
		// operator to it) — benign, mirrors claude's same not-found path.
		return nil
	}
	switch p.method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
		return a.replyResult(p.rpcID, map[string]any{"decision": approvalDecision(d)})
	default:
		return nil
	}
}

// RespondToUserInput has nothing to answer today: parseServerRequest never
// opens a pending entry for item/tool/requestUserInput (EXPERIMENTAL per the
// app-server's own schema, and its answers-keyed-by-question-id echo
// contract is unverified against a live capture — see parseServerRequest's
// doc comment) — that method is auto-declined immediately instead. A no-op
// here is therefore correct, not a gap: there is never a pending entry for
// this to find.
func (a *adapter) RespondToUserInput(context.Context, string, string, map[string]any) error {
	return nil
}

// SetInteractionMode is a no-op: Codex has no plan mode equivalent to switch a
// live thread into.
func (a *adapter) SetInteractionMode(context.Context, string, provider.InteractionMode) error {
	return nil
}

// SetRuntimeMode is a no-op: approvalPolicyFor is only ever sent as a
// thread/start param (StartSession above) — the generated protocol schema
// this package's own doc comment insists on verifying against (no guessed
// RPCs) has no thread- or turn-level method for changing it afterward. A
// thread's approval policy is therefore fixed for the life of its Codex
// thread once started; switching the composer's Permission pill mid-session
// updates DevDeck's own state but has no live effect until the thread is
// restarted with the new mode. RespondToRequest is unaffected: it answers a
// request the CURRENT policy already opened, regardless of what the pill
// says now.
func (a *adapter) SetRuntimeMode(context.Context, string, provider.RuntimeMode) error {
	return nil
}

func (a *adapter) StopSession(ctx context.Context, threadID string) error {
	a.mu.Lock()
	s := a.sessions[threadID]
	delete(a.sessions, threadID)
	if s != nil {
		delete(a.byCodex, s.codexID)
	}
	a.mu.Unlock()
	if s == nil {
		return nil
	}
	_, err := a.call(ctx, "thread/unsubscribe", map[string]any{"threadId": s.codexID})
	return err
}

func (a *adapter) StopAll(context.Context) error {
	a.mu.Lock()
	a.sessions = map[string]*session{}
	a.byCodex = map[string]*session{}
	cmd := a.cmd
	a.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
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
	for _, s := range a.sessions {
		out = append(out, provider.Session{ThreadID: s.threadID, StartedAt: s.startedAt, Model: s.model})
	}
	return out
}

// ReadThread and RollbackThread are unimplemented. `thread/read` and
// `thread/rollback` both exist in the protocol, so these are a known gap
// rather than an impossibility.
func (a *adapter) ReadThread(context.Context, string) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, fmt.Errorf("codex: ReadThread not implemented")
}

func (a *adapter) RollbackThread(context.Context, string, int) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, fmt.Errorf("codex: RollbackThread not implemented")
}

// buildEnv mirrors pi's: the process environment, then the instance's
// overrides, then CODEX_HOME — which is Codex's own home variable (confirmed
// in the initialize response's `codexHome`), not HOME.
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
		merged["CODEX_HOME"] = cfg.HomeDir
	}
	out := make([]string, 0, len(merged))
	for k, v := range merged {
		out = append(out, k+"="+v)
	}
	return out
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

var _ provider.Adapter = (*adapter)(nil)

package opencode

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/detect"
)

const eventBufferSize = 256

// serverReadyPrefix is what `opencode serve` prints on stdout once it is
// accepting connections: "opencode server listening on http://127.0.0.1:PORT".
// Waiting for this rather than polling the port is what t3code does too, and
// it is the difference between a first request that works and one that races
// startup.
const serverReadyPrefix = "opencode server listening"

const serverStartTimeout = 30 * time.Second

// session is one DevDeck thread mapped onto an OpenCode session.
type session struct {
	threadID  string
	sessionID string
	state     *parseState
	startedAt int64
	model     string
	cancel    context.CancelFunc // stops this session's SSE subscription
}

type adapter struct {
	instanceID provider.InstanceID
	cfg        Config
	env        map[string]string
	ctx        context.Context

	events chan event.Event

	startOnce sync.Once
	startErr  error
	baseURL   string
	cmd       *exec.Cmd
	http      *http.Client

	// globalOnce guards the ONE server-wide /api/event subscription this
	// adapter needs — see subscribeGlobal. Unlike subscribe (one per
	// session), permission requests carry their own sessionID, so a single
	// long-lived subscription can route to every session this adapter owns.
	globalOnce sync.Once

	mu         sync.Mutex
	sessions   map[string]*session // DevDeck threadID -> session
	byOpencode map[string]*session // OpenCode sessionID -> session
	// childStates maps a SUBAGENT's child sessionID onto the parse state its
	// frames are read with — see subagent.go's newChildParseState. A child
	// session is created by the server, never by StartSession, so it has no
	// entry in byOpencode and its frames used to be dropped as "another
	// instance's traffic", losing the subagent's whole transcript.
	childStates map[string]*parseState

	readers sync.WaitGroup
}

func newAdapter(ctx context.Context, id provider.InstanceID, cfg Config, env map[string]string) *adapter {
	a := &adapter{
		instanceID:  id,
		cfg:         cfg,
		env:         env,
		ctx:         ctx,
		events:      make(chan event.Event, eventBufferSize),
		sessions:    map[string]*session{},
		byOpencode:  map[string]*session{},
		childStates: map[string]*parseState{},
		// No global timeout: the SSE subscription is a long-lived request and
		// a client timeout would cut every turn short. Per-request deadlines
		// come from the caller's context instead.
		http: &http.Client{},
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
		// POST /api/session/{id}/model switches a live session's model.
		SessionModelSwitch: provider.ModelSwitchInSession,
		SupportsResume:     true,
		SupportsMCP:        true,
	}
}

func (a *adapter) emit(e event.Event) {
	select {
	case a.events <- e:
	default:
		log.Printf("agentcore: opencode event dropped, type=%s thread=%s", e.Type, e.ThreadID)
	}
}

func (a *adapter) Events() <-chan event.Event { return a.events }

// freePort asks the OS for an unused port. `opencode serve` needs an explicit
// one, and hardcoding would collide the moment a second instance starts.
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// ensureServer starts `opencode serve` exactly once per adapter. mcpEndpoints
// comes from whichever StartSession call happens to be first — OpenCode is
// one server for every thread on this instance, so MCP config is an
// instance-wide, start-time concern (see configureMCP).
func (a *adapter) ensureServer(mcpEndpoints []provider.MCPEndpoint) error {
	a.startOnce.Do(func() {
		bin, err := detect.ResolveBinary(a.cfg.BinaryName)
		if err != nil {
			a.startErr = fmt.Errorf("opencode: binary not found: %w", err)
			return
		}
		// Must happen before cmd.Start(): the server reads opencode.jsonc
		// once, at its own startup.
		configureMCP(bin, a.cfg, mcpEndpoints)
		port, err := freePort()
		if err != nil {
			a.startErr = fmt.Errorf("opencode: pick port: %w", err)
			return
		}

		args := append([]string{"serve", "--port", fmt.Sprint(port)}, a.cfg.ExtraArgs...)
		cmd := exec.CommandContext(a.ctx, bin, args...)
		cmd.Env = buildEnv(a.env, a.cfg)

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			a.startErr = fmt.Errorf("opencode: stdout pipe: %w", err)
			return
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			a.startErr = fmt.Errorf("opencode: stderr pipe: %w", err)
			return
		}
		if err := cmd.Start(); err != nil {
			a.startErr = fmt.Errorf("opencode: start server: %w", err)
			return
		}
		a.cmd = cmd

		ready := make(chan string, 1)
		a.readers.Add(2)
		go func() { defer a.readers.Done(); watchForReady(stdout, ready) }()
		go func() { defer a.readers.Done(); drain(stderr) }()

		select {
		case line := <-ready:
			a.baseURL = urlFromReadyLine(line, port)
		case <-time.After(serverStartTimeout):
			a.startErr = fmt.Errorf("opencode: server did not report ready within %s", serverStartTimeout)
		case <-a.ctx.Done():
			a.startErr = a.ctx.Err()
		}
	})
	return a.startErr
}

// watchForReady forwards the readiness line, then keeps draining so the pipe
// never fills and blocks the server.
func watchForReady(r io.Reader, ready chan<- string) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	sent := false
	for sc.Scan() {
		line := sc.Text()
		if !sent && strings.Contains(line, serverReadyPrefix) {
			ready <- line
			sent = true
		}
	}
}

func drain(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		_ = sc.Text()
	}
}

// urlFromReadyLine pulls the base URL out of the readiness line, falling back
// to the port that was requested. The line's own URL is preferred because it
// is what the server actually bound.
func urlFromReadyLine(line string, port int) string {
	if i := strings.Index(line, "http://"); i >= 0 {
		return strings.TrimSpace(line[i:])
	}
	return fmt.Sprintf("http://127.0.0.1:%d", port)
}

// envelope is OpenCode's uniform response wrapper: every JSON body is
// `{"data": …}`. Reading the payload off the top level silently yields zero
// values, which is how a session id comes back empty and the next request
// falls through to the server's SPA fallback with a 200.
type envelope struct {
	Data json.RawMessage `json:"data"`
}

func (a *adapter) do(ctx context.Context, method, path string, body any, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.baseURL+path, rdr)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		snippet, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("opencode: %s %s: %s: %s", method, path, res.Status, snippet)
	}
	if out == nil {
		return nil
	}
	var env envelope
	if err := json.NewDecoder(res.Body).Decode(&env); err != nil {
		return fmt.Errorf("opencode: decode %s: %w", path, err)
	}
	return json.Unmarshal(env.Data, out)
}

func (a *adapter) StartSession(ctx context.Context, in provider.SessionStartInput) (provider.Session, error) {
	if err := a.ensureServer(in.MCPEndpoints); err != nil {
		return provider.Session{}, err
	}

	body := map[string]any{}
	if in.Cwd != "" {
		body["location"] = map[string]any{"directory": in.Cwd}
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := a.do(ctx, http.MethodPost, "/api/session", body, &created); err != nil {
		return provider.Session{}, err
	}
	if created.ID == "" {
		return provider.Session{}, fmt.Errorf("opencode: session create returned no id")
	}

	sctx, cancel := context.WithCancel(a.ctx)
	s := &session{
		threadID:  in.ThreadID,
		sessionID: created.ID,
		state:     newParseState(in.ThreadID, created.ID, a.instanceID),
		startedAt: time.Now().UnixMilli(),
		model:     in.Model.Model,
		cancel:    cancel,
	}
	a.mu.Lock()
	a.sessions[in.ThreadID] = s
	a.byOpencode[created.ID] = s
	a.mu.Unlock()

	// Started once per adapter, bound to a.ctx (the adapter's whole
	// lifetime) rather than sctx (this one session's) — permission requests
	// for EVERY session this adapter owns arrive on this one bus.
	a.globalOnce.Do(func() {
		a.readers.Add(1)
		go func() { defer a.readers.Done(); a.subscribeGlobal(a.ctx) }()
	})

	a.readers.Add(1)
	go func() { defer a.readers.Done(); a.subscribe(sctx, s) }()

	e := s.state.envelope(event.SessionStarted)
	e.Payload = &event.SessionStartedPayload{Resume: mustJSON(map[string]string{"opencodeSessionId": created.ID})}
	a.emit(e)

	return provider.Session{ThreadID: in.ThreadID, StartedAt: s.startedAt, Model: s.model}, nil
}

// subscribe streams one session's own content events. Per-session rather
// than the server's global /api/event stream: the routing is then the URL's
// job rather than a demultiplexer's, and one thread's backlog cannot stall
// another's. This stream cannot carry a permission request though — verified
// live (2026-08-18): permission.v2.asked never appeared here in a capture
// where it fired on /api/event for the same session in the same turn. See
// subscribeGlobal for the one thing this deliberately does not cover.
func (a *adapter) subscribe(ctx context.Context, s *session) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.baseURL+"/api/session/"+s.sessionID+"/event", nil)
	if err != nil {
		return
	}
	req.Header.Set("Accept", "text/event-stream")
	res, err := a.http.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("agentcore: opencode subscribe failed, thread=%s err=%v", s.threadID, err)
		}
		return
	}
	defer res.Body.Close()

	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 0, 256*1024), 8*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		for _, e := range parseEvent([]byte(payload), s.state) {
			a.emit(e)
		}
	}

	// The stream ended. If that was not our own cancellation, the session is
	// gone as far as this adapter is concerned.
	if ctx.Err() == nil {
		e := s.state.envelope(event.SessionExited)
		e.Payload = &event.SessionExitedPayload{Reason: "opencode event stream closed"}
		a.emit(e)
	}
}

// subscribeGlobal streams the server-wide /api/event bus for the adapter's
// whole lifetime (ctx is a.ctx, not any one session's). This is the ONLY
// channel that carries permission.v2.asked/permission.v2.replied — see the
// package comment in parse.go for the live capture that proved it. Before
// this existed, DevDeck had no way to ever learn a permission request had
// been raised at all: RespondToRequest/RespondToUserInput were no-ops not
// for lack of an HTTP call to make, but because nothing upstream of them
// ever produced a request.opened event to answer.
func (a *adapter) subscribeGlobal(ctx context.Context) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.baseURL+"/api/event", nil)
	if err != nil {
		return
	}
	req.Header.Set("Accept", "text/event-stream")
	res, err := a.http.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("agentcore: opencode global subscribe failed: %v", err)
		}
		return
	}
	defer res.Body.Close()

	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 0, 256*1024), 8*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		a.dispatchGlobalEvent([]byte(payload))
	}
}

// dispatchGlobalEvent routes one global-bus frame to the session it names.
// The global bus is server-wide — not scoped to this adapter's own sessions
// — so a frame naming a sessionID this adapter doesn't own (another
// instance's, or one already stopped) is silently dropped rather than
// warned about; that is normal traffic, not a parsing gap.
func (a *adapter) dispatchGlobalEvent(payload []byte) {
	var probe struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(payload, &probe); err != nil {
		return
	}
	var ids struct {
		SessionID string `json:"sessionID"`
		Type      string `json:"type"`
		Info      struct {
			ID       string `json:"id"`
			ParentID string `json:"parentID"`
		} `json:"info"`
	}
	_ = json.Unmarshal(probe.Data, &ids)
	var envelope struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(payload, &envelope)

	// A SUBAGENT announcing itself. `info.parentID` is the only link opencode
	// ever draws between a child session and the parent that spawned it — the
	// parent's own stream never names the child — so this is where the two
	// halves are joined. Without it the child's entire turn arrives under a
	// sessionID nothing owns and is dropped below.
	if envelope.Type == "session.created" && ids.Info.ParentID != "" && ids.Info.ID != "" {
		a.mu.Lock()
		parent := a.byOpencode[ids.Info.ParentID]
		a.mu.Unlock()
		if parent != nil {
			if sp := parent.state.bindChildSession(ids.Info.ID); sp != nil {
				child := newChildParseState(parent.state, ids.Info.ID, sp)
				a.mu.Lock()
				a.childStates[ids.Info.ID] = child
				a.mu.Unlock()
			}
		}
		return
	}

	if ids.SessionID == "" {
		return
	}

	a.mu.Lock()
	s := a.byOpencode[ids.SessionID]
	child := a.childStates[ids.SessionID]
	a.mu.Unlock()

	// A child session's frames are the subagent's own work: parsed with its
	// dedicated state (which stamps AgentID on everything it produces) and
	// through parseChildEvent, which drops the child's turn lifecycle so a
	// finishing subagent cannot settle the parent thread to idle underneath a
	// turn that is still running.
	if s == nil && child != nil {
		for _, e := range parseChildEvent(probe.Data, child) {
			a.emit(e)
		}
		return
	}
	if s == nil {
		return
	}

	for _, e := range parseGlobalEvent(payload, s.state) {
		a.emit(e)
	}
}

func (a *adapter) SendTurn(ctx context.Context, in provider.SendTurnInput) (provider.TurnStartResult, error) {
	a.mu.Lock()
	s := a.sessions[in.ThreadID]
	a.mu.Unlock()
	if s == nil {
		return provider.TurnStartResult{}, fmt.Errorf("opencode: thread %s has no active session", in.ThreadID)
	}

	// Model switching is its own endpoint here, not a field on the prompt.
	if in.Model.Model != "" && in.Model.Model != s.model {
		if err := a.do(ctx, http.MethodPost, "/api/session/"+s.sessionID+"/model",
			modelRef(in.Model.Model), nil); err != nil {
			return provider.TurnStartResult{}, fmt.Errorf("opencode: switch model: %w", err)
		}
		s.model = in.Model.Model
	}

	body := map[string]any{
		"prompt": map[string]any{"text": in.Text},
		// "steer" is what makes a message sent mid-turn redirect the running
		// turn instead of queueing behind it — the same behavior DevDeck's
		// composer already promises when you type while the agent works.
		"delivery": "steer",
	}
	if err := a.do(ctx, http.MethodPost, "/api/session/"+s.sessionID+"/prompt", body, nil); err != nil {
		return provider.TurnStartResult{}, err
	}
	return provider.TurnStartResult{TurnID: in.TurnID}, nil
}

// modelRef splits DevDeck's flat model id into OpenCode's {providerID, id}.
// OpenCode ids are conventionally "provider/model"; an id with no slash is
// passed through with an empty providerID so the server can apply its default
// rather than this code inventing one.
func modelRef(model string) map[string]any {
	if providerID, id, ok := strings.Cut(model, "/"); ok {
		return map[string]any{"providerID": providerID, "id": id}
	}
	return map[string]any{"providerID": "", "id": model}
}

func (a *adapter) InterruptTurn(ctx context.Context, threadID, turnID string) error {
	a.mu.Lock()
	s := a.sessions[threadID]
	a.mu.Unlock()
	if s == nil {
		return nil
	}
	return a.do(ctx, http.MethodPost, "/api/session/"+s.sessionID+"/interrupt", map[string]any{}, nil)
}

// opencodeReply maps DevDeck's Decision onto PermissionV2Reply. Verified live
// (2026-08-18): {"reply":"once"} against a real pending
// item/commandExecution-equivalent bash approval actually unblocked the tool
// call — the command ran and the turn proceeded to session.next.step.ended.
// OpenCode's reply vocabulary has no "cancel and abort the turn" distinct
// from a plain denial, unlike claude/codex, so DecisionCancel folds into
// "reject" here rather than being offered as a separate option — see
// parse.go's permissionV2Options, which omits it from the card in the first
// place.
func opencodeReply(d event.Decision) string {
	switch d {
	case event.DecisionAccept:
		return "once"
	case event.DecisionAcceptForSession:
		return "always"
	default:
		return "reject"
	}
}

// RespondToRequest answers a pending permission.v2.asked request via
// POST /api/session/{sessionID}/permission/{requestID}/reply. Until
// 2026-08-18 this was a no-op — not because the HTTP call was hard to write,
// but because subscribe's per-session stream structurally never delivered a
// permission request in the first place (see subscribeGlobal); there was
// nothing to answer even after this method existed. No local pending state
// to look up first, unlike codex/claude: OpenCode's reply endpoint needs
// only the sessionID (already on the session) and requestID (the caller's
// own event.RequestID, unmodified from what parseGlobalEvent opened the card
// with), so a stale or already-answered id is left to the server's own
// PermissionNotFoundError rather than a local double-check.
func (a *adapter) RespondToRequest(ctx context.Context, threadID, requestID string, d event.Decision) error {
	a.mu.Lock()
	s := a.sessions[threadID]
	a.mu.Unlock()
	if s == nil {
		return nil
	}
	return a.do(ctx, http.MethodPost, "/api/session/"+s.sessionID+"/permission/"+requestID+"/reply",
		map[string]any{"reply": opencodeReply(d)}, nil)
}

// RespondToUserInput has nothing to answer: no request.opened this file
// raises today originates from a distinct "ask the user a question" flow —
// OpenCode's "question" permission action gates a TOOL asking permission to
// ask, per its own PermissionConfig, not a question/reply endpoint of its
// own, and no such endpoint was found in the running server's /doc schema.
// A no-op is therefore correct, not a gap.
func (a *adapter) RespondToUserInput(context.Context, string, string, map[string]any) error {
	return nil
}

// SetInteractionMode maps onto OpenCode's agent switch
// (POST /api/session/{id}/agent) — unimplemented until the agent names are
// captured, and a no-op rather than a guess.
func (a *adapter) SetInteractionMode(context.Context, string, provider.InteractionMode) error {
	return nil
}

// SetRuntimeMode is a no-op: OpenCode's permission policy is server-wide
// config (the "ask"/"allow"/"deny" rules per action/resource DevDeck's own
// instance config sets, per its own /doc schema), not a per-session value a
// running session can be told to switch — there is no verified endpoint to
// call here, and this package does not guess at unverified RPCs (see
// RespondToRequest's identical stance on the permission reply endpoint,
// which IS verified). Switching the composer's Permission pill has no live
// effect on an OpenCode thread today.
func (a *adapter) SetRuntimeMode(context.Context, string, provider.RuntimeMode) error {
	return nil
}

func (a *adapter) StopSession(ctx context.Context, threadID string) error {
	a.mu.Lock()
	s := a.sessions[threadID]
	delete(a.sessions, threadID)
	if s != nil {
		delete(a.byOpencode, s.sessionID)
	}
	a.mu.Unlock()
	if s == nil {
		return nil
	}
	s.cancel()
	return nil
}

func (a *adapter) StopAll(context.Context) error {
	a.mu.Lock()
	sessions := a.sessions
	a.sessions = map[string]*session{}
	a.byOpencode = map[string]*session{}
	cmd := a.cmd
	a.mu.Unlock()
	for _, s := range sessions {
		s.cancel()
	}
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

// ReadThread and RollbackThread are unimplemented. /api/session/{id}/history
// and /revert/* exist, so these are a known gap rather than an impossibility.
func (a *adapter) ReadThread(context.Context, string) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, fmt.Errorf("opencode: ReadThread not implemented")
}

func (a *adapter) RollbackThread(context.Context, string, int) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, fmt.Errorf("opencode: RollbackThread not implemented")
}

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

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

var _ provider.Adapter = (*adapter)(nil)

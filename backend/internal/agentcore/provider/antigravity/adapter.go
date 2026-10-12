package antigravity

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"maps"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/detect"
	"devdeck/backend/internal/procgroup"
)

type cursor struct {
	ConversationID string     `json:"conversationId"`
	Usage          *wireUsage `json:"usage,omitempty"`
}

type session struct {
	in        provider.SessionStartInput
	startedAt int64
	resume    cursor
	active    *turn
}

type turn struct {
	id     string
	cancel context.CancelFunc
	done   chan struct{}
}

type adapter struct {
	instanceID   provider.InstanceID
	cfg          Config
	env          map[string]string
	ctx          context.Context
	mu           sync.Mutex
	sessions     map[string]*session
	events       chan event.Event
	queue        []event.Event
	wake         chan struct{}
	deliveryStop chan struct{}
	readers      sync.WaitGroup
	closed       bool
}

func newAdapter(ctx context.Context, id provider.InstanceID, cfg Config, env map[string]string) *adapter {
	a := &adapter{instanceID: id, cfg: cfg, env: maps.Clone(env), ctx: ctx,
		sessions: make(map[string]*session), events: make(chan event.Event, 256), wake: make(chan struct{}, 1), deliveryStop: make(chan struct{})}
	go a.deliverEvents()
	go func() {
		<-ctx.Done()
		_ = a.StopAll(context.Background())
		a.readers.Wait()
		a.mu.Lock()
		a.closed = true
		close(a.deliveryStop)
		a.mu.Unlock()
	}()
	return a
}

func (a *adapter) Kind() provider.Kind             { return Kind }
func (a *adapter) InstanceID() provider.InstanceID { return a.instanceID }
func (a *adapter) Events() <-chan event.Event      { return a.events }
func (a *adapter) Capabilities() provider.Capabilities {
	return provider.Capabilities{SessionModelSwitch: provider.ModelSwitchInSession,
		SupportsPlanMode: true, SupportsResume: true,
		// Native CLI MCP/skills still load; DevDeck endpoints cannot be injected.
		SupportsMCP: false}
}

func validate(mode provider.RuntimeMode, interact provider.InteractionMode, model provider.ModelSelection) error {
	if mode != provider.ModeAuto && mode != provider.ModeFullAccess {
		return fmt.Errorf("antigravity: runtime mode %q unsupported; use auto (native permissions) or full-access", mode)
	}
	if !interact.Valid() {
		return fmt.Errorf("antigravity: invalid interaction mode %q", interact)
	}
	for k, v := range model.Options {
		if k != "effort" {
			return fmt.Errorf("antigravity: unsupported model option %q", k)
		}
		effort, ok := v.(string)
		if !ok {
			return fmt.Errorf("antigravity: effort must be a string")
		}
		switch effort {
		case "low", "medium", "high", "xhigh", "max":
		default:
			return fmt.Errorf("antigravity: invalid effort %q", effort)
		}
	}
	return nil
}

func (a *adapter) StartSession(ctx context.Context, in provider.SessionStartInput) (provider.Session, error) {
	if err := ctx.Err(); err != nil {
		return provider.Session{}, err
	}
	if in.Mode == "" {
		in.Mode = provider.ModeAuto
	}
	if in.Interact == "" {
		in.Interact = provider.InteractionDefault
	}
	if err := validate(in.Mode, in.Interact, in.Model); err != nil {
		return provider.Session{}, err
	}
	if in.ThreadID == "" {
		return provider.Session{}, fmt.Errorf("antigravity: thread ID is required")
	}
	var resume cursor
	if len(in.ResumeCursor) > 0 {
		if err := json.Unmarshal(in.ResumeCursor, &resume); err != nil {
			if err = json.Unmarshal(in.ResumeCursor, &resume.ConversationID); err != nil {
				return provider.Session{}, fmt.Errorf("antigravity: invalid resume cursor")
			}
		}
		if resume.ConversationID == "" {
			return provider.Session{}, fmt.Errorf("antigravity: resume cursor has no conversation ID")
		}
	}
	in.Env = maps.Clone(in.Env)
	in.Model.Options = maps.Clone(in.Model.Options)
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.ctx.Err(); err != nil {
		return provider.Session{}, err
	}
	if _, ok := a.sessions[in.ThreadID]; ok {
		return provider.Session{}, fmt.Errorf("antigravity: thread %s already has a session", in.ThreadID)
	}
	s := &session{in: in, resume: resume, startedAt: time.Now().UnixMilli()}
	a.sessions[in.ThreadID] = s
	e := envelope(a.instanceID, in.ThreadID, "", event.SessionStarted)
	e.Payload = &event.SessionStartedPayload{Message: "Antigravity headless session ready"}
	if resume.ConversationID != "" {
		e.Payload.(*event.SessionStartedPayload).Resume, _ = json.Marshal(resume)
	}
	a.emitLocked(e)
	return sessionInfo(s), nil
}

func buildArgs(in provider.SendTurnInput, resume cursor) []string {
	args := []string{"-p", in.Text, "--output-format", "stream-json", "--print-timeout", "0"}
	if resume.ConversationID != "" {
		args = append(args, "--conversation", resume.ConversationID)
	}
	if in.Model.Model != "" {
		args = append(args, "--model", in.Model.Model)
	}
	if effort, ok := in.Model.Options["effort"].(string); ok {
		args = append(args, "--effort", effort)
	}
	if in.Interact == provider.InteractionPlan {
		args = append(args, "--mode", "plan")
	}
	if in.Mode == provider.ModeFullAccess {
		args = append(args, "--dangerously-skip-permissions")
	}
	return args
}

func (a *adapter) SendTurn(ctx context.Context, in provider.SendTurnInput) (provider.TurnStartResult, error) {
	if err := ctx.Err(); err != nil {
		return provider.TurnStartResult{}, err
	}
	if len(in.Attachments) > 0 {
		return provider.TurnStartResult{}, fmt.Errorf("antigravity: attachments are unsupported")
	}
	if in.TurnID == "" || strings.TrimSpace(in.Text) == "" {
		return provider.TurnStartResult{}, fmt.Errorf("antigravity: turn ID and prompt are required")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.ctx.Err(); err != nil {
		return provider.TurnStartResult{}, err
	}
	s := a.sessions[in.ThreadID]
	if s == nil {
		return provider.TurnStartResult{}, fmt.Errorf("antigravity: thread %s has no active session", in.ThreadID)
	}
	if s.active != nil {
		return provider.TurnStartResult{}, fmt.Errorf("antigravity: thread %s already has a running turn", in.ThreadID)
	}
	if in.Mode == "" {
		in.Mode = s.in.Mode
	}
	if in.Interact == "" {
		in.Interact = s.in.Interact
	}
	if in.Model.Model == "" && in.Model.InstanceID == "" {
		in.Model.Model = s.in.Model.Model
	}
	if in.Model.Options == nil && in.Model.InstanceID == "" {
		in.Model.Options = s.in.Model.Options
	}
	if err := validate(in.Mode, in.Interact, in.Model); err != nil {
		return provider.TurnStartResult{}, err
	}
	bin, err := detect.ResolveBinary(a.cfg.BinaryName)
	if err != nil {
		return provider.TurnStartResult{}, fmt.Errorf("antigravity: resolve CLI: %w", err)
	}
	cmd := exec.Command(bin, buildArgs(in, s.resume)...)
	cmd.Dir = s.in.Cwd
	cmd.Env = buildEnv(a.cfg, a.env, s.in.Env)
	cmd.WaitDelay = 2 * time.Second
	prepareProcess(cmd)
	// Own the pipe: Cmd.Wait must not close stdout before the reader drains it.
	stdout, writer, err := os.Pipe()
	if err != nil {
		return provider.TurnStartResult{}, fmt.Errorf("antigravity: stdout: %w", err)
	}
	cmd.Stdout = writer
	stderr := &boundedBuffer{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		_ = stdout.Close()
		_ = writer.Close()
		return provider.TurnStartResult{}, fmt.Errorf("antigravity: start CLI: %w", err)
	}
	_ = writer.Close()
	job, err := procgroup.Attach(cmd.Process)
	if err != nil {
		log.Printf("antigravity: process group: %v", err)
	}
	tctx, cancel := context.WithCancel(a.ctx)
	t := &turn{id: in.TurnID, cancel: cancel, done: make(chan struct{})}
	s.active = t
	s.in.Mode, s.in.Interact = in.Mode, in.Interact
	s.in.Model = in.Model
	s.in.Model.Options = maps.Clone(in.Model.Options)
	e := envelope(a.instanceID, in.ThreadID, in.TurnID, event.TurnStarted)
	e.Payload = &event.TurnStartedPayload{Model: in.Model.Model}
	a.emitLocked(e)
	a.readers.Add(1)
	go a.readTurn(tctx, s, t, cmd, job, stdout, stderr)
	return provider.TurnStartResult{TurnID: in.TurnID}, nil
}

func (a *adapter) readTurn(ctx context.Context, s *session, t *turn, cmd *exec.Cmd, job procgroup.Handle, stdout io.ReadCloser, stderr *boundedBuffer) {
	defer a.readers.Done()
	defer func() { close(t.done); t.cancel() }()
	defer job.Release()
	// A turn's CLI may leave tool descendants after exiting.
	defer killProcess(cmd, job)
	defer stdout.Close()
	scanDone := make(chan struct{})
	waitResult := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		// A descendant retaining stdout must not keep a completed turn alive.
		killProcess(cmd, job)
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		select {
		case <-scanDone:
		case <-timer.C:
			_ = stdout.Close()
		}
		waitResult <- err
	}()
	go func() {
		select {
		case <-t.done:
			return
		case <-ctx.Done():
		}
		interruptProcess(cmd, job)
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		select {
		case <-t.done:
		case <-timer.C:
			killProcess(cmd, job)
		}
	}()
	st := newParseState(a.instanceID, s.in.ThreadID, t.id, s.resume)
	scan := bufio.NewScanner(stdout)
	scan.Buffer(make([]byte, 64<<10), 4<<20)
	var parseErr error
	for scan.Scan() {
		if len(strings.TrimSpace(scan.Text())) == 0 {
			continue
		}
		events, err := st.parse(scan.Bytes())
		if err != nil {
			parseErr = err
			t.cancel()
			break
		}
		a.mu.Lock()
		s.resume = st.resume
		if a.sessions[s.in.ThreadID] == s {
			for _, e := range events {
				a.emitLocked(e)
			}
		}
		a.mu.Unlock()
	}
	if err := scan.Err(); err != nil && !(st.status != "" && errors.Is(err, os.ErrClosed)) {
		parseErr = fmt.Errorf("read stream: %w", err)
		t.cancel()
	}
	if parseErr != nil {
		_ = stdout.Close()
	}
	close(scanDone)
	waitErr := <-waitResult
	status, detail := st.status, st.failure
	if parseErr != nil {
		status, detail = "failed", parseErr.Error()
	}
	if status == "" {
		status, detail = "failed", "CLI exited without a result event"
	}
	if waitErr != nil && !errors.Is(waitErr, exec.ErrWaitDelay) && status == "completed" {
		status, detail = "failed", fmt.Sprintf("CLI exited after result: %v", waitErr)
	}
	if ctx.Err() != nil && parseErr == nil {
		status, detail = "interrupted", ""
	}
	if status == "failed" && stderr.String() != "" {
		detail += ": " + stderr.String()
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sessions[s.in.ThreadID] != s {
		return
	}
	s.active = nil
	if detail != "" {
		e := envelope(a.instanceID, s.in.ThreadID, t.id, event.RuntimeError)
		e.Payload = &event.ErrorPayload{Message: "antigravity: " + detail}
		a.emitLocked(e)
	}
	if status != "failed" && stderr.String() != "" {
		e := envelope(a.instanceID, s.in.ThreadID, t.id, event.RuntimeWarning)
		e.Payload = &event.WarningPayload{Message: "antigravity: " + stderr.String()}
		a.emitLocked(e)
	}
	for _, e := range st.finishItems(status) {
		a.emitLocked(e)
	}
	e := envelope(a.instanceID, s.in.ThreadID, t.id, event.TurnCompleted)
	e.Payload = &event.TurnCompletedPayload{Status: status, Usage: st.turnUsage}
	a.emitLocked(e)
}

func (a *adapter) InterruptTurn(_ context.Context, threadID, turnID string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if s := a.sessions[threadID]; s != nil && s.active != nil && (turnID == "" || s.active.id == turnID) {
		s.active.cancel()
	}
	return nil
}

func (a *adapter) RespondToRequest(context.Context, string, string, event.Decision) error {
	return fmt.Errorf("antigravity: headless approval responses are unsupported; configure native permissions")
}
func (a *adapter) RespondToUserInput(context.Context, string, string, map[string]any) error {
	return fmt.Errorf("antigravity: headless user-input responses are unsupported; send another turn")
}

// Setters affect the next process; they never change a running turn's policy.
func (a *adapter) SetInteractionMode(_ context.Context, threadID string, mode provider.InteractionMode) error {
	if !mode.Valid() {
		return fmt.Errorf("antigravity: invalid interaction mode %q", mode)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if s := a.sessions[threadID]; s != nil {
		s.in.Interact = mode
	}
	return nil
}
func (a *adapter) SetRuntimeMode(_ context.Context, threadID string, mode provider.RuntimeMode) error {
	if err := validate(mode, provider.InteractionDefault, provider.ModelSelection{}); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if s := a.sessions[threadID]; s != nil {
		s.in.Mode = mode
	}
	return nil
}

func (a *adapter) StopSession(ctx context.Context, threadID string) error {
	a.mu.Lock()
	s := a.sessions[threadID]
	delete(a.sessions, threadID)
	var active *turn
	if s != nil {
		active = s.active
	}
	if active != nil {
		active.cancel()
	}
	a.mu.Unlock()
	if active != nil {
		select {
		case <-active.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (a *adapter) StopAll(ctx context.Context) error {
	a.mu.Lock()
	sessions := a.sessions
	a.sessions = make(map[string]*session)
	for _, s := range sessions {
		if s.active != nil {
			s.active.cancel()
		}
	}
	a.mu.Unlock()
	for _, s := range sessions {
		if s.active != nil {
			select {
			case <-s.active.done:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return nil
}

func (a *adapter) HasSession(threadID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[threadID] != nil
}
func sessionInfo(s *session) provider.Session {
	return provider.Session{ThreadID: s.in.ThreadID, ProviderSessionID: s.resume.ConversationID, StartedAt: s.startedAt, Model: s.in.Model.Model}
}
func (a *adapter) ListSessions() []provider.Session {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]provider.Session, 0, len(a.sessions))
	for _, s := range a.sessions {
		out = append(out, sessionInfo(s))
	}
	return out
}
func (a *adapter) ReadThread(_ context.Context, threadID string) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{ThreadID: threadID}, nil
}
func (a *adapter) RollbackThread(context.Context, string, int) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, fmt.Errorf("antigravity: rollback unsupported")
}
func (a *adapter) emitLocked(e event.Event) {
	if a.closed {
		return
	}
	// shortcut: live backlog is unbounded; add backpressure if ingestion can remain stalled.
	a.queue = append(a.queue, e)
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

// One delivery loop preserves stream order under a slow consumer. On adapter
// shutdown it abandons undelivered events so teardown cannot wait on a client.
func (a *adapter) deliverEvents() {
	defer close(a.events)
	for {
		a.mu.Lock()
		if len(a.queue) == 0 {
			a.mu.Unlock()
			select {
			case <-a.wake:
				continue
			case <-a.deliveryStop:
				return
			}
		}
		e := a.queue[0]
		a.mu.Unlock()
		select {
		case a.events <- e:
			a.mu.Lock()
			a.queue[0] = event.Event{}
			a.queue = a.queue[1:]
			if len(a.queue) == 0 {
				a.queue = nil
			}
			a.mu.Unlock()
		case <-a.deliveryStop:
			return
		}
	}
}

type boundedBuffer struct {
	mu   sync.Mutex
	text []byte
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	if room := (8 << 10) - len(b.text); room > 0 {
		b.text = append(b.text, p[:min(room, n)]...)
	}
	return n, nil
}
func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	// CLI diagnostics are plain text; strip terminal/control characters.
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 32 && r != '\n' && r != '\t' || r == 127 {
			return -1
		}
		return r
	}, string(b.text)))
}

var _ provider.Adapter = (*adapter)(nil)

// Package claude adalah CONTOH adapter — sengaja tidak lengkap. Tujuannya
// menunjukkan bentuk terjemahan native -> kanonik, bukan jadi implementasi
// siap pakai.
//
// Catatan transport: t3code memakai npm SDK (@anthropic-ai/claude-agent-sdk)
// yang menyembunyikan proses anak. Dari Go tidak ada SDK setara, jadi kamu
// bicara langsung ke CLI:
//
//	claude --print --output-format stream-json --input-format stream-json \
//	       --include-partial-messages --verbose
//
// Ini memberi NDJSON dua arah di stdin/stdout. Yang HILANG dibanding SDK
// adalah callback canUseTool — di mode ini approval dinegosiasikan lewat
// control request di stream yang sama. Verifikasi bentuknya terhadap versi
// CLI yang kamu pakai sebelum menulis parser: formatnya masih berubah.
package claude

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"sync"

	"example.com/agentcore/approval"
	"example.com/agentcore/event"
	"example.com/agentcore/provider"
)

const Kind provider.Kind = "claude"

type Config struct {
	BinaryPath string            `json:"binaryPath"`
	LaunchArgs string            `json:"launchArgs,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	// HomeDir memisahkan state antar instance. Tanpa ini, dua instance akan
	// saling menimpa kredensial — t3code menemukan ini dan menjadikan
	// (binary + HOME) sebagai cache key.
	HomeDir string `json:"homeDir,omitempty"`
}

func (Config) ProviderKind() provider.Kind { return Kind }

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

type Driver struct{}

func (Driver) Kind() provider.Kind { return Kind }

func (Driver) DefaultConfig() json.RawMessage { return json.RawMessage(`{"binaryPath":"claude"}`) }

func (Driver) DecodeConfig(raw json.RawMessage) (provider.Config, error) {
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("config claude tidak valid: %w", err)
	}
	if c.BinaryPath == "" {
		c.BinaryPath = "claude"
	}
	return c, nil
}

func (Driver) Probe(ctx context.Context, cfg provider.Config) (provider.Snapshot, error) {
	c := cfg.(Config)
	out, err := exec.CommandContext(ctx, c.BinaryPath, "--version").Output()
	if err != nil {
		return provider.Snapshot{
			Kind: Kind, Available: false,
			Detail: fmt.Sprintf("binary %q tidak bisa dijalankan: %v", c.BinaryPath, err),
		}, nil // NB: bukan error. Provider tidak tersedia adalah status, bukan kegagalan.
	}
	return provider.Snapshot{Kind: Kind, Available: true, Version: string(out), BinaryPath: c.BinaryPath}, nil
}

func (Driver) Create(ctx context.Context, spec provider.InstanceSpec) (provider.Adapter, error) {
	c, ok := spec.Config.(Config)
	if !ok {
		return nil, fmt.Errorf("claude: config bertipe salah")
	}
	a := &Adapter{
		instanceID: spec.InstanceID,
		cfg:        c,
		env:        spec.Env,
		broker:     approval.New(),
		events:     make(chan event.Event, 512),
		sessions:   make(map[string]*session),
		seq:        make(map[string]uint64),
	}
	go func() {
		<-ctx.Done()
		_ = a.StopAll(context.Background())
		close(a.events)
	}()
	return a, nil
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

type session struct {
	threadID    string
	nativeID    string
	cmd         *exec.Cmd
	stdin       *json.Encoder
	cancel      context.CancelFunc
	currentTurn string
}

type Adapter struct {
	instanceID provider.InstanceID
	cfg        Config
	env        map[string]string
	broker     *approval.Broker

	events chan event.Event

	mu       sync.RWMutex
	sessions map[string]*session
	seq      map[string]uint64 // itemID -> nomor urut delta
}

func (a *Adapter) Kind() provider.Kind             { return Kind }
func (a *Adapter) InstanceID() provider.InstanceID { return a.instanceID }
func (a *Adapter) Events() <-chan event.Event      { return a.events }

func (a *Adapter) Capabilities() provider.Capabilities {
	return provider.Capabilities{
		SessionModelSwitch: provider.ModelSwitchInSession,
		SupportsPlanMode:   true,
		SupportsResume:     true,
		SupportsMCP:        true,
	}
}

// buildArgs memusatkan pemetaan mode -> flag. Satu-satunya tempat kebijakan
// izin diterjemahkan ke bahasa provider.
func (a *Adapter) buildArgs(in provider.SessionStartInput) []string {
	args := []string{
		"--print",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
	}
	switch in.Mode {
	case provider.ModeAutoAcceptEdits:
		args = append(args, "--permission-mode", "acceptEdits")
	case provider.ModeFullAccess:
		args = append(args, "--permission-mode", "bypassPermissions")
	case provider.ModeAuto:
		args = append(args, "--permission-mode", "auto")
	default:
		// approval-required: biarkan default, semua tool minta izin.
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
		cfg, _ := json.Marshal(map[string]any{
			"mcpServers": map[string]any{
				in.MCPEndpoint.Name: map[string]any{
					"type": "http", "url": in.MCPEndpoint.URL,
					"headers": map[string]string{"Authorization": "Bearer " + in.MCPEndpoint.Token},
				},
			},
		})
		args = append(args, "--mcp-config", string(cfg))
	}
	return args
}

func (a *Adapter) StartSession(ctx context.Context, in provider.SessionStartInput) (provider.Session, error) {
	sctx, cancel := context.WithCancel(context.WithoutCancel(ctx))

	cmd := exec.CommandContext(sctx, a.cfg.BinaryPath, a.buildArgs(in)...)
	cmd.Dir = in.Cwd
	cmd.Env = buildEnv(a.env, a.cfg)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return provider.Session{}, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return provider.Session{}, err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return provider.Session{}, fmt.Errorf("claude: gagal spawn: %w", err)
	}

	s := &session{threadID: in.ThreadID, cmd: cmd, stdin: json.NewEncoder(stdin), cancel: cancel}
	a.mu.Lock()
	a.sessions[in.ThreadID] = s
	a.mu.Unlock()

	go a.readLoop(sctx, s, stdout)

	return provider.Session{ThreadID: in.ThreadID}, nil
}

// readLoop adalah JANTUNG adapter: NDJSON native -> event kanonik.
// Semua pengetahuan tentang bentuk pesan Claude berhenti di fungsi ini.
func (a *Adapter) readLoop(ctx context.Context, s *session, stdout interface{ Read([]byte) (int, error) }) {
	sc := bufio.NewScanner(stdout)
	// Pesan bisa besar (isi file dalam tool result). Default 64KB tidak cukup.
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)

	for sc.Scan() {
		var msg map[string]any
		if err := json.Unmarshal(sc.Bytes(), &msg); err != nil {
			continue // baris rusak jangan mematikan sesi
		}
		a.translate(ctx, s, msg, sc.Bytes())
	}

	a.emit(event.Event{
		Type: event.SessionExited, Provider: string(Kind), ThreadID: s.threadID,
		Payload: &event.SessionExitedPayload{Reason: "stdout closed"},
	})
	a.broker.CancelThread(s.threadID)
}

// translate — kerangka pemetaan. Isi sesuai versi CLI kamu.
func (a *Adapter) translate(ctx context.Context, s *session, msg map[string]any, raw []byte) {
	typ, _ := msg["type"].(string)

	switch typ {
	case "system":
		if sub, _ := msg["subtype"].(string); sub == "init" {
			if sid, ok := msg["session_id"].(string); ok {
				s.nativeID = sid
				cursor, _ := json.Marshal(sid)
				a.emit(event.Event{
					Type: event.SessionStarted, Provider: string(Kind), ThreadID: s.threadID,
					Refs:    &event.Refs{SessionID: sid},
					Payload: &event.SessionStartedPayload{Resume: cursor},
				})
			}
		}

	case "stream_event":
		// Delta streaming. Ambil teksnya, tandai stream text vs reasoning.
		text, stream := extractDelta(msg)
		if text == "" {
			return
		}
		itemID := stringField(msg, "uuid")
		a.emit(event.Event{
			Type: event.ContentDelta, Provider: string(Kind), ThreadID: s.threadID,
			TurnID: s.currentTurn, ItemID: itemID,
			Payload: &event.ContentDeltaPayload{
				ItemType: event.ItemAssistantMessage,
				Stream:   stream, Text: text, Sequence: a.nextSeq(itemID),
			},
			Raw: &event.Raw{Source: "claude.cli", Method: typ, Payload: raw},
		})

	case "control_request":
		// Approval. Alurnya WAJIB: emit RequestOpened -> tunggu broker ->
		// kirim balasan ke stdin -> emit RequestResolved.
		go a.handleApproval(ctx, s, msg)

	case "result":
		status := "completed"
		if b, _ := msg["is_error"].(bool); b {
			status = "failed"
		}
		a.emit(event.Event{
			Type: event.TurnCompleted, Provider: string(Kind), ThreadID: s.threadID,
			TurnID:  s.currentTurn,
			Payload: &event.TurnCompletedPayload{Status: status, Usage: extractUsage(msg)},
		})
	}
}

func (a *Adapter) handleApproval(ctx context.Context, s *session, msg map[string]any) {
	reqID := stringField(msg, "request_id")
	if reqID == "" {
		return
	}
	args, _ := json.Marshal(msg["request"])

	a.emit(event.Event{
		Type: event.RequestOpened, Provider: string(Kind), ThreadID: s.threadID,
		TurnID: s.currentTurn, RequestID: reqID,
		Payload: &event.RequestOpenedPayload{
			RequestType: event.ReqCommandExecApproval,
			Args:        args,
			Options: []event.Decision{
				event.DecisionAccept, event.DecisionAcceptForSession, event.DecisionDecline,
			},
		},
	})

	decision, _ := a.broker.Await(ctx, reqID, s.threadID, event.ReqCommandExecApproval)

	behavior := "deny"
	if decision == event.DecisionAccept || decision == event.DecisionAcceptForSession {
		behavior = "allow"
	}
	a.mu.RLock()
	enc := s.stdin
	a.mu.RUnlock()
	_ = enc.Encode(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"request_id": reqID,
			"subtype":    "success",
			"response":   map[string]any{"behavior": behavior},
		},
	})

	a.emit(event.Event{
		Type: event.RequestResolved, Provider: string(Kind), ThreadID: s.threadID,
		TurnID: s.currentTurn, RequestID: reqID,
		Payload: &event.RequestResolvedPayload{
			RequestType: event.ReqCommandExecApproval, Decision: decision,
		},
	})
}

func (a *Adapter) SendTurn(ctx context.Context, in provider.SendTurnInput) (provider.TurnStartResult, error) {
	a.mu.Lock()
	s, ok := a.sessions[in.ThreadID]
	if ok {
		s.currentTurn = in.TurnID
	}
	a.mu.Unlock()
	if !ok {
		return provider.TurnStartResult{}, fmt.Errorf("claude: sesi %s tidak aktif", in.ThreadID)
	}

	a.emit(event.Event{
		Type: event.TurnStarted, Provider: string(Kind), ThreadID: in.ThreadID,
		TurnID: in.TurnID, Payload: &event.TurnStartedPayload{Model: in.Model.Model},
	})

	return provider.TurnStartResult{TurnID: in.TurnID}, s.stdin.Encode(map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": []map[string]any{{"type": "text", "text": in.Text}},
		},
	})
}

func (a *Adapter) RespondToRequest(ctx context.Context, threadID, requestID string, d event.Decision) error {
	// Jalur callback: broker yang membuka blokir, balasan dikirim oleh
	// handleApproval. Jadi di sini cukup Resolve.
	err := a.broker.Resolve(requestID, d)
	if err == approval.ErrUnknownRequest {
		return nil // sudah selesai / dibatalkan — bukan kegagalan
	}
	return err
}

func (a *Adapter) RespondToUserInput(ctx context.Context, threadID, requestID string, answers map[string]any) error {
	return fmt.Errorf("claude: belum diimplementasikan")
}

func (a *Adapter) InterruptTurn(ctx context.Context, threadID, turnID string) error {
	a.broker.CancelThread(threadID)
	a.mu.RLock()
	s, ok := a.sessions[threadID]
	a.mu.RUnlock()
	if !ok {
		return nil
	}
	return s.stdin.Encode(map[string]any{"type": "control_request", "request": map[string]any{"subtype": "interrupt"}})
}

func (a *Adapter) StopSession(ctx context.Context, threadID string) error {
	a.mu.Lock()
	s, ok := a.sessions[threadID]
	delete(a.sessions, threadID)
	a.mu.Unlock()
	if !ok {
		return nil
	}
	a.broker.CancelThread(threadID)
	s.cancel()
	return nil
}

func (a *Adapter) StopAll(ctx context.Context) error {
	a.mu.Lock()
	ids := make([]string, 0, len(a.sessions))
	for id := range a.sessions {
		ids = append(ids, id)
	}
	a.mu.Unlock()
	for _, id := range ids {
		_ = a.StopSession(ctx, id)
	}
	a.broker.Close()
	return nil
}

func (a *Adapter) HasSession(threadID string) bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	_, ok := a.sessions[threadID]
	return ok
}

func (a *Adapter) ListSessions() []provider.Session {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := make([]provider.Session, 0, len(a.sessions))
	for id := range a.sessions {
		out = append(out, provider.Session{ThreadID: id})
	}
	return out
}

func (a *Adapter) ReadThread(ctx context.Context, threadID string) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{ThreadID: threadID}, nil
}

func (a *Adapter) RollbackThread(ctx context.Context, threadID string, turns int) (provider.ThreadSnapshot, error) {
	return provider.ThreadSnapshot{}, fmt.Errorf("claude: rollback tidak didukung")
}

// emit tidak boleh memblokir readLoop. Kalau konsumen tertinggal, event
// dibuang dan itu disengaja — memblokir di sini akan menghentikan pembacaan
// stdout, yang pada gilirannya membuat proses agent macet.
func (a *Adapter) emit(ev event.Event) {
	select {
	case a.events <- ev:
	default:
	}
}

func (a *Adapter) nextSeq(itemID string) uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.seq[itemID]++
	return a.seq[itemID]
}

// --- helper (stub) ---

func buildEnv(env map[string]string, cfg Config) []string {
	out := make([]string, 0, len(env)+1)
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	if cfg.HomeDir != "" {
		out = append(out, "HOME="+cfg.HomeDir)
	}
	return out
}

func stringField(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func extractDelta(msg map[string]any) (string, event.StreamKind) {
	ev, ok := msg["event"].(map[string]any)
	if !ok {
		return "", event.StreamText
	}
	delta, ok := ev["delta"].(map[string]any)
	if !ok {
		return "", event.StreamText
	}
	if t, ok := delta["thinking"].(string); ok && t != "" {
		return t, event.StreamReasoning
	}
	t, _ := delta["text"].(string)
	return t, event.StreamText
}

func extractUsage(msg map[string]any) *event.Usage {
	u, ok := msg["usage"].(map[string]any)
	if !ok {
		return nil
	}
	num := func(k string) int64 {
		f, _ := u[k].(float64)
		return int64(f)
	}
	return &event.Usage{
		InputTokens:     num("input_tokens"),
		OutputTokens:    num("output_tokens"),
		CacheReadTokens: num("cache_read_input_tokens"),
	}
}

var _ provider.Driver = Driver{}
var _ provider.Adapter = (*Adapter)(nil)

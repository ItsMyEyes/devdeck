package telegram

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/store"
)

// ---------------------------------------------------------------------------
// Fake Telegram transport
// ---------------------------------------------------------------------------

// fakeTransport is the bridge's only network dependency, replaced end to end
// for these tests. It satisfies telegramClient — the narrow interface
// bridge.go declares over *Client's methods — rather than *Client itself,
// which is a concrete struct client.go must not be changed to accommodate
// (see the task brief). Every call is recorded so a test can assert on
// exactly what reached "Telegram", including the zero-calls case that
// TestUnknownSenderIsIgnoredSilently depends on.
type fakeTransport struct {
	mu      sync.Mutex
	sent    []SendOptions
	edits   []editCall
	answers []answerCall
	topics  []topicCall

	nextMsgID int64
	// failSend, when > 0, makes the next N SendMessage calls fail (and
	// decrements). Used by TestLastSeqAdvancesOnlyAfterASuccessfulSend to
	// prove a failed send never advances the replay cursor.
	failSend int
	// failEdit does the same for EditMessageText — the live message is
	// reached by an edit on every tick after the first, so its failure mode
	// needs its own switch.
	failEdit int
	// sendErr, when non-nil, fails EVERY SendMessage with that exact error.
	// A *APIError carrying RetryAfter is how the shutdown test parks the pump
	// inside callWithRetry's retry sleep.
	sendErr error
	// attempts counts every SendMessage call, failures included, so a test
	// can wait for the pump to have actually reached the transport.
	attempts int
	// webhook/webhookErr are what GetWebhookInfo answers. The zero value is
	// "no webhook registered", the healthy case every pre-existing test wants.
	webhook    WebhookInfo
	webhookErr error
	// pins records every pinChatMessage; pinErr fails them all, which is the
	// realistic group case (a bot without can_pin_messages).
	pins    []pinCall
	unpins  []pinCall
	actions []actionCall
	pinErr error
	// topicErr fails createForumTopic — the realistic case of a bot that is
	// not an admin with can_manage_topics.
	topicErr error
}

type pinCall struct {
	ChatID, MessageID int64
}

type actionCall struct {
	ChatID, TopicID int64
	Action          string
}

type editCall struct {
	ChatID, MessageID int64
	Text              string
}

type answerCall struct {
	ID, Text string
}

type topicCall struct {
	ChatID int64
	Name   string
}

func (f *fakeTransport) GetUpdates(ctx context.Context, _ int64, _ int) ([]Update, error) {
	// Almost no test drives the bridge through Run()/pollLoop — they call
	// handleUpdate/sweep directly, which exercises exactly the same code
	// those loops call, without the timing flakiness of a real long-poll
	// goroutine. This blocks like a real long poll rather than returning
	// immediately, so the one test that DOES run the loops
	// (TestRunReturnsPromptlyWhileParkedInARateLimitRetry) is not spinning a
	// hot loop while it works.
	<-ctx.Done()
	return nil, ctx.Err()
}

// GetWebhookInfo answers "no webhook" by default — the healthy case. A test
// that wants the conflict sets webhook to a non-empty WebhookInfo.
func (f *fakeTransport) GetWebhookInfo(context.Context) (WebhookInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.webhook, f.webhookErr
}

func (f *fakeTransport) SendMessage(_ context.Context, o SendOptions) (Message, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attempts++
	if f.sendErr != nil {
		return Message{}, f.sendErr
	}
	if f.failSend > 0 {
		f.failSend--
		return Message{}, fmt.Errorf("fake: send failed")
	}
	f.nextMsgID++
	f.sent = append(f.sent, o)
	return Message{MessageID: f.nextMsgID, Chat: Chat{ID: o.ChatID}}, nil
}

func (f *fakeTransport) EditMessageText(_ context.Context, chatID, messageID int64, text string, _ InlineKeyboard) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failEdit > 0 {
		f.failEdit--
		return &APIError{Code: 400, Desc: "Bad Request: message to edit not found"}
	}
	f.edits = append(f.edits, editCall{ChatID: chatID, MessageID: messageID, Text: text})
	return nil
}

func (f *fakeTransport) sendAttempts() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.attempts
}

func (f *fakeTransport) AnswerCallbackQuery(_ context.Context, id, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answers = append(f.answers, answerCall{ID: id, Text: text})
	return nil
}

func (f *fakeTransport) PinChatMessage(_ context.Context, chatID, messageID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pins = append(f.pins, pinCall{ChatID: chatID, MessageID: messageID})
	return f.pinErr
}

func (f *fakeTransport) SendChatAction(_ context.Context, chatID, topicID int64, action string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.actions = append(f.actions, actionCall{ChatID: chatID, TopicID: topicID, Action: action})
	return nil
}

func (f *fakeTransport) UnpinChatMessage(_ context.Context, chatID, messageID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.unpins = append(f.unpins, pinCall{ChatID: chatID, MessageID: messageID})
	return nil
}

func (f *fakeTransport) CreateForumTopic(_ context.Context, chatID int64, name string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.topics = append(f.topics, topicCall{ChatID: chatID, Name: name})
	if f.topicErr != nil {
		return 0, f.topicErr
	}
	// A distinct id per topic: a project publishes many sessions into one
	// group, and a fake handing them all the same topic id would hide a
	// binding collision the real API could never produce.
	return int64(900 + len(f.topics)), nil
}

// outboundCalls totals every kind of call the fake recorded — the single
// number TestUnknownSenderIsIgnoredSilently needs to be exactly zero.
func (f *fakeTransport) outboundCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent) + len(f.edits) + len(f.answers) + len(f.topics)
}

var _ telegramClient = (*fakeTransport)(nil)

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

// newTestBridge wires a real orchestration.Engine over a real, temp-file
// SQLite store — the same pattern handler.newAgentWSTestEnv uses
// (backend/internal/handler/agent_ws_test.go) — rather than
// orchestration.NewMemStore(). MemStore only implements the engine's narrow
// Store interface (SeenCommand/Commit/EventsSince, context-taking); Deps.Store
// is a port.Store, which needs AgentEventsSince(threadID, seq) and every
// Telegram accessor from Task 1. store.NewTestStore's *store.Store is both a
// port.Store directly AND, once wrapped by orchestration.NewPortStore, an
// orchestration.Store — one object backing both views, so AgentEventsSince
// reads exactly what the engine committed. This is the only combination in
// the codebase that gives a test a real engine AND a real, spec-shaped
// Deps.Store at once.
func newTestBridge(t *testing.T, transport *fakeTransport) (*Bridge, *orchestration.Engine, *store.Store) {
	t.Helper()
	st := store.NewTestStore(t)

	n := 0
	engine := orchestration.NewEngine(orchestration.EngineOptions{
		Store:     orchestration.NewPortStore(st),
		NewID:     func() string { n++; return "ae-" + strconv.Itoa(n) },
		QueueSize: 8,
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go engine.Run(ctx)

	cmdN := 0
	b := New(Deps{
		Store:      st,
		Engine:     engine,
		Client:     transport,
		Pairing:    &Pairing{TTL: 5 * time.Minute, Now: time.Now},
		NewID:      func() string { cmdN++; return "tg-" + strconv.Itoa(cmdN) },
		ListSkills: func() ([]string, error) { return nil, nil },
		Models:     func(string) ([]string, error) { return nil, nil },
		ListAgents: func() ([]domain.AgentSummary, error) { return testAgents, nil },
		Now:        time.Now,
	})
	return b, engine, st
}

// seedThread creates a thread in the engine directly, mirroring
// agent_ws.go's autoCreateThread / engine_test.go's dispatchCreate. Every
// other command the decider accepts requires the thread to already exist.
// testAgents is the catalog /agents offers. One uninstalled entry on
// purpose: a missing binary is a state the picker has to render (shown, not
// tappable) rather than quietly omit.
var testAgents = []domain.AgentSummary{
	{ID: "claude", Name: "Claude", Installed: true},
	{ID: "codex", Name: "Codex", Installed: true},
	{ID: "opencode", Name: "OpenCode", Installed: false},
}

func seedThread(t *testing.T, engine *orchestration.Engine, threadID string) {
	t.Helper()
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: "create-" + threadID, Type: orchestration.CmdThreadCreate, ThreadID: threadID,
		Payload: mustJSON(t, map[string]any{"instanceId": "claude:default"}),
	}); err != nil {
		t.Fatalf("seed thread %s: %v", threadID, err)
	}
}

func mustAllow(t *testing.T, st *store.Store, userID int64) {
	t.Helper()
	if err := st.AddTelegramUser(domain.TelegramUser{UserID: userID, Label: "test", AddedAt: 1}); err != nil {
		t.Fatalf("allow user %d: %v", userID, err)
	}
}

// seedRequestOpened commits the two events Ingestion emits for a real
// approval request (workers.go's RequestOpened case): the forwarded
// event.Event itself, carrying the payload, and the session-set that marks
// the request pending. Skipping the second one would leave
// Thread.PendingRequests empty, and the decider rejects an approval response
// to a request that is not pending — exactly the guard this bridge must
// respect, not bypass.
func seedRequestOpened(t *testing.T, engine *orchestration.Engine, threadID, requestID string, options []event.Decision) {
	t.Helper()
	inner := event.Event{
		Type: event.RequestOpened, ThreadID: threadID, RequestID: requestID,
		Payload: &event.RequestOpenedPayload{
			RequestType: event.ReqCommandExecApproval,
			Detail:      "rm -rf /tmp/build",
			Options:     options,
		},
	}
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: "req-open-" + requestID, Type: orchestration.CmdThreadActivityAppend, ThreadID: threadID,
		Payload: mustJSON(t, inner),
	}); err != nil {
		t.Fatalf("seed request opened: %v", err)
	}
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: "req-pending-" + requestID, Type: orchestration.CmdThreadSessionSet, ThreadID: threadID,
		Payload: mustJSON(t, map[string]any{"status": "waiting", "pendingRequestAdd": requestID}),
	}); err != nil {
		t.Fatalf("seed pending: %v", err)
	}
}

// fakeQuestion/fakeOption build the raw JSON for
// event.UserInputRequestedPayload.Questions without importing render.go's
// unexported userInputQuestion type — json.Unmarshal only cares about field
// names matching, not Go type identity, so this is a faithful stand-in for
// what the claude provider adapter actually emits.
type fakeOption struct {
	Label string `json:"label"`
}

type fakeQuestion struct {
	ID       string       `json:"id,omitempty"`
	Question string       `json:"question"`
	Options  []fakeOption `json:"options"`
}

func seedUserInputRequested(t *testing.T, engine *orchestration.Engine, threadID, requestID string, questions []fakeQuestion) {
	t.Helper()
	inner := event.Event{
		Type: event.UserInputRequested, ThreadID: threadID, RequestID: requestID,
		Payload: &event.UserInputRequestedPayload{Questions: mustJSON(t, questions)},
	}
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: "ui-open-" + requestID, Type: orchestration.CmdThreadActivityAppend, ThreadID: threadID,
		Payload: mustJSON(t, inner),
	}); err != nil {
		t.Fatalf("seed user input requested: %v", err)
	}
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: "ui-pending-" + requestID, Type: orchestration.CmdThreadSessionSet, ThreadID: threadID,
		Payload: mustJSON(t, map[string]any{"status": "waiting", "pendingRequestAdd": requestID}),
	}); err != nil {
		t.Fatalf("seed pending: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Required tests
// ---------------------------------------------------------------------------

// This bot can approve systemctl and rm on production servers. An update
// from a user id NOT on the allowlist must produce ZERO outbound calls — not
// an error reply, not a toast, nothing — because even a rejection confirms
// the bot exists and is listening on this chat.
//
// A user is seeded onto the allowlist FIRST (id 1, distinct from the sender
// under test) so this pins the property that actually matters post trust-on-
// first-use: once the allowlist is non-empty, an unknown sender is still
// dropped in silence. The empty-allowlist case is deliberately a DIFFERENT
// property now (auto-enrolment) — see
// TestEmptyAllowlistAutoEnrolsFirstSenderAndProcessesTheMessage.
func TestUnknownSenderIsIgnoredSilently(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	mustAllow(t, st, 1) // makes the allowlist non-empty; sender 9999 stays off it

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 9999}, Chat: Chat{ID: 100}, Text: "jalankan rm -rf /",
	}})

	if n := transport.outboundCalls(); n != 0 {
		t.Fatalf("unknown sender produced %d outbound call(s), want 0", n)
	}
	evts, err := st.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	for _, e := range evts {
		if e.Type == orchestration.EvtThreadTurnStartRequested {
			t.Fatalf("unknown sender's message started a turn")
		}
	}
}

// /pair is the one command an unlisted sender may run — it is how a stranger
// stops being a stranger. A live code enrols the sender and the bridge
// confirms it.
func TestPairEnrolsTheSenderAndConfirms(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	code := b.pairing.Issue()

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 555, Username: "kiyora"}, Chat: Chat{ID: 100}, Text: "/pair " + code,
	}})

	users, err := st.TelegramUsers()
	if err != nil {
		t.Fatalf("users: %v", err)
	}
	if len(users) != 1 || users[0].UserID != 555 {
		t.Fatalf("users = %+v, want exactly [555]", users)
	}
	if n := len(transport.sent); n != 1 {
		t.Fatalf("want 1 confirmation reply, got %d", n)
	}
}

// ---------------------------------------------------------------------------
// Trust-on-first-use (Change 1) & never-silent-authorized-sender (Change 2)
// ---------------------------------------------------------------------------

// While the allowlist is EMPTY, the very first sender to reach handleMessage
// is enrolled automatically (trust-on-first-use, replacing mandatory
// pairing) and their message is processed normally — not merely
// acknowledged and dropped. This is the actual bug fix: an operator who sets
// a bot token and messages the bot gets a live thread AND a reply, not the
// silence that made the product look broken.
// Publishing a connection with /init writes a BINDING and nothing else. The
// engine only learns a thread exists when something creates it, and for the
// browser that is agent_ws.go's autoCreateThread on the WebSocket hello. So
// "set it up at the desk, then use it from a phone" — without ever opening
// that chat on the desktop — reached the decider with a thread it had never
// heard of, which rejected the turn ("thread ... does not exist"). startTurn
// logged that and returned, so the operator got silence: the same dead end as
// the empty allowlist, one step further along the happy path.
func TestTurnOnANeverOpenedThreadCreatesItInsteadOfGoingSilent(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 1)
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "ssh:c-never", ChatID: 500}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	if _, ok := engine.State().Thread("ssh:c-never"); ok {
		t.Fatal("precondition broken: this test is only meaningful if the thread does NOT exist yet")
	}

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 1, Username: "kiyora"}, Chat: Chat{ID: 500, Type: "private"},
		Text: "restart nginx",
	}})

	th, ok := engine.State().Thread("ssh:c-never")
	if !ok {
		t.Fatal("thread was never created — the turn was rejected and the operator got silence")
	}
	// An empty InstanceID matches no driver: the thread would exist and then
	// fail every turn with "thread is not bound to an instance".
	if th.InstanceID == "" {
		t.Fatal("thread created with an empty InstanceID; every turn on it would fail")
	}
	if th.Status != orchestration.ThreadRunning {
		t.Fatalf("turn did not start on the freshly created thread: status=%q", th.Status)
	}
}

// The EXACT state a fresh install lands in, reproduced from a live diagnosis:
// a token set and the bridge enabled, but `telegram_users` empty AND
// `telegram_bindings` empty. Before trust-on-first-use, this combination made
// the bot answer every message with total silence — the operator had no way to
// tell a broken token from a working bridge waiting on a `/pair` flow they had
// never heard of.
//
// The neighbouring auto-enrol test seeds a binding first, so it exercises a
// strictly easier path. Nothing pinned the no-binding case, which is the one
// every new operator actually hits first.
func TestEmptyAllowlistAndNoBindingStillAnswersTheFirstMessage(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	// No mustAllow, and deliberately no SetTelegramBinding: this is a bot that
	// has just been given a token and nothing else.

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 777, Username: "operator"}, Chat: Chat{ID: 555, Type: "private"},
		Text: "halo",
	}})

	users, err := st.TelegramUsers()
	if err != nil {
		t.Fatalf("users: %v", err)
	}
	if len(users) != 1 || users[0].UserID != 777 {
		t.Fatalf("users = %+v, want the first sender auto-enrolled", users)
	}

	transport.mu.Lock()
	sent := append([]SendOptions(nil), transport.sent...)
	transport.mu.Unlock()

	if len(sent) == 0 {
		t.Fatal("the bot said NOTHING — this is the exact silence the fix exists to remove")
	}
	var all string
	for _, s := range sent {
		if s.ChatID != 555 {
			t.Fatalf("replied to chat %d, want 555", s.ChatID)
		}
		all += s.Text + "\n"
	}
	// It must not merely make a noise: an operator in this state needs to be
	// told what to do next, which is to publish a thread and run /init here.
	if !strings.Contains(all, "/init") {
		t.Fatalf("reply never mentions /init, so it leaves the operator no next step:\n%s", all)
	}
}

func TestEmptyAllowlistAutoEnrolsFirstSenderAndProcessesTheMessage(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	// Deliberately no mustAllow call — this IS what an empty allowlist looks
	// like.

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 777, Username: "operator"}, Chat: Chat{ID: 100},
		Text: "restart the api",
	}})

	users, err := st.TelegramUsers()
	if err != nil {
		t.Fatalf("users: %v", err)
	}
	if len(users) != 1 || users[0].UserID != 777 {
		t.Fatalf("users = %+v, want exactly [777] auto-enrolled", users)
	}
	th, ok := engine.State().Thread("w-abc")
	if !ok || th.Status != orchestration.ThreadRunning {
		t.Fatalf("auto-enrolled sender's message was not processed: %+v", th)
	}
	if len(transport.sent) == 0 {
		t.Fatalf("auto-enrolled sender got no reply at all — the exact silence this change fixes")
	}
}

// Trust-on-first-use fires exactly ONCE: the moment the allowlist holds
// anyone it is no longer empty, so a second, different sender arriving after
// the first gets the pre-existing rule — dropped in silence, not enrolled as
// a free second owner.
func TestAutoEnrolOnlyEverFiresForTheFirstSender(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 111}, Chat: Chat{ID: 100}, Text: "hi",
	}})
	sentAfterFirst := transport.outboundCalls()

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 2, From: &User{ID: 222}, Chat: Chat{ID: 100}, Text: "hi again",
	}})

	users, err := st.TelegramUsers()
	if err != nil {
		t.Fatalf("users: %v", err)
	}
	if len(users) != 1 || users[0].UserID != 111 {
		t.Fatalf("users = %+v, want exactly [111] — the second sender must not be auto-enrolled", users)
	}
	if n := transport.outboundCalls(); n != sentAfterFirst {
		t.Fatalf("the second, un-enrolled sender produced an outbound call: before=%d after=%d", sentAfterFirst, n)
	}
}

// Change 2: an allowlisted sender who sends plain text to a chat with no
// binding gets told what to do about it, instead of the same dead silence
// that made the operator think the bridge was broken.
func TestAllowlistedSenderInUnboundChatGetsAnInitNudge(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)
	// Deliberately no binding for (chatID 100, topic 0).

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: 100}, Text: "hello?",
	}})

	if len(transport.sent) != 1 || !strings.Contains(transport.sent[0].Text, "/init") {
		t.Fatalf("want exactly one reply naming /init, got %+v", transport.sent)
	}
}

// A textless update (sticker, photo, voice note) landing on an unbound chat
// must stay silent — Change 2 answers plain TEXT, not every update, or this
// would reply to every sticker sent at a not-yet-published chat.
func TestTextlessMessageInUnboundChatProducesNoReply(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: 100}, Text: "   ",
	}})

	if n := transport.outboundCalls(); n != 0 {
		t.Fatalf("a textless message in an unbound chat produced %d outbound call(s), want 0", n)
	}
	th, ok := engine.State().Thread("w-abc")
	if !ok || th.Status == orchestration.ThreadRunning {
		t.Fatalf("a textless message started a turn: %+v", th)
	}
}

// failingAddUserStore wraps a real store but makes AddTelegramUser always
// fail — the seam needed to prove auto-enrolment fails CLOSED: a write that
// never lands on disk must not grant the message that triggered it any
// authorization at all.
type failingAddUserStore struct {
	*store.Store
}

func (f *failingAddUserStore) AddTelegramUser(domain.TelegramUser) error {
	return fmt.Errorf("fake: store unavailable")
}

var _ port.Store = (*failingAddUserStore)(nil)

// If the enrolment write itself fails, the sender that triggered it must NOT
// be treated as authorized: no turn started and nothing left in the
// allowlist. Processing the message anyway would grant access that was
// never durably recorded.
func TestAutoEnrolStoreFailureDoesNotAuthorizeTheMessage(t *testing.T) {
	transport := &fakeTransport{}
	st := store.NewTestStore(t)
	failing := &failingAddUserStore{Store: st}

	n := 0
	engine := orchestration.NewEngine(orchestration.EngineOptions{
		Store:     orchestration.NewPortStore(st),
		NewID:     func() string { n++; return "ae-" + strconv.Itoa(n) },
		QueueSize: 8,
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go engine.Run(ctx)

	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	cmdN := 0
	b := New(Deps{
		Store: failing, Engine: engine, Client: transport,
		Pairing:    &Pairing{TTL: 5 * time.Minute, Now: time.Now},
		NewID:      func() string { cmdN++; return "tg-" + strconv.Itoa(cmdN) },
		ListSkills: func() ([]string, error) { return nil, nil },
		Models:     func(string) ([]string, error) { return nil, nil },
		ListAgents: func() ([]domain.AgentSummary, error) { return testAgents, nil },
		Now:        time.Now,
	})

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 999}, Chat: Chat{ID: 100}, Text: "hello",
	}})

	users, err := st.TelegramUsers()
	if err != nil {
		t.Fatalf("users: %v", err)
	}
	if len(users) != 0 {
		t.Fatalf("users = %+v, want none — the write failed", users)
	}
	th, ok := engine.State().Thread("w-abc")
	if !ok || th.Status == orchestration.ThreadRunning {
		t.Fatalf("a failed auto-enrolment still processed the message: %+v", th)
	}
}

// A message in a bound (chatId, topicId) starts a turn on THAT thread, and
// no other — the whole point of §0.2's "one binding = one destination" is
// that there is no shared "active thread" state a message could land on by
// mistake.
func TestPlainTextFromBoundChatStartsATurn(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-bound")
	seedThread(t, engine, "w-other")
	mustAllow(t, st, 42)
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-bound", ChatID: 100, TopicID: 7}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: 100, IsForum: true}, MessageThreadID: 7,
		Text: "restart the api",
	}})

	th, ok := engine.State().Thread("w-bound")
	if !ok || th.Status != orchestration.ThreadRunning {
		t.Fatalf("bound thread = %+v, want running", th)
	}
	other, ok := engine.State().Thread("w-other")
	if !ok || other.Status == orchestration.ThreadRunning {
		t.Fatalf("turn leaked onto an unrelated thread: %+v", other)
	}
}

// Allowlisted sender, but no binding exists for (chatId, topicId): the
// message must not fall back to some default or most-recent thread.
func TestMessageFromAnUnboundChatStartsNothing(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)
	// Deliberately no binding for (chatID 100, topic 0).

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: 100}, Text: "hello?",
	}})

	th, ok := engine.State().Thread("w-abc")
	if !ok || th.Status == orchestration.ThreadRunning {
		t.Fatalf("an unbound chat must not start a turn on any thread, got %+v", th)
	}
}

// A callback whose data is a token the bridge itself minted (via a real
// sweep, sending a real approval card) dispatches CmdThreadApprovalRespond
// with the exact requestId and decision that card advertised.
func TestCallbackAnswersTheApproval(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	seedRequestOpened(t, engine, "w-abc", "req-1", []event.Decision{event.DecisionAccept, event.DecisionDecline})

	b.sweep(context.Background())

	if len(transport.sent) != 1 || len(transport.sent[0].Keyboard) == 0 {
		t.Fatalf("expected exactly one approval card, got %+v", transport.sent)
	}
	token := transport.sent[0].Keyboard[0][0].CallbackData

	mustAllow(t, st, 42)
	b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID: "cbq-1", From: &User{ID: 42}, Data: token,
		Message: &Message{MessageID: 55, Chat: Chat{ID: 100}},
	}})

	evts, err := st.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	var found bool
	for _, e := range evts {
		if e.Type != orchestration.EvtThreadApprovalResponseRequested {
			continue
		}
		var p orchestration.ApprovalRespondPayload
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			t.Fatalf("decode approval payload: %v", err)
		}
		if p.RequestID != "req-1" || p.Decision != event.DecisionAccept {
			t.Fatalf("approval payload = %+v, want req-1/accept", p)
		}
		found = true
	}
	if !found {
		t.Fatalf("no thread.approval-response-requested event committed")
	}
}

// An unrecognised cb: token — never minted by this process — must answer the
// callback with an error toast and dispatch NOTHING. Guessing a requestId
// here would let a stranger approve a command the operator never even saw.
func TestStaleCallbackTokenIsRejectedNotGuessed(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)

	before, err := st.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("events before: %v", err)
	}

	b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID: "cbq-1", From: &User{ID: 42}, Data: "cb:deadbeef",
		Message: &Message{MessageID: 55, Chat: Chat{ID: 100}},
	}})

	after, err := st.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("events after: %v", err)
	}
	if len(after) != len(before) {
		t.Fatalf("a stale token dispatched something: before=%d after=%d", len(before), len(after))
	}
	if len(transport.answers) != 1 || transport.answers[0].Text == "" {
		t.Fatalf("want exactly one non-empty error toast, got %+v", transport.answers)
	}
	if len(transport.sent) != 0 {
		t.Fatalf("a stale token must not send anything else, got %d sends", len(transport.sent))
	}
}

// Commits events to the engine WITHOUT ever calling Run() — so nothing is
// draining Engine.Subscribe, a direct stand-in for §0.3's "slow subscriber"
// scenario, where Engine.publish drops batches by design. The event must
// still reach Telegram once sweep() runs, because sweep reads
// AgentEventsSince(threadID, binding.LastSeq) — the durable log — not the
// subscription channel.
func TestOutboundReplaysFromLastSeqNotFromTheSubscription(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: "turn-1", Type: orchestration.CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustJSON(t, orchestration.TurnStartPayload{Text: "cek status server"}),
	}); err != nil {
		t.Fatalf("turn start: %v", err)
	}

	b.sweep(context.Background())

	if len(transport.sent) == 0 {
		t.Fatalf("no message reached Telegram via replay")
	}
	if !strings.Contains(transport.sent[0].Text, "cek status server") {
		t.Fatalf("live message = %q, missing the user's text", transport.sent[0].Text)
	}
}

// A send failure must not move the replay cursor, and the SAME events must
// go out again next tick — the buffer (here, the durable event log itself)
// is the queue, and losing content on a transient failure is the one thing
// this pump must never do.
func TestLastSeqAdvancesOnlyAfterASuccessfulSend(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: "turn-1", Type: orchestration.CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustJSON(t, orchestration.TurnStartPayload{Text: "deploy"}),
	}); err != nil {
		t.Fatalf("turn start: %v", err)
	}

	transport.mu.Lock()
	transport.failSend = 1
	transport.mu.Unlock()

	b.sweep(context.Background())

	binding, err := st.TelegramBindingByThread("w-abc")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding.LastSeq != 0 {
		t.Fatalf("LastSeq advanced to %d despite a failed send", binding.LastSeq)
	}
	if len(transport.sent) != 0 {
		t.Fatalf("a failed send must not have recorded a sent message, got %d", len(transport.sent))
	}

	// Second sweep: the same events must be re-read from the log (the
	// cursor never moved) and this time the transport accepts them.
	b.sweep(context.Background())

	binding, err = st.TelegramBindingByThread("w-abc")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding.LastSeq == 0 {
		t.Fatalf("LastSeq did not advance after a successful send")
	}
	// Two, not one: a prompt renders as its own message plus the "memproses…"
	// that follows it (renderMessageSent).
	if len(transport.sent) != 2 {
		t.Fatalf("want the echo and the loading notice after the retry, got %d", len(transport.sent))
	}
	if !strings.Contains(transport.sent[0].Text, "deploy") {
		t.Fatalf("resent message = %q, missing the original text", transport.sent[0].Text)
	}
}

// §5a: a multi-question AskUserQuestion prompt sends one card per question
// and accumulates answers in memory. Answering only the first question must
// dispatch NOTHING — a partial Answers map reaches the agent as no answer at
// all (orchestration.UserInputRespondPayload's doc comment). Only once every
// question has an answer does the bridge dispatch
// CmdThreadUserInputRespond, exactly once, with the complete map.
func TestMultiQuestionInputDispatchesOnlyWhenEveryQuestionIsAnswered(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	mustAllow(t, st, 42)

	questions := []fakeQuestion{
		{Question: "Deploy ke production?", Options: []fakeOption{{Label: "Ya"}, {Label: "Tidak"}}},
		{Question: "Restart service setelahnya?", Options: []fakeOption{{Label: "Ya"}, {Label: "Tidak"}}},
	}
	seedUserInputRequested(t, engine, "w-abc", "req-ui-1", questions)

	b.sweep(context.Background())

	if len(transport.sent) != 2 {
		t.Fatalf("want one card per question, got %d messages: %+v", len(transport.sent), transport.sent)
	}
	token1 := transport.sent[0].Keyboard[0][0].CallbackData
	token2 := transport.sent[1].Keyboard[0][0].CallbackData

	countDispatches := func() int {
		evts, err := st.AgentEventsSince("w-abc", 0)
		if err != nil {
			t.Fatalf("events: %v", err)
		}
		n := 0
		for _, e := range evts {
			if e.Type == orchestration.EvtThreadUserInputResponseRequested {
				n++
			}
		}
		return n
	}

	b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID: "cbq-1", From: &User{ID: 42}, Data: token1,
		Message: &Message{MessageID: 1, Chat: Chat{ID: 100}},
	}})
	if n := countDispatches(); n != 0 {
		t.Fatalf("answering only the first question must not dispatch, got %d dispatch(es)", n)
	}

	b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID: "cbq-2", From: &User{ID: 42}, Data: token2,
		Message: &Message{MessageID: 2, Chat: Chat{ID: 100}},
	}})

	evts, err := st.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	var found orchestration.UserInputRespondPayload
	count := 0
	for _, e := range evts {
		if e.Type != orchestration.EvtThreadUserInputResponseRequested {
			continue
		}
		count++
		if err := json.Unmarshal(e.Payload, &found); err != nil {
			t.Fatalf("decode user-input payload: %v", err)
		}
	}
	if count != 1 {
		t.Fatalf("want exactly 1 dispatch once both questions are answered, got %d", count)
	}
	if found.RequestID != "req-ui-1" {
		t.Fatalf("requestId = %q, want req-ui-1", found.RequestID)
	}
	if _, ok := found.Answers["Deploy ke production?"]; !ok {
		t.Fatalf("answers missing the first question, keyed by its full text: %+v", found.Answers)
	}
	if _, ok := found.Answers["Restart service setelahnya?"]; !ok {
		t.Fatalf("answers missing the second question, keyed by its full text: %+v", found.Answers)
	}
}

// ---------------------------------------------------------------------------
// Review regression tests
// ---------------------------------------------------------------------------

// seedDelta commits one assistant text delta, the event the live message is
// built out of.
func seedDelta(t *testing.T, engine *orchestration.Engine, threadID, commandID, text string, seq uint64) {
	t.Helper()
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: commandID, Type: orchestration.CmdThreadAssistantDelta, ThreadID: threadID,
		Payload: mustJSON(t, orchestration.AssistantDeltaPayload{
			ItemID: "i1", Stream: event.StreamText, Text: text, Sequence: seq,
		}),
	}); err != nil {
		t.Fatalf("seed delta %s: %v", commandID, err)
	}
}

// seedTurnEnd commits the TurnCompleted that closes a turn — the signal the
// pump flushes buffered prose on. Prose is never sent without one.
func seedTurnEnd(t *testing.T, engine *orchestration.Engine, threadID, commandID string) {
	t.Helper()
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: commandID, Type: orchestration.CmdThreadActivityAppend, ThreadID: threadID,
		Payload: mustJSON(t, event.Event{Type: event.TurnCompleted, ThreadID: threadID}),
	}); err != nil {
		t.Fatalf("seed turn end %s: %v", commandID, err)
	}
}

// A sweep only reads the events AFTER the persisted cursor, so the deltas it
// sees are a fragment of the turn, not the whole of it. The pump therefore
// holds prose until the turn ends AND refuses to advance the cursor past
// anything still buffered — so a fragment can never be sent as if it were the
// whole answer, and a restart mid-turn re-reads it rather than losing it.
func TestBufferedProseIsSentAsOneMessageWhenTheTurnEnds(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	// Drain the thread-created event first, so the cursor below moves only if
	// the pump advanced past the DELTA — which is the thing under test.
	b.sweep(context.Background())
	base, err := st.TelegramBindingByThread("w-abc")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}

	seedDelta(t, engine, "w-abc", "d1", "SEGMENT-ONE ", 1)
	b.sweep(context.Background())

	// Nothing yet: a half-finished sentence is not a chat message.
	if len(transport.sent) != 0 {
		t.Fatalf("prose was sent before the turn ended: %+v", transport.sent)
	}
	binding, err := st.TelegramBindingByThread("w-abc")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding.LastSeq != base.LastSeq {
		t.Fatalf("cursor advanced past prose that was never sent (%d -> %d)", base.LastSeq, binding.LastSeq)
	}

	seedDelta(t, engine, "w-abc", "d2", "SEGMENT-TWO", 2)
	seedTurnEnd(t, engine, "w-abc", "end-1")
	b.sweep(context.Background())

	if len(transport.sent) == 0 {
		t.Fatal("the turn ended and nothing was sent")
	}
	// Escaped, because "-" is a MarkdownV2 special and an unescaped one 400s
	// the send. That the escaping ran over the JOINED text is the point: a
	// per-delta pass would have had to escape each half separately.
	got := transport.sent[0].Text
	if !strings.Contains(got, `SEGMENT\-ONE`) || !strings.Contains(got, `SEGMENT\-TWO`) {
		t.Fatalf("answer = %q, want both fragments in ONE message", got)
	}
	if len(transport.edits) != 0 {
		t.Fatalf("the chat transcript must never be edited: %+v", transport.edits)
	}
}

// The pump sweeps on every engine wakeup. A sweep carrying only bookkeeping
// must send nothing at all — a message per wakeup would burn the per-chat
// rate limit and bury the actual transcript.
func TestSweepWithoutRenderableContentSendsNothing(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	seedDelta(t, engine, "w-abc", "d1", "halo", 1)
	seedTurnEnd(t, engine, "w-abc", "end-1")
	b.sweep(context.Background())
	before := len(transport.sent)

	// A bookkeeping event renders as nothing at all.
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: "sess-1", Type: orchestration.CmdThreadSessionSet, ThreadID: "w-abc",
		Payload: mustJSON(t, map[string]any{"status": "running"}),
	}); err != nil {
		t.Fatalf("session set: %v", err)
	}
	b.sweep(context.Background())

	if len(transport.sent) != before {
		t.Fatalf("a content-free sweep sent something anyway: %+v", transport.sent[before:])
	}
}

// Repointing a binding must send everything after it to the NEW destination.
// (Under the old edit-in-place pump this was a wedging bug: the retained
// message id named a message in the old chat, and editing it at the new one
// failed non-retryably forever. A chat that only ever appends cannot hit
// that, but the routing itself still has to be right.)
func TestRepointedBindingSendsToTheNewDestination(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	seedDelta(t, engine, "w-abc", "d1", "pertama", 1)
	seedTurnEnd(t, engine, "w-abc", "end-1")
	b.sweep(context.Background())

	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 200, TopicID: 5}); err != nil {
		t.Fatalf("repoint: %v", err)
	}
	seedDelta(t, engine, "w-abc", "d2", "kedua", 2)
	seedTurnEnd(t, engine, "w-abc", "end-2")
	b.sweep(context.Background())

	if len(transport.edits) != 0 {
		t.Fatalf("edited a message belonging to the old chat: %+v", transport.edits)
	}
	if len(transport.sent) != 2 {
		t.Fatalf("want one message per turn, got sends %+v", transport.sent)
	}
	if transport.sent[1].ChatID != 200 || transport.sent[1].TopicID != 5 {
		t.Fatalf("second message went to %+v, want chat 200 topic 5", transport.sent[1])
	}
	binding, err := st.TelegramBindingByThread("w-abc")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding.LastSeq == 0 {
		t.Fatalf("the cursor stalled after the repoint")
	}
}

// A send that fails mid-turn must lose nothing: the cursor stays put, and the
// next sweep rebuilds the same answer from the event log and sends it again.
// Duplicating is recoverable; losing the answer is not.
func TestFailedProseSendIsRebuiltAndRetried(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	seedDelta(t, engine, "w-abc", "d1", "AAA", 1)
	seedDelta(t, engine, "w-abc", "d2", "BBB", 2)
	seedTurnEnd(t, engine, "w-abc", "end-1")

	transport.mu.Lock()
	transport.failSend = 1
	transport.mu.Unlock()
	b.sweep(context.Background())

	binding, err := st.TelegramBindingByThread("w-abc")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	seqAfterFailure := binding.LastSeq
	if seqAfterFailure != 0 {
		t.Fatalf("cursor advanced past a failed send (LastSeq=%d)", seqAfterFailure)
	}

	b.sweep(context.Background())

	if len(transport.sent) != 1 {
		t.Fatalf("want the answer delivered exactly once on retry, got %+v", transport.sent)
	}
	got := transport.sent[0].Text
	if !strings.Contains(got, "AAA") || !strings.Contains(got, "BBB") {
		t.Fatalf("retried message = %q, want both fragments", got)
	}
	binding, err = st.TelegramBindingByThread("w-abc")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding.LastSeq <= seqAfterFailure {
		t.Fatalf("cursor never recovered: %d -> %d", seqAfterFailure, binding.LastSeq)
	}
}

// Unpublishing must not leave the old live-message bookkeeping behind: a
// later republish would resume by editing a message that belongs to a binding
// the operator already threw away.
func TestUnpublishForgetsTheLiveMessage(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	seedDelta(t, engine, "w-abc", "d1", "halo", 1)
	b.sweep(context.Background())

	if err := st.DeleteTelegramBinding("w-abc"); err != nil {
		t.Fatalf("unpublish: %v", err)
	}
	b.sweep(context.Background())

	b.chatsMu.Lock()
	_, stale := b.chats["w-abc"]
	b.chatsMu.Unlock()
	if stale {
		t.Fatalf("an unpublished thread kept its live-message state")
	}
}

// Most cards are never tapped — the operator usually answers in the browser —
// so a token map that only shrinks on a tap grows for the life of the
// process. Expired tokens must stop resolving AND stop occupying memory.
func TestCallbackTokensExpireAndAreEvicted(t *testing.T) {
	transport := &fakeTransport{}
	b, _, _ := newTestBridge(t, transport)
	base := time.Unix(1_700_000_000, 0)
	now := base
	b.now = func() time.Time { return now }

	token := b.mintCallback(callbackTarget{
		Kind: cbApproval, ThreadID: "w-abc", RequestID: "req-1", Decision: event.DecisionAccept,
	})
	if _, ok := b.resolveCallback(token); !ok {
		t.Fatalf("a freshly minted token must resolve")
	}

	now = base.Add(callbackTokenTTL + time.Minute)
	if _, ok := b.resolveCallback(token); ok {
		t.Fatalf("an expired token still resolves — a card from a day ago can still approve a command")
	}
	b.mintCallback(callbackTarget{Kind: cbApproval, ThreadID: "w-abc", RequestID: "req-2"})
	b.cbMu.Lock()
	n := len(b.cb)
	b.cbMu.Unlock()
	if n != 1 {
		t.Fatalf("expired tokens were not pruned: %d entries left", n)
	}

	for i := 0; i < maxCallbackTokens+16; i++ {
		b.mintCallback(callbackTarget{Kind: cbApproval, ThreadID: "w-abc", RequestID: "req-flood"})
	}
	b.cbMu.Lock()
	n = len(b.cb)
	b.cbMu.Unlock()
	if n > maxCallbackTokens {
		t.Fatalf("token map grew past its ceiling: %d entries", n)
	}
}

// Routing a callback on "which field happens to be non-empty" reclassifies a
// question that carries no text as an APPROVAL, and dispatches
// CmdThreadApprovalRespond with an empty decision against a real pending
// request. On a thread that runs shell commands on a production server, an
// answer must never turn into a decision.
func TestUserInputTokenIsNeverActedOnAsAnApproval(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	mustAllow(t, st, 42)
	seedUserInputRequested(t, engine, "w-abc", "req-ui-1", []fakeQuestion{
		{ID: "q-0", Question: "", Options: []fakeOption{{Label: "Ya"}}},
	})

	b.sweep(context.Background())
	if len(transport.sent) != 1 {
		t.Fatalf("want one question card, got %+v", transport.sent)
	}
	token := transport.sent[0].Keyboard[0][0].CallbackData

	b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID: "cbq-1", From: &User{ID: 42}, Data: token,
		Message: &Message{MessageID: 1, Chat: Chat{ID: 100}},
	}})

	evts, err := st.AgentEventsSince("w-abc", 0)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	var answers orchestration.UserInputRespondPayload
	for _, e := range evts {
		if e.Type == orchestration.EvtThreadApprovalResponseRequested {
			t.Fatalf("a question answer was dispatched as an approval decision")
		}
		if e.Type == orchestration.EvtThreadUserInputResponseRequested {
			if err := json.Unmarshal(e.Payload, &answers); err != nil {
				t.Fatalf("decode user-input payload: %v", err)
			}
		}
	}
	// With no question text there is no full-question-text key to use, so the
	// answer falls back to the question's id — the same key the browser panel
	// sends (pendingUserInput.ts keys by question.id).
	if _, ok := answers.Answers["q-0"]; !ok {
		t.Fatalf("answers = %+v, want the question's id as the key", answers.Answers)
	}
}

// A photo, sticker or voice note in a bound chat arrives with no text.
// Starting a turn on it runs a shell-capable agent with no instruction.
func TestTextlessMessageDoesNotStartATurn(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: 100}, Text: "   ",
	}})

	th, ok := engine.State().Thread("w-abc")
	if !ok || th.Status == orchestration.ThreadRunning {
		t.Fatalf("a textless message started a turn: %+v", th)
	}
}

// The 429 path holds content rather than dropping it, which means it retries
// for as long as Telegram keeps saying no. That loop MUST come apart on
// context cancellation, or disabling the bridge from Settings leaves a
// goroutine polling the bot token until the process is killed — and two
// pollers on one token evict each other with 409 Conflict.
func TestRunReturnsPromptlyWhileParkedInARateLimitRetry(t *testing.T) {
	transport := &fakeTransport{
		sendErr: &APIError{Code: 429, Desc: "Too Many Requests", RetryAfter: time.Hour},
	}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); b.Run(ctx) }()

	seedDelta(t, engine, "w-abc", "d1", "halo", 1)
	// Prose alone is buffered until the turn ends, so the pump would never
	// reach the transport without this.
	seedTurnEnd(t, engine, "w-abc", "end-1")

	deadline := time.Now().Add(5 * time.Second)
	for transport.sendAttempts() == 0 {
		if time.Now().After(deadline) {
			cancel()
			t.Fatalf("the pump never reached the transport")
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("Run did not return after cancellation — the retry loop ignores ctx")
	}
}

// ---------------------------------------------------------------------------
// /init
// ---------------------------------------------------------------------------

// /init means "the destination identifies itself": an allowlisted sender's
// /init in a chat/topic that is not yet bound to anything writes a binding
// carrying THAT message's chat id and topic id — no dialog anywhere asks for
// a raw chatId/topicId, because Telegram does not show them.
func TestInitBindsFromTheMessageItArrivedIn(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "ssh:c-a1b2")
	mustAllow(t, st, 42)

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: -100234, IsForum: true}, MessageThreadID: 17,
		Text: "/init ssh:c-a1b2",
	}})

	binding, err := st.TelegramBindingByThread("ssh:c-a1b2")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding.ChatID != -100234 || binding.TopicID != 17 {
		t.Fatalf("binding = %+v, want chat -100234 topic 17 — the place the /init was SENT from", binding)
	}
	if len(transport.sent) != 1 {
		t.Fatalf("want exactly one confirmation reply, got %d: %+v", len(transport.sent), transport.sent)
	}
	// Pinned, so "which thread is this chat wired to" stays answerable from
	// the chat header instead of requiring a scroll past the whole transcript.
	if len(transport.pins) != 1 || transport.pins[0].ChatID != -100234 {
		t.Fatalf("the confirmation was not pinned: %+v", transport.pins)
	}
}

// The confirmation has to name the thread AND what it is, because a bare
// "w-20840bf5" tells an operator nothing about which project they just wired
// a shell-capable agent to.
func TestInitConfirmationNamesTheProjectAndBranch(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)

	ws, err := st.CreateWorkspace("acme")
	if err != nil {
		t.Fatalf("workspace: %v", err)
	}
	project, err := st.CreateProject(ws.ID, "devdeck", "/tmp/devdeck", "", "")
	if err != nil {
		t.Fatalf("project: %v", err)
	}
	wt, err := st.CreateWorktree(project.ID, "branch", "feat/telegram", "main", "", "", "", "/tmp/devdeck-wt")
	if err != nil {
		t.Fatalf("worktree: %v", err)
	}
	seedThread(t, engine, wt.ID)

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: 100}, Text: "/init " + wt.ID,
	}})

	if len(transport.sent) != 1 {
		t.Fatalf("want one confirmation, got %+v", transport.sent)
	}
	got := transport.sent[0].Text
	if !strings.Contains(got, wt.ID) {
		t.Fatalf("confirmation omits the thread id: %q", got)
	}
	if !strings.Contains(got, "devdeck") {
		t.Fatalf("confirmation omits the project name: %q", got)
	}
	if !strings.Contains(got, "feat/telegram") {
		t.Fatalf("confirmation omits the branch: %q", got)
	}
}

// A thread this process cannot resolve — one belonging to another machine, or
// a row since deleted — must still bind. Refusing to publish because a label
// lookup missed would break the exact case /init exists for.
func TestInitStillBindsWhenTheThreadCannotBeLabelled(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-unknown")
	mustAllow(t, st, 42)

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: 100}, Text: "/init w-unknown",
	}})

	if _, err := st.TelegramBindingByThread("w-unknown"); err != nil {
		t.Fatalf("an unlabelled thread was not bound: %v", err)
	}
	if len(transport.sent) != 1 || !strings.Contains(transport.sent[0].Text, "w-unknown") {
		t.Fatalf("confirmation missing or wrong: %+v", transport.sent)
	}
}

// A pin needs can_pin_messages, which a bot in a group usually does not have.
// That must stay cosmetic: the binding is already saved, and refusing to
// confirm it would make a working /init look like a failed one.
func TestInitSurvivesAPinItIsNotAllowedToMake(t *testing.T) {
	transport := &fakeTransport{pinErr: &APIError{Code: 400, Desc: "Bad Request: not enough rights to pin a message"}}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "ssh:c-a1b2")
	mustAllow(t, st, 42)

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: 100}, Text: "/init ssh:c-a1b2",
	}})

	if _, err := st.TelegramBindingByThread("ssh:c-a1b2"); err != nil {
		t.Fatalf("a failed pin lost the binding: %v", err)
	}
	// The confirmation still goes out; a second message now explains why the
	// pin did not happen and how to fix it (see warnCannotPin).
	if len(transport.sent) == 0 || !strings.Contains(transport.sent[0].Text, "ssh:c-a1b2") {
		t.Fatalf("a failed pin lost the confirmation: %+v", transport.sent)
	}
}

// Unlike /pair, /init is not a pre-auth command: it binds a destination to a
// thread whose agent can run shell commands on production servers. A sender
// not on the allowlist must produce the same silent drop every other command
// gets — no binding, no reply, nothing that confirms the bot exists.
//
// A user is seeded onto the allowlist first (id 1) so this is genuinely an
// "unlisted sender" test post trust-on-first-use: with an EMPTY allowlist,
// sender 9999 would instead be auto-enrolled by this very /init message and
// legitimately succeed — that is Change 1's point, not a bug. Non-empty
// allowlist is where the old "must be unlisted" property still applies.
func TestInitFromNonAllowlistedSenderWritesNothing(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "ssh:c-a1b2")
	mustAllow(t, st, 1)
	// Deliberately not allowlisted.

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 9999}, Chat: Chat{ID: -100234}, MessageThreadID: 17,
		Text: "/init ssh:c-a1b2",
	}})

	if _, err := st.TelegramBindingByThread("ssh:c-a1b2"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("an unlisted sender's /init produced a binding, err=%v", err)
	}
	if n := transport.outboundCalls(); n != 0 {
		t.Fatalf("unlisted sender produced %d outbound call(s), want 0", n)
	}
}

// Matches handler/telegram.go's PutBinding 409 rule: naming a destination
// another thread already owns must be refused, and the existing binding must
// come out untouched. Without this, /init reopens exactly the "a y lands on
// the wrong production server" hole §0.2 claims is impossible.
func TestInitRefusesADestinationAnotherThreadAlreadyOwns(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "ssh:c-a1b2")
	seedThread(t, engine, "ssh:c-other")
	mustAllow(t, st, 42)
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "ssh:c-a1b2", ChatID: -100234, TopicID: 17}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: -100234, IsForum: true}, MessageThreadID: 17,
		Text: "/init ssh:c-other",
	}})

	binding, err := st.TelegramBindingByThread("ssh:c-a1b2")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding.ChatID != -100234 || binding.TopicID != 17 {
		t.Fatalf("the existing binding was overwritten: %+v", binding)
	}
	if _, err := st.TelegramBindingByThread("ssh:c-other"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("the colliding thread got bound anyway, err=%v", err)
	}
	if len(transport.sent) != 1 {
		t.Fatalf("want exactly one refusal reply, got %d: %+v", len(transport.sent), transport.sent)
	}
}

// Re-sending /init for the same thread at the same destination must be
// idempotent, not an error — the operator may just be re-confirming. It must
// also not rewind a cursor that has since advanced past bind time.
func TestInitForTheSameThreadAndDestinationIsIdempotent(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "ssh:c-a1b2")
	mustAllow(t, st, 42)

	send := func() {
		b.handleUpdate(context.Background(), Update{Message: &Message{
			MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: -100234, IsForum: true}, MessageThreadID: 17,
			Text: "/init ssh:c-a1b2",
		}})
	}

	send()
	binding1, err := st.TelegramBindingByThread("ssh:c-a1b2")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}

	// The pump has since moved the cursor forward — a re-send must not
	// rewind it back to the original bind-time head seq.
	if err := st.SetTelegramBindingSeq("ssh:c-a1b2", 7); err != nil {
		t.Fatalf("advance seq: %v", err)
	}

	send()
	binding2, err := st.TelegramBindingByThread("ssh:c-a1b2")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding2.ChatID != binding1.ChatID || binding2.TopicID != binding1.TopicID {
		t.Fatalf("re-sending /init changed the destination: %+v -> %+v", binding1, binding2)
	}
	if binding2.LastSeq != 7 {
		t.Fatalf("re-sending /init rewound the replay cursor: %+v", binding2)
	}
	if len(transport.sent) != 2 {
		t.Fatalf("want a confirmation reply each time (idempotent, not an error), got %d", len(transport.sent))
	}
}

// The deliberate deviation from the plan's "Known follow-ups" item 2: a
// brand-new binding starts at the thread's current head sequence, not 0.
// With events already on the log before /init is ever sent, the pump must
// mirror NONE of that history — /init means "mirror from here on".
func TestInitBindingStartsAtTheThreadsHeadSequence(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "ssh:c-a1b2")
	mustAllow(t, st, 42)

	seedDelta(t, engine, "ssh:c-a1b2", "d1", "riwayat lama satu", 1)
	seedDelta(t, engine, "ssh:c-a1b2", "d2", "riwayat lama dua", 2)

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: -100234, IsForum: true}, MessageThreadID: 17,
		Text: "/init ssh:c-a1b2",
	}})

	binding, err := st.TelegramBindingByThread("ssh:c-a1b2")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	events, err := st.AgentEventsSince("ssh:c-a1b2", 0)
	if err != nil || len(events) == 0 {
		t.Fatalf("events: %v", err)
	}
	headSeq := events[len(events)-1].Seq
	if binding.LastSeq != headSeq {
		t.Fatalf("LastSeq = %d, want the thread's head seq %d", binding.LastSeq, headSeq)
	}

	// A sweep from here must mirror NOTHING historical — only the /init
	// confirmation reply itself should be on record.
	sentBeforeSweep := len(transport.sent)
	b.sweep(context.Background())
	if len(transport.sent) != sentBeforeSweep {
		t.Fatalf("sweep mirrored historical events after /init: %+v", transport.sent[sentBeforeSweep:])
	}
}

// A bare /init (missing threadId) must reply with the usage form and write
// nothing — there is no destination-safety story if the argument is absent.
func TestInitWithNoArgumentRepliesWithUsage(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "ssh:c-a1b2")
	mustAllow(t, st, 42)

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: -100234}, Text: "/init",
	}})

	if _, err := st.TelegramBindingByThread("ssh:c-a1b2"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("a bare /init wrote a binding, err=%v", err)
	}
	if len(transport.sent) != 1 || !strings.Contains(transport.sent[0].Text, "/init") {
		t.Fatalf("want a usage reply naming /init, got %+v", transport.sent)
	}
}

// The pin is a bookmark for a binding that exists. /unpublish removes the
// binding, so it has to remove the bookmark too — otherwise the chat header
// keeps pointing at a thread it no longer receives anything from.
func TestUnpublishRemovesThePinnedConfirmation(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "ssh:c-a1b2")
	mustAllow(t, st, 42)

	// Bind by the real path, so the pinned message id is recorded the way
	// production records it rather than being written by hand.
	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: 100}, Text: "/init ssh:c-a1b2",
	}})
	if len(transport.pins) != 1 {
		t.Fatalf("setup: want one pin, got %+v", transport.pins)
	}
	pinned := transport.pins[0].MessageID

	binding, err := st.TelegramBindingByThread("ssh:c-a1b2")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding.PinnedMessageID != pinned {
		t.Fatalf("PinnedMessageID = %d, want the pinned message %d", binding.PinnedMessageID, pinned)
	}

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 2, From: &User{ID: 42}, Chat: Chat{ID: 100}, Text: "/unpublish",
	}})

	if _, err := st.TelegramBindingByThread("ssh:c-a1b2"); err == nil {
		t.Fatal("/unpublish left the binding in place")
	}
	if len(transport.unpins) != 1 {
		t.Fatalf("want exactly one unpin, got %+v", transport.unpins)
	}
	if transport.unpins[0].MessageID != pinned || transport.unpins[0].ChatID != 100 {
		t.Fatalf("unpinned the wrong message: %+v", transport.unpins[0])
	}
}

// A binding with no recorded pin — one written before pinning existed, or one
// in a chat where the bot lacked can_pin_messages — must not ask Telegram to
// unpin anything. unpinChatMessage with no message id removes the chat's most
// recent pin, which is quite likely something the operator pinned themselves.
func TestUnpublishWithoutAPinTouchesNothing(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "ssh:c-a1b2")
	mustAllow(t, st, 42)
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "ssh:c-a1b2", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: 100}, Text: "/unpublish",
	}})

	if len(transport.unpins) != 0 {
		t.Fatalf("unpinned something for a binding that had no pin: %+v", transport.unpins)
	}
}

// Re-pointing a thread with /init from a different chat leaves a pin in the
// OLD one, naming a thread that chat is about to stop receiving.
func TestInitRepointUnpinsTheOldDestination(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "ssh:c-a1b2")
	mustAllow(t, st, 42)

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: 100}, Text: "/init ssh:c-a1b2",
	}})
	first := transport.pins[0].MessageID

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 2, From: &User{ID: 42}, Chat: Chat{ID: 200}, Text: "/init ssh:c-a1b2",
	}})

	if len(transport.unpins) != 1 || transport.unpins[0].ChatID != 100 || transport.unpins[0].MessageID != first {
		t.Fatalf("the old destination's pin was not removed: %+v", transport.unpins)
	}
	binding, err := st.TelegramBindingByThread("ssh:c-a1b2")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding.ChatID != 200 {
		t.Fatalf("binding did not repoint: %+v", binding)
	}
	// And the NEW destination's pin is the one now recorded.
	if len(transport.pins) != 2 || binding.PinnedMessageID != transport.pins[1].MessageID {
		t.Fatalf("the new pin was not recorded: pins=%+v binding=%+v", transport.pins, binding)
	}
}

// The operator typed the prompt into this very chat, so mirroring it back is
// pure noise — Telegram already shows their own message.
func TestPromptTypedInTelegramIsNotEchoedBack(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: 100}, Text: "lu pake model apa?",
	}})
	b.sweep(context.Background())

	for _, sent := range transport.sent {
		if strings.Contains(sent.Text, "lu pake model apa") {
			t.Fatalf("the operator's own message was sent back to them: %q", sent.Text)
		}
	}
	// The "working on it" notice still goes out — that one is the bot
	// answering "did it hear me?", not a repeat of the prompt.
	var sawLoading bool
	for _, sent := range transport.sent {
		if strings.Contains(sent.Text, "memproses") {
			sawLoading = true
		}
	}
	if !sawLoading {
		t.Fatalf("the loading notice was dropped along with the echo: %+v", transport.sent)
	}
}

// A turn started in the BROWSER keeps its echo: Telegram never saw that
// prompt, so without it the chat shows an answer to an invisible question.
func TestPromptStartedElsewhereIsStillEchoed(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	// Dispatched straight at the engine — exactly what the browser does, and
	// what the bridge therefore has no record of having caused.
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: "browser-turn-1", Type: orchestration.CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustJSON(t, orchestration.TurnStartPayload{Text: "deploy staging"}),
	}); err != nil {
		t.Fatalf("turn start: %v", err)
	}
	b.sweep(context.Background())

	var echoed bool
	for _, sent := range transport.sent {
		if strings.Contains(sent.Text, "deploy staging") {
			echoed = true
		}
	}
	if !echoed {
		t.Fatalf("a browser-started prompt was never shown in Telegram: %+v", transport.sent)
	}
}

// Two identical prompts must not let one suppression swallow both echoes:
// the set is keyed by the committed event's Seq, not by its text.
func TestOnlyTheBridgesOwnEchoIsSuppressed(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	seedThread(t, engine, "w-abc")
	mustAllow(t, st, 42)
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "w-abc", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: 100}, Text: "status",
	}})
	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: "browser-same-text", Type: orchestration.CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustJSON(t, orchestration.TurnStartPayload{Text: "status"}),
	}); err != nil {
		t.Fatalf("turn start: %v", err)
	}
	b.sweep(context.Background())

	echoes := 0
	for _, sent := range transport.sent {
		if strings.HasPrefix(sent.Text, "👤") {
			echoes++
		}
	}
	if echoes != 1 {
		t.Fatalf("want exactly the browser turn's echo, got %d: %+v", echoes, transport.sent)
	}
}

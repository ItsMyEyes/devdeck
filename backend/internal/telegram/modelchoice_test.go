package telegram

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/domain"
)

// tapKeyboard taps the button at row `row` of the LAST card this bridge sent,
// as user 42. Every picker in this package is one button per row.
func tapKeyboard(t *testing.T, b *Bridge, transport *fakeTransport, chatID, topicID int64, row int) {
	t.Helper()
	if len(transport.sent) == 0 {
		t.Fatal("no card was sent")
	}
	last := transport.sent[len(transport.sent)-1]
	if row >= len(last.Keyboard) {
		t.Fatalf("card has %d row(s), wanted row %d: %q", len(last.Keyboard), row, last.Text)
	}
	b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID: "cb-tap", From: &User{ID: 42}, Data: last.Keyboard[row][0].CallbackData,
		Message: &Message{MessageID: 9, Chat: Chat{ID: chatID}, MessageThreadID: topicID},
	}})
}

// turnModels is every model a turn was started with on threadID, in order.
func turnModels(t *testing.T, b *Bridge, threadID string) []string {
	t.Helper()
	events, err := b.store.AgentEventsSince(threadID, 0)
	if err != nil {
		t.Fatalf("events for %s: %v", threadID, err)
	}
	var out []string
	for _, e := range events {
		if e.Type != orchestration.EvtThreadTurnStartRequested {
			continue
		}
		var p orchestration.TurnStartPayload
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			t.Fatalf("decode turn payload: %v", err)
		}
		out = append(out, p.Model.Model)
	}
	return out
}

// The whole point of /model: the pick has to reach the provider. This pins the
// plumbing from the tapped button to the committed turn payload, so a failure
// further up is never mistaken for a broken adapter.
func TestPickedModelReachesTheTurn(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	seedThread(t, engine, "ssh:c-a1b2")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "ssh:c-a1b2", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	b.models = func(string) ([]string, error) { return []string{"claude-sonnet-5", "claude-opus-5"}, nil }

	b.handleUpdate(context.Background(), dm(100, "/model"))
	tapKeyboard(t, b, transport, 100, 0, 1)
	b.handleUpdate(context.Background(), dm(100, "apa modelmu?"))

	models := turnModels(t, b, "ssh:c-a1b2")
	if len(models) != 1 {
		t.Fatalf("want exactly one turn, got %v", models)
	}
	if models[0] != "claude-opus-5" {
		t.Fatalf("turn ran on %q, want the picked claude-opus-5", models[0])
	}
}

// A published PROJECT keeps the model on the session's binding, and /new
// replaces that session. Without carrying the choice forward the model lasts
// exactly one session — and /agents' own confirmation tells the operator to
// run /new, so the two commands cancel each other out.
func TestPickedModelSurvivesANewProjectSession(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")
	b.models = func(string) ([]string, error) {
		return []string{"anthropic/claude-sonnet-5", "anthropic/claude-opus-5"}, nil
	}

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))
	b.handleUpdate(context.Background(), dm(100, "halo"))
	b.handleUpdate(context.Background(), dm(100, "/model"))
	tapKeyboard(t, b, transport, 100, 0, 1)

	before, _ := st.TelegramBindings()
	if len(before) != 1 || before[0].Model != "anthropic/claude-opus-5" {
		t.Fatalf("the pick was not recorded on the session: %+v", before)
	}

	b.handleUpdate(context.Background(), dm(100, "/new"))

	after, err := st.TelegramBindings()
	if err != nil {
		t.Fatalf("bindings: %v", err)
	}
	if len(after) != 1 {
		t.Fatalf("want exactly one session after /new, got %+v", after)
	}
	if after[0].Model != "anthropic/claude-opus-5" {
		t.Fatalf("/new dropped the picked model: %+v", after[0])
	}
}

// A model id belongs to the agent whose catalog it came from. Carrying
// "claude-opus-5" into a Codex session hands the CLI a model it does not know;
// leaving the field empty starts the new agent on its own default, which is
// what "I switched agents" means.
func TestSwitchingAgentDropsTheModelPickedForTheOldOne(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	seedThread(t, engine, "ssh:c-a1b2")
	if err := st.SetTelegramBinding(domain.TelegramBinding{
		ThreadID: "ssh:c-a1b2", ChatID: 100, Agent: "claude", Model: "claude-opus-5",
	}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	b.handleUpdate(context.Background(), dm(100, "/agents"))
	last := transport.sent[len(transport.sent)-1]
	row := -1
	for i, r := range last.Keyboard {
		if strings.Contains(r[0].Text, "Codex") {
			row = i
		}
	}
	if row < 0 {
		t.Fatalf("no Codex button: %+v", last.Keyboard)
	}
	tapKeyboard(t, b, transport, 100, 0, row)

	binding, err := st.TelegramBindingByThread("ssh:c-a1b2")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding.Agent != "codex" {
		t.Fatalf("agent = %q, want codex", binding.Agent)
	}
	if binding.Model != "" {
		t.Fatalf("model %q survived the switch to codex — it belongs to claude's catalog", binding.Model)
	}
}

// Carrying the model forward must stop at an agent change. /model acts on the
// LIVE session, so between an /agents pick and the /new that spends it the
// operator can only pick from the OLD agent's catalog — handing that id to the
// new agent is how "I switched and nothing changed" happens (Pi's set_model
// silently no-ops on an id it cannot parse; Codex would simply be wrong).
func TestNewSessionDoesNotInheritTheOldAgentsModel(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	projectID := seedProject(t, st, "devdeck")
	b.models = func(string) ([]string, error) { return []string{"claude-sonnet-5", "claude-opus-5"}, nil }

	b.handleUpdate(context.Background(), dm(100, "/init "+projectID))
	b.handleUpdate(context.Background(), dm(100, "halo"))

	// Agents FIRST, model second — the order /agents' own confirmation invites,
	// and the one where clearing the model at switch time is not enough: the
	// pick that follows still comes from the live session's claude catalog.
	b.handleUpdate(context.Background(), dm(100, "/agents"))
	last := transport.sent[len(transport.sent)-1]
	row := -1
	for i, r := range last.Keyboard {
		if strings.Contains(r[0].Text, "Codex") {
			row = i
		}
	}
	if row < 0 {
		t.Fatalf("no Codex button: %+v", last.Keyboard)
	}
	tapKeyboard(t, b, transport, 100, 0, row)

	b.handleUpdate(context.Background(), dm(100, "/model"))
	tapKeyboard(t, b, transport, 100, 0, 1)
	b.handleUpdate(context.Background(), dm(100, "/new"))

	after, err := st.TelegramBindings()
	if err != nil {
		t.Fatalf("bindings: %v", err)
	}
	if len(after) != 1 {
		t.Fatalf("want exactly one session after /new, got %+v", after)
	}
	if after[0].Model != "" {
		t.Fatalf("a claude model rode into the codex session: %+v", after[0])
	}
}

// /model must offer the catalog of the agent that will actually run the turn.
// A thread the engine has never seen — a connection published with /init and
// not yet typed into, created lazily by ensureThread — used to fall back to the
// GLOBAL default agent, so /agents' pick was invisible to the model picker and
// every id it offered belonged to a CLI this destination does not run.
func TestModelPickerAsksForTheAgentThisDestinationWillRun(t *testing.T) {
	transport := &fakeTransport{}
	b, _, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	if err := st.SetTelegramBinding(domain.TelegramBinding{
		ThreadID: "ssh:c-a1b2", ChatID: 100, Agent: "codex",
	}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	asked := ""
	b.models = func(agentID string) ([]string, error) {
		asked = agentID
		return []string{"gpt-5.5"}, nil
	}

	b.handleUpdate(context.Background(), dm(100, "/model"))

	if asked != "codex" {
		t.Fatalf("model picker asked for %q, want the destination's codex", asked)
	}
}

// The live session's agent still wins over a pending /agents pick: a thread's
// agent is fixed at thread.create, so until /new spends the choice the models
// this session can actually switch to are the ones it was born with.
func TestModelPickerPrefersTheLiveSessionsAgent(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	seedThread(t, engine, "ssh:c-a1b2") // claude:default
	if err := st.SetTelegramBinding(domain.TelegramBinding{
		ThreadID: "ssh:c-a1b2", ChatID: 100, Agent: "codex",
	}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	asked := ""
	b.models = func(agentID string) ([]string, error) {
		asked = agentID
		return []string{"claude-opus-5"}, nil
	}

	b.handleUpdate(context.Background(), dm(100, "/model"))

	if asked != "claude" {
		t.Fatalf("model picker asked for %q, want the running session's claude", asked)
	}
}

// A pick that is about to be discarded has to SAY so. With an /agents switch
// still waiting for its /new, the ids offered belong to the outgoing agent and
// carryModel will drop whichever one is tapped — silently, which is the exact
// failure mode this change set exists to remove.
func TestModelPickerSaysWhenAnAgentSwitchIsStillPending(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	seedThread(t, engine, "ssh:c-a1b2") // claude:default
	if err := st.SetTelegramBinding(domain.TelegramBinding{
		ThreadID: "ssh:c-a1b2", ChatID: 100, Agent: "codex",
	}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	b.models = func(string) ([]string, error) { return []string{"claude-opus-5"}, nil }

	b.handleUpdate(context.Background(), dm(100, "/model"))

	last := transport.sent[len(transport.sent)-1]
	if !strings.Contains(last.Text, "Codex") || !strings.Contains(last.Text, "/new") {
		t.Fatalf("picker did not name the pending switch or the way to spend it: %q", last.Text)
	}
}

// ...and stays quiet when there is nothing pending, so the common case is not
// buried under a warning that does not apply.
func TestModelPickerIsQuietWithNoPendingSwitch(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	seedThread(t, engine, "ssh:c-a1b2")
	if err := st.SetTelegramBinding(domain.TelegramBinding{
		ThreadID: "ssh:c-a1b2", ChatID: 100, Agent: "claude",
	}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	b.models = func(string) ([]string, error) { return []string{"claude-opus-5"}, nil }

	b.handleUpdate(context.Background(), dm(100, "/model"))

	last := transport.sent[len(transport.sent)-1]
	if strings.Contains(last.Text, "/new") {
		t.Fatalf("picker warned about a switch that is not pending: %q", last.Text)
	}
}

// Re-picking the SAME agent is a no-op confirmation, not a reset: an operator
// tapping the already-ticked entry must not silently lose their model.
func TestRePickingTheSameAgentKeepsTheModel(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	seedThread(t, engine, "ssh:c-a1b2")
	if err := st.SetTelegramBinding(domain.TelegramBinding{
		ThreadID: "ssh:c-a1b2", ChatID: 100, Agent: "claude", Model: "claude-opus-5",
	}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	b.handleUpdate(context.Background(), dm(100, "/agents"))
	last := transport.sent[len(transport.sent)-1]
	row := -1
	for i, r := range last.Keyboard {
		if strings.Contains(r[0].Text, "Claude") {
			row = i
		}
	}
	if row < 0 {
		t.Fatalf("no Claude button: %+v", last.Keyboard)
	}
	tapKeyboard(t, b, transport, 100, 0, row)

	binding, err := st.TelegramBindingByThread("ssh:c-a1b2")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding.Model != "claude-opus-5" {
		t.Fatalf("re-picking claude cleared the model: %+v", binding)
	}
}

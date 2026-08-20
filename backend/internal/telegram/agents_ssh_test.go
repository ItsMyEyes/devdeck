package telegram

import (
	"context"
	"strings"
	"testing"

	"devdeck/backend/internal/domain"
)

// An SSH connection is published as ONE thread, not a project. /agents used to
// refuse there ("cuma berlaku di chat yang publish satu project"), which left
// an SSH publish with no way to pick its agent from Telegram at all.
func TestAgentsPickerWorksForAPublishedSSHThread(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	seedThread(t, engine, "ssh:c-a1b2")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "ssh:c-a1b2", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	b.handleUpdate(context.Background(), dm(100, "/agents"))

	last := transport.sent[len(transport.sent)-1]
	if len(last.Keyboard) == 0 {
		t.Fatalf("no agent picker for an SSH publish: %q", last.Text)
	}
	if strings.Contains(last.Text, "publish satu project") {
		t.Fatalf("still refusing outside a project: %q", last.Text)
	}

	var codexToken string
	for _, row := range last.Keyboard {
		if strings.Contains(row[0].Text, "Codex") {
			codexToken = row[0].CallbackData
		}
	}
	if codexToken == "" {
		t.Fatalf("no tappable Codex button: %+v", last.Keyboard)
	}

	b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID: "cb1", From: &User{ID: 42}, Data: codexToken,
		Message: &Message{MessageID: 9, Chat: Chat{ID: 100}},
	}})

	binding, err := st.TelegramBindingByThread("ssh:c-a1b2")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding.Agent != "codex" {
		t.Fatalf("agent = %q, want codex recorded on the binding", binding.Agent)
	}
}

// The picker would be decoration if /new ignored it: a thread's agent is fixed
// at thread.create, so the NEXT session is the only place the choice can land.
func TestNewSessionUsesTheAgentPickedForAnSSHThread(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	seedThread(t, engine, "ssh:c-a1b2")
	if err := st.SetTelegramBinding(domain.TelegramBinding{
		ThreadID: "ssh:c-a1b2", ChatID: -100234, Agent: "codex",
	}); err != nil {
		t.Fatalf("bind: %v", err)
	}

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42},
		Chat: Chat{ID: -100234, IsForum: true}, Text: "/new",
	}})

	var created string
	for id := range engine.State().Threads {
		if strings.HasPrefix(id, "ssh:c-a1b2::chat-") {
			created = id
		}
	}
	if created == "" {
		t.Fatal("/new created no session")
	}
	thread, ok := engine.State().Thread(created)
	if !ok {
		t.Fatalf("thread %s missing", created)
	}
	if !strings.HasPrefix(string(thread.InstanceID), "codex:") {
		t.Fatalf("new session ran on %q, want the picked codex", thread.InstanceID)
	}
	// And the choice survives, or it would last exactly one /new.
	next, err := st.TelegramBindingByThread(created)
	if err != nil {
		t.Fatalf("new binding: %v", err)
	}
	if next.Agent != "codex" {
		t.Fatalf("the agent choice was dropped on the new binding: %+v", next)
	}
}

// /model is thread-scoped and already worked; this pins that an SSH publish
// can reach it, since the two pickers are the pair the operator needs.
func TestModelPickerWorksForAPublishedSSHThread(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	seedThread(t, engine, "ssh:c-a1b2")
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: "ssh:c-a1b2", ChatID: 100}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	b.models = func(string) ([]string, error) { return []string{"claude-sonnet-5", "claude-opus-5"}, nil }

	b.handleUpdate(context.Background(), dm(100, "/model"))

	last := transport.sent[len(transport.sent)-1]
	if len(last.Keyboard) != 2 {
		t.Fatalf("want a button per model, got %+v", last.Keyboard)
	}

	b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID: "cb1", From: &User{ID: 42}, Data: last.Keyboard[1][0].CallbackData,
		Message: &Message{MessageID: 9, Chat: Chat{ID: 100}},
	}})

	binding, err := st.TelegramBindingByThread("ssh:c-a1b2")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	if binding.Model != "claude-opus-5" {
		t.Fatalf("model = %q, want the picked one", binding.Model)
	}
}

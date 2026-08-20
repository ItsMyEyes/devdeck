package telegram

import (
	"context"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/event"
	"devdeck/backend/internal/agentcore/orchestration"
	"devdeck/backend/internal/agentcore/provider"
	"devdeck/backend/internal/domain"
)

func bindSession(t *testing.T, b *Bridge, engine *orchestration.Engine, st interface {
	SetTelegramBinding(domain.TelegramBinding) error
}, threadID string, chatID int64) {
	t.Helper()
	seedThread(t, engine, threadID)
	if err := st.SetTelegramBinding(domain.TelegramBinding{ThreadID: threadID, ChatID: chatID}); err != nil {
		t.Fatalf("bind: %v", err)
	}
}

// /permissions is the composer's "Approval required" control, reachable from
// the phone. Without it, an operator being asked to approve every command had
// to walk back to the app to stop it.
func TestPermissionsPickerAppliesToTheRunningSession(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	mustAllow(t, st, 42)
	bindSession(t, b, engine, st, "w-abc", 100)

	b.handleUpdate(context.Background(), Update{Message: &Message{
		MessageID: 1, From: &User{ID: 42}, Chat: Chat{ID: 100}, Text: "/permissions",
	}})

	last := transport.sent[len(transport.sent)-1]
	if len(last.Keyboard) != len(permissionOptions) {
		t.Fatalf("want a button per mode, got %+v", last.Keyboard)
	}
	// The current mode is marked, since "what is it set to now" is the
	// question that sends an operator here.
	var marked int
	var fullAccessToken string
	for _, row := range last.Keyboard {
		if strings.HasPrefix(row[0].Text, "✅") {
			marked++
		}
		if strings.Contains(row[0].Text, "Full access") {
			fullAccessToken = row[0].CallbackData
		}
	}
	if marked != 1 {
		t.Fatalf("want exactly one mode marked as current, got %d: %+v", marked, last.Keyboard)
	}

	b.handleUpdate(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID: "cb1", From: &User{ID: 42}, Data: fullAccessToken,
		Message: &Message{MessageID: 9, Chat: Chat{ID: 100}},
	}})

	// Unlike /agents, this lands on the LIVE thread — the mode is thread
	// state the engine accepts a command for, not something fixed at
	// creation.
	thread, ok := engine.State().Thread("w-abc")
	if !ok {
		t.Fatal("thread vanished")
	}
	if thread.Mode != provider.ModeFullAccess {
		t.Fatalf("mode = %q, want full-access", thread.Mode)
	}
}

// The typing hint is the only progress signal Telegram gives a bot, and it
// must mean what it says.
func TestTypingHintOnlyWhileTheTurnIsRunning(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	bindSession(t, b, engine, st, "w-abc", 100)

	// Idle: nothing to say.
	b.sweep(context.Background())
	if len(transport.actions) != 0 {
		t.Fatalf("typing sent while idle: %+v", transport.actions)
	}

	if _, err := engine.Dispatch(context.Background(), orchestration.Command{
		CommandID: "turn-1", Type: orchestration.CmdThreadTurnStart, ThreadID: "w-abc",
		Payload: mustJSON(t, orchestration.TurnStartPayload{Text: "kerjakan"}),
	}); err != nil {
		t.Fatalf("turn start: %v", err)
	}
	b.sweep(context.Background())

	if len(transport.actions) == 0 {
		t.Fatal("no typing hint while a turn is running")
	}
	if transport.actions[0].Action != "typing" || transport.actions[0].ChatID != 100 {
		t.Fatalf("action = %+v", transport.actions[0])
	}
}

// A thread WAITING on an approval is blocked on the operator, not working.
// Showing "typing" there hides the very ask it is waiting for.
func TestNoTypingHintWhileWaitingForAnApproval(t *testing.T) {
	transport := &fakeTransport{}
	b, engine, st := newTestBridge(t, transport)
	bindSession(t, b, engine, st, "w-abc", 100)
	seedRequestOpened(t, engine, "w-abc", "req-1", []event.Decision{event.DecisionAccept})

	before := len(transport.actions)
	b.sweep(context.Background())

	for _, a := range transport.actions[before:] {
		if a.Action == "typing" {
			t.Fatalf("typing hint sent while waiting on an approval: %+v", a)
		}
	}
}

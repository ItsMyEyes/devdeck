package store

import (
	"testing"

	"devdeck/backend/internal/domain"
)

func TestTelegramConfigRoundTrips(t *testing.T) {
	s := NewTestStore(t)
	cfg, err := s.TelegramConfig()
	if err != nil {
		t.Fatalf("TelegramConfig: %v", err)
	}
	if cfg.Enabled || cfg.HasToken {
		t.Fatalf("fresh db should be disabled and tokenless, got %+v", cfg)
	}
	if err := s.SetTelegramBotToken("123456:AAH"); err != nil {
		t.Fatalf("SetTelegramBotToken: %v", err)
	}
	if err := s.SetTelegramConfig(domain.TelegramConfig{Enabled: true, BotUsername: "devdeck_bot"}); err != nil {
		t.Fatalf("SetTelegramConfig: %v", err)
	}
	cfg, err = s.TelegramConfig()
	if err != nil {
		t.Fatalf("TelegramConfig: %v", err)
	}
	// HasToken is DERIVED from the stored token, never written by the caller:
	// SetTelegramConfig must not be able to lie about it.
	if !cfg.Enabled || !cfg.HasToken || cfg.BotUsername != "devdeck_bot" {
		t.Fatalf("round trip lost data: %+v", cfg)
	}
	tok, err := s.TelegramBotToken()
	if err != nil || tok != "123456:AAH" {
		t.Fatalf("TelegramBotToken = %q, %v", tok, err)
	}
}

func TestTelegramBindingSeqAdvancesWithoutRewritingTheRow(t *testing.T) {
	s := NewTestStore(t)
	b := domain.TelegramBinding{ThreadID: "ssh:c-a1b2", ChatID: -100234, TopicID: 17, Model: "claude-sonnet-5"}
	if err := s.SetTelegramBinding(b); err != nil {
		t.Fatalf("SetTelegramBinding: %v", err)
	}
	if err := s.SetTelegramBindingSeq("ssh:c-a1b2", 42); err != nil {
		t.Fatalf("SetTelegramBindingSeq: %v", err)
	}
	got, err := s.TelegramBindingByThread("ssh:c-a1b2")
	if err != nil {
		t.Fatalf("TelegramBindingByThread: %v", err)
	}
	if got.LastSeq != 42 || got.ChatID != -100234 || got.TopicID != 17 || got.Model != "claude-sonnet-5" {
		t.Fatalf("seq update clobbered the row: %+v", got)
	}
}

func TestTelegramUsersAddAndDelete(t *testing.T) {
	s := NewTestStore(t)
	if err := s.AddTelegramUser(domain.TelegramUser{UserID: 587442310, Label: "@kiyora", AddedAt: 1000}); err != nil {
		t.Fatalf("AddTelegramUser: %v", err)
	}
	// Re-pairing the same account must update, not duplicate.
	if err := s.AddTelegramUser(domain.TelegramUser{UserID: 587442310, Label: "@kiyora2", AddedAt: 2000}); err != nil {
		t.Fatalf("AddTelegramUser (repeat): %v", err)
	}
	users, err := s.TelegramUsers()
	if err != nil || len(users) != 1 || users[0].Label != "@kiyora2" {
		t.Fatalf("users = %+v, %v", users, err)
	}
	if err := s.DeleteTelegramUser(587442310); err != nil {
		t.Fatalf("DeleteTelegramUser: %v", err)
	}
	users, _ = s.TelegramUsers()
	if len(users) != 0 {
		t.Fatalf("delete left %d users", len(users))
	}
}

package store

import (
	"testing"

	"devdeck/backend/internal/port"
)

func TestCompletionsDefaultsOnFreshDB(t *testing.T) {
	s := newTestStore(t)

	cfg, err := s.CompletionsConfig()
	if err != nil {
		t.Fatalf("CompletionsConfig: %v", err)
	}
	if cfg.Provider != "anthropic" {
		t.Errorf("Provider = %q, want anthropic", cfg.Provider)
	}
	if cfg.Model != "claude-haiku-4-5" {
		t.Errorf("Model = %q, want claude-haiku-4-5", cfg.Model)
	}
	if cfg.Enabled {
		t.Errorf("Enabled = true on a fresh db, want false")
	}
	if cfg.BaseURL != "" {
		t.Errorf("BaseURL = %q, want empty", cfg.BaseURL)
	}

	configured, err := s.CompletionsConfigured()
	if err != nil {
		t.Fatalf("CompletionsConfigured: %v", err)
	}
	if configured {
		t.Errorf("Configured = true on a fresh db, want false")
	}
}

func TestUpdateCompletionsConfigPartialUpdate(t *testing.T) {
	s := newTestStore(t)

	model := "claude-sonnet-5"
	enabled := true
	if _, err := s.UpdateCompletionsConfig(port.CompletionsConfigPatch{Model: &model, Enabled: &enabled}); err != nil {
		t.Fatalf("UpdateCompletionsConfig: %v", err)
	}

	cfg, err := s.CompletionsConfig()
	if err != nil {
		t.Fatalf("CompletionsConfig: %v", err)
	}
	if cfg.Model != "claude-sonnet-5" {
		t.Errorf("Model = %q, want claude-sonnet-5", cfg.Model)
	}
	if !cfg.Enabled {
		t.Errorf("Enabled = false, want true")
	}
	// Provider was never patched — must remain at its default.
	if cfg.Provider != "anthropic" {
		t.Errorf("Provider = %q, want anthropic (unchanged)", cfg.Provider)
	}
}

func TestUpdateCompletionsConfigAPIKeyRoundTrips(t *testing.T) {
	s := newTestStore(t)

	key := "sk-test-key-123"
	if _, err := s.UpdateCompletionsConfig(port.CompletionsConfigPatch{APIKey: &key}); err != nil {
		t.Fatalf("UpdateCompletionsConfig: %v", err)
	}

	configured, err := s.CompletionsConfigured()
	if err != nil {
		t.Fatalf("CompletionsConfigured: %v", err)
	}
	if !configured {
		t.Errorf("Configured = false after setting a key, want true")
	}

	got, err := s.CompletionsAPIKey()
	if err != nil {
		t.Fatalf("CompletionsAPIKey: %v", err)
	}
	if got != key {
		t.Errorf("CompletionsAPIKey = %q, want %q", got, key)
	}

	// CompletionsConfig() must never expose the key.
	cfg, err := s.CompletionsConfig()
	if err != nil {
		t.Fatalf("CompletionsConfig: %v", err)
	}
	_ = cfg // no APIKey field exists on domain.CompletionsConfig — this is a compile-time guarantee, not a runtime check
}

func TestUpdateCompletionsConfigBaseURLClearedExplicitly(t *testing.T) {
	s := newTestStore(t)

	url := "https://example.com/v1"
	if _, err := s.UpdateCompletionsConfig(port.CompletionsConfigPatch{BaseURL: &url, HasBaseURL: true}); err != nil {
		t.Fatalf("UpdateCompletionsConfig: %v", err)
	}
	cfg, err := s.CompletionsConfig()
	if err != nil {
		t.Fatalf("CompletionsConfig: %v", err)
	}
	if cfg.BaseURL != "https://example.com/v1" {
		t.Errorf("BaseURL = %q, want https://example.com/v1", cfg.BaseURL)
	}

	empty := ""
	if _, err := s.UpdateCompletionsConfig(port.CompletionsConfigPatch{BaseURL: &empty, HasBaseURL: true}); err != nil {
		t.Fatalf("UpdateCompletionsConfig: %v", err)
	}
	cfg, err = s.CompletionsConfig()
	if err != nil {
		t.Fatalf("CompletionsConfig: %v", err)
	}
	if cfg.BaseURL != "" {
		t.Errorf("BaseURL = %q, want empty after explicit clear", cfg.BaseURL)
	}
}

// TestUpdateCompletionsConfigBaseURLNilPointer exercises the documented-valid
// {"baseUrl": null} request shape directly: HasBaseURL=true with a nil
// pointer (not a pointer to ""). This must clear the stored value rather
// than panic on a nil dereference.
func TestUpdateCompletionsConfigBaseURLNilPointer(t *testing.T) {
	s := newTestStore(t)

	url := "https://example.com/v1"
	if _, err := s.UpdateCompletionsConfig(port.CompletionsConfigPatch{BaseURL: &url, HasBaseURL: true}); err != nil {
		t.Fatalf("UpdateCompletionsConfig: %v", err)
	}

	if _, err := s.UpdateCompletionsConfig(port.CompletionsConfigPatch{BaseURL: nil, HasBaseURL: true}); err != nil {
		t.Fatalf("UpdateCompletionsConfig with nil BaseURL: %v", err)
	}
	cfg, err := s.CompletionsConfig()
	if err != nil {
		t.Fatalf("CompletionsConfig: %v", err)
	}
	if cfg.BaseURL != "" {
		t.Errorf("BaseURL = %q, want empty after nil-pointer clear", cfg.BaseURL)
	}
}

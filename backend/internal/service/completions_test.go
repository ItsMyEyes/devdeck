package service

import (
	"context"
	"errors"
	"testing"

	"devdeck/backend/internal/completions/provider"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/store"
)

type fakeAdapter struct {
	calls int
	out   string
	err   error
}

func (f *fakeAdapter) Complete(_ context.Context, _ provider.CompletionRequest, _ provider.Config) (string, error) {
	f.calls++
	return f.out, f.err
}

func newTestCompletionsService(t *testing.T) (*CompletionsService, *fakeAdapter, *fakeAdapter) {
	t.Helper()
	st := store.NewTestStore(t)
	anthropic := &fakeAdapter{out: "anthropic-result"}
	openai := &fakeAdapter{out: "openai-result"}
	return newCompletionsService(st, anthropic, openai), anthropic, openai
}

func TestCompleteReturnsNotConfiguredWhenDisabled(t *testing.T) {
	svc, _, _ := newTestCompletionsService(t)

	_, err := svc.Complete(context.Background(), provider.CompletionRequest{Prefix: "x"})
	if !errors.Is(err, ErrCompletionsNotConfigured) {
		t.Fatalf("err = %v, want ErrCompletionsNotConfigured", err)
	}
}

func TestCompleteReturnsNotConfiguredWithNoKey(t *testing.T) {
	svc, _, _ := newTestCompletionsService(t)
	enabled := true
	if _, err := svc.UpdateConfig(port.CompletionsConfigPatch{Enabled: &enabled}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	_, err := svc.Complete(context.Background(), provider.CompletionRequest{Prefix: "x"})
	if !errors.Is(err, ErrCompletionsNotConfigured) {
		t.Fatalf("err = %v, want ErrCompletionsNotConfigured", err)
	}
}

func TestCompleteCallsAnthropicAdapterByDefault(t *testing.T) {
	svc, anthropic, openai := newTestCompletionsService(t)
	enabled := true
	key := "sk-test"
	if _, err := svc.UpdateConfig(port.CompletionsConfigPatch{Enabled: &enabled, APIKey: &key}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	result, err := svc.Complete(context.Background(), provider.CompletionRequest{Prefix: "x"})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if result != "anthropic-result" {
		t.Errorf("result = %q, want anthropic-result", result)
	}
	if anthropic.calls != 1 || openai.calls != 0 {
		t.Errorf("anthropic.calls=%d openai.calls=%d, want 1,0", anthropic.calls, openai.calls)
	}
}

func TestCompleteCallsOpenAIAdapterWhenConfigured(t *testing.T) {
	svc, anthropic, openai := newTestCompletionsService(t)
	enabled := true
	key := "sk-test"
	providerName := "openai-compatible"
	if _, err := svc.UpdateConfig(port.CompletionsConfigPatch{Enabled: &enabled, APIKey: &key, Provider: &providerName}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	result, err := svc.Complete(context.Background(), provider.CompletionRequest{Prefix: "y"})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if result != "openai-result" {
		t.Errorf("result = %q, want openai-result", result)
	}
	if openai.calls != 1 || anthropic.calls != 0 {
		t.Errorf("anthropic.calls=%d openai.calls=%d, want 0,1", anthropic.calls, openai.calls)
	}
}

func TestCompleteCachesRepeatedIdenticalRequests(t *testing.T) {
	svc, anthropic, _ := newTestCompletionsService(t)
	enabled := true
	key := "sk-test"
	if _, err := svc.UpdateConfig(port.CompletionsConfigPatch{Enabled: &enabled, APIKey: &key}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}

	req := provider.CompletionRequest{Prefix: "same prefix"}
	if _, err := svc.Complete(context.Background(), req); err != nil {
		t.Fatalf("Complete (1st): %v", err)
	}
	if _, err := svc.Complete(context.Background(), req); err != nil {
		t.Fatalf("Complete (2nd): %v", err)
	}
	if anthropic.calls != 1 {
		t.Errorf("anthropic.calls = %d, want 1 (2nd call should hit cache)", anthropic.calls)
	}
}

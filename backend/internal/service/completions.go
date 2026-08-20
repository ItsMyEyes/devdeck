package service

import (
	"context"
	"errors"
	"fmt"

	"devdeck/backend/internal/completions/provider"
	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

// ErrCompletionsNotConfigured is returned when the feature is disabled or no
// API key is stored. The handler maps this to 204, not an error response —
// an unconfigured completions feature is a silent no-op, never a surfaced
// error.
var ErrCompletionsNotConfigured = errors.New("completions: not configured")

var validCompletionsProviders = map[string]bool{
	"anthropic":         true,
	"openai-compatible": true,
}

type CompletionsService struct {
	store     port.Store
	anthropic provider.Adapter
	openai    provider.Adapter
	cache     *boundedCache
}

// NewCompletionsService builds a service with the real HTTP adapters.
func NewCompletionsService(st port.Store) *CompletionsService {
	return newCompletionsService(st, provider.NewAnthropicAdapter(), provider.NewOpenAICompatAdapter())
}

// newCompletionsService is the injectable constructor used by tests to swap
// in fake adapters and avoid network calls.
func newCompletionsService(st port.Store, anthropic, openai provider.Adapter) *CompletionsService {
	return &CompletionsService{store: st, anthropic: anthropic, openai: openai, cache: newBoundedCache()}
}

func (s *CompletionsService) Config() (domain.CompletionsConfig, error) {
	return s.store.CompletionsConfig()
}

func (s *CompletionsService) UpdateConfig(p port.CompletionsConfigPatch) (domain.CompletionsConfig, error) {
	if p.Provider != nil && !validCompletionsProviders[*p.Provider] {
		return domain.CompletionsConfig{}, fmt.Errorf("completions: invalid provider %q", *p.Provider)
	}
	return s.store.UpdateCompletionsConfig(p)
}

func (s *CompletionsService) Configured() (bool, error) {
	return s.store.CompletionsConfigured()
}

// Complete returns ErrCompletionsNotConfigured when disabled or no key is
// stored.
func (s *CompletionsService) Complete(ctx context.Context, req provider.CompletionRequest) (string, error) {
	cfg, err := s.store.CompletionsConfig()
	if err != nil {
		return "", err
	}
	if !cfg.Enabled {
		return "", ErrCompletionsNotConfigured
	}
	apiKey, err := s.store.CompletionsAPIKey()
	if err != nil {
		return "", err
	}
	if apiKey == "" {
		return "", ErrCompletionsNotConfigured
	}

	key := cacheKey(cfg.Provider, cfg.Model, req)
	if cached, ok := s.cache.get(key); ok {
		return cached, nil
	}

	adapter := s.anthropic
	if cfg.Provider == "openai-compatible" {
		adapter = s.openai
	}

	result, err := adapter.Complete(ctx, req, provider.Config{
		Provider: cfg.Provider,
		BaseURL:  cfg.BaseURL,
		Model:    cfg.Model,
		APIKey:   apiKey,
	})
	if err != nil {
		return "", err
	}

	s.cache.set(key, result)
	return result, nil
}

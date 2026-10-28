package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type MemoryLLMTest struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	BaseURL  string `json:"baseUrl"`
	APIKey   string `json:"apiKey"`
}

// TestLLMConnection checks the selected provider directly; it does not change
// Hindsight's running configuration or send any stored memories to the model.
func (s *MemoryService) TestLLMConnection(ctx context.Context, cfg MemoryLLMTest) error {
	if !validMemoryLLMProviders[cfg.Provider] {
		return errors.New("unsupported LLM provider")
	}
	model := strings.TrimSpace(cfg.Model)
	if model == "" {
		return errors.New("enter a model before testing")
	}
	key := cfg.APIKey
	if key == "" {
		var err error
		key, err = s.store.MemoryLLMAPIKey()
		if err != nil {
			return errors.New("could not read saved LLM key")
		}
	}
	if key == "" && cfg.Provider != "ollama" && cfg.Provider != "lmstudio" {
		return errors.New("an API key is required for this provider")
	}
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if base == "" {
		base = map[string]string{"openai": "https://api.openai.com/v1", "anthropic": "https://api.anthropic.com", "gemini": "https://generativelanguage.googleapis.com/v1beta", "groq": "https://api.groq.com/openai/v1", "ollama": "http://127.0.0.1:11434", "lmstudio": "http://127.0.0.1:1234/v1"}[cfg.Provider]
	}
	parsed, err := url.Parse(base)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("enter a valid HTTP(S) base URL")
	}
	if cfg.Provider == "lmstudio" && parsed.Path == "" {
		base += "/v1"
	}
	messages := []map[string]string{{"role": "user", "content": "Reply OK."}}
	body := map[string]any{"model": model, "messages": messages}
	path := "/chat/completions"
	switch cfg.Provider {
	case "anthropic":
		path = "/v1/messages"
		if strings.HasSuffix(base, "/v1") {
			path = "/messages"
		}
		body["max_tokens"] = 16
	case "gemini":
		path = "/models/" + url.PathEscape(strings.TrimPrefix(model, "models/")) + ":generateContent"
		body = map[string]any{"contents": []any{map[string]any{"parts": []any{map[string]string{"text": "Reply OK."}}}}}
	case "ollama":
		path = "/api/chat"
		body["stream"] = false
		body["options"] = map[string]int{"num_predict": 16}
	case "openai":
		body["max_completion_tokens"] = 128
	default:
		body["max_tokens"] = 16
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return errors.New("could not create test request")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, bytes.NewReader(payload))
	if err != nil {
		return errors.New("invalid provider URL")
	}
	req.Header.Set("Content-Type", "application/json")
	switch cfg.Provider {
	case "anthropic":
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", "2023-06-01")
	case "gemini":
		req.Header.Set("x-goog-api-key", key)
	default:
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
	}
	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return errors.New("connection test cancelled or timed out")
		}
		return errors.New("could not reach LLM provider; check the URL and network")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("LLM provider returned HTTP %d; check model, API key and provider settings", resp.StatusCode)
	}
	var result map[string]json.RawMessage
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result); err != nil {
		return errors.New("LLM provider returned an invalid response")
	}
	field := "choices"
	switch cfg.Provider {
	case "anthropic":
		field = "content"
	case "gemini":
		field = "candidates"
	case "ollama":
		field = "message"
	}
	if len(result[field]) == 0 || string(result[field]) == "null" || string(result[field]) == "[]" {
		return errors.New("LLM provider returned no model response")
	}
	return nil
}

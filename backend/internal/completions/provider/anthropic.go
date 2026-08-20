package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const (
	anthropicDefaultBaseURL = "https://api.anthropic.com"
	anthropicVersion        = "2023-06-01"
	anthropicDefaultModel   = "claude-haiku-4-5"
)

type anthropicAdapter struct {
	client *http.Client
}

// NewAnthropicAdapter builds an Adapter that calls the Anthropic Messages
// API. Requests use a 15s timeout — this is a per-keystroke latency path, a
// slow provider should fail fast rather than hang the debounce queue.
func NewAnthropicAdapter() Adapter {
	return &anthropicAdapter{client: &http.Client{Timeout: 15 * time.Second}}
}

func (a *anthropicAdapter) Complete(ctx context.Context, req CompletionRequest, cfg Config) (string, error) {
	baseURL := cfg.BaseURL
	if baseURL == "" {
		baseURL = anthropicDefaultBaseURL
	}
	model := cfg.Model
	if model == "" {
		model = anthropicDefaultModel
	}

	body := map[string]any{
		"model":      model,
		"max_tokens": 512,
		"system": []map[string]any{
			{"type": "text", "text": completionSystemPrompt, "cache_control": map[string]string{"type": "ephemeral"}},
		},
		"tools": []map[string]any{
			{
				"name":          "emit_completion",
				"description":   "Insert the completed code at the cursor.",
				"input_schema":  completionToolSchema,
				"cache_control": map[string]string{"type": "ephemeral"},
			},
		},
		"tool_choice": map[string]string{"type": "tool", "name": "emit_completion"},
		"messages": []map[string]any{
			{"role": "user", "content": buildUserContent(req)},
		},
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return "", err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/v1/messages", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", cfg.APIKey)
	httpReq.Header.Set("anthropic-version", anthropicVersion)

	resp, err := a.client.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("anthropic: unexpected status %d", resp.StatusCode)
	}

	var parsed struct {
		Content []struct {
			Type  string          `json:"type"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", err
	}
	for _, block := range parsed.Content {
		if block.Type == "tool_use" && block.Name == "emit_completion" {
			var input struct {
				Completion string `json:"completion"`
			}
			if err := json.Unmarshal(block.Input, &input); err != nil {
				return "", err
			}
			return input.Completion, nil
		}
	}
	return "", fmt.Errorf("anthropic: no tool_use block in response")
}

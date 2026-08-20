package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const openAICompatDefaultBaseURL = "https://api.openai.com/v1"

type openAICompatAdapter struct {
	client *http.Client
}

func NewOpenAICompatAdapter() Adapter {
	return &openAICompatAdapter{client: &http.Client{Timeout: 15 * time.Second}}
}

func (a *openAICompatAdapter) Complete(ctx context.Context, req CompletionRequest, cfg Config) (string, error) {
	baseURL := cfg.BaseURL
	if baseURL == "" {
		baseURL = openAICompatDefaultBaseURL
	}
	model := cfg.Model
	if model == "" {
		model = "gpt-4o-mini"
	}

	body := map[string]any{
		"model": model,
		"messages": []map[string]any{
			{"role": "system", "content": completionSystemPrompt},
			{"role": "user", "content": buildUserContent(req)},
		},
		"tools": []map[string]any{
			{
				"type": "function",
				"function": map[string]any{
					"name":        "emit_completion",
					"description": "Insert the completed code at the cursor.",
					"parameters":  completionToolSchema,
				},
			},
		},
		"tool_choice": map[string]any{
			"type":     "function",
			"function": map[string]string{"name": "emit_completion"},
		},
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return "", err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+cfg.APIKey)

	resp, err := a.client.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("openai-compatible: unexpected status %d", resp.StatusCode)
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				ToolCalls []struct {
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", err
	}
	for _, choice := range parsed.Choices {
		for _, call := range choice.Message.ToolCalls {
			if call.Function.Name == "emit_completion" {
				var args struct {
					Completion string `json:"completion"`
				}
				if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
					return "", err
				}
				return args.Completion, nil
			}
		}
	}
	return "", fmt.Errorf("openai-compatible: no tool call in response")
}

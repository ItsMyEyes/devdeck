package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAnthropicAdapterSendsForcedToolCallAndCaching(t *testing.T) {
	var capturedBody map[string]any
	var capturedAuth string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedAuth = r.Header.Get("x-api-key")
		if err := json.NewDecoder(r.Body).Decode(&capturedBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"content": [
				{"type": "tool_use", "name": "emit_completion", "input": {"completion": "return 42"}}
			]
		}`))
	}))
	defer srv.Close()

	adapter := NewAnthropicAdapter()
	result, err := adapter.Complete(context.Background(), CompletionRequest{
		Prefix: "func answer() int {\n", Suffix: "\n}", Language: "go",
		GroundingSymbols: []GroundingSymbol{{Name: "fmt.Sprintf", Kind: "function", Detail: "func(format string, a ...any) string"}},
	}, Config{Provider: "anthropic", BaseURL: srv.URL, Model: "claude-haiku-4-5", APIKey: "test-key"})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if result != "return 42" {
		t.Errorf("result = %q, want %q", result, "return 42")
	}
	if capturedAuth != "test-key" {
		t.Errorf("x-api-key = %q, want test-key", capturedAuth)
	}

	toolChoice, _ := capturedBody["tool_choice"].(map[string]any)
	if toolChoice["type"] != "tool" || toolChoice["name"] != "emit_completion" {
		t.Errorf("tool_choice = %+v, want forced emit_completion", toolChoice)
	}

	tools, _ := capturedBody["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %+v, want exactly one tool definition", tools)
	}
	tool, _ := tools[0].(map[string]any)
	if _, ok := tool["cache_control"]; !ok {
		t.Errorf("tool definition missing cache_control")
	}

	system, _ := capturedBody["system"].([]any)
	if len(system) != 1 {
		t.Fatalf("system = %+v, want exactly one system block", system)
	}
	sysBlock, _ := system[0].(map[string]any)
	if _, ok := sysBlock["cache_control"]; !ok {
		t.Errorf("system block missing cache_control")
	}

	messages, _ := capturedBody["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("messages = %+v, want exactly one user message", messages)
	}
	msg, _ := messages[0].(map[string]any)
	content, _ := msg["content"].(string)
	if !strings.Contains(content, "fmt.Sprintf") {
		t.Errorf("user content missing grounding symbol, got: %s", content)
	}
	if !strings.Contains(content, "<CURSOR>") {
		t.Errorf("user content missing <CURSOR> marker, got: %s", content)
	}
}

func TestAnthropicAdapterErrorsOnNonOKStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	adapter := NewAnthropicAdapter()
	_, err := adapter.Complete(context.Background(), CompletionRequest{}, Config{BaseURL: srv.URL, APIKey: "bad-key"})
	if err == nil {
		t.Fatal("expected an error on 401, got nil")
	}
}

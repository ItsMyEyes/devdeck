package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOpenAICompatAdapterSendsForcedToolCall(t *testing.T) {
	var capturedBody map[string]any
	var capturedAuth string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&capturedBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"choices": [
				{"message": {"tool_calls": [
					{"function": {"name": "emit_completion", "arguments": "{\"completion\":\"return 7\"}"}}
				]}}
			]
		}`))
	}))
	defer srv.Close()

	adapter := NewOpenAICompatAdapter()
	result, err := adapter.Complete(context.Background(), CompletionRequest{Prefix: "x := ", Language: "go"}, Config{
		Provider: "openai-compatible", BaseURL: srv.URL, Model: "gpt-4o-mini", APIKey: "test-key",
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if result != "return 7" {
		t.Errorf("result = %q, want %q", result, "return 7")
	}
	if capturedAuth != "Bearer test-key" {
		t.Errorf("Authorization = %q, want %q", capturedAuth, "Bearer test-key")
	}

	toolChoice, _ := capturedBody["tool_choice"].(map[string]any)
	fn, _ := toolChoice["function"].(map[string]any)
	if toolChoice["type"] != "function" || fn["name"] != "emit_completion" {
		t.Errorf("tool_choice = %+v, want forced emit_completion function", toolChoice)
	}
}

func TestOpenAICompatAdapterDefaultsBaseURL(t *testing.T) {
	adapter := NewOpenAICompatAdapter().(*openAICompatAdapter)
	if adapter == nil {
		t.Fatal("expected *openAICompatAdapter")
	}
	// resolveBaseURL is exercised indirectly via Complete() in the test above
	// with an explicit BaseURL; this test only pins the default constant so a
	// future edit can't silently change it without a diff show up here.
	if openAICompatDefaultBaseURL != "https://api.openai.com/v1" {
		t.Errorf("openAICompatDefaultBaseURL = %q, want https://api.openai.com/v1", openAICompatDefaultBaseURL)
	}
}

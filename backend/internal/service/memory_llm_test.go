package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"devdeck/backend/internal/port"
)

func TestMemoryLLMConnectionUsesSavedKeyAndSelectedModel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer saved-secret" {
			t.Errorf("unexpected request path or credentials")
		}
		var body struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Model != "test-model" {
			t.Errorf("model = %q, err = %v", body.Model, err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"OK"}}]}`))
	}))
	defer server.Close()
	svc := newTestMemoryService(t)
	key := "saved-secret"
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{LLMAPIKey: &key}); err != nil {
		t.Fatal(err)
	}
	if err := svc.TestLLMConnection(context.Background(), MemoryLLMTest{Provider: "openai", Model: "test-model", BaseURL: server.URL + "/v1"}); err != nil {
		t.Fatal(err)
	}
}

func TestMemoryLLMConnectionDoesNotLeakProviderErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "secret-provider-body", http.StatusUnauthorized)
	}))
	defer server.Close()
	svc := newTestMemoryService(t)
	err := svc.TestLLMConnection(context.Background(), MemoryLLMTest{Provider: "openai", Model: "test-model", BaseURL: server.URL, APIKey: "secret-key"})
	if err == nil || !strings.Contains(err.Error(), "401") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMemoryLLMConnectionProviderProtocols(t *testing.T) {
	cases := []struct{ provider, path, header, response string }{
		{"anthropic", "/v1/messages", "x-api-key", `{"content":[{"type":"text","text":"OK"}]}`},
		{"gemini", "/models/test-model:generateContent", "x-goog-api-key", `{"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}`},
		{"ollama", "/api/chat", "", `{"message":{"role":"assistant","content":"OK"}}`},
		{"groq", "/chat/completions", "Authorization", `{"choices":[{"message":{"content":"OK"}}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.provider, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != tc.path {
					t.Errorf("got %s %s", r.Method, r.URL.Path)
				}
				if tc.header != "" && !strings.Contains(r.Header.Get(tc.header), "test-key") {
					t.Errorf("missing provider credential")
				}
				_, _ = w.Write([]byte(tc.response))
			}))
			defer server.Close()
			err := newTestMemoryService(t).TestLLMConnection(context.Background(), MemoryLLMTest{Provider: tc.provider, Model: "test-model", BaseURL: server.URL, APIKey: "test-key"})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMemoryLLMConnectionRejectsEmptyModelResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"choices":[]}`)) }))
	defer server.Close()
	err := newTestMemoryService(t).TestLLMConnection(context.Background(), MemoryLLMTest{Provider: "lmstudio", Model: "test-model", BaseURL: server.URL})
	if err == nil {
		t.Fatal("empty response must not be reported as connected")
	}
}

func TestMemoryLLMLMStudioRootURLUsesV1(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path = %s, want /v1/chat/completions", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"OK"}}]}`))
	}))
	defer server.Close()
	err := newTestMemoryService(t).TestLLMConnection(context.Background(), MemoryLLMTest{Provider: "lmstudio", Model: "test-model", BaseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
}

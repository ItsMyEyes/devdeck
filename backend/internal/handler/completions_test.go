package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

func newTestCompletionsHandler(t *testing.T) *CompletionsHandler {
	t.Helper()
	st := store.NewTestStore(t)
	return NewCompletionsHandler(service.NewCompletionsService(st))
}

func TestGetConfigDefaultsUnconfigured(t *testing.T) {
	h := newTestCompletionsHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/completions/config", nil)
	rec := httptest.NewRecorder()
	h.GetConfig(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["configured"] != false {
		t.Errorf("configured = %v, want false", body["configured"])
	}
	if _, hasKey := body["apiKey"]; hasKey {
		t.Errorf("response leaked apiKey field: %+v", body)
	}
}

func TestPutConfigUpdatesAndNeverEchoesKey(t *testing.T) {
	h := newTestCompletionsHandler(t)

	payload, _ := json.Marshal(map[string]any{"enabled": true, "apiKey": "sk-secret"})
	req := httptest.NewRequest(http.MethodPut, "/api/completions/config", bytes.NewReader(payload))
	rec := httptest.NewRecorder()
	h.PutConfig(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["enabled"] != true {
		t.Errorf("enabled = %v, want true", body["enabled"])
	}
	if body["configured"] != true {
		t.Errorf("configured = %v, want true after setting a key", body["configured"])
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"configured":true`)) {
		t.Errorf("response body missing configured:true: %s", rec.Body.String())
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("sk-secret")) {
		t.Errorf("response body leaked the raw API key: %s", rec.Body.String())
	}
}

func TestPostInlineReturns204WhenNotConfigured(t *testing.T) {
	h := newTestCompletionsHandler(t)

	payload, _ := json.Marshal(map[string]any{"prefix": "x", "suffix": "", "language": "go"})
	req := httptest.NewRequest(http.MethodPost, "/api/completions/inline", bytes.NewReader(payload))
	rec := httptest.NewRecorder()
	h.PostInline(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body: %s)", rec.Code, rec.Body.String())
	}
}

package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHubKeyHandlerConfigured(t *testing.T) {
	h := NewHubKeyHandler("hub-secret-key")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/self/hub-key", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var body struct {
		Configured bool   `json:"configured"`
		Key        string `json:"key"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !body.Configured {
		t.Error("configured = false, want true when the hub was started with --key")
	}
	if body.Key != "hub-secret-key" {
		t.Errorf("key = %q, want %q", body.Key, "hub-secret-key")
	}
}

// A hub started without --key cannot accept self-registration at all. Saying
// so lets the dialog explain the problem instead of handing the operator a
// command that fails with a 401 on the target machine.
func TestHubKeyHandlerNotConfigured(t *testing.T) {
	h := NewHubKeyHandler("")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/self/hub-key", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var body struct {
		Configured bool   `json:"configured"`
		Key        string `json:"key"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Configured {
		t.Error("configured = true, want false when no --key was set")
	}
	if body.Key != "" {
		t.Errorf("key = %q, want an empty string when unconfigured", body.Key)
	}
}

// The response carries a long-lived credential, so it must not sit in any
// intermediary or browser cache.
func TestHubKeyHandlerSetsNoStore(t *testing.T) {
	for _, key := range []string{"hub-secret-key", ""} {
		rec := httptest.NewRecorder()
		NewHubKeyHandler(key).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/self/hub-key", nil))
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("Cache-Control = %q for key %q, want %q", got, key, "no-store")
		}
	}
}

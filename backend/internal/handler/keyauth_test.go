package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func requireKeyServer(t *testing.T) http.Handler {
	t.Helper()
	return RequireKey("sekrit")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
}

func TestRequireKeyRejectsMissingKey(t *testing.T) {
	rec := httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestRequireKeyRejectsWrongKey(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/workspaces", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestRequireKeyAcceptsBearerKey(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/workspaces", nil)
	req.Header.Set("Authorization", "Bearer sekrit")
	rec := httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestRequireKeyHealthIsPublic(t *testing.T) {
	rec := httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestRequireKeyProtectsWhoami(t *testing.T) {
	rec := httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/whoami", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 (whoami must NOT be exempt like /api/health)", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/whoami", nil)
	req.Header.Set("Authorization", "Bearer sekrit")
	rec = httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 with the correct key", rec.Code)
	}
}

func TestRequireKeyAcceptsQueryKeyOnlyForWebSocketUpgrade(t *testing.T) {
	// Plain GET with ?key= must be rejected (keys don't belong in URLs)…
	rec := httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces?key=sekrit", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("plain GET with ?key: status = %d, want 401", rec.Code)
	}
	// …but a WS upgrade request may use it (browser WS API can't set headers).
	req := httptest.NewRequest(http.MethodGet, "/ws/terminal?key=sekrit", nil)
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	rec = httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("WS upgrade with ?key: status = %d, want 200", rec.Code)
	}
}

package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// okHandler records that the middleware let the request through.
func okHandler(hit *bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		*hit = true
		w.WriteHeader(http.StatusOK)
	})
}

func TestRequireRuntimeAuthAcceptsBearerKey(t *testing.T) {
	var hit bool
	mw := RequireRuntimeAuth(nil, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/api/worktrees", nil)
	req.Header.Set("Authorization", "Bearer rt-key")
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)
	if !hit || rec.Code != http.StatusOK {
		t.Errorf("bearer key rejected: code=%d hit=%v", rec.Code, hit)
	}
}

func TestRequireRuntimeAuthAcceptsWebSocketQueryKey(t *testing.T) {
	var hit bool
	mw := RequireRuntimeAuth(nil, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/ws/terminal?key=rt-key", nil)
	req.Header.Set("Upgrade", "websocket")
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)
	if !hit || rec.Code != http.StatusOK {
		t.Errorf("websocket ?key= rejected: code=%d hit=%v", rec.Code, hit)
	}
}

func TestRequireRuntimeAuthAllowsHealthAndStaticAssets(t *testing.T) {
	for _, path := range []string{"/api/health", "/", "/assets/index.js"} {
		var hit bool
		mw := RequireRuntimeAuth(nil, "rt-key")
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		mw(okHandler(&hit)).ServeHTTP(rec, req)
		if !hit {
			t.Errorf("path %q was blocked, want public", path)
		}
	}
}

func TestRequireRuntimeAuthRejectsMissingCredential(t *testing.T) {
	var hit bool
	mw := RequireRuntimeAuth(nil, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/api/worktrees", nil)
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)
	if hit || rec.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated request allowed: code=%d hit=%v", rec.Code, hit)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

func TestRequireRuntimeAuthRejectsWrongKey(t *testing.T) {
	var hit bool
	mw := RequireRuntimeAuth(nil, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/api/worktrees", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)
	if hit || rec.Code != http.StatusUnauthorized {
		t.Errorf("wrong key allowed: code=%d hit=%v", rec.Code, hit)
	}
}

package handler

import (
	"crypto/ed25519"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"devdeck/backend/internal/handovertoken"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
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

func TestRequireRuntimeAuthAcceptsAValidHandoverToken(t *testing.T) {
	st := store.NewTestStore(t)
	authKey := make([]byte, 32)
	authSvc := service.NewAuthService(st, authKey)

	pub, priv, _ := ed25519.GenerateKey(nil)
	SetRuntimeIdentity("m-this-runtime", pub)
	defer SetRuntimeIdentity("", nil) // don't leak state into other tests

	tok, err := handovertoken.Issue(priv, "user-1", "m-this-runtime", time.Now())
	if err != nil {
		t.Fatal(err)
	}

	var hit bool
	mw := RequireRuntimeAuth(authSvc, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/?t="+tok, nil)
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)

	if rec.Code != http.StatusFound && rec.Code != http.StatusTemporaryRedirect {
		t.Fatalf("status = %d, want a redirect (302/307) to a clean URL after minting a cookie", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if strings.Contains(loc, "t=") {
		t.Errorf("redirect Location = %q, still carries the token — it must be scrubbed", loc)
	}
	setCookie := rec.Header().Get("Set-Cookie")
	if !strings.Contains(setCookie, "devdeck_session=") || !strings.Contains(setCookie, "SameSite=Lax") {
		t.Errorf("Set-Cookie = %q, want a devdeck_session cookie with SameSite=Lax", setCookie)
	}
}

func TestRequireRuntimeAuthRejectsATokenForADifferentMachine(t *testing.T) {
	st := store.NewTestStore(t)
	authKey := make([]byte, 32)
	authSvc := service.NewAuthService(st, authKey)

	pub, priv, _ := ed25519.GenerateKey(nil)
	SetRuntimeIdentity("m-this-runtime", pub)
	defer SetRuntimeIdentity("", nil)

	tok, _ := handovertoken.Issue(priv, "user-1", "m-a-different-runtime", time.Now())

	var hit bool
	mw := RequireRuntimeAuth(authSvc, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/?t="+tok, nil)
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)

	// The static SPA shell is served either way — "/" stays public so the
	// client-side router can run and show the sign-in page itself; that's
	// not a privilege grant. What must never happen is a session actually
	// getting minted, or a handover redirect, for a token that doesn't
	// verify.
	if rec.Code == http.StatusFound || rec.Header().Get("Set-Cookie") != "" {
		t.Errorf("a token for a different machine was accepted: code=%d set-cookie=%q", rec.Code, rec.Header().Get("Set-Cookie"))
	}
}

func TestRequireRuntimeAuthFallsThroughWhenIdentityIsUnknown(t *testing.T) {
	SetRuntimeIdentity("", nil) // simulates a runtime that hasn't registered yet
	_, priv, _ := ed25519.GenerateKey(nil)
	tok, _ := handovertoken.Issue(priv, "user-1", "m-whatever", time.Now())

	var hit bool
	mw := RequireRuntimeAuth(nil, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/?t="+tok, nil)
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)

	if rec.Code == http.StatusFound || rec.Header().Get("Set-Cookie") != "" {
		t.Errorf("token was accepted despite no known runtime identity: code=%d set-cookie=%q", rec.Code, rec.Header().Get("Set-Cookie"))
	}
}

func TestRequireRuntimeAuthStillAcceptsBearerKeyAlongsideTokenSupport(t *testing.T) {
	// Regression guard: adding ?t= handling must not disturb the existing
	// paths frontend/src/lib/machineClient.ts depends on.
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

func TestRequireRuntimeAuthAllowsWhoamiWithoutACredential(t *testing.T) {
	var hit bool
	mw := RequireRuntimeAuth(nil, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/api/whoami", nil)
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)
	if !hit || rec.Code != http.StatusOK {
		t.Errorf("unauthenticated /api/whoami: code=%d hit=%v, want 200 — the frontend must be able to learn this process's role before any credential exists", rec.Code, hit)
	}
}

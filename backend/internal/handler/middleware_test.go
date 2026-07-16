package handler

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"

	"loom/backend/internal/service"
	"loom/backend/internal/store"
)

func TestHandleStoreErrMapsValidationTo400(t *testing.T) {
	rec := httptest.NewRecorder()
	err := fmt.Errorf("base branch %q not found: %w", "nope", service.ErrValidation)
	if !handleStoreErr(rec, err) {
		t.Fatal("expected handleStoreErr to report an error was handled")
	}
	if rec.Code != 400 {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestHandleStoreErrMapsConflictTo409(t *testing.T) {
	rec := httptest.NewRecorder()
	err := fmt.Errorf("branch %q already in use: %w", "feat/x", service.ErrConflict)
	if !handleStoreErr(rec, err) {
		t.Fatal("expected handleStoreErr to report an error was handled")
	}
	if rec.Code != 409 {
		t.Errorf("status = %d, want 409", rec.Code)
	}
}

func TestHandleStoreErrStillMapsNotFoundTo404(t *testing.T) {
	rec := httptest.NewRecorder()
	if !handleStoreErr(rec, store.ErrNotFound) {
		t.Fatal("expected handleStoreErr to report an error was handled")
	}
	if rec.Code != 404 {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestHandleStoreErrMapsUnauthorizedTo401(t *testing.T) {
	rec := httptest.NewRecorder()
	err := fmt.Errorf("invalid email or password: %w", service.ErrUnauthorized)
	if !handleStoreErr(rec, err) {
		t.Fatal("expected handleStoreErr to report an error was handled")
	}
	if rec.Code != 401 {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestHandleStoreErrMapsLockedTo423(t *testing.T) {
	rec := httptest.NewRecorder()
	err := fmt.Errorf("account locked until 2026-01-01T00:05:00Z: %w", service.ErrLocked)
	if !handleStoreErr(rec, err) {
		t.Fatal("expected handleStoreErr to report an error was handled")
	}
	if rec.Code != 423 {
		t.Errorf("status = %d, want 423", rec.Code)
	}
}

func newTestAuthServiceForMiddleware(t *testing.T) *service.AuthService {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return service.NewAuthService(store.New(db), make([]byte, 32))
}

func TestRequireAuthAllowsPublicPathWithoutCookie(t *testing.T) {
	svc := newTestAuthServiceForMiddleware(t)
	called := false
	mw := RequireAuth(svc, "")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/auth/login", nil))
	if !called {
		t.Error("RequireAuth blocked a public path")
	}
}

func TestRequireAuthAllowsBrowserProxyPathWithoutCookie(t *testing.T) {
	svc := newTestAuthServiceForMiddleware(t)
	called := false
	mw := RequireAuth(svc, "")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, browserProxyPath, nil))
	if !called {
		t.Error("RequireAuth blocked browser proxy path before token validation")
	}
}

func TestRequireAuthBlocksProtectedPathWithoutCookie(t *testing.T) {
	svc := newTestAuthServiceForMiddleware(t)
	called := false
	mw := RequireAuth(svc, "")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces", nil))
	if called {
		t.Error("RequireAuth let a protected path through without a session cookie")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestRequireAuthBlocksWhoamiWithoutCookie(t *testing.T) {
	svc := newTestAuthServiceForMiddleware(t)
	called := false
	mw := RequireAuth(svc, "")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/whoami", nil))
	if called {
		t.Error("RequireAuth let /api/whoami through without a session cookie or key (it must not be public like /api/health)")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestRequireAuthBlocksTerminalWebsocketPathWithoutCookie(t *testing.T) {
	svc := newTestAuthServiceForMiddleware(t)
	called := false
	mw := RequireAuth(svc, "")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ws/terminal", nil))
	if called {
		t.Error("RequireAuth let /ws/terminal through without a session cookie")
	}
}

func TestRequireAuthBlocksLSPWebsocketPathWithoutCookie(t *testing.T) {
	svc := newTestAuthServiceForMiddleware(t)
	called := false
	mw := RequireAuth(svc, "")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ws/lsp", nil))
	if called {
		t.Error("RequireAuth let /ws/lsp through without a session cookie")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestCorsMiddlewareAllowsAuthorizationHeader(t *testing.T) {
	h := CorsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodOptions, "/api/machines", nil))
	got := rec.Header().Get("Access-Control-Allow-Headers")
	if !strings.Contains(got, "Authorization") {
		t.Errorf("Access-Control-Allow-Headers = %q, want it to include Authorization", got)
	}
}

func TestRequireAuthAllowsProtectedPathWithValidCookie(t *testing.T) {
	svc := newTestAuthServiceForMiddleware(t)
	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	secret, _, err := svc.BeginTotpEnrollment(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	setupCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmTotpEnrollment(user.ID, setupCode); err != nil {
		t.Fatal(err)
	}
	pendingToken, err := svc.Login("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	loginCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	sessionToken, _, err := svc.VerifyTotp(pendingToken, loginCode)
	if err != nil {
		t.Fatal(err)
	}

	called := false
	mw := RequireAuth(svc, "")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/workspaces", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionToken})
	mw.ServeHTTP(rec, req)
	if !called {
		t.Errorf("RequireAuth blocked a valid session, status = %d, body=%s", rec.Code, rec.Body)
	}
}

func TestRequireAuthAcceptsBearerHubKey(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	svc := service.NewAuthService(store.New(db), make([]byte, 32))

	h := RequireAuth(svc, "hubkey")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/workspaces", nil)
	req.Header.Set("Authorization", "Bearer hubkey")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("bearer hub key: status = %d, want 200", rec.Code)
	}

	// wrong key still falls through to cookie auth → 401 (no cookie)
	req = httptest.NewRequest(http.MethodGet, "/api/workspaces", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("wrong bearer key: status = %d, want 401", rec.Code)
	}
}

func TestRequireAuthEmptyHubKeyNeverMatchesBearer(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	svc := service.NewAuthService(store.New(db), make([]byte, 32))

	h := RequireAuth(svc, "")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	req := httptest.NewRequest(http.MethodGet, "/api/workspaces", nil)
	req.Header.Set("Authorization", "Bearer ")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("empty configured key: status = %d, want 401", rec.Code)
	}
}

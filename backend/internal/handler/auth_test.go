package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"

	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

func newTestAuthHandler(t *testing.T) *AuthHandler {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	key := make([]byte, 32)
	return NewAuthHandler(service.NewAuthService(store.New(db), key))
}

func jsonBody(t *testing.T, v any) *bytes.Buffer {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.NewBuffer(b)
}

func cookieFrom(rec *httptest.ResponseRecorder, name string) string {
	for _, c := range rec.Result().Cookies() {
		if c.Name == name {
			return c.Value
		}
	}
	return ""
}

func TestRegisterLoginTotpFullFlow(t *testing.T) {
	h := newTestAuthHandler(t)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", jsonBody(t, map[string]string{
		"email": "owner@example.com", "password": "correct horse battery staple",
	}))
	h.PostRegister(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register status = %d, want 201, body=%s", rec.Code, rec.Body)
	}
	pendingCookie := cookieFrom(rec, pendingCookieName)
	if pendingCookie == "" {
		t.Fatal("register did not set the pending cookie")
	}

	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/api/auth/register", jsonBody(t, map[string]string{
		"email": "intruder@example.com", "password": "another long enough password",
	}))
	h.PostRegister(rec2, req2)
	if rec2.Code != http.StatusConflict {
		t.Errorf("second register status = %d, want 409", rec2.Code)
	}

	setupRec := httptest.NewRecorder()
	setupReq := httptest.NewRequest(http.MethodPost, "/api/auth/totp/setup", nil)
	setupReq.AddCookie(&http.Cookie{Name: pendingCookieName, Value: pendingCookie})
	h.PostTotpSetup(setupRec, setupReq)
	if setupRec.Code != http.StatusOK {
		t.Fatalf("totp setup status = %d, want 200, body=%s", setupRec.Code, setupRec.Body)
	}
	var setupResp struct {
		OtpauthUri string `json:"otpauthUri"`
	}
	if err := json.Unmarshal(setupRec.Body.Bytes(), &setupResp); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(setupResp.OtpauthUri)
	if err != nil {
		t.Fatal(err)
	}
	secret := u.Query().Get("secret")
	if secret == "" {
		t.Fatal("otpauth URI missing secret query param")
	}

	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	confirmRec := httptest.NewRecorder()
	confirmReq := httptest.NewRequest(http.MethodPost, "/api/auth/totp/verify-setup", jsonBody(t, map[string]string{"code": code}))
	confirmReq.AddCookie(&http.Cookie{Name: pendingCookieName, Value: pendingCookie})
	h.PostTotpVerifySetup(confirmRec, confirmReq)
	if confirmRec.Code != http.StatusOK {
		t.Fatalf("verify-setup status = %d, want 200, body=%s", confirmRec.Code, confirmRec.Body)
	}

	loginRec := httptest.NewRecorder()
	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", jsonBody(t, map[string]string{
		"email": "owner@example.com", "password": "correct horse battery staple",
	}))
	h.PostLogin(loginRec, loginReq)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login status = %d, want 200, body=%s", loginRec.Code, loginRec.Body)
	}
	loginPendingCookie := cookieFrom(loginRec, pendingCookieName)

	loginCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	verifyRec := httptest.NewRecorder()
	verifyReq := httptest.NewRequest(http.MethodPost, "/api/auth/totp/verify", jsonBody(t, map[string]string{"code": loginCode}))
	verifyReq.AddCookie(&http.Cookie{Name: pendingCookieName, Value: loginPendingCookie})
	h.PostTotpVerify(verifyRec, verifyReq)
	if verifyRec.Code != http.StatusOK {
		t.Fatalf("totp verify status = %d, want 200, body=%s", verifyRec.Code, verifyRec.Body)
	}
	sessionCookie := cookieFrom(verifyRec, sessionCookieName)
	if sessionCookie == "" {
		t.Fatal("totp verify did not set the session cookie")
	}

	meRec := httptest.NewRecorder()
	meReq := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	meReq.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionCookie})
	h.GetMe(meRec, meReq)
	if meRec.Code != http.StatusOK {
		t.Fatalf("me status = %d, want 200, body=%s", meRec.Code, meRec.Body)
	}

	logoutRec := httptest.NewRecorder()
	logoutReq := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	logoutReq.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionCookie})
	h.PostLogout(logoutRec, logoutReq)
	if logoutRec.Code != http.StatusNoContent {
		t.Errorf("logout status = %d, want 204", logoutRec.Code)
	}

	meRec2 := httptest.NewRecorder()
	meReq2 := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	meReq2.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionCookie})
	h.GetMe(meRec2, meReq2)
	if meRec2.Code != http.StatusUnauthorized {
		t.Errorf("me after logout status = %d, want 401", meRec2.Code)
	}
}

func TestLoginLockoutReturns423(t *testing.T) {
	h := newTestAuthHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", jsonBody(t, map[string]string{
		"email": "owner@example.com", "password": "correct horse battery staple",
	}))
	h.PostRegister(rec, req)

	for i := 0; i < 5; i++ {
		badRec := httptest.NewRecorder()
		badReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", jsonBody(t, map[string]string{
			"email": "owner@example.com", "password": "wrong password",
		}))
		h.PostLogin(badRec, badReq)
	}
	lockedRec := httptest.NewRecorder()
	lockedReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", jsonBody(t, map[string]string{
		"email": "owner@example.com", "password": "wrong password",
	}))
	h.PostLogin(lockedRec, lockedReq)
	if lockedRec.Code != http.StatusLocked {
		t.Fatalf("status = %d, want 423, body=%s", lockedRec.Code, lockedRec.Body)
	}
}

func TestLoginRequiresTurnstileWhenConfigured(t *testing.T) {
	h := newTestAuthHandler(t)
	h.SetTurnstile(service.NewTurnstileVerifier("site-key", "secret-key"), nil, "")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", jsonBody(t, map[string]string{
		"email": "owner@example.com", "password": "correct horse battery staple",
	}))
	h.PostLogin(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("login without turnstile token status = %d, want 400, body=%s", rec.Code, rec.Body)
	}

	cfgRec := httptest.NewRecorder()
	h.GetConfig(cfgRec, httptest.NewRequest(http.MethodGet, "/api/auth/config", nil))
	var cfg struct {
		TurnstileSiteKey string `json:"turnstileSiteKey"`
	}
	if err := json.Unmarshal(cfgRec.Body.Bytes(), &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.TurnstileSiteKey != "site-key" {
		t.Errorf("config turnstileSiteKey = %q, want %q", cfg.TurnstileSiteKey, "site-key")
	}
}

func TestConfigOmitsTurnstileWhenDisabled(t *testing.T) {
	h := newTestAuthHandler(t)
	rec := httptest.NewRecorder()
	h.GetConfig(rec, httptest.NewRequest(http.MethodGet, "/api/auth/config", nil))
	var cfg struct {
		TurnstileSiteKey string `json:"turnstileSiteKey"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.TurnstileSiteKey != "" {
		t.Errorf("config turnstileSiteKey = %q, want empty when disabled", cfg.TurnstileSiteKey)
	}
}

func TestSetSecureCookiesTogglesSecureAttribute(t *testing.T) {
	t.Cleanup(func() { SetSecureCookies(true) })

	rec := httptest.NewRecorder()
	setAuthCookie(rec, sessionCookieName, "tok", time.Hour, http.SameSiteStrictMode)
	if c := rec.Result().Cookies()[0]; !c.Secure {
		t.Fatal("expected Secure cookie by default")
	}

	SetSecureCookies(false)
	rec = httptest.NewRecorder()
	setAuthCookie(rec, sessionCookieName, "tok", time.Hour, http.SameSiteStrictMode)
	if c := rec.Result().Cookies()[0]; c.Secure {
		t.Fatal("expected non-Secure cookie after SetSecureCookies(false)")
	}
}

func TestKeySessionExchangesKeyForSession(t *testing.T) {
	h := newTestAuthHandler(t)
	h.SetDesktopKey("sekrit")

	req := httptest.NewRequest(http.MethodPost, "/api/auth/key-session", nil)
	req.Header.Set("Authorization", "Bearer sekrit")
	rec := httptest.NewRecorder()
	h.PostKeySession(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	var session *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName {
			session = c
		}
	}
	if session == nil || session.Value == "" {
		t.Fatal("no session cookie set")
	}

	// The minted session must work against GetMe.
	me := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	me.AddCookie(session)
	meRec := httptest.NewRecorder()
	h.GetMe(meRec, me)
	if meRec.Code != http.StatusOK {
		t.Fatalf("GetMe with key-session cookie = %d, want 200", meRec.Code)
	}
}

func TestKeySessionRejectsWrongKey(t *testing.T) {
	h := newTestAuthHandler(t)
	h.SetDesktopKey("sekrit")

	req := httptest.NewRequest(http.MethodPost, "/api/auth/key-session", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()
	h.PostKeySession(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestKeySessionRejectsWhenNoKeyConfigured(t *testing.T) {
	h := newTestAuthHandler(t) // SetDesktopKey never called

	req := httptest.NewRequest(http.MethodPost, "/api/auth/key-session", nil)
	req.Header.Set("Authorization", "Bearer anything")
	rec := httptest.NewRecorder()
	h.PostKeySession(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestSetAuthCookieHonoursSameSite(t *testing.T) {
	tests := []struct {
		name     string
		sameSite http.SameSite
		want     string
	}{
		{"strict for hub", http.SameSiteStrictMode, "SameSite=Strict"},
		{"lax for runtime", http.SameSiteLaxMode, "SameSite=Lax"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			setAuthCookie(rec, "devdeck_session", "tok", time.Hour, tt.sameSite)
			got := rec.Header().Get("Set-Cookie")
			if !strings.Contains(got, tt.want) {
				t.Errorf("Set-Cookie = %q, want it to contain %q", got, tt.want)
			}
		})
	}
}

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
	setAuthCookie(rec, nil, sessionCookieName, "tok", time.Hour, http.SameSiteStrictMode)
	if c := rec.Result().Cookies()[0]; !c.Secure {
		t.Fatal("expected Secure cookie by default when r is nil")
	}

	SetSecureCookies(false)
	rec = httptest.NewRecorder()
	setAuthCookie(rec, nil, sessionCookieName, "tok", time.Hour, http.SameSiteStrictMode)
	if c := rec.Result().Cookies()[0]; c.Secure {
		t.Fatal("expected non-Secure cookie after SetSecureCookies(false)")
	}
}

func TestAuthCookieSecureOnlyOnTLSOrHTTPS(t *testing.T) {
	t.Cleanup(func() { SetSecureCookies(true) })
	SetSecureCookies(true)

	// Plain HTTP: should NOT set Secure (fixes Issue #1 and Issue #2)
	httpReq := httptest.NewRequest(http.MethodPost, "http://192.168.1.100:8989/api/auth/login", nil)
	rec := httptest.NewRecorder()
	setAuthCookie(rec, httpReq, sessionCookieName, "tok", time.Hour, http.SameSiteStrictMode)
	if c := rec.Result().Cookies()[0]; c.Secure {
		t.Errorf("plain HTTP request must NOT have Secure cookie, got Secure=%v", c.Secure)
	}

	// HTTPS via TLS
	httpsReq := httptest.NewRequest(http.MethodPost, "https://example.com/api/auth/login", nil)
	rec = httptest.NewRecorder()
	setAuthCookie(rec, httpsReq, sessionCookieName, "tok", time.Hour, http.SameSiteStrictMode)
	if c := rec.Result().Cookies()[0]; !c.Secure {
		t.Errorf("HTTPS request must have Secure cookie, got Secure=%v", c.Secure)
	}

	// HTTPS via X-Forwarded-Proto
	forwardedReq := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8989/api/auth/login", nil)
	forwardedReq.Header.Set("X-Forwarded-Proto", "https")
	rec = httptest.NewRecorder()
	setAuthCookie(rec, forwardedReq, sessionCookieName, "tok", time.Hour, http.SameSiteStrictMode)
	if c := rec.Result().Cookies()[0]; !c.Secure {
		t.Errorf("X-Forwarded-Proto: https request must have Secure cookie, got Secure=%v", c.Secure)
	}

	// HTTPS with SetSecureCookies(false) disabled
	SetSecureCookies(false)
	rec = httptest.NewRecorder()
	setAuthCookie(rec, httpsReq, sessionCookieName, "tok", time.Hour, http.SameSiteStrictMode)
	if c := rec.Result().Cookies()[0]; c.Secure {
		t.Errorf("SetSecureCookies(false) must not set Secure cookie even on HTTPS, got Secure=%v", c.Secure)
	}
}

func TestRegisterTotpSetupOnHTTP(t *testing.T) {
	h := newTestAuthHandler(t)

	// 1. Register over plain HTTP (Issue #1 reproduction)
	regRec := httptest.NewRecorder()
	regReq := httptest.NewRequest(http.MethodPost, "http://192.168.1.100:8989/api/auth/register", jsonBody(t, map[string]string{
		"email": "owner@example.com", "password": "correct horse battery staple",
	}))
	h.PostRegister(regRec, regReq)
	if regRec.Code != http.StatusCreated {
		t.Fatalf("register status = %d, want 201, body=%s", regRec.Code, regRec.Body)
	}
	pendingCookie := regRec.Result().Cookies()[0]
	if pendingCookie.Name != pendingCookieName || pendingCookie.Value == "" {
		t.Fatal("register did not set devdeck_pending cookie")
	}
	if pendingCookie.Secure {
		t.Errorf("pending cookie over plain HTTP must not be Secure, got Secure=%v", pendingCookie.Secure)
	}

	// 2. Setup TOTP over HTTP with the pending cookie (previously failed with 401 in Issue #1)
	setupRec := httptest.NewRecorder()
	setupReq := httptest.NewRequest(http.MethodPost, "http://192.168.1.100:8989/api/auth/totp/setup", nil)
	setupReq.AddCookie(pendingCookie)
	h.PostTotpSetup(setupRec, setupReq)
	if setupRec.Code != http.StatusOK {
		t.Fatalf("totp setup status = %d, want 200, body=%s", setupRec.Code, setupRec.Body)
	}
	var setupResp struct {
		OtpauthUri string `json:"otpauthUri"`
	}
	if err := json.Unmarshal(setupRec.Body.Bytes(), &setupResp); err != nil || setupResp.OtpauthUri == "" {
		t.Fatalf("invalid setup response: %s", setupRec.Body.String())
	}
}

func TestLoginWithout2FAOnHTTP(t *testing.T) {
	h := newTestAuthHandler(t)
	h.svc.SetTOTPRequired(false)

	// Register over HTTP
	regRec := httptest.NewRecorder()
	regReq := httptest.NewRequest(http.MethodPost, "http://192.168.1.100:8989/api/auth/register", jsonBody(t, map[string]string{
		"email": "owner@example.com", "password": "correct horse battery staple",
	}))
	h.PostRegister(regRec, regReq)
	if regRec.Code != http.StatusCreated {
		t.Fatalf("register status = %d, want 201, body=%s", regRec.Code, regRec.Body)
	}
	regCookie := regRec.Result().Cookies()[0]
	if regCookie.Secure {
		t.Errorf("register cookie over HTTP must not be Secure, got Secure=%v", regCookie.Secure)
	}

	// Login over HTTP with 2FA disabled (Issue #2 scenario)
	loginRec := httptest.NewRecorder()
	loginReq := httptest.NewRequest(http.MethodPost, "http://192.168.1.100:8989/api/auth/login", jsonBody(t, map[string]string{
		"email": "owner@example.com", "password": "correct horse battery staple",
	}))
	h.PostLogin(loginRec, loginReq)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login status = %d, want 200, body=%s", loginRec.Code, loginRec.Body)
	}
	var loginResp map[string]string
	if err := json.Unmarshal(loginRec.Body.Bytes(), &loginResp); err != nil || loginResp["status"] != "ok" {
		t.Fatalf("login response = %v, want status ok", loginResp)
	}
	loginCookie := loginRec.Result().Cookies()[0]
	if loginCookie.Name != sessionCookieName || loginCookie.Value == "" {
		t.Fatal("login did not set devdeck_session cookie")
	}
	if loginCookie.Secure {
		t.Errorf("login cookie over HTTP must not be Secure, got Secure=%v", loginCookie.Secure)
	}

	// Subsequent GetMe with session cookie
	meRec := httptest.NewRecorder()
	meReq := httptest.NewRequest(http.MethodGet, "http://192.168.1.100:8989/api/auth/me", nil)
	meReq.AddCookie(loginCookie)
	h.GetMe(meRec, meReq)
	if meRec.Code != http.StatusOK {
		t.Fatalf("GetMe status = %d, want 200, body=%s", meRec.Code, meRec.Body)
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

func TestKeySessionDefaultsToThirtyDayMaxAge(t *testing.T) {
	h := newTestAuthHandler(t)
	h.SetDesktopKey("sekrit")

	req := httptest.NewRequest(http.MethodPost, "/api/auth/key-session", nil)
	req.Header.Set("Authorization", "Bearer sekrit")
	rec := httptest.NewRecorder()
	h.PostKeySession(rec, req)

	var session *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName {
			session = c
		}
	}
	if session == nil {
		t.Fatal("no session cookie set")
	}
	want := int(30 * 24 * time.Hour / time.Second)
	if session.MaxAge != want {
		t.Errorf("MaxAge = %d, want %d (30 days, the hub's desktop-sidecar key-session default)", session.MaxAge, want)
	}
}

func TestKeySessionHonoursSessionMaxAgeOverride(t *testing.T) {
	h := newTestAuthHandler(t)
	h.SetDesktopKey("sekrit")
	h.SetSessionMaxAge(12 * time.Hour)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/key-session", nil)
	req.Header.Set("Authorization", "Bearer sekrit")
	rec := httptest.NewRecorder()
	h.PostKeySession(rec, req)

	var session *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName {
			session = c
		}
	}
	if session == nil {
		t.Fatal("no session cookie set")
	}
	want := int(12 * time.Hour / time.Second)
	if session.MaxAge != want {
		t.Errorf("MaxAge = %d, want %d (runtime override)", session.MaxAge, want)
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
			setAuthCookie(rec, nil, "devdeck_session", "tok", time.Hour, tt.sameSite)
			got := rec.Header().Get("Set-Cookie")
			if !strings.Contains(got, tt.want) {
				t.Errorf("Set-Cookie = %q, want it to contain %q", got, tt.want)
			}
		})
	}
}

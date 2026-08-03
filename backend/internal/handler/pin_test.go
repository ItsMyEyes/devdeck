package handler

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

// newTestPINHandler returns an AuthHandler with the PIN routes enabled and the
// given PIN already set. Pass "" to leave the runtime unconfigured.
func newTestPINHandler(t *testing.T, pin string) *AuthHandler {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	h := NewAuthHandler(service.NewAuthService(st, make([]byte, 32)))
	pinSvc := service.NewPINService(st)
	if pin != "" {
		if err := pinSvc.Set(pin); err != nil {
			t.Fatal(err)
		}
	}
	h.SetPINService(pinSvc)
	return h
}

func postPIN(t *testing.T, h *AuthHandler, pin, remoteAddr string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/pin-session", jsonBody(t, map[string]string{"pin": pin}))
	if remoteAddr != "" {
		req.RemoteAddr = remoteAddr
	}
	rec := httptest.NewRecorder()
	h.PostPINSession(rec, req)
	return rec
}

func TestPINSessionExchangesPINForSession(t *testing.T) {
	h := newTestPINHandler(t, "482913")

	rec := postPIN(t, h, "482913", "10.0.0.1:5000")
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

	// The minted session must be a real one, indistinguishable from the
	// key-session path's — that is the whole point of routing both through
	// AuthService.KeySession.
	me := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	me.AddCookie(session)
	meRec := httptest.NewRecorder()
	h.GetMe(meRec, me)
	if meRec.Code != http.StatusOK {
		t.Fatalf("GetMe with pin-session cookie = %d, want 200", meRec.Code)
	}
}

func TestPINSessionRejectsWrongPIN(t *testing.T) {
	h := newTestPINHandler(t, "482913")
	rec := postPIN(t, h, "482914", "10.0.0.1:5000")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Error("a rejected PIN must not set any cookie")
	}
}

// "wrong PIN" and "no PIN configured" must be indistinguishable from outside.
func TestPINSessionGivesTheSameAnswerWhenNoPINIsConfigured(t *testing.T) {
	unset := newTestPINHandler(t, "")
	set := newTestPINHandler(t, "482913")

	unsetRec := postPIN(t, unset, "482913", "10.0.0.1:5000")
	wrongRec := postPIN(t, set, "482914", "10.0.0.1:5000")

	if unsetRec.Code != http.StatusUnauthorized {
		t.Fatalf("unconfigured status = %d, want 401", unsetRec.Code)
	}
	if unsetRec.Body.String() != wrongRec.Body.String() {
		t.Errorf("unconfigured body %q != wrong-PIN body %q; the two must not be distinguishable",
			unsetRec.Body.String(), wrongRec.Body.String())
	}
}

func TestPINSessionLocksOutAndSendsRetryAfter(t *testing.T) {
	h := newTestPINHandler(t, "482913")
	for i := 0; i < 5; i++ {
		if rec := postPIN(t, h, "000001", "10.0.0.7:5000"); rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d = %d, want 401", i+1, rec.Code)
		}
	}
	rec := postPIN(t, h, "482913", "10.0.0.7:5000")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status past the failure budget = %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("no Retry-After header on a 429")
	}
	// A different client is unaffected.
	if other := postPIN(t, h, "482913", "10.0.0.8:5000"); other.Code != http.StatusOK {
		t.Errorf("a different client = %d, want 200", other.Code)
	}
}

func TestPutPINSetsAndRotates(t *testing.T) {
	h := newTestPINHandler(t, "482913")

	req := httptest.NewRequest(http.MethodPut, "/api/auth/pin", jsonBody(t, map[string]string{"pin": "571904"}))
	rec := httptest.NewRecorder()
	h.PutPIN(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body: %s)", rec.Code, rec.Body.String())
	}
	if old := postPIN(t, h, "482913", "10.0.0.1:5000"); old.Code != http.StatusUnauthorized {
		t.Errorf("the old PIN = %d, want 401", old.Code)
	}
	if now := postPIN(t, h, "571904", "10.0.0.1:5000"); now.Code != http.StatusOK {
		t.Errorf("the new PIN = %d, want 200", now.Code)
	}
}

func TestPutPINRejectsBadValues(t *testing.T) {
	for _, pin := range []string{"12345", "1234567", "abcdef", "", "123456", "000000"} {
		h := newTestPINHandler(t, "482913")
		req := httptest.NewRequest(http.MethodPut, "/api/auth/pin", jsonBody(t, map[string]string{"pin": pin}))
		rec := httptest.NewRecorder()
		h.PutPIN(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("PutPIN(%q) = %d, want 400", pin, rec.Code)
		}
		// The existing PIN must survive a rejected rotation.
		if ok := postPIN(t, h, "482913", "10.0.0.1:5000"); ok.Code != http.StatusOK {
			t.Errorf("after a rejected PutPIN(%q), the old PIN = %d, want 200", pin, ok.Code)
		}
	}
}

func TestGetPINReportsConfiguredWithoutLeakingIt(t *testing.T) {
	h := newTestPINHandler(t, "482913")
	req := httptest.NewRequest(http.MethodGet, "/api/auth/pin", nil)
	rec := httptest.NewRecorder()
	h.GetPIN(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"configured":true`) {
		t.Errorf("body = %s, want configured:true", body)
	}
	if strings.Contains(body, "482913") {
		t.Errorf("body = %s, must never contain the PIN itself", body)
	}
}

func TestGetPINReportsUnconfigured(t *testing.T) {
	h := newTestPINHandler(t, "")
	req := httptest.NewRequest(http.MethodGet, "/api/auth/pin", nil)
	rec := httptest.NewRecorder()
	h.GetPIN(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"configured":false`) {
		t.Errorf("body = %s, want configured:false", rec.Body.String())
	}
}

// A hub never calls SetPINService, so the routes must not half-work there.
func TestPINRoutesAre404WithoutAPINService(t *testing.T) {
	h := newTestAuthHandler(t)
	for _, tc := range []struct {
		name string
		run  func(w http.ResponseWriter, r *http.Request)
		req  *http.Request
	}{
		{"pin-session", h.PostPINSession, httptest.NewRequest(http.MethodPost, "/api/auth/pin-session", jsonBody(t, map[string]string{"pin": "482913"}))},
		{"get pin", h.GetPIN, httptest.NewRequest(http.MethodGet, "/api/auth/pin", nil)},
		{"put pin", h.PutPIN, httptest.NewRequest(http.MethodPut, "/api/auth/pin", jsonBody(t, map[string]string{"pin": "482913"}))},
	} {
		rec := httptest.NewRecorder()
		tc.run(rec, tc.req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s = %d, want 404", tc.name, rec.Code)
		}
	}
}

// The public-path allowlist is what makes the sign-in page reachable at all.
func TestRuntimeAuthLetsThePINSessionRouteThrough(t *testing.T) {
	reached := false
	mw := RequireRuntimeAuth(nil, "rt-key")
	h := mw(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))

	req := httptest.NewRequest(http.MethodPost, "/api/auth/pin-session", nil)
	h.ServeHTTP(httptest.NewRecorder(), req)
	if !reached {
		t.Error("POST /api/auth/pin-session was blocked; an unauthenticated browser could never sign in")
	}
}

// PIN management itself is NOT public: it is what the runtime key authorizes.
func TestRuntimeAuthStillGuardsPINManagement(t *testing.T) {
	mw := RequireRuntimeAuth(nil, "rt-key")
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))

	for _, method := range []string{http.MethodGet, http.MethodPut} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, "/api/auth/pin", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s /api/auth/pin without a credential = %d, want 401", method, rec.Code)
		}

		rec = httptest.NewRecorder()
		req := httptest.NewRequest(method, "/api/auth/pin", nil)
		req.Header.Set("Authorization", "Bearer rt-key")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Errorf("%s /api/auth/pin with the runtime key = %d, want 204", method, rec.Code)
		}
	}
}

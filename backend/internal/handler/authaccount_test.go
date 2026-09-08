package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"devdeck/backend/internal/domain"
)

// keySessionCookie bootstraps the desktop operator account the way the desktop
// shell does, and returns the session cookie that flow mints.
func keySessionCookie(t *testing.T, h *AuthHandler) string {
	t.Helper()
	h.SetDesktopKey("test-hub-key")
	req := httptest.NewRequest(http.MethodPost, "/api/auth/key-session", nil)
	req.Header.Set("Authorization", "Bearer test-hub-key")
	rec := httptest.NewRecorder()
	h.PostKeySession(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("key-session status = %d, body = %s", rec.Code, rec.Body.String())
	}
	return cookieFrom(rec, sessionCookieName)
}

func putAccount(t *testing.T, h *AuthHandler, sessionToken string, body any) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, "/api/auth/account", jsonBody(t, body))
	if sessionToken != "" {
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionToken})
	}
	rec := httptest.NewRecorder()
	h.PutAccount(rec, req)
	return rec
}

func TestPutAccountUpdatesCredentialsAndAllowsLogin(t *testing.T) {
	h := newTestAuthHandler(t)
	h.svc.SetTOTPRequired(false)
	session := keySessionCookie(t, h)

	rec := putAccount(t, h, session, map[string]any{
		"email":    "owner@example.com",
		"password": "correct horse battery staple",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got domain.User
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Email != "owner@example.com" || !got.PasswordSet {
		t.Fatalf("response = %+v, want the new email with passwordSet = true", got)
	}
	if strings.Contains(rec.Body.String(), "password_hash") || strings.Contains(rec.Body.String(), "$2a$") {
		t.Fatalf("response leaks the password hash: %s", rec.Body.String())
	}

	loginRec := httptest.NewRecorder()
	h.PostLogin(loginRec, httptest.NewRequest(http.MethodPost, "/api/auth/login", jsonBody(t, map[string]string{
		"email":    "owner@example.com",
		"password": "correct horse battery staple",
	})))
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login with the new credentials: status = %d, body = %s", loginRec.Code, loginRec.Body.String())
	}
}

func TestPutAccountRequiresASession(t *testing.T) {
	h := newTestAuthHandler(t)
	keySessionCookie(t, h) // account exists; the caller just has no cookie

	rec := putAccount(t, h, "", map[string]any{"email": "owner@example.com"})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body = %s", rec.Code, rec.Body.String())
	}
}

func TestPutAccountRevokesOtherSessionsOnPasswordChange(t *testing.T) {
	h := newTestAuthHandler(t)
	keeper := keySessionCookie(t, h)
	stale := keySessionCookie(t, h)

	rec := putAccount(t, h, keeper, map[string]any{"password": "correct horse battery staple"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if _, err := h.svc.CurrentUser(keeper); err != nil {
		t.Errorf("the session that made the change was revoked: %v", err)
	}
	if _, err := h.svc.CurrentUser(stale); err == nil {
		t.Error("a session opened before the password change is still valid")
	}
}

func TestPutAccountKeepsOtherSessionsOnEmailOnlyChange(t *testing.T) {
	h := newTestAuthHandler(t)
	keeper := keySessionCookie(t, h)
	other := keySessionCookie(t, h)

	rec := putAccount(t, h, keeper, map[string]any{"email": "owner@example.com"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if _, err := h.svc.CurrentUser(other); err != nil {
		t.Errorf("renaming the account signed the operator out elsewhere: %v", err)
	}
}

func TestPutAccountRejectsWeakPassword(t *testing.T) {
	h := newTestAuthHandler(t)
	session := keySessionCookie(t, h)

	rec := putAccount(t, h, session, map[string]any{"password": "short"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
}

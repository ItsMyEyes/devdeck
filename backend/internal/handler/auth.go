package handler

import (
	"net"
	"net/http"
	"time"

	"loom/backend/internal/service"
)

const (
	sessionCookieName = "loom_session"
	pendingCookieName = "loom_pending"
)

// AuthHandler handles registration, login, TOTP enrollment/verification,
// logout, and the current-user endpoint.
type AuthHandler struct {
	svc            *service.AuthService
	turnstile      *service.TurnstileVerifier
	trustedProxies []*net.IPNet
	clientIPHeader string
}

// NewAuthHandler creates an auth handler.
func NewAuthHandler(svc *service.AuthService) *AuthHandler {
	return &AuthHandler{svc: svc}
}

// SetTurnstile enables Cloudflare Turnstile verification on login. The proxy
// settings mirror the access middleware so the remote IP forwarded to
// siteverify is the real client, not the tunnel.
func (h *AuthHandler) SetTurnstile(v *service.TurnstileVerifier, trustedProxies []*net.IPNet, clientIPHeader string) {
	h.turnstile = v
	h.trustedProxies = trustedProxies
	h.clientIPHeader = clientIPHeader
}

// secureCookies controls the Secure attribute on auth cookies. Desktop
// (Tauri) builds serve the UI over plain http://127.0.0.1, where WebKit
// webviews drop Secure cookies; the sidecar passes --secure-cookies=false.
var secureCookies = true

// SetSecureCookies toggles the Secure attribute on all auth cookies.
func SetSecureCookies(enabled bool) { secureCookies = enabled }

func setAuthCookie(w http.ResponseWriter, name, value string, maxAge time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   secureCookies,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(maxAge.Seconds()),
	})
}

func clearAuthCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secureCookies,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
	})
}

func cookieValue(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return c.Value
}

// PostRegister handles POST /api/auth/register.
func (h *AuthHandler) PostRegister(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	user, pendingToken, err := h.svc.Register(body.Email, body.Password)
	if handleStoreErr(w, err) {
		return
	}
	if !h.svc.TOTPRequired() {
		sessionToken, sessUser, err := h.svc.CompleteLogin(pendingToken)
		if handleStoreErr(w, err) {
			return
		}
		setAuthCookie(w, sessionCookieName, sessionToken, 30*24*time.Hour)
		writeJSON(w, http.StatusCreated, sessUser)
		return
	}
	setAuthCookie(w, pendingCookieName, pendingToken, 2*time.Minute)
	writeJSON(w, http.StatusCreated, user)
}

// GetConfig handles GET /api/auth/config — public flow flags the SPA needs
// before a session exists (e.g. whether login/registration includes TOTP).
func (h *AuthHandler) GetConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"totpRequired":     h.svc.TOTPRequired(),
		"turnstileSiteKey": h.turnstile.SiteKey(),
	})
}

// PostLogin handles POST /api/auth/login.
func (h *AuthHandler) PostLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email          string `json:"email"`
		Password       string `json:"password"`
		TurnstileToken string `json:"turnstileToken"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if h.turnstile.Enabled() {
		var remoteIP string
		if ip := ClientIP(r, h.trustedProxies, h.clientIPHeader); ip != nil {
			remoteIP = ip.String()
		}
		if err := h.turnstile.Verify(r.Context(), body.TurnstileToken, remoteIP); err != nil {
			handleStoreErr(w, err)
			return
		}
	}
	pendingToken, err := h.svc.Login(body.Email, body.Password)
	if handleStoreErr(w, err) {
		return
	}
	if !h.svc.TOTPRequired() {
		sessionToken, _, err := h.svc.CompleteLogin(pendingToken)
		if handleStoreErr(w, err) {
			return
		}
		setAuthCookie(w, sessionCookieName, sessionToken, 30*24*time.Hour)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	setAuthCookie(w, pendingCookieName, pendingToken, 2*time.Minute)
	writeJSON(w, http.StatusOK, map[string]string{"status": "totp_required"})
}

// pendingUserID resolves the pending-login cookie to a user ID, falling
// back to an established session. Writes a 401 and returns ok=false if
// neither is valid.
func (h *AuthHandler) pendingUserID(w http.ResponseWriter, r *http.Request) (string, bool) {
	if pendingToken := cookieValue(r, pendingCookieName); pendingToken != "" {
		if userID, err := h.svc.PendingUserID(pendingToken); err == nil {
			return userID, true
		}
	}
	if sessionToken := cookieValue(r, sessionCookieName); sessionToken != "" {
		if user, err := h.svc.CurrentUser(sessionToken); err == nil {
			return user.ID, true
		}
	}
	writeErr(w, http.StatusUnauthorized, "unauthorized")
	return "", false
}

// PostTotpSetup handles POST /api/auth/totp/setup.
func (h *AuthHandler) PostTotpSetup(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.pendingUserID(w, r)
	if !ok {
		return
	}
	_, otpauthURI, err := h.svc.BeginTotpEnrollment(userID)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"otpauthUri": otpauthURI})
}

// PostTotpVerifySetup handles POST /api/auth/totp/verify-setup.
func (h *AuthHandler) PostTotpVerifySetup(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.pendingUserID(w, r)
	if !ok {
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	backupCodes, err := h.svc.ConfirmTotpEnrollment(userID, body.Code)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"backupCodes": backupCodes})
}

// PostTotpVerify handles POST /api/auth/totp/verify, completing login.
func (h *AuthHandler) PostTotpVerify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	sessionToken, user, err := h.svc.VerifyTotp(cookieValue(r, pendingCookieName), body.Code)
	if handleStoreErr(w, err) {
		return
	}
	clearAuthCookie(w, pendingCookieName)
	setAuthCookie(w, sessionCookieName, sessionToken, 30*24*time.Hour)
	writeJSON(w, http.StatusOK, user)
}

// PostLogout handles POST /api/auth/logout.
func (h *AuthHandler) PostLogout(w http.ResponseWriter, r *http.Request) {
	_ = h.svc.Logout(cookieValue(r, sessionCookieName))
	clearAuthCookie(w, sessionCookieName)
	w.WriteHeader(http.StatusNoContent)
}

// GetMe handles GET /api/auth/me.
func (h *AuthHandler) GetMe(w http.ResponseWriter, r *http.Request) {
	user, err := h.svc.CurrentUser(cookieValue(r, sessionCookieName))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, user)
}

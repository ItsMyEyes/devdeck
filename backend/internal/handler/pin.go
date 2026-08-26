package handler

import (
	"errors"
	"net/http"
	"strconv"

	"devdeck/backend/internal/service"
)

// The PIN routes live on AuthHandler rather than a handler of their own so a
// PIN session is minted through exactly the same cookie path as the key
// session (same Max-Age, same SameSite, same AuthService.KeySession) — two
// spellings of "this browser may drive this runtime" must not drift apart.

// SetPINService enables the runtime sign-in PIN routes. Left nil on the hub,
// which authenticates operators with password + TOTP instead; the handlers
// below then answer 404 rather than pretending the feature exists.
func (h *AuthHandler) SetPINService(svc *service.PINService) { h.pin = svc }

// GetPIN handles GET /api/auth/pin. Reports only whether a PIN is configured —
// the PIN itself is stored as a bcrypt hash and is never readable. Sits behind
// the normal auth middleware, so reaching it already required the runtime key
// or a session.
func (h *AuthHandler) GetPIN(w http.ResponseWriter, r *http.Request) {
	if h.pin == nil {
		writeErr(w, http.StatusNotFound, "sign-in pin is not available on this process")
		return
	}
	configured, err := h.pin.Configured()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"configured": configured, "length": service.PINLength})
}

// PutPIN handles PUT /api/auth/pin — set or rotate this runtime's sign-in PIN.
// Authorization is whatever the auth middleware already required: the runtime
// key (how the hub reaches this route, through MachineProxyHandler) or an
// existing session cookie (how the runtime's own settings UI reaches it).
func (h *AuthHandler) PutPIN(w http.ResponseWriter, r *http.Request) {
	if h.pin == nil {
		writeErr(w, http.StatusNotFound, "sign-in pin is not available on this process")
		return
	}
	var body struct {
		PIN string `json:"pin"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	switch err := h.pin.Set(body.PIN); {
	case err == nil:
	case errors.Is(err, service.ErrPINFormat), errors.Is(err, service.ErrPINWeak):
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	default:
		if handleStoreErr(w, err) {
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// PostPINSession handles POST /api/auth/pin-session. It is the runtime's
// entire browser sign-in: the operator types the 6-digit PIN shown on
// /runtime-sign-in and gets the same session cookie PostKeySession mints.
//
// Public (see RequireRuntimeAuth's allowlist), so it is the one route an
// unauthenticated attacker can reach — PINService.Verify's lockout, not
// secrecy, is what protects a 6-digit credential here.
func (h *AuthHandler) PostPINSession(w http.ResponseWriter, r *http.Request) {
	if h.pin == nil {
		writeErr(w, http.StatusNotFound, "sign-in pin is not available on this process")
		return
	}
	var body struct {
		PIN string `json:"pin"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	err := h.pin.Verify(body.PIN, h.clientID(r))
	var locked service.ErrPINLocked
	switch {
	case err == nil:
	case errors.As(err, &locked):
		w.Header().Set("Retry-After", strconv.Itoa(int(locked.RetryAfter.Seconds())+1))
		writeErr(w, http.StatusTooManyRequests, locked.Error())
		return
	case errors.Is(err, service.ErrPINWrong), errors.Is(err, service.ErrPINNotSet), errors.Is(err, service.ErrPINFormat):
		// One message for all three: telling an attacker apart "wrong PIN"
		// from "no PIN set" hands them a free bit.
		writeErr(w, http.StatusUnauthorized, "incorrect pin")
		return
	default:
		if handleStoreErr(w, err) {
			return
		}
	}
	sessionToken, user, err := h.svc.KeySession()
	if handleStoreErr(w, err) {
		return
	}
	setAuthCookie(w, r, sessionCookieName, sessionToken, h.maxAge(), h.sameSite())
	writeJSON(w, http.StatusOK, user)
}

// clientID is the rate-limit bucket for a sign-in attempt: the real client IP
// where one is resolvable, "" otherwise (all such callers then share a single
// bucket, which throttles more aggressively rather than less).
func (h *AuthHandler) clientID(r *http.Request) string {
	if ip := ClientIP(r, h.trustedProxies, h.clientIPHeader); ip != nil {
		return ip.String()
	}
	return ""
}

package handler

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// bearerToken extracts the token from an "Authorization: Bearer x" header,
// or "" when absent or malformed.
func bearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(auth, prefix) {
		return ""
	}
	return auth[len(prefix):]
}

// keyFromRequest resolves the presented API key: the bearer header, or the
// ?key= query param for WebSocket upgrades only (the browser WebSocket API
// cannot set headers; every other request must keep keys out of URLs).
func keyFromRequest(r *http.Request) string {
	if tok := bearerToken(r); tok != "" {
		return tok
	}
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return r.URL.Query().Get("key")
	}
	return ""
}

// keyMatches compares in constant time.
func keyMatches(presented, want string) bool {
	return want != "" && subtle.ConstantTimeCompare([]byte(presented), []byte(want)) == 1
}

// RequireKey returns middleware for the runtime role: every request except
// GET /api/health must present the static API key.
func RequireKey(key string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/health" {
				next.ServeHTTP(w, r)
				return
			}
			if !keyMatches(keyFromRequest(r), key) {
				writeErr(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

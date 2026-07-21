package handler

import (
	"crypto/ed25519"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"devdeck/backend/internal/handovertoken"
	"devdeck/backend/internal/service"
)

type runtimeIdentity struct {
	machineID string
	hubPub    ed25519.PublicKey
}

var identity atomic.Pointer[runtimeIdentity]

// SetRuntimeIdentity records this runtime's own hub-assigned machine id and
// the hub's Ed25519 public key, learned via self-registration
// (machineclient.SelfRegister). Both are required together to verify a
// handover token: the key to check the signature, the id to check the
// audience claim. Called from a background goroutine after the server has
// already started accepting connections, so — unlike SetSecureCookies,
// which is set once before serving begins — this uses atomic storage for a
// safe concurrent read from request-handling goroutines.
//
// Call with ("", nil) to clear (used by tests to avoid leaking state
// between them); a real runtime never does this once registered.
func SetRuntimeIdentity(machineID string, hubPub ed25519.PublicKey) {
	if machineID == "" && hubPub == nil {
		identity.Store(nil)
		return
	}
	identity.Store(&runtimeIdentity{machineID: machineID, hubPub: hubPub})
}

// RequireRuntimeAuth returns middleware for the runtime role. It is additive
// over RequireKey: the bearer-key and ?key= paths that frontend/src/lib/
// machineClient.ts already depends on keep working unchanged, and a session
// cookie is accepted as well so the runtime can serve its own web UI.
//
// svc may be nil when the runtime has no UI session support wired; the
// cookie and ?t= branches are then simply never taken.
func RequireRuntimeAuth(svc *service.AuthService, key string) func(http.Handler) http.Handler {
	publicPaths := map[string]bool{
		"/api/health":           true,
		"/api/auth/key-session": true,
		// The frontend must be able to tell "this is a runtime" apart from
		// "this is a hub" BEFORE any credential exists, to decide whether an
		// unauthenticated visitor should see the runtime sign-in page or the
		// hub's password/TOTP login — see __root.tsx's beforeLoad. Nothing in
		// this payload (role, machineName, hubUrl, machineId, lastSyncedAt)
		// is secret.
		"/api/whoami": true,
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if publicPaths[r.URL.Path] {
				next.ServeHTTP(w, r)
				return
			}
			// Static SPA assets stay public, mirroring RequireAuth's rule
			// (middleware.go:105-108) so the UI shell can load and then
			// authenticate itself.
			if !strings.HasPrefix(r.URL.Path, "/api") && !strings.HasPrefix(r.URL.Path, "/ws/") {
				if svc != nil && tryHandoverToken(w, r, svc) {
					return
				}
				next.ServeHTTP(w, r)
				return
			}
			if keyMatches(keyFromRequest(r), key) {
				next.ServeHTTP(w, r)
				return
			}
			if svc != nil {
				if cookie, err := r.Cookie(sessionCookieName); err == nil {
					if _, err := svc.CurrentUser(cookie.Value); err == nil {
						next.ServeHTTP(w, r)
						return
					}
				}
			}
			writeErr(w, http.StatusUnauthorized, "unauthorized")
		})
	}
}

// tryHandoverToken checks for a ?t= query param, verifies it against this
// runtime's known identity, and on success mints a session cookie and
// redirects to a clean URL (the token must never linger in browser
// history). Returns false — meaning "did nothing, keep going" — whenever
// there's no token, the identity isn't known yet, or verification fails for
// any reason; the caller then falls through to the normal unauthenticated
// path (the sign-in page, which still offers the key field). This must
// never hard-fail with 401 on its own: a missing/invalid token here is not
// an error, just "this path didn't apply".
func tryHandoverToken(w http.ResponseWriter, r *http.Request, svc *service.AuthService) bool {
	tok := r.URL.Query().Get("t")
	if tok == "" {
		return false
	}
	id := identity.Load()
	if id == nil {
		return false
	}
	if _, err := handovertoken.Verify(id.hubPub, tok, id.machineID, time.Now()); err != nil {
		return false
	}
	sessionToken, _, err := svc.KeySession()
	if err != nil {
		return false
	}
	setAuthCookie(w, sessionCookieName, sessionToken, 12*time.Hour, http.SameSiteLaxMode)

	clean := *r.URL
	q := clean.Query()
	q.Del("t")
	clean.RawQuery = q.Encode()
	http.Redirect(w, r, clean.RequestURI(), http.StatusFound)
	return true
}

package handler

import (
	"net/http"
	"strings"

	"devdeck/backend/internal/service"
)

// RequireRuntimeAuth returns middleware for the runtime role. It is additive
// over RequireKey: the bearer-key and ?key= paths that frontend/src/lib/
// machineClient.ts already depends on keep working unchanged, and a session
// cookie is accepted as well so the runtime can serve its own web UI.
//
// svc may be nil when the runtime has no UI session support wired; the cookie
// branch is then simply never taken.
func RequireRuntimeAuth(svc *service.AuthService, key string) func(http.Handler) http.Handler {
	publicPaths := map[string]bool{
		"/api/health":           true,
		"/api/auth/key-session": true,
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

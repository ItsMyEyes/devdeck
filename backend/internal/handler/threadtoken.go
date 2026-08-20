package handler

import (
	"context"
	"net/http"

	"devdeck/backend/internal/sshtool"
)

// threadTokenCtxKey is the unexported context key RequireThreadToken stores
// the resolved sshtool.Session under, so nothing outside this package can
// forge or overwrite it.
type threadTokenCtxKey struct{}

// RequireThreadToken authenticates a request to the /api/agent-tools/ssh/*
// route group by its per-thread token — minted once per SSH chat session by
// sshtool.TokenStore.Mint and handed to the devdeck-ssh helper CLI through
// its seeded workspace — rather than by the hub's session cookie or a
// machine key. This is the codebase's RequireMachineKey pattern
// (machinekey.go) applied to a thread instead of a runtime: the caller is
// derived entirely from the credential it presents, never from a path,
// query, or body parameter, so a request literally has no vocabulary for
// naming a connection other than the one its token was minted for. The
// resolved sshtool.Session is stashed on the request context for handlers
// to read back via ThreadSessionFrom.
func RequireThreadToken(store *sshtool.TokenStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Header only — deliberately NOT keyFromRequest's ?key= fallback.
			// AccessLog records the raw query string (access.go), and the
			// redaction pass that would hide a secret runs over request and
			// response bodies, never over the URL — so a single ?key= call
			// writes a credential granting shell on a production host into a
			// plaintext log. The fallback also had no caller to serve: the
			// devdeck-ssh helper CLI sets an Authorization header, which
			// audit.go's redactedHeaders already covers, and these are plain
			// HTTP requests, not WebSocket upgrades that cannot carry headers.
			sess, ok := store.Lookup(bearerToken(r))
			if !ok {
				writeErr(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), threadTokenCtxKey{}, sess)))
		})
	}
}

// ThreadSessionFrom returns the sshtool.Session resolved by
// RequireThreadToken, if the request passed through that middleware.
func ThreadSessionFrom(ctx context.Context) (sshtool.Session, bool) {
	sess, ok := ctx.Value(threadTokenCtxKey{}).(sshtool.Session)
	return sess, ok
}

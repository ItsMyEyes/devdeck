package handler

import "net/http"

// NewAPINotFoundHandler answers any /api/ path that no route claimed.
//
// Without it such a request falls through to the embedded web UI's catch-all,
// which sees no file extension to reject (see internal/webui.Handler) and so
// returns index.html with a 200. The frontend's request() then parses HTML as
// JSON, turning "this route is not registered" into a confusing parse error far
// from its cause.
//
// This is routine rather than exotic because routes are role-gated: a
// --role runtime process registers neither /api/machines nor
// /api/ssh/connections (see the `if !isRuntime` block in cmd/server/main.go),
// yet that runtime serves its own web UI, which asks for both.
//
// Go 1.22's ServeMux dispatches on the most specific matching pattern, so every
// registered /api/... route still takes precedence over this one.
func NewAPINotFoundHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusNotFound, "not found")
	})
}

package handler

import (
	"context"
	"net/http"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

type machineCtxKey struct{}

// RequireMachineKey resolves the calling runtime from the API key it presents
// and stores it on the request context. Because the machine is derived from
// the credential rather than a path parameter, a runtime cannot express a
// request for another machine's data at all.
func RequireMachineKey(st port.Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			m, err := st.MachineByKey(keyFromRequest(r))
			if err != nil {
				writeErr(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), machineCtxKey{}, m)))
		})
	}
}

// MachineFromContext returns the machine resolved by RequireMachineKey.
func MachineFromContext(ctx context.Context) (domain.Machine, bool) {
	m, ok := ctx.Value(machineCtxKey{}).(domain.Machine)
	return m, ok
}

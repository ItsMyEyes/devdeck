package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// muxLikeRuntime mirrors the relevant slice of cmd/server/main.go's wiring on a
// --role runtime process: the hub-only routes (/api/machines, /api/ssh/connections)
// are absent, a role-independent route is present, the /api/ backstop is
// registered, and the SPA catch-all sits at "/".
func muxLikeRuntime() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/whoami", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"role": "runtime"})
	})
	mux.Handle("/api/", NewAPINotFoundHandler())
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("<!doctype html><title>devdeck</title>"))
	})
	return mux
}

// The regression this guards: on a runtime these two paths used to reach the
// SPA catch-all and come back as index.html with a 200, so the frontend's
// request() parsed HTML as JSON instead of seeing a plain "no such route".
func TestAPINotFound_UnregisteredAPIPathsReturnJSON404(t *testing.T) {
	mux := muxLikeRuntime()

	for _, path := range []string{"/api/machines", "/api/ssh/connections", "/api/self/hub-key"} {
		t.Run(path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))

			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
			}
			if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
				t.Fatalf("Content-Type = %q, want application/json", ct)
			}
			if strings.Contains(rec.Body.String(), "<!doctype html") {
				t.Fatalf("body served the SPA shell: %q", rec.Body.String())
			}

			// CONTRACTS.md: every API response uses the {"error": "..."} envelope.
			var body map[string]string
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("body is not JSON (%v): %q", err, rec.Body.String())
			}
			if body["error"] == "" {
				t.Fatalf("missing error envelope, got %v", body)
			}
		})
	}
}

// Go 1.22 ServeMux picks the most specific pattern, so the backstop must not
// shadow any route that is registered.
func TestAPINotFound_RegisteredRouteStillWins(t *testing.T) {
	rec := httptest.NewRecorder()
	muxLikeRuntime().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/whoami", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if !strings.Contains(rec.Body.String(), `"role":"runtime"`) {
		t.Fatalf("real handler did not run, body = %q", rec.Body.String())
	}
}

// The backstop is scoped to /api/ — client-side router paths must still get the
// SPA shell, or a hard refresh on any deep link would 404.
func TestAPINotFound_SPARoutesUnaffected(t *testing.T) {
	rec := httptest.NewRecorder()
	muxLikeRuntime().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/w/ws-1104f4d4", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if !strings.Contains(rec.Body.String(), "<!doctype html") {
		t.Fatalf("SPA shell not served, body = %q", rec.Body.String())
	}
}

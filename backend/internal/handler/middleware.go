package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"loom/backend/internal/service"
	"loom/backend/internal/store"
)

// writeJSON encodes v as JSON and writes it with the given status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeErr writes a JSON error response.
func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// handleStoreErr maps a store error onto an HTTP response. Returns true when it
// wrote a response (i.e. there was an error).
func handleStoreErr(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "not found")
		return true
	}
	if errors.Is(err, service.ErrValidation) {
		writeErr(w, http.StatusBadRequest, err.Error())
		return true
	}
	if errors.Is(err, service.ErrConflict) {
		writeErr(w, http.StatusConflict, err.Error())
		return true
	}
	if errors.Is(err, service.ErrUnauthorized) {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return true
	}
	if errors.Is(err, service.ErrLocked) {
		writeErr(w, http.StatusLocked, err.Error())
		return true
	}
	writeErr(w, http.StatusInternalServerError, err.Error())
	return true
}

// decodeBody reads the request body into both a typed struct (dst, may be nil)
// and a raw key map (for presence detection). An empty body is treated as {}.
func decodeBody(r *http.Request, dst any) (map[string]json.RawMessage, error) {
	raw := map[string]json.RawMessage{}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		return raw, err
	}
	if len(body) == 0 {
		return raw, nil
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return raw, err
	}
	if dst != nil {
		if err := json.Unmarshal(body, dst); err != nil {
			return raw, err
		}
	}
	return raw, nil
}

// CorsMiddleware sets permissive CORS headers on every /api response and
// short-circuits OPTIONS preflight requests.
func CorsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// JSONErrorMiddleware ensures error responses under /api are JSON, including
// those net/http's ServeMux generates itself (404, 405).
func JSONErrorMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api") {
			next.ServeHTTP(w, r)
			return
		}
		rec := &errRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		rec.flush()
	})
}

type errRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
	held        bool
	body        []byte
}

func (e *errRecorder) WriteHeader(code int) {
	if e.wroteHeader {
		return
	}
	e.status = code
	e.wroteHeader = true
	if code >= 400 {
		e.held = true
		return
	}
	e.ResponseWriter.WriteHeader(code)
}

func (e *errRecorder) Write(b []byte) (int, error) {
	if !e.wroteHeader {
		e.WriteHeader(http.StatusOK)
	}
	if e.held {
		e.body = append(e.body, b...)
		return len(b), nil
	}
	return e.ResponseWriter.Write(b)
}

func (e *errRecorder) flush() {
	if !e.held {
		return
	}
	trimmed := bytes.TrimSpace(e.body)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		e.ResponseWriter.WriteHeader(e.status)
		_, _ = e.ResponseWriter.Write(e.body)
		return
	}
	msg := strings.TrimSpace(string(e.body))
	if msg == "" {
		msg = http.StatusText(e.status)
	}
	e.ResponseWriter.Header().Set("Content-Type", "application/json")
	e.ResponseWriter.WriteHeader(e.status)
	_ = json.NewEncoder(e.ResponseWriter).Encode(map[string]string{"error": msg})
}

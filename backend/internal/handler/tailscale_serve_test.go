package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// stubServe is a ServeController that records calls instead of spawning a
// tailscale child, so every branch is reachable without a tailscale install.
type stubServe struct {
	mu      sync.Mutex
	running bool
	port    string
	startAt []string
	stops   int
	startEr error
	stopErr error
}

func (s *stubServe) Status() (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running, s.port
}

func (s *stubServe) Start(port string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.startAt = append(s.startAt, port)
	if s.startEr != nil {
		return s.startEr
	}
	s.running, s.port = true, port
	return nil
}

func (s *stubServe) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stops++
	if s.stopErr != nil {
		return s.stopErr
	}
	s.running, s.port = false, ""
	return nil
}

func postServe(t *testing.T, h *TailscaleServeHandler, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/tailscale-serve", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestTailscaleServeStarts(t *testing.T) {
	ctl := &stubServe{}
	h := NewTailscaleServeHandler(ctl, func() string { return "60635" })
	rec := postServe(t, h, `{"enabled":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if got := ctl.startAt; len(got) != 1 || got[0] != "60635" {
		t.Fatalf("Start calls = %v, want exactly [60635]", got)
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["serving"] != true || resp["servePort"] != "60635" {
		t.Fatalf("body = %v, want serving with the bound port", resp)
	}
}

// The port is the hub's OWN bound port, never one the caller chose — a
// client-supplied port would publish an unrelated local service to the tailnet.
func TestTailscaleServeIgnoresACallerSuppliedPort(t *testing.T) {
	ctl := &stubServe{}
	h := NewTailscaleServeHandler(ctl, func() string { return "60635" })
	postServe(t, h, `{"enabled":true,"port":"22"}`)
	if got := ctl.startAt; len(got) != 1 || got[0] != "60635" {
		t.Fatalf("Start calls = %v, want the hub's own port, not the body's", got)
	}
}

func TestTailscaleServeStops(t *testing.T) {
	ctl := &stubServe{running: true, port: "60635"}
	h := NewTailscaleServeHandler(ctl, func() string { return "60635" })
	rec := postServe(t, h, `{"enabled":false}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ctl.stops != 1 {
		t.Fatalf("Stop calls = %d, want 1", ctl.stops)
	}
	if len(ctl.startAt) != 0 {
		t.Fatalf("disabling must never Start, got %v", ctl.startAt)
	}
}

// A tailscale failure must reach the operator verbatim rather than being
// swallowed into a toggle that silently springs back.
func TestTailscaleServeReportsAStartFailure(t *testing.T) {
	ctl := &stubServe{startEr: errors.New("listener already exists for port 443")}
	h := NewTailscaleServeHandler(ctl, func() string { return "60635" })
	rec := postServe(t, h, `{"enabled":true}`)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	var resp map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if !strings.Contains(resp["error"], "listener already exists") {
		t.Fatalf("body = %v, want the CLI's own message in the error envelope", resp)
	}
}

func TestTailscaleServeRefusesBeforeThePortIsKnown(t *testing.T) {
	ctl := &stubServe{}
	h := NewTailscaleServeHandler(ctl, func() string { return "" })
	rec := postServe(t, h, `{"enabled":true}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	if len(ctl.startAt) != 0 {
		t.Fatalf("must not Start without a bound port, got %v", ctl.startAt)
	}
}

func TestTailscaleServeRejectsAMalformedBody(t *testing.T) {
	ctl := &stubServe{}
	h := NewTailscaleServeHandler(ctl, func() string { return "60635" })
	rec := postServe(t, h, `{not json`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

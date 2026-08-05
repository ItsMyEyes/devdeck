package handler

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/service"
)

func TestProxyHandlerPostStartReturnsBoundAddresses(t *testing.T) {
	h := NewProxyHandler(service.NewProxyService("127.0.0.1"))
	req := httptest.NewRequest(http.MethodPost, "/api/proxy/start", nil)
	rec := httptest.NewRecorder()

	h.PostStart(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		SOCKS5Addr    string `json:"socks5Addr"`
		HTTPProxyAddr string `json:"httpProxyAddr"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.SOCKS5Addr == "" || body.HTTPProxyAddr == "" {
		t.Fatalf("response missing fields: %+v", body)
	}
}

func TestProxyHandlerPostStartIsIdempotent(t *testing.T) {
	h := NewProxyHandler(service.NewProxyService("127.0.0.1"))

	rec1 := httptest.NewRecorder()
	h.PostStart(rec1, httptest.NewRequest(http.MethodPost, "/api/proxy/start", nil))

	rec2 := httptest.NewRecorder()
	h.PostStart(rec2, httptest.NewRequest(http.MethodPost, "/api/proxy/start", nil))

	if rec1.Body.String() != rec2.Body.String() {
		t.Fatalf("second call returned a different body:\nfirst:  %s\nsecond: %s", rec1.Body.String(), rec2.Body.String())
	}
}

// fakePublishedSOCKSStore is an in-memory service.PublishedSOCKSStore.
type fakePublishedSOCKSStore struct{ cfg domain.PublishedSOCKSConfig }

func (f *fakePublishedSOCKSStore) PublishedSOCKS() (domain.PublishedSOCKSConfig, error) {
	return f.cfg, nil
}

func (f *fakePublishedSOCKSStore) SetPublishedSOCKS(cfg domain.PublishedSOCKSConfig) error {
	f.cfg = cfg
	return nil
}

func newPublishedSOCKSHandler(t *testing.T) *PublishedSOCKSHandler {
	t.Helper()
	svc := service.NewPublishedSOCKSService(&fakePublishedSOCKSStore{
		cfg: domain.PublishedSOCKSConfig{Port: 1080},
	}, "127.0.0.1")
	t.Cleanup(func() { _ = svc.Stop() })
	return NewPublishedSOCKSHandler(svc)
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestPublishedSOCKSGetReportsDisabledByDefault(t *testing.T) {
	h := newPublishedSOCKSHandler(t)
	rec := httptest.NewRecorder()

	h.Get(rec, httptest.NewRequest(http.MethodGet, "/api/proxy/publish", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body domain.PublishedSOCKSStatus
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Enabled || body.Running {
		t.Errorf("fresh handler reports %+v, want disabled and not running", body)
	}
	if body.Port != 1080 {
		t.Errorf("Port = %d, want 1080", body.Port)
	}
}

func TestPublishedSOCKSPutEnablesAndReturnsURL(t *testing.T) {
	h := newPublishedSOCKSHandler(t)
	port := freeTCPPort(t)
	rec := httptest.NewRecorder()

	req := httptest.NewRequest(http.MethodPut, "/api/proxy/publish",
		strings.NewReader(`{"enabled":true,"port":`+strconv.Itoa(port)+`}`))
	h.Put(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body domain.PublishedSOCKSStatus
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Running || body.Key == "" {
		t.Fatalf("expected a running, keyed proxy, got %+v", body)
	}
	if !strings.HasPrefix(body.URL, "socks5://devdeck:") {
		t.Errorf("URL = %q, want a socks5://devdeck:<key>@host:port form", body.URL)
	}
}

func TestPublishedSOCKSPutPortConflictUsesErrorEnvelope(t *testing.T) {
	h := newPublishedSOCKSHandler(t)
	// Wildcard blocker, matching what the service binds — see the same note on
	// TestApplyPortConflictReturnsErrorNotPanic in the service package: a
	// loopback blocker does not conflict with a wildcard bind on Darwin/BSD.
	blocker, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Close()
	busy := blocker.Addr().(*net.TCPAddr).Port

	rec := httptest.NewRecorder()
	h.Put(rec, httptest.NewRequest(http.MethodPut, "/api/proxy/publish",
		strings.NewReader(`{"enabled":true,"port":`+strconv.Itoa(busy)+`}`)))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["error"] == "" {
		t.Errorf("response %v missing the {\"error\":...} envelope", body)
	}
}

func TestPublishedSOCKSRejectsWrongMethod(t *testing.T) {
	h := newPublishedSOCKSHandler(t)
	rec := httptest.NewRecorder()

	h.Get(rec, httptest.NewRequest(http.MethodPost, "/api/proxy/publish", nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

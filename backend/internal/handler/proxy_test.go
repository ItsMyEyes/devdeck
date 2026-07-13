package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"loom/backend/internal/service"
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

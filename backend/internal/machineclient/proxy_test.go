package machineclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"devdeck/backend/internal/domain"
)

func TestStartProxySendsBearerKeyAndDecodesAddr(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/proxy/start" {
			t.Errorf("request = %s %s, want POST /api/proxy/start", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"socks5Addr":"10.0.0.1:1080","httpProxyAddr":"10.0.0.1:8888"}`))
	}))
	t.Cleanup(srv.Close)

	result, err := StartProxy(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"})
	if err != nil {
		t.Fatal(err)
	}
	if result.HTTPProxyAddr != "10.0.0.1:8888" {
		t.Errorf("HTTPProxyAddr = %q, want 10.0.0.1:8888", result.HTTPProxyAddr)
	}
}

func TestStartProxyErrorsOnUnreachable(t *testing.T) {
	_, err := StartProxy(context.Background(), domain.Machine{ID: "m-1", URL: "http://127.0.0.1:1", Key: "k"})
	if err == nil {
		t.Error("err = nil, want error for unreachable machine")
	}
}

func TestStartProxyErrorsOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	_, err := StartProxy(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"})
	if err == nil {
		t.Error("err = nil, want error for non-200 response")
	}
}

func TestStartProxyErrorsWhenAddrMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"socks5Addr":"10.0.0.1:1080"}`))
	}))
	t.Cleanup(srv.Close)

	_, err := StartProxy(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"})
	if err == nil {
		t.Error("err = nil, want error when httpProxyAddr is missing")
	}
}

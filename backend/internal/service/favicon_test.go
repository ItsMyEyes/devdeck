package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"devdeck/backend/internal/netproxy"
	"devdeck/backend/internal/store"
)

// fakeMachineServer stands in for a runtime's POST /api/proxy/start, handing
// back a real forward proxy (netproxy.NewHTTPProxyHandler, the same handler
// service.ProxyService starts) so the test exercises the whole hop, not a
// stub of it.
func fakeMachineServer(t *testing.T, proxyAddr string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/proxy/start" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"httpProxyAddr": proxyAddr})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newFaviconTestStore(t *testing.T) *store.Store {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return store.New(db)
}

func TestFaviconServiceFetchesLinkedIcon(t *testing.T) {
	const pngBytes = "\x89PNG\r\n\x1a\nfake-icon-bytes"

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte(`<html><head><link rel="icon" href="/icon.png"></head></html>`))
		case "/icon.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte(pngBytes))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(upstream.Close)

	proxy := httptest.NewServer(netproxy.NewHTTPProxyHandler(""))
	t.Cleanup(proxy.Close)
	proxyAddr := strings.TrimPrefix(proxy.URL, "http://")

	machineSrv := fakeMachineServer(t, proxyAddr)

	st := newFaviconTestStore(t)
	machine, err := st.CreateMachine("test", machineSrv.URL, "k", false)
	if err != nil {
		t.Fatal(err)
	}

	svc := NewFaviconService(st)
	got := svc.Fetch(context.Background(), machine.ID, upstream.URL+"/")
	want := "data:image/png;base64," + b64(pngBytes)
	if got != want {
		t.Errorf("Fetch() = %q, want %q", got, want)
	}
}

func TestFaviconServiceFallsBackToFaviconIco(t *testing.T) {
	const icoBytes = "fake-ico-bytes"

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte(`<html><head><title>No icon link</title></head></html>`))
		case "/favicon.ico":
			_, _ = w.Write([]byte(icoBytes)) // no Content-Type: exercises the sniff fallback
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(upstream.Close)

	proxy := httptest.NewServer(netproxy.NewHTTPProxyHandler(""))
	t.Cleanup(proxy.Close)
	proxyAddr := strings.TrimPrefix(proxy.URL, "http://")

	machineSrv := fakeMachineServer(t, proxyAddr)

	st := newFaviconTestStore(t)
	machine, err := st.CreateMachine("test", machineSrv.URL, "k", false)
	if err != nil {
		t.Fatal(err)
	}

	svc := NewFaviconService(st)
	got := svc.Fetch(context.Background(), machine.ID, upstream.URL+"/")
	want := "data:image/x-icon;base64," + b64(icoBytes)
	if got != want {
		t.Errorf("Fetch() = %q, want %q", got, want)
	}
}

func TestFaviconServiceReturnsEmptyForUnknownMachine(t *testing.T) {
	svc := NewFaviconService(newFaviconTestStore(t))
	if got := svc.Fetch(context.Background(), "m-nope", "https://example.com/"); got != "" {
		t.Errorf("Fetch() = %q, want empty for unknown machine", got)
	}
}

func TestFaviconServiceReturnsEmptyForBlankMachineID(t *testing.T) {
	svc := NewFaviconService(newFaviconTestStore(t))
	if got := svc.Fetch(context.Background(), "", "https://example.com/"); got != "" {
		t.Errorf("Fetch() = %q, want empty for blank machineId", got)
	}
}

func TestFaviconServiceReturnsEmptyWhenMachineUnreachable(t *testing.T) {
	st := newFaviconTestStore(t)
	machine, err := st.CreateMachine("test", "http://127.0.0.1:1", "k", false)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewFaviconService(st)
	if got := svc.Fetch(context.Background(), machine.ID, "https://example.com/"); got != "" {
		t.Errorf("Fetch() = %q, want empty when the machine is unreachable", got)
	}
}

func TestFaviconServiceReturnsEmptyWhenIconTooLarge(t *testing.T) {
	big := strings.Repeat("x", faviconMaxIconBytes+1)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte(`<html><head><link rel="icon" href="/icon.png"></head></html>`))
		case "/icon.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte(big))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(upstream.Close)

	proxy := httptest.NewServer(netproxy.NewHTTPProxyHandler(""))
	t.Cleanup(proxy.Close)
	proxyAddr := strings.TrimPrefix(proxy.URL, "http://")
	machineSrv := fakeMachineServer(t, proxyAddr)

	st := newFaviconTestStore(t)
	machine, err := st.CreateMachine("test", machineSrv.URL, "k", false)
	if err != nil {
		t.Fatal(err)
	}

	svc := NewFaviconService(st)
	if got := svc.Fetch(context.Background(), machine.ID, upstream.URL+"/"); got != "" {
		t.Errorf("Fetch() = %q, want empty for an oversized icon", got)
	}
}

func b64(s string) string {
	return base64.StdEncoding.EncodeToString([]byte(s))
}

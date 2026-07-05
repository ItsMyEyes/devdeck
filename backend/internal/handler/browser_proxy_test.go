package handler

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestNormalizeBrowserURL(t *testing.T) {
	got, err := normalizeBrowserURL("example.com/path")
	if err != nil {
		t.Fatalf("normalizeBrowserURL: %v", err)
	}
	if got.String() != "https://example.com/path" {
		t.Fatalf("url = %q, want https://example.com/path", got.String())
	}

	if _, err := normalizeBrowserURL("file:///etc/passwd"); err == nil {
		t.Fatal("expected unsupported scheme to be rejected")
	}
}

func TestBrowserProxyRewritesHTMLAndStripsUnsafeHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Set-Cookie", "sid=remote")
		_, _ = w.Write([]byte(`<html><head></head><body><a href="/next">next</a><img src="img.png"><img srcset="/small.png 1x, /large.png 2x"></body></html>`))
	}))
	defer upstream.Close()

	h := &BrowserProxyHandler{client: upstream.Client()}
	req := httptest.NewRequest(http.MethodGet, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/page"), nil)
	rec := httptest.NewRecorder()

	h.Proxy(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Frame-Options") != "" {
		t.Fatalf("X-Frame-Options leaked: %q", rec.Header().Get("X-Frame-Options"))
	}
	if rec.Header().Get("Set-Cookie") != "" {
		t.Fatalf("Set-Cookie leaked: %q", rec.Header().Get("Set-Cookie"))
	}
	if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("missing sandbox CSP: %q", rec.Header().Get("Content-Security-Policy"))
	}

	body := rec.Body.String()
	if !strings.Contains(body, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/next")) {
		t.Fatalf("relative link was not rewritten: %s", body)
	}
	if !strings.Contains(body, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/img.png")) {
		t.Fatalf("relative image was not rewritten: %s", body)
	}
	if !strings.Contains(body, browserProxyPath+"?url="+url.QueryEscape(upstream.URL+"/small.png")) {
		t.Fatalf("srcset was not rewritten: %s", body)
	}
}

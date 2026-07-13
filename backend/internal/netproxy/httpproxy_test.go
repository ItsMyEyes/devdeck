package netproxy

import (
	"bufio"
	"bytes"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestHTTPProxyForwardsPlainRequest(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/hello" {
			t.Errorf("upstream saw unexpected path %q", r.URL.Path)
		}
		_, _ = w.Write([]byte("hello from upstream"))
	}))
	defer upstream.Close()

	proxy := httptest.NewServer(NewHTTPProxyHandler(""))
	defer proxy.Close()

	proxyURL, _ := url.Parse(proxy.URL)
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}

	resp, err := client.Get(upstream.URL + "/hello")
	if err != nil {
		t.Fatalf("GET via proxy: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "hello from upstream" {
		t.Fatalf("status = %d, body = %q", resp.StatusCode, body)
	}
}

func TestHTTPProxyRequiresAuthWhenConfigured(t *testing.T) {
	proxy := httptest.NewServer(NewHTTPProxyHandler("s3cret"))
	defer proxy.Close()

	proxyURL, _ := url.Parse(proxy.URL)
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}

	resp, err := client.Get("http://example.com/")
	if err != nil {
		t.Fatalf("GET via proxy: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusProxyAuthRequired {
		t.Fatalf("status = %d, want 407", resp.StatusCode)
	}
}

func TestHTTPProxyAcceptsConfiguredAuth(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	defer upstream.Close()

	proxy := httptest.NewServer(NewHTTPProxyHandler("s3cret"))
	defer proxy.Close()

	proxyURL, _ := url.Parse(proxy.URL)
	proxyURL.User = url.UserPassword("loom", "s3cret")
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}

	resp, err := client.Get(upstream.URL)
	if err != nil {
		t.Fatalf("GET via proxy: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}

func TestHTTPProxyConnectTunnels(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("tunneled"))
	}))
	defer upstream.Close()

	proxyLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer proxyLn.Close()
	go func() {
		_ = http.Serve(proxyLn, NewHTTPProxyHandler(""))
	}()

	conn, err := net.DialTimeout("tcp", proxyLn.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	upstreamHost := upstream.Listener.Addr().String()
	if _, err := conn.Write([]byte("CONNECT " + upstreamHost + " HTTP/1.1\r\nHost: " + upstreamHost + "\r\n\r\n")); err != nil {
		t.Fatalf("write CONNECT: %v", err)
	}
	r := bufio.NewReader(conn)
	statusLine, err := r.ReadString('\n')
	if err != nil {
		t.Fatalf("read CONNECT status line: %v", err)
	}
	if statusLine[:12] != "HTTP/1.1 200" {
		t.Fatalf("CONNECT status line = %q, want 200", statusLine)
	}
	// Drain the rest of the CONNECT response headers (just the blank line here).
	for {
		line, err := r.ReadString('\n')
		if err != nil || line == "\r\n" {
			break
		}
	}

	if _, err := conn.Write([]byte("GET / HTTP/1.1\r\nHost: " + upstreamHost + "\r\nConnection: close\r\n\r\n")); err != nil {
		t.Fatalf("write tunneled request: %v", err)
	}
	body, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read tunneled response: %v", err)
	}
	if !bytes.Contains(body, []byte("tunneled")) {
		t.Fatalf("tunneled response missing body: %s", body)
	}
}

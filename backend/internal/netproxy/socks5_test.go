package netproxy

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func startSOCKS5(t *testing.T, authKey string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := NewSOCKS5Server(authKey)
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = ln.Close() })
	return ln.Addr().String()
}

// socks5Handshake performs the greeting, optional auth, and CONNECT
// request against a running SOCKS5Server, returning the raw connection
// (still positioned right after the reply) for the caller to use as a
// tunnel, plus the final reply code.
func socks5Handshake(t *testing.T, proxyAddr, authKey, targetHost string, targetPort int) (net.Conn, *bufio.Reader, byte) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", proxyAddr, 2*time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	r := bufio.NewReader(conn)

	method := byte(socksMethodNoAuth)
	if authKey != "" {
		method = socksMethodUserPass
	}
	if _, err := conn.Write([]byte{socks5Version, 1, method}); err != nil {
		t.Fatalf("write greeting: %v", err)
	}
	sel := make([]byte, 2)
	if _, err := io.ReadFull(r, sel); err != nil {
		t.Fatalf("read method selection: %v", err)
	}
	if sel[0] != socks5Version || sel[1] != method {
		t.Fatalf("unexpected method selection: %v", sel)
	}

	if method == socksMethodUserPass {
		user := []byte("loom")
		pass := []byte(authKey)
		req := append([]byte{userPassAuthVersion, byte(len(user))}, user...)
		req = append(req, byte(len(pass)))
		req = append(req, pass...)
		if _, err := conn.Write(req); err != nil {
			t.Fatalf("write auth: %v", err)
		}
		authResp := make([]byte, 2)
		if _, err := io.ReadFull(r, authResp); err != nil {
			t.Fatalf("read auth reply: %v", err)
		}
		if authResp[1] != 0x00 {
			return conn, r, authResp[1]
		}
	}

	req := []byte{socks5Version, socksCmdConnect, 0x00, socksAtypDomain, byte(len(targetHost))}
	req = append(req, []byte(targetHost)...)
	portBuf := make([]byte, 2)
	binary.BigEndian.PutUint16(portBuf, uint16(targetPort))
	req = append(req, portBuf...)
	if _, err := conn.Write(req); err != nil {
		t.Fatalf("write connect request: %v", err)
	}

	reply := make([]byte, 10)
	if _, err := io.ReadFull(r, reply); err != nil {
		t.Fatalf("read connect reply: %v", err)
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, r, reply[1]
}

func TestSOCKS5ConnectAndRelayHTTP(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("hello via socks5"))
	}))
	defer upstream.Close()

	upstreamHost, upstreamPortStr, err := net.SplitHostPort(upstream.Listener.Addr().String())
	if err != nil {
		t.Fatalf("split upstream addr: %v", err)
	}
	upstreamPort, err := strconv.Atoi(upstreamPortStr)
	if err != nil {
		t.Fatalf("parse upstream port: %v", err)
	}

	proxyAddr := startSOCKS5(t, "")
	conn, r, code := socks5Handshake(t, proxyAddr, "", upstreamHost, upstreamPort)
	defer conn.Close()
	if code != socksRepSucceeded {
		t.Fatalf("connect reply code = %d, want succeeded", code)
	}

	if _, err := conn.Write([]byte("GET / HTTP/1.1\r\nHost: " + upstreamHost + "\r\nConnection: close\r\n\r\n")); err != nil {
		t.Fatalf("write request over tunnel: %v", err)
	}
	body, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read response over tunnel: %v", err)
	}
	if !bytes.Contains(body, []byte("hello via socks5")) {
		t.Fatalf("response missing expected body: %s", body)
	}
}

func TestSOCKS5RequiresCorrectPassword(t *testing.T) {
	proxyAddr := startSOCKS5(t, "s3cret")

	conn, _, code := socks5Handshake(t, proxyAddr, "wrong-password", "example.com", 80)
	defer conn.Close()
	if code == socksRepSucceeded {
		t.Fatalf("expected auth failure, got succeeded reply")
	}
}

func TestSOCKS5AcceptsCorrectPassword(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	defer upstream.Close()
	upstreamHost, upstreamPortStr, _ := net.SplitHostPort(upstream.Listener.Addr().String())
	upstreamPort, _ := strconv.Atoi(upstreamPortStr)

	proxyAddr := startSOCKS5(t, "s3cret")
	conn, _, code := socks5Handshake(t, proxyAddr, "s3cret", upstreamHost, upstreamPort)
	defer conn.Close()
	if code != socksRepSucceeded {
		t.Fatalf("connect reply code = %d, want succeeded", code)
	}
}

func TestSOCKS5ReportsFailureForUnreachableTarget(t *testing.T) {
	// Bind and immediately close a port so the CONNECT dial fails fast.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port, _ := strconv.Atoi(portStr)
	_ = ln.Close()

	proxyAddr := startSOCKS5(t, "")
	conn, _, code := socks5Handshake(t, proxyAddr, "", host, port)
	defer conn.Close()
	if code == socksRepSucceeded {
		t.Fatalf("expected connect failure for closed port, got succeeded reply")
	}
}

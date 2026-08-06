package netproxy

import (
	"context"
	"io"
	"net"
	"strconv"
	"sync/atomic"
	"testing"
)

func TestSOCKS5UsesCustomDialContext(t *testing.T) {
	// Upstream that announces itself, so we can prove the tunnel is real.
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		for {
			c, err := upstream.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte("hello"))
			c.Close()
		}
	}()

	var used atomic.Int32
	srv := NewSOCKS5Server("")
	srv.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		used.Add(1)
		// Ignore the requested addr entirely and dial our upstream: proves
		// the custom dialer is what actually establishes the connection.
		return net.Dial(network, upstream.Addr().String())
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() { _ = srv.Serve(ln) }()

	// authKey "" -> no-auth method. Target host/port are ignored by the
	// custom DialContext above, so any values work here.
	conn, r, code := socks5Handshake(t, ln.Addr().String(), "", "ignored.invalid", 9999)
	defer conn.Close()
	if code != 0x00 {
		t.Fatalf("CONNECT reply = %#x, want 0x00", code)
	}
	if used.Load() == 0 {
		t.Fatal("custom DialContext was never called")
	}
	// Read through `r`, not a fresh read on `conn` — socks5Handshake's
	// bufio.Reader may already hold bytes read past the CONNECT reply.
	buf := make([]byte, 5)
	if _, err := io.ReadFull(r, buf); err != nil {
		t.Fatalf("read through tunnel: %v", err)
	}
	if string(buf) != "hello" {
		t.Errorf("read %q through the tunnel, want \"hello\"", buf)
	}
}

func TestSOCKS5DefaultDialerStillWorks(t *testing.T) {
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		for {
			c, err := upstream.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()

	srv := NewSOCKS5Server("") // no DialContext set
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() { _ = srv.Serve(ln) }()

	host, portStr, _ := net.SplitHostPort(upstream.Addr().String())
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatal(err)
	}
	conn, _, code := socks5Handshake(t, ln.Addr().String(), "", host, port)
	defer conn.Close()
	if code != 0x00 {
		t.Errorf("CONNECT reply = %#x, want 0x00 with the default dialer", code)
	}
}

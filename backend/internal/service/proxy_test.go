package service

import (
	"net"
	"testing"
)

func TestProxyServiceStartIsIdempotent(t *testing.T) {
	svc := NewProxyService("127.0.0.1")

	first, err := svc.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if first.SOCKS5Addr == "" || first.HTTPProxyAddr == "" || first.ProxyKey == "" {
		t.Fatalf("Start returned incomplete result: %+v", first)
	}
	if first.SOCKS5Addr == first.HTTPProxyAddr {
		t.Fatalf("socks5 and http proxy addrs must differ, got %q for both", first.SOCKS5Addr)
	}

	second, err := svc.Start()
	if err != nil {
		t.Fatalf("second Start: %v", err)
	}
	if second != first {
		t.Fatalf("second Start() = %+v, want identical to first %+v (idempotent)", second, first)
	}
}

func TestProxyServiceListenersAcceptConnections(t *testing.T) {
	svc := NewProxyService("127.0.0.1")
	result, err := svc.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	conn, err := net.Dial("tcp", result.SOCKS5Addr)
	if err != nil {
		t.Fatalf("dial socks5 listener at %s: %v", result.SOCKS5Addr, err)
	}
	conn.Close()

	conn, err = net.Dial("tcp", result.HTTPProxyAddr)
	if err != nil {
		t.Fatalf("dial http proxy listener at %s: %v", result.HTTPProxyAddr, err)
	}
	conn.Close()
}

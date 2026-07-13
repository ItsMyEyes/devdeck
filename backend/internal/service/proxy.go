package service

import (
	"fmt"
	"net"
	"net/http"
	"sync"

	"loom/backend/internal/netproxy"
)

// ProxyStartResult is the bound state of an on-demand forward proxy pair.
type ProxyStartResult struct {
	SOCKS5Addr    string
	HTTPProxyAddr string
}

// ProxyService starts backend/internal/netproxy's SOCKS5 and HTTP forward
// proxies on demand (idempotent) instead of via CLI flags, so a desktop
// client can ask any machine running this backend to "start your forward
// proxy now" and then dial it directly over the tailnet. See
// docs/superpowers/specs/2026-07-13-desktop-proxied-browser-tab-design.md.
type ProxyService struct {
	// advertiseHost is the interface this machine is reachable at (the
	// runtime's own --public-url hostname) — the listeners themselves bind
	// on all interfaces (":0"), but the *advertised* address must be
	// tailnet-reachable, not the bind address, since the desktop client
	// dialing this proxy usually runs on a different machine.
	advertiseHost string

	mu      sync.Mutex
	started bool
	result  ProxyStartResult
}

func NewProxyService(advertiseHost string) *ProxyService {
	return &ProxyService{advertiseHost: advertiseHost}
}

// Start starts (once) the SOCKS5+HTTP forward proxies bound to ephemeral
// ports. A second call while already running returns the existing bound
// addresses rather than starting a duplicate listener pair.
//
// Unauthenticated by design: these proxies exist solely so a Tauri desktop
// webview's proxy_url can dial out through them, and neither wry's macOS
// (Network.framework nw_proxy_config_create_socksv5) nor Windows
// (WebView2 --proxy-server flag) proxy plumbing carries credentials — the
// URL's userinfo is dropped before it reaches the OS. A per-session key
// would only ever see "no auth" offered by the client and reject every
// connection, which is what actually happened before this was removed (see
// docs/superpowers/specs/2026-07-13-desktop-proxied-browser-tab-design.md
// for the original, untested assumption). Safe as long as advertiseHost
// stays tailnet/loopback-scoped and the listener is ephemeral per process.
func (s *ProxyService) Start() (ProxyStartResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started {
		return s.result, nil
	}

	socks5Ln, err := net.Listen("tcp", ":0")
	if err != nil {
		return ProxyStartResult{}, fmt.Errorf("listen socks5: %w", err)
	}
	httpLn, err := net.Listen("tcp", ":0")
	if err != nil {
		socks5Ln.Close()
		return ProxyStartResult{}, fmt.Errorf("listen http proxy: %w", err)
	}

	_, socks5Port, err := net.SplitHostPort(socks5Ln.Addr().String())
	if err != nil {
		socks5Ln.Close()
		httpLn.Close()
		return ProxyStartResult{}, fmt.Errorf("resolve socks5 port: %w", err)
	}
	_, httpPort, err := net.SplitHostPort(httpLn.Addr().String())
	if err != nil {
		socks5Ln.Close()
		httpLn.Close()
		return ProxyStartResult{}, fmt.Errorf("resolve http proxy port: %w", err)
	}

	go func() { _ = netproxy.NewSOCKS5Server("").Serve(socks5Ln) }()
	go func() {
		srv := &http.Server{Handler: netproxy.NewHTTPProxyHandler("")}
		_ = srv.Serve(httpLn)
	}()

	s.result = ProxyStartResult{
		SOCKS5Addr:    net.JoinHostPort(s.advertiseHost, socks5Port),
		HTTPProxyAddr: net.JoinHostPort(s.advertiseHost, httpPort),
	}
	s.started = true
	return s.result, nil
}

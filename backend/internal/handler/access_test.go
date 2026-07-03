package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseCIDRList(t *testing.T) {
	nets, err := ParseCIDRList(" 203.0.113.7, 198.51.100.0/24 , 2001:db8::/32 ")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(nets) != 3 {
		t.Fatalf("expected 3 networks, got %d", len(nets))
	}
	if got := nets[0].String(); got != "203.0.113.7/32" {
		t.Errorf("bare IPv4 should become /32, got %s", got)
	}

	if _, err := ParseCIDRList("not-an-ip"); err == nil {
		t.Error("expected error for invalid IP")
	}
	if _, err := ParseCIDRList("10.0.0.0/99"); err == nil {
		t.Error("expected error for invalid CIDR")
	}
	if nets, err := ParseCIDRList(""); err != nil || len(nets) != 0 {
		t.Errorf("empty list should parse to no networks, got %v, %v", nets, err)
	}
}

func TestClientIP(t *testing.T) {
	proxies, _ := ParseCIDRList("10.0.0.0/8")

	tests := []struct {
		name       string
		remoteAddr string
		xff        string
		cfIP       string
		ipHeader   string
		trusted    string
		want       string
	}{
		{"direct peer, no proxies configured", "203.0.113.7:1234", "", "", "", "", "203.0.113.7"},
		{"spoofed header ignored without trusted proxies", "203.0.113.7:1234", "198.51.100.9", "", "", "", "203.0.113.7"},
		{"spoofed header ignored from untrusted peer", "203.0.113.7:1234", "198.51.100.9", "", "", "10.0.0.0/8", "203.0.113.7"},
		{"header honored behind trusted proxy", "10.0.0.5:1234", "198.51.100.9", "", "", "10.0.0.0/8", "198.51.100.9"},
		{"walks right to left past trusted hops", "10.0.0.5:1234", "198.51.100.9, 10.0.0.7", "", "", "10.0.0.8/8", "198.51.100.9"},
		{"client-controlled left hops ignored", "10.0.0.5:1234", "1.2.3.4, 198.51.100.9", "", "", "10.0.0.0/8", "198.51.100.9"},
		{"malformed hop stops the walk at peer", "10.0.0.5:1234", "garbage", "", "", "10.0.0.0/8", "10.0.0.5"},
		{"trusted peer with no header is the client", "10.0.0.5:1234", "", "", "", "10.0.0.0/8", "10.0.0.5"},
		{"ip header wins over XFF behind trusted proxy", "10.0.0.5:1234", "1.2.3.4", "198.51.100.9", "CF-Connecting-IP", "10.0.0.0/8", "198.51.100.9"},
		{"ip header ignored from untrusted peer", "203.0.113.7:1234", "", "198.51.100.9", "CF-Connecting-IP", "10.0.0.0/8", "203.0.113.7"},
		{"garbage ip header falls back to XFF", "10.0.0.5:1234", "198.51.100.9", "garbage", "CF-Connecting-IP", "10.0.0.0/8", "198.51.100.9"},
		{"missing ip header falls back to peer", "10.0.0.5:1234", "", "", "CF-Connecting-IP", "10.0.0.0/8", "10.0.0.5"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var trusted = proxies
			if tt.trusted == "" {
				trusted = nil
			}
			r := httptest.NewRequest(http.MethodGet, "/api/health", nil)
			r.RemoteAddr = tt.remoteAddr
			if tt.xff != "" {
				r.Header.Set("X-Forwarded-For", tt.xff)
			}
			if tt.cfIP != "" {
				r.Header.Set("CF-Connecting-IP", tt.cfIP)
			}
			ip := ClientIP(r, trusted, tt.ipHeader)
			if ip == nil || ip.String() != tt.want {
				t.Errorf("ClientIP = %v, want %s", ip, tt.want)
			}
		})
	}
}

func TestOnlyFrom(t *testing.T) {
	allowed, _ := ParseCIDRList("198.51.100.0/24")
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mw := OnlyFrom(allowed, nil, "")(next)

	do := func(remoteAddr, path, xff string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.RemoteAddr = remoteAddr
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		w := httptest.NewRecorder()
		mw.ServeHTTP(w, r)
		return w
	}

	if w := do("198.51.100.9:1234", "/api/workspaces", ""); w.Code != http.StatusOK {
		t.Errorf("allowed IP: got %d, want 200", w.Code)
	}
	if w := do("203.0.113.7:1234", "/api/workspaces", ""); w.Code != http.StatusForbidden {
		t.Errorf("blocked IP on API: got %d, want 403", w.Code)
	} else if !strings.Contains(w.Body.String(), `"error"`) {
		t.Errorf("API deny must use the JSON error envelope, got %q", w.Body.String())
	}
	// Spoofing an allowed IP via header must NOT grant access.
	if w := do("203.0.113.7:1234", "/api/workspaces", "198.51.100.9"); w.Code != http.StatusForbidden {
		t.Errorf("spoofed X-Forwarded-For: got %d, want 403", w.Code)
	}
	if w := do("203.0.113.7:1234", "/", ""); w.Code != http.StatusForbidden {
		t.Errorf("blocked IP on page: got %d, want 403", w.Code)
	} else if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("page deny should be HTML, got %q", ct)
	} else if !strings.Contains(w.Body.String(), "Access denied") {
		t.Error("page deny should render the access denied page")
	}
	// Unparseable RemoteAddr fails closed.
	if w := do("bogus", "/api/workspaces", ""); w.Code != http.StatusForbidden {
		t.Errorf("unparseable RemoteAddr: got %d, want 403", w.Code)
	}
}

// The /ws/terminal upgrade hijacks the connection; the access-log recorder
// must expose the underlying Hijacker or the terminal breaks.
func TestAccessLogSupportsHijack(t *testing.T) {
	hijacked := make(chan bool, 1)
	srv := httptest.NewServer(AccessLog(nil, "")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			hijacked <- false
			return
		}
		conn, _, err := hj.Hijack()
		if err != nil {
			hijacked <- false
			return
		}
		_ = conn.Close()
		hijacked <- true
	})))
	defer srv.Close()
	_, _ = http.Get(srv.URL) // error expected: the handler closes the hijacked conn
	if !<-hijacked {
		t.Fatal("AccessLog recorder does not support hijacking")
	}
}

func TestLoopbackAllowed(t *testing.T) {
	yes, _ := ParseCIDRList("127.0.0.0/8, 198.51.100.0/24")
	no, _ := ParseCIDRList("198.51.100.0/24")
	if !LoopbackAllowed(yes) {
		t.Error("127.0.0.0/8 should cover loopback")
	}
	if LoopbackAllowed(no) {
		t.Error("public-only allowlist should not cover loopback")
	}
}

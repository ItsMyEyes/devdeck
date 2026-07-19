package handler

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"
)

// ParseCIDRList parses a comma-separated list of IPs and CIDR ranges
// (e.g. "203.0.113.7, 198.51.100.0/24, 2001:db8::/32"). Bare IPs become
// single-host networks (/32 for IPv4, /128 for IPv6).
func ParseCIDRList(s string) ([]*net.IPNet, error) {
	var nets []*net.IPNet
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			ip := net.ParseIP(part)
			if ip == nil {
				return nil, fmt.Errorf("invalid IP %q", part)
			}
			bits := 32
			if ip.To4() == nil {
				bits = 128
			}
			part = fmt.Sprintf("%s/%d", part, bits)
		}
		_, n, err := net.ParseCIDR(part)
		if err != nil {
			return nil, fmt.Errorf("invalid CIDR %q: %w", part, err)
		}
		nets = append(nets, n)
	}
	return nets, nil
}

// LoopbackAllowed reports whether 127.0.0.1 or ::1 falls inside any of the
// networks — used to warn the operator when --only-from would lock out the
// machine the server runs on.
func LoopbackAllowed(nets []*net.IPNet) bool {
	return ipInAny(net.IPv4(127, 0, 0, 1), nets) || ipInAny(net.IPv6loopback, nets)
}

func ipInAny(ip net.IP, nets []*net.IPNet) bool {
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// ClientIP resolves the real client IP for a request. It starts from the TCP
// peer address (RemoteAddr), which cannot be forged by the client. Forwarding
// headers are ONLY consulted when the direct peer is inside trustedProxies —
// otherwise anyone could spoof an allowed IP with a single header.
//
// When the peer is trusted and ipHeader is set (e.g. "CF-Connecting-IP"
// behind a Cloudflare Tunnel, where the edge overwrites the header on every
// request), its value wins. Otherwise X-Forwarded-For is walked right-to-left
// and the first hop that is not itself a trusted proxy is the client. Returns
// nil when RemoteAddr is unparseable; callers must treat nil as untrusted.
func ClientIP(r *http.Request, trustedProxies []*net.IPNet, ipHeader string) net.IP {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer := net.ParseIP(host)
	if peer == nil || len(trustedProxies) == 0 || !ipInAny(peer, trustedProxies) {
		return peer
	}
	if ipHeader != "" {
		if ip := net.ParseIP(strings.TrimSpace(r.Header.Get(ipHeader))); ip != nil {
			return ip
		}
		// Header absent or garbage: fall through to the X-Forwarded-For walk,
		// which is bounded by the same trusted-peer requirement.
	}
	var hops []string
	for _, v := range r.Header.Values("X-Forwarded-For") {
		hops = append(hops, strings.Split(v, ",")...)
	}
	client := peer
	for i := len(hops) - 1; i >= 0; i-- {
		ip := net.ParseIP(strings.TrimSpace(hops[i]))
		if ip == nil {
			break // malformed hop: stop, keep the last verifiable IP
		}
		client = ip
		if !ipInAny(ip, trustedProxies) {
			break // first non-proxy hop is the client; hops left of it are client-controlled
		}
	}
	return client
}

// AccessLog logs every request with its resolved client IP, method, path,
// status, response size, and duration. For /api and /ws requests it appends
// a full audit block — request headers, request body, and response body
// (capped, secrets redacted; see audit.go) — so anomalous traffic is visible
// in the log. Static SPA asset requests keep the one-line summary.
func AccessLog(trustedProxies []*net.IPNet, ipHeader string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			audited := strings.HasPrefix(r.URL.Path, "/api") || strings.HasPrefix(r.URL.Path, "/ws/")
			var reqBody *bodyTap
			if audited && r.Body != nil {
				reqBody = &bodyTap{rc: r.Body}
				r.Body = reqBody
			}
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK, captureBody: audited}
			next.ServeHTTP(rec, r)
			status := rec.status
			if rec.hijacked {
				status = http.StatusSwitchingProtocols
			}
			ip := ClientIP(r, trustedProxies, ipHeader)
			ipStr := "unknown"
			if ip != nil {
				ipStr = ip.String()
			}
			target := r.URL.Path
			if r.URL.RawQuery != "" {
				target += "?" + clip(sanitizeLogText(r.URL.RawQuery), logValueCap)
			}
			line := fmt.Sprintf("http: %s %s %s -> %d (%dB, %s)",
				ipStr, r.Method, target, status, rec.bytes, time.Since(start).Round(time.Millisecond))
			if audited {
				line += formatAudit(r, reqBody, rec)
			}
			log.Print(line)
		})
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	bytes       int
	wroteHeader bool
	hijacked    bool
	captureBody bool
	bodyBuf     []byte
	bodyTotal   int64
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status = code
		s.wroteHeader = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if !s.wroteHeader {
		s.status = http.StatusOK
		s.wroteHeader = true
	}
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	if s.captureBody && n > 0 {
		if room := logBodyCap - len(s.bodyBuf); room > 0 {
			if n < room {
				room = n
			}
			s.bodyBuf = append(s.bodyBuf, b[:room]...)
		}
		s.bodyTotal += int64(n)
	}
	return n, err
}

// Hijack lets the WebSocket terminal upgrade pass through the recorder.
func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := s.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("underlying ResponseWriter does not support hijacking")
	}
	s.hijacked = true
	return h.Hijack()
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// OnlyFrom restricts all access to clients whose resolved IP falls inside one
// of the allowed networks (the --only-from flag). API and WebSocket requests
// get the standard JSON error envelope; page loads get a standalone access
// denied page (the SPA itself is blocked, so it can't render one). Requests
// with an unresolvable client IP are denied (fail closed).
func OnlyFrom(allowed, trustedProxies []*net.IPNet, ipHeader string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := ClientIP(r, trustedProxies, ipHeader)
			if ip != nil && ipInAny(ip, allowed) {
				next.ServeHTTP(w, r)
				return
			}
			ipStr := "unknown"
			if ip != nil {
				ipStr = ip.String()
			}
			log.Printf("access: denied %s %s %s (not in --only-from allowlist)", ipStr, r.Method, r.URL.Path)
			if strings.HasPrefix(r.URL.Path, "/api") || strings.HasPrefix(r.URL.Path, "/ws/") {
				writeErr(w, http.StatusForbidden, "access denied: your IP address is not allowed")
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, accessDeniedHTML)
		})
	}
}

// accessDeniedHTML is a self-contained page matching the DevDeck dark theme,
// served when a blocked browser requests any non-API path.
const accessDeniedHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Access denied — DevDeck</title>
<style>
  :root {
    --bg: #0c0d10; --elevated: #1a1d23; --border: #1d2027;
    --fg: #e8eaed; --muted: #9aa0aa; --red: #f87171; --red-tint: #3a2626;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
  }
  .card {
    background: var(--elevated); border: 1px solid var(--border);
    border-radius: 10px; padding: 40px 44px; max-width: 380px; text-align: center;
  }
  .badge {
    width: 44px; height: 44px; margin: 0 auto 18px; border-radius: 10px;
    background: var(--red-tint); color: var(--red);
    display: flex; align-items: center; justify-content: center;
    font-size: 20px; font-weight: 600;
  }
  h1 { font-size: 16px; font-weight: 500; margin-bottom: 10px; }
  p { font-size: 12.5px; line-height: 1.6; color: var(--muted); }
  .code { margin-top: 22px; font-size: 11px; color: var(--muted); letter-spacing: 0.08em; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">&#9888;</div>
    <h1>Access denied</h1>
    <p>This DevDeck instance only accepts connections from approved IP addresses. Your address is not on the allowlist.</p>
    <p style="margin-top:8px">If you believe this is a mistake, contact the operator of this instance.</p>
    <div class="code">HTTP 403 &middot; IP RESTRICTED</div>
  </div>
</body>
</html>
`

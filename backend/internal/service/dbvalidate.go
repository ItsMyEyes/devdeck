package service

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// ValidEngines lists the SQL engines supported today. MongoDB and Redis are
// Pieces B and C of the design and are deliberately rejected here until their
// drivers exist — accepting them would fail confusingly at connect time.
var ValidEngines = []string{"postgres", "mysql", "sqlite"}

func ValidateEngine(engine string) error {
	for _, e := range ValidEngines {
		if engine == e {
			return nil
		}
	}
	return fmt.Errorf("unsupported engine %q; supported: %s", engine, strings.Join(ValidEngines, ", "))
}

// DefaultPortForEngine returns the conventional port, used to prefill the
// connection form. SQLite is file-based and has no port.
func DefaultPortForEngine(engine string) int {
	switch engine {
	case "postgres":
		return 5432
	case "mysql":
		return 3306
	default:
		return 0
	}
}

// verifiedSSLModes are the modes that actually authenticate the server.
//
// The subtle case is PostgreSQL's "require": it encrypts the connection but
// performs no certificate validation whatsoever, so an attacker in the path
// can present a self-signed certificate and be accepted. Encryption without
// authentication does not prevent a man-in-the-middle. MySQL's "skip-verify"
// and "preferred" have the same property.
var verifiedSSLModes = map[string]map[string]bool{
	"postgres": {"verify-ca": true, "verify-full": true},
	"mysql":    {"true": true, "verify-ca": true, "verify-identity": true},
}

var knownSSLModes = map[string]map[string]bool{
	"postgres": {"disable": true, "allow": true, "prefer": true, "require": true, "verify-ca": true, "verify-full": true},
	"mysql":    {"false": true, "true": true, "skip-verify": true, "preferred": true, "verify-ca": true, "verify-identity": true},
}

// ValidateSSLMode checks that sslMode is known for the engine and, for
// production connections, that it actually verifies the server certificate.
func ValidateSSLMode(engine, sslMode string, isProduction bool) error {
	if engine == "sqlite" {
		return nil // local file; no transport to protect
	}
	known, ok := knownSSLModes[engine]
	if !ok {
		return fmt.Errorf("unsupported engine %q", engine)
	}
	if !known[sslMode] {
		return fmt.Errorf("unknown sslMode %q for %s", sslMode, engine)
	}
	if !isProduction {
		return nil
	}
	if !verifiedSSLModes[engine][sslMode] {
		return fmt.Errorf("sslMode %q does not verify the server certificate, which is not allowed for a connection marked production; use a verifying mode and supply a CA certificate if the server uses a private CA", sslMode)
	}
	return nil
}

// ValidateExecutorURL enforces that a Machine may only act as a database
// executor when the hub can reach it over an authenticated, encrypted path.
//
// The hub sends a decrypted database password to the executor. Over plain
// http:// to a host outside the tailnet, that password crosses the network in
// cleartext. Tailscale hosts are accepted over http:// because WireGuard
// already encrypts and authenticates that path.
func ValidateExecutorURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid executor machine URL: %v", err)
	}
	if u.Scheme == "https" {
		return nil
	}
	if u.Scheme != "http" {
		return fmt.Errorf("executor machine URL must use http or https, got %q", u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("executor machine URL has no host")
	}
	if strings.HasSuffix(host, ".ts.net") {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && isTailscaleCGNAT(ip) {
		return nil
	}
	return fmt.Errorf("executor machine %q uses plain http outside the tailnet; database credentials would cross the network unencrypted — use https or a tailnet address", rawURL)
}

// ValidateDBHost rejects a database host that resolves to a link-local
// address — 169.254.0.0/16 (IPv4) and fe80::/10 (IPv6) — which is where
// every major cloud's instance-metadata service listens: 169.254.169.254 on
// AWS/GCP/Azure, 100.100.100.100 on Alibaba (that one is inside Tailscale's
// own CGNAT range and is not blocked here — see the design doc's
// residual-risks note).
//
// Unlike ValidateExecutorURL, this does not require TLS or reject public
// hosts outright: pointing a DB client at an arbitrary host:port is the
// entire feature. Only the specific metadata-endpoint shape is blocked, and
// only at connection-save time — this is a footgun guard against a
// deliberate metadata-endpoint host, not a defense against a hostile actor
// racing DNS after validation, matching the design's "IsProduction is not a
// security boundary" framing: the operator holds full credentials either way.
func ValidateDBHost(host string) error {
	h := strings.TrimSpace(host)
	if h == "" {
		return nil // sqlite, or "host required" is validated elsewhere
	}
	if ip := net.ParseIP(h); ip != nil {
		return checkLinkLocal(host, []net.IP{ip})
	}
	ips, err := net.LookupIP(h)
	if err != nil {
		return nil
	}
	return checkLinkLocal(host, ips)
}

func checkLinkLocal(host string, ips []net.IP) error {
	for _, ip := range ips {
		if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			return fmt.Errorf("host %q resolves to a link-local address, which is blocked to prevent reaching a cloud metadata endpoint (e.g. 169.254.169.254)", host)
		}
	}
	return nil
}

// tailscaleCGNAT is the 100.64.0.0/10 carrier-grade NAT range Tailscale
// assigns to tailnet nodes.
var tailscaleCGNAT = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

func isTailscaleCGNAT(ip net.IP) bool {
	v4 := ip.To4()
	return v4 != nil && tailscaleCGNAT.Contains(v4)
}

package service

import "testing"

func TestValidateSSLModeRejectsUnverifiedModesForProduction(t *testing.T) {
	// "require" encrypts but does NOT verify the server certificate, so a
	// man-in-the-middle presenting any certificate is accepted. This is the
	// mode operators most often assume is safe.
	for _, mode := range []string{"disable", "allow", "prefer", "require"} {
		if err := ValidateSSLMode("postgres", mode, true); err == nil {
			t.Errorf("sslMode %q accepted for a production connection, want rejection", mode)
		}
	}
}

func TestValidateSSLModeAllowsVerifiedModesForProduction(t *testing.T) {
	for _, mode := range []string{"verify-ca", "verify-full"} {
		if err := ValidateSSLMode("postgres", mode, true); err != nil {
			t.Errorf("sslMode %q rejected for production: %v", mode, err)
		}
	}
}

func TestValidateSSLModeAllowsWeakModesForNonProduction(t *testing.T) {
	if err := ValidateSSLMode("postgres", "require", false); err != nil {
		t.Errorf("require rejected for non-production connection: %v", err)
	}
}

func TestValidateSSLModeMySQLUnverifiedModes(t *testing.T) {
	for _, mode := range []string{"false", "skip-verify", "preferred"} {
		if err := ValidateSSLMode("mysql", mode, true); err == nil {
			t.Errorf("mysql tls mode %q accepted for production, want rejection", mode)
		}
	}
	if err := ValidateSSLMode("mysql", "true", true); err != nil {
		t.Errorf("mysql tls=true rejected for production: %v", err)
	}
}

func TestValidateSSLModeSQLiteIgnoresTLS(t *testing.T) {
	// SQLite is a local file; no network, so no TLS policy applies.
	if err := ValidateSSLMode("sqlite", "", true); err != nil {
		t.Errorf("sqlite production connection rejected over TLS mode: %v", err)
	}
}

func TestValidateSSLModeRejectsUnknownMode(t *testing.T) {
	if err := ValidateSSLMode("postgres", "banana", false); err == nil {
		t.Error("unknown sslMode accepted, want rejection")
	}
}

func TestValidateExecutorURLAcceptsHTTPSAndTailnet(t *testing.T) {
	ok := []string{
		"https://runtime.example.com:8989",
		"http://runtime.tail1234.ts.net:8989",
		"http://100.101.102.103:8989", // CGNAT range used by Tailscale
	}
	for _, u := range ok {
		if err := ValidateExecutorURL(u); err != nil {
			t.Errorf("ValidateExecutorURL(%q) = %v, want nil", u, err)
		}
	}
}

func TestValidateExecutorURLRejectsPlaintextPublicHosts(t *testing.T) {
	// A decrypted database password travels to the executor. Over plain http
	// to a non-tailnet host that password crosses the network in the clear.
	bad := []string{
		"http://1.2.3.4:8989",
		"http://runtime.example.com:8989",
		"http://203.0.113.9",
	}
	for _, u := range bad {
		if err := ValidateExecutorURL(u); err == nil {
			t.Errorf("ValidateExecutorURL(%q) = nil, want rejection", u)
		}
	}
}

func TestValidateExecutorURLRejectsMalformed(t *testing.T) {
	for _, u := range []string{"", "not a url", "ftp://host", "runtime.example.com"} {
		if err := ValidateExecutorURL(u); err == nil {
			t.Errorf("ValidateExecutorURL(%q) = nil, want rejection", u)
		}
	}
}

func TestValidateDBHostRejectsLinkLocalIPv4(t *testing.T) {
	// 169.254.169.254 is the cloud metadata endpoint on AWS, GCP, and Azure
	// alike — the exact address the design's residual-risks section names.
	if err := ValidateDBHost("169.254.169.254"); err == nil {
		t.Fatal("link-local IPv4 host accepted, want rejection")
	}
}

func TestValidateDBHostRejectsLinkLocalIPv6(t *testing.T) {
	if err := ValidateDBHost("fe80::1"); err == nil {
		t.Fatal("link-local IPv6 host accepted, want rejection")
	}
}

func TestValidateDBHostAcceptsOrdinaryHosts(t *testing.T) {
	for _, host := range []string{"10.0.0.5", "db.internal.example.com", "127.0.0.1", ""} {
		if err := ValidateDBHost(host); err != nil {
			t.Errorf("host %q rejected: %v", host, err)
		}
	}
}

func TestValidateDBHostAcceptsUnresolvableHostname(t *testing.T) {
	// A hostname the hub cannot resolve yet is not link-local by definition;
	// connecting will simply fail later with its own, clearer error.
	if err := ValidateDBHost("this-host-does-not-exist.invalid"); err != nil {
		t.Errorf("unresolvable hostname rejected: %v", err)
	}
}

func TestValidateEngine(t *testing.T) {
	for _, e := range ValidEngines {
		if err := ValidateEngine(e); err != nil {
			t.Errorf("ValidateEngine(%q) = %v, want nil", e, err)
		}
	}
	for _, e := range []string{"", "mongodb", "redis", "oracle"} {
		if err := ValidateEngine(e); err == nil {
			t.Errorf("ValidateEngine(%q) = nil, want rejection", e)
		}
	}
}

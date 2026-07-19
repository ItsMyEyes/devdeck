package pgdrv

import (
	"testing"

	"devdeck/backend/internal/port"
)

func TestBuildTLSConfigVerifyFullChecksHostname(t *testing.T) {
	cfg, err := BuildTLSConfig(port.DSNDescriptor{SSLMode: "verify-full", Host: "db.example.com"})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if cfg.InsecureSkipVerify {
		t.Fatal("verify-full must not skip verification")
	}
	if cfg.ServerName != "db.example.com" {
		t.Fatalf("ServerName = %q, want the host for hostname verification", cfg.ServerName)
	}
}

func TestBuildTLSConfigVerifyCASkipsHostnameButVerifiesChain(t *testing.T) {
	cfg, err := BuildTLSConfig(port.DSNDescriptor{SSLMode: "verify-ca", Host: "db.example.com"})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	// verify-ca validates the chain but not the hostname, which Go expresses
	// as InsecureSkipVerify plus a custom VerifyPeerCertificate.
	if cfg.VerifyPeerCertificate == nil {
		t.Fatal("verify-ca needs a custom chain verifier")
	}
}

func TestBuildTLSConfigDisableReturnsNil(t *testing.T) {
	cfg, err := BuildTLSConfig(port.DSNDescriptor{SSLMode: "disable"})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if cfg != nil {
		t.Fatal("disable must produce no TLS config")
	}
}

func TestBuildTLSConfigRejectsUnparseableCACert(t *testing.T) {
	_, err := BuildTLSConfig(port.DSNDescriptor{SSLMode: "verify-full", Host: "h", CACert: "not a pem block"})
	if err == nil {
		t.Fatal("invalid CA certificate accepted, want rejection")
	}
}

func TestBuildTLSConfigPinnedFingerprintSetsVerifier(t *testing.T) {
	cfg, err := BuildTLSConfig(port.DSNDescriptor{
		SSLMode: "verify-full", Host: "h",
		ServerCertFingerprint: "AA:BB:CC",
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if cfg.VerifyPeerCertificate == nil {
		t.Fatal("a pinned fingerprint requires a custom verifier")
	}
}

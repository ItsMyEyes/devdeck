package pgdrv

import (
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"devdeck/backend/internal/port"
)

// BuildTLSConfig translates a descriptor's TLS fields into a *tls.Config.
//
// The modes mirror libpq's sslmode. The distinction that matters is between
// encryption and authentication: "require" encrypts but validates nothing, so
// anyone in the network path can present a self-signed certificate and be
// accepted. service.ValidateSSLMode already blocks the unverified modes for
// connections marked production; this function implements whatever mode
// survived that check and never silently upgrades or downgrades one.
//
// A nil config (with a nil error) means "no TLS configured here" — the caller
// leaves negotiation to pgx's own sslmode handling.
func BuildTLSConfig(d port.DSNDescriptor) (*tls.Config, error) {
	mode := strings.TrimSpace(d.SSLMode)
	switch mode {
	case "", "disable", "allow", "prefer":
		// Nothing to configure: these modes either disable TLS or leave it to
		// opportunistic negotiation with no verification to set up.
		return nil, nil
	case "require", "verify-ca", "verify-full":
	default:
		return nil, fmt.Errorf("postgres: unknown sslMode %q", mode)
	}

	roots, err := caPool(d.CACert)
	if err != nil {
		return nil, err
	}

	cfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
		RootCAs:    roots,
	}

	if err := applyClientCert(cfg, d); err != nil {
		return nil, err
	}

	switch mode {
	case "require":
		// Encryption without authentication. Permitted only for connections
		// not marked production; the caller has already enforced that.
		cfg.InsecureSkipVerify = true
	case "verify-ca":
		// Go has no built-in "verify the chain but not the hostname" mode, so
		// the standard verification is switched off and replaced with a manual
		// chain build that omits the DNSName check.
		cfg.InsecureSkipVerify = true
		cfg.VerifyPeerCertificate = chainVerifier(roots)
	case "verify-full":
		// Full verification: chain and hostname. ServerName is what makes the
		// hostname check happen at all.
		cfg.ServerName = d.Host
	}

	if fp := strings.TrimSpace(d.ServerCertFingerprint); fp != "" {
		want, err := normalizeFingerprint(fp)
		if err != nil {
			return nil, err
		}
		cfg.VerifyPeerCertificate = withPinnedLeaf(cfg.VerifyPeerCertificate, want)
	}
	return cfg, nil
}

// caPool parses a PEM CA bundle. An unparseable bundle is an error rather than
// a silent fallback to the system roots: the operator supplied a private CA
// precisely because the system roots do not cover this server, and quietly
// ignoring it would verify against the wrong trust anchors.
func caPool(pem string) (*x509.CertPool, error) {
	if strings.TrimSpace(pem) == "" {
		return nil, nil // nil RootCAs means system roots
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(pem)) {
		return nil, errors.New("postgres: caCert contains no parseable PEM certificate")
	}
	return pool, nil
}

// applyClientCert loads a client keypair for mutual TLS. Supplying only one
// half is a configuration error, not a reason to connect without one.
func applyClientCert(cfg *tls.Config, d port.DSNDescriptor) error {
	cert := strings.TrimSpace(d.ClientCert)
	key := strings.TrimSpace(d.ClientKey)
	if cert == "" && key == "" {
		return nil
	}
	if cert == "" || key == "" {
		return errors.New("postgres: clientCert and clientKey must both be supplied for mutual TLS")
	}
	pair, err := tls.X509KeyPair([]byte(d.ClientCert), []byte(d.ClientKey))
	if err != nil {
		return fmt.Errorf("postgres: invalid client certificate keypair: %w", err)
	}
	cfg.Certificates = []tls.Certificate{pair}
	return nil
}

// chainVerifier builds and verifies the presented chain against roots (or the
// system roots when nil) without checking the hostname — the "verify-ca"
// semantics.
func chainVerifier(roots *x509.CertPool) func([][]byte, [][]*x509.Certificate) error {
	return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		certs, err := parseChain(rawCerts)
		if err != nil {
			return err
		}
		opts := x509.VerifyOptions{Roots: roots, Intermediates: x509.NewCertPool()}
		for _, c := range certs[1:] {
			opts.Intermediates.AddCert(c)
		}
		if _, err := certs[0].Verify(opts); err != nil {
			return fmt.Errorf("postgres: server certificate chain is not trusted: %w", err)
		}
		return nil
	}
}

// withPinnedLeaf wraps an existing verifier with a SHA-256 pin on the leaf
// certificate. A mismatch is fatal: the whole point of a pin is that an
// otherwise valid certificate is still the wrong one.
func withPinnedLeaf(next func([][]byte, [][]*x509.Certificate) error, want []byte) func([][]byte, [][]*x509.Certificate) error {
	return func(rawCerts [][]byte, chains [][]*x509.Certificate) error {
		if next != nil {
			if err := next(rawCerts, chains); err != nil {
				return err
			}
		}
		if len(rawCerts) == 0 {
			return errors.New("postgres: server presented no certificate to match against the pinned fingerprint")
		}
		sum := sha256.Sum256(rawCerts[0])
		// Constant time so a mismatched pin cannot be recovered byte by byte
		// from response timing.
		if subtle.ConstantTimeCompare(sum[:], want) != 1 {
			return fmt.Errorf("postgres: server certificate fingerprint %s does not match the pinned %s",
				hex.EncodeToString(sum[:]), hex.EncodeToString(want))
		}
		return nil
	}
}

func parseChain(rawCerts [][]byte) ([]*x509.Certificate, error) {
	if len(rawCerts) == 0 {
		return nil, errors.New("postgres: server presented no certificate")
	}
	out := make([]*x509.Certificate, 0, len(rawCerts))
	for _, raw := range rawCerts {
		c, err := x509.ParseCertificate(raw)
		if err != nil {
			return nil, fmt.Errorf("postgres: unparseable server certificate: %w", err)
		}
		out = append(out, c)
	}
	return out, nil
}

// normalizeFingerprint accepts the usual human forms — "AA:BB:CC…",
// "sha256:aabbcc…", or bare hex — and returns the raw digest bytes.
//
// The length is deliberately not enforced here: an operator can paste a
// truncated fingerprint, and comparing a short prefix against a full digest
// simply never matches, which fails closed.
func normalizeFingerprint(fp string) ([]byte, error) {
	s := strings.TrimSpace(fp)
	s = strings.TrimPrefix(strings.ToLower(s), "sha256:")
	s = strings.NewReplacer(":", "", " ", "", "-", "").Replace(s)
	b, err := hex.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("postgres: serverCertFingerprint is not hex: %w", err)
	}
	if len(b) == 0 {
		return nil, errors.New("postgres: serverCertFingerprint is empty")
	}
	return b, nil
}

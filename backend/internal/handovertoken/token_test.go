package handovertoken

import (
	"crypto/ed25519"
	"strings"
	"testing"
	"time"
)

func TestIssueThenVerifyRoundTrips(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_700_000_000, 0)

	tok, err := Issue(priv, "user-1", "m-abc", now)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := Verify(pub, tok, "m-abc", now)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Sub != "user-1" || claims.Aud != "m-abc" {
		t.Errorf("claims = %+v, want sub=user-1 aud=m-abc", claims)
	}
}

func TestVerifyRejectsWrongAudience(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_700_000_000, 0)
	tok, _ := Issue(priv, "user-1", "m-abc", now)

	if _, err := Verify(pub, tok, "m-different", now); err == nil {
		t.Fatal("Verify succeeded for a token issued to a different machine, want error")
	}
}

func TestVerifyRejectsExpiredToken(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	issuedAt := time.Unix(1_700_000_000, 0)
	tok, _ := Issue(priv, "user-1", "m-abc", issuedAt)

	// 60s TTL + 30s skew tolerance = 90s grace. 91s later must fail.
	tooLate := issuedAt.Add(91 * time.Second)
	if _, err := Verify(pub, tok, "m-abc", tooLate); err == nil {
		t.Fatal("Verify succeeded 91s after issuance, want expired error")
	}
}

func TestVerifyToleratesThirtySecondsOfClockSkew(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	issuedAt := time.Unix(1_700_000_000, 0)
	tok, _ := Issue(priv, "user-1", "m-abc", issuedAt)

	// 60s TTL + 29s into the skew-tolerance window: must still succeed.
	stillOk := issuedAt.Add(89 * time.Second)
	if _, err := Verify(pub, tok, "m-abc", stillOk); err != nil {
		t.Errorf("Verify failed 89s after issuance (within the 30s skew tolerance): %v", err)
	}
}

func TestVerifyRejectsTamperedSignature(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_700_000_000, 0)
	tok, _ := Issue(priv, "user-1", "m-abc", now)

	parts := strings.SplitN(tok, ".", 2)
	tampered := parts[0] + ".not-a-real-signature"
	if _, err := Verify(pub, tampered, "m-abc", now); err == nil {
		t.Fatal("Verify succeeded with a tampered signature, want error")
	}
}

func TestVerifyRejectsWrongSigningKey(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(nil)
	otherPub, _, _ := ed25519.GenerateKey(nil) // a different keypair entirely
	now := time.Unix(1_700_000_000, 0)
	tok, _ := Issue(priv, "user-1", "m-abc", now)

	if _, err := Verify(otherPub, tok, "m-abc", now); err == nil {
		t.Fatal("Verify succeeded against the wrong public key, want error")
	}
}

func TestVerifyRejectsMalformedToken(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(nil)
	for _, bad := range []string{"", "no-dot-in-here", "one.two.three", "!!!.###"} {
		if _, err := Verify(pub, bad, "m-abc", time.Now()); err == nil {
			t.Errorf("Verify(%q) succeeded, want error", bad)
		}
	}
}

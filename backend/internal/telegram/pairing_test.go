package telegram

import (
	"testing"
	"time"
)

func TestPairingCodeIsSixDigitsAndSingleUse(t *testing.T) {
	now := time.Unix(1000, 0)
	p := &Pairing{TTL: 5 * time.Minute, Now: func() time.Time { return now }}
	code := p.Issue()
	if len(code) != 6 {
		t.Fatalf("code = %q, want 6 digits", code)
	}
	for _, r := range code {
		if r < '0' || r > '9' {
			t.Fatalf("code = %q, want digits only", code)
		}
	}
	if !p.Redeem(code) {
		t.Fatalf("first redeem must succeed")
	}
	// Single use: a code shared in a group chat must not enrol everyone who
	// scrolled up and read it.
	if p.Redeem(code) {
		t.Fatalf("second redeem must fail")
	}
}

func TestPairingCodeExpires(t *testing.T) {
	now := time.Unix(1000, 0)
	p := &Pairing{TTL: 5 * time.Minute, Now: func() time.Time { return now }}
	code := p.Issue()
	now = now.Add(6 * time.Minute)
	if p.Redeem(code) {
		t.Fatalf("expired code must not redeem")
	}
}

func TestIssueInvalidatesThePreviousCode(t *testing.T) {
	now := time.Unix(1000, 0)
	p := &Pairing{TTL: 5 * time.Minute, Now: func() time.Time { return now }}
	first := p.Issue()
	second := p.Issue()
	if first == second {
		t.Fatalf("a reissue must produce a different code")
	}
	if p.Redeem(first) {
		t.Fatalf("the superseded code must be dead")
	}
	if !p.Redeem(second) {
		t.Fatalf("the current code must redeem")
	}
}

func TestRedeemRejectsEmptyAndUnissuedCodes(t *testing.T) {
	p := &Pairing{TTL: 5 * time.Minute, Now: time.Now}
	code := p.Issue()
	if p.Redeem("") {
		t.Fatalf("an empty code must never redeem")
	}
	// A wrong guess must not consume the live code either.
	wrong := "000000"
	if wrong == code {
		wrong = "111111"
	}
	if p.Redeem(wrong) {
		t.Fatalf("a wrong code must not redeem")
	}
	if !p.Redeem(code) {
		t.Fatalf("a failed guess must not have burned the real code")
	}
}

package telegram

import (
	"crypto/rand"
	"fmt"
	"sync"
	"time"
)

// Pairing is an ordinary short-lived enrolment code, the same idea as
// pairing a TV app with a streaming account: /pair proves possession of a
// live code, never a password, and the code is worthless the moment it is
// used or its TTL runs out.
//
// Pure and self-contained on purpose (see commands.go's doc comment): no
// store, no network. Task 5 is the only thing that persists what a
// successful Redeem means (adding a domain.TelegramUser).
//
// Now is injected rather than calling time.Now() directly so the expiry
// test can move the clock without a real 5-minute sleep.
type Pairing struct {
	TTL time.Duration
	Now func() time.Time

	mu        sync.Mutex
	code      string
	expiresAt time.Time
}

// Issue mints a fresh 6-digit code and invalidates whatever code was live
// before it — a stale code left over from an earlier /pair attempt must not
// keep working once a new one has been generated. crypto/rand, not
// math/rand: this is a credential, however short-lived.
func (p *Pairing) Issue() string {
	p.mu.Lock()
	defer p.mu.Unlock()

	var next string
	for {
		next = randomSixDigits()
		if next != p.code {
			break
		}
	}
	p.code = next
	p.expiresAt = p.Now().Add(p.TTL)
	return next
}

// Redeem reports whether code is the live, unexpired code, and — this is
// the load-bearing part — clears the stored code on success so a code
// pasted into a group chat cannot enrol everyone who later scrolls up and
// reads it. A wrong guess is NOT allowed to consume the live code: if it
// were, anyone could lock out the real operator by spamming guesses at the
// pairing endpoint. An empty argument can never match, since the stored
// code is never empty once Issue has run and Redeem never sets it to "".
func (p *Pairing) Redeem(code string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()

	if code == "" || p.code == "" || code != p.code {
		return false
	}
	if !p.Now().Before(p.expiresAt) {
		return false
	}
	p.code = ""
	return true
}

// Current reports the live code without consuming it — used to show an
// operator-facing "pairing code: 482913, expires in 4m" status, never to
// answer a Telegram update.
func (p *Pairing) Current() (code string, expiresAt time.Time, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.code == "" || !p.Now().Before(p.expiresAt) {
		return "", time.Time{}, false
	}
	return p.code, p.expiresAt, true
}

// randomSixDigits draws a code from crypto/rand rather than math/rand: a
// pairing code is a bearer credential for enrolling a Telegram account, and
// math/rand's sequence is predictable from a handful of outputs.
func randomSixDigits() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand.Read failing means the OS entropy source is broken —
		// nothing this process does is trustworthy at that point, and the
		// caller (Issue) has no error return to propagate this through.
		panic("telegram: crypto/rand unavailable: " + err.Error())
	}
	n := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	return fmt.Sprintf("%06d", n%1_000_000)
}

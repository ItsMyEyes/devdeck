package service

import (
	"errors"
	"testing"
	"time"

	"devdeck/backend/internal/store"
)

func newPINService(t *testing.T) *PINService {
	t.Helper()
	return NewPINService(store.NewTestStore(t))
}

func TestValidPINRequiresExactlySixDigits(t *testing.T) {
	cases := []struct {
		pin  string
		want bool
	}{
		{"019283", true},
		{"000000", true}, // format-valid; weakPIN rejects it separately
		{"12345", false},
		{"1234567", false},
		{"", false},
		{"12345a", false},
		{"12 456", false},
		{"१२३४५६", false}, // non-ASCII digits
	}
	for _, c := range cases {
		if got := ValidPIN(c.pin); got != c.want {
			t.Errorf("ValidPIN(%q) = %v, want %v", c.pin, got, c.want)
		}
	}
}

func TestSetRejectsBadFormatAndWeakPINs(t *testing.T) {
	svc := newPINService(t)
	for _, pin := range []string{"12345", "abcdef", ""} {
		if err := svc.Set(pin); !errors.Is(err, ErrPINFormat) {
			t.Errorf("Set(%q) = %v, want ErrPINFormat", pin, err)
		}
	}
	for _, pin := range []string{"111111", "123456", "654321", "456789"} {
		if err := svc.Set(pin); !errors.Is(err, ErrPINWeak) {
			t.Errorf("Set(%q) = %v, want ErrPINWeak", pin, err)
		}
	}
}

func TestSetThenVerifyRoundTrips(t *testing.T) {
	svc := newPINService(t)
	if err := svc.Set("482913"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := svc.Verify("482913", "10.0.0.1"); err != nil {
		t.Fatalf("Verify with the right PIN: %v", err)
	}
	if err := svc.Verify("482914", "10.0.0.1"); !errors.Is(err, ErrPINWrong) {
		t.Errorf("Verify with a wrong PIN = %v, want ErrPINWrong", err)
	}
}

// The PIN must never be readable back out — only its bcrypt hash is stored.
func TestStoredPINIsHashedNotPlaintext(t *testing.T) {
	st := store.NewTestStore(t)
	svc := NewPINService(st)
	if err := svc.Set("482913"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	hash, err := st.SignInPINHash()
	if err != nil {
		t.Fatalf("SignInPINHash: %v", err)
	}
	if hash == "482913" || hash == "" {
		t.Fatalf("stored hash = %q, want a bcrypt hash of the PIN", hash)
	}
}

func TestConfiguredReportsWhetherAPINExists(t *testing.T) {
	svc := newPINService(t)
	if configured, err := svc.Configured(); err != nil || configured {
		t.Fatalf("Configured on a fresh store = %v, %v; want false, nil", configured, err)
	}
	if err := svc.Set("482913"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if configured, err := svc.Configured(); err != nil || !configured {
		t.Fatalf("Configured after Set = %v, %v; want true, nil", configured, err)
	}
}

func TestEnsureSeededGeneratesOnceThenLeavesThePINAlone(t *testing.T) {
	svc := newPINService(t)
	first, err := svc.EnsureSeeded()
	if err != nil {
		t.Fatalf("EnsureSeeded: %v", err)
	}
	if !ValidPIN(first) {
		t.Fatalf("EnsureSeeded returned %q, want %d digits", first, PINLength)
	}
	if err := svc.Verify(first, ""); err != nil {
		t.Fatalf("the seeded PIN does not verify: %v", err)
	}
	second, err := svc.EnsureSeeded()
	if err != nil {
		t.Fatalf("second EnsureSeeded: %v", err)
	}
	if second != "" {
		t.Errorf("second EnsureSeeded = %q, want \"\" (an existing PIN must be left alone)", second)
	}
	if err := svc.Verify(first, ""); err != nil {
		t.Errorf("the original PIN stopped working after a second EnsureSeeded: %v", err)
	}
}

// A seeded PIN must never be one Set would refuse — otherwise an operator who
// tries to re-enter the PIN from the log gets "too easy to guess".
func TestGeneratePINNeverReturnsAWeakPIN(t *testing.T) {
	for i := 0; i < 500; i++ {
		pin, err := GeneratePIN()
		if err != nil {
			t.Fatalf("GeneratePIN: %v", err)
		}
		if !ValidPIN(pin) || weakPIN(pin) {
			t.Fatalf("GeneratePIN returned %q, want a valid non-weak PIN", pin)
		}
	}
}

func TestVerifyLocksOutAfterTheFailureBudget(t *testing.T) {
	svc := newPINService(t)
	if err := svc.Set("482913"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	for i := 0; i < pinFailureBudget; i++ {
		if err := svc.Verify("000001", "10.0.0.9"); !errors.Is(err, ErrPINWrong) {
			t.Fatalf("attempt %d = %v, want ErrPINWrong", i+1, err)
		}
	}
	// The very next attempt is refused before any hash compare — and the
	// CORRECT PIN is refused too, which is the point: a locked-out client is
	// locked out, not merely slowed down.
	var locked ErrPINLocked
	if err := svc.Verify("482913", "10.0.0.9"); !errors.As(err, &locked) {
		t.Fatalf("attempt past the budget = %v, want ErrPINLocked", err)
	}
	if locked.RetryAfter <= 0 || locked.RetryAfter > pinLockoutBase {
		t.Errorf("RetryAfter = %v, want (0, %v]", locked.RetryAfter, pinLockoutBase)
	}
}

// One client's failures must not lock anyone else out.
func TestLockoutIsPerClient(t *testing.T) {
	svc := newPINService(t)
	if err := svc.Set("482913"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	for i := 0; i < pinFailureBudget; i++ {
		_ = svc.Verify("000001", "10.0.0.9")
	}
	if err := svc.Verify("482913", "10.0.0.10"); err != nil {
		t.Errorf("a different client = %v, want nil (lockout must not be global)", err)
	}
}

func TestLockoutExpiresAndEscalates(t *testing.T) {
	svc := newPINService(t)
	now := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }
	if err := svc.Set("482913"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	for i := 0; i < pinFailureBudget; i++ {
		_ = svc.Verify("000001", "10.0.0.9")
	}
	now = now.Add(pinLockoutBase + time.Second)
	if err := svc.Verify("482913", "10.0.0.9"); err != nil {
		t.Fatalf("after the lockout expired = %v, want nil", err)
	}

	// A second burst, after waiting the first lockout out and WITHOUT a
	// successful sign-in in between, doubles the window. Note the failures
	// have to be spent after the lock expires: attempts made while locked
	// are refused before they are counted, so hammering never escalates on
	// its own (and never burns a bcrypt compare).
	var locked ErrPINLocked
	for i := 0; i < pinFailureBudget; i++ {
		_ = svc.Verify("000001", "10.0.0.11")
	}
	if err := svc.Verify("000001", "10.0.0.11"); !errors.As(err, &locked) {
		t.Fatalf("after one budget of failures = %v, want ErrPINLocked", err)
	}
	if locked.RetryAfter > pinLockoutBase {
		t.Fatalf("first RetryAfter = %v, want <= %v", locked.RetryAfter, pinLockoutBase)
	}

	now = now.Add(pinLockoutBase + time.Second)
	for i := 0; i < pinFailureBudget; i++ {
		_ = svc.Verify("000001", "10.0.0.11")
	}
	if err := svc.Verify("000001", "10.0.0.11"); !errors.As(err, &locked) {
		t.Fatalf("after two budgets of failures = %v, want ErrPINLocked", err)
	}
	if locked.RetryAfter <= pinLockoutBase {
		t.Errorf("second RetryAfter = %v, want > %v (the window must double)", locked.RetryAfter, pinLockoutBase)
	}
}

// Hammering while locked must not extend the lock — otherwise an attacker
// could hold a client out indefinitely just by continuing to knock.
func TestAttemptsWhileLockedDoNotExtendTheLockout(t *testing.T) {
	svc := newPINService(t)
	now := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }
	if err := svc.Set("482913"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	for i := 0; i < pinFailureBudget; i++ {
		_ = svc.Verify("000001", "10.0.0.9")
	}
	for i := 0; i < 50; i++ {
		_ = svc.Verify("000001", "10.0.0.9")
	}
	now = now.Add(pinLockoutBase + time.Second)
	if err := svc.Verify("482913", "10.0.0.9"); err != nil {
		t.Errorf("after the original window elapsed = %v, want nil", err)
	}
}

// Setting a new PIN must clear lockouts: whoever just proved runtime-key or
// session authority to rotate it should not inherit an attacker's penalty.
func TestSetClearsOutstandingLockouts(t *testing.T) {
	svc := newPINService(t)
	if err := svc.Set("482913"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	for i := 0; i < pinFailureBudget; i++ {
		_ = svc.Verify("000001", "10.0.0.9")
	}
	if err := svc.Set("571904"); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if err := svc.Verify("571904", "10.0.0.9"); err != nil {
		t.Errorf("after rotating the PIN = %v, want nil (lockouts must be cleared)", err)
	}
}

// An unconfigured runtime must not be a free oracle: attempts still count.
func TestVerifyWithNoPINSetIsRateLimitedToo(t *testing.T) {
	svc := newPINService(t)
	for i := 0; i < pinFailureBudget; i++ {
		if err := svc.Verify("482913", "10.0.0.9"); !errors.Is(err, ErrPINNotSet) {
			t.Fatalf("attempt %d = %v, want ErrPINNotSet", i+1, err)
		}
	}
	var locked ErrPINLocked
	if err := svc.Verify("482913", "10.0.0.9"); !errors.As(err, &locked) {
		t.Errorf("attempt past the budget = %v, want ErrPINLocked", err)
	}
}

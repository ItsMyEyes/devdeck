package service

import (
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"

	"devdeck/backend/internal/port"
)

// PINLength is the fixed number of digits in a runtime sign-in PIN.
const PINLength = 6

// Brute-force policy. A 6-digit PIN is only 10^6 combinations, so unlike the
// 32-byte runtime key it cannot stand on secrecy alone — the lockout below is
// load-bearing, not defence in depth. bcryptCost (12) already caps an online
// attacker at a few tries per second per core; the lockout then bounds a
// single client to pinFailureBudget attempts per pinLockoutBase window, and
// doubles that window on every further burst up to pinLockoutMax. At the
// floor of 5 tries per minute, exhausting the keyspace takes ~380 years.
const (
	pinFailureBudget = 5
	pinLockoutBase   = time.Minute
	pinLockoutMax    = 15 * time.Minute
	// pinAttemptTTL is how long an idle attempt record is kept before the
	// next sweep discards it, bounding memory on a runtime that is scanned.
	pinAttemptTTL = time.Hour
)

var (
	// ErrPINFormat means the value wasn't exactly PINLength ASCII digits.
	ErrPINFormat = fmt.Errorf("pin must be exactly %d digits", PINLength)
	// ErrPINNotSet means no PIN has been configured on this process yet.
	ErrPINNotSet = errors.New("no sign-in pin is configured")
	// ErrPINWrong means the PIN didn't match. Deliberately indistinguishable
	// from ErrPINNotSet to callers that surface messages to the browser.
	ErrPINWrong = errors.New("incorrect pin")
	// ErrPINWeak rejects PINs an operator would regret: all-same digits and
	// straight ascending/descending runs. These are the first guesses any
	// attacker makes, and the lockout can't save a PIN of "123456".
	ErrPINWeak = errors.New("pin is too easy to guess")
)

// ErrPINLocked is returned while a client is serving a lockout. RetryAfter is
// how long remains.
type ErrPINLocked struct {
	RetryAfter time.Duration
}

func (e ErrPINLocked) Error() string {
	return fmt.Sprintf("too many attempts; retry in %s", e.RetryAfter.Round(time.Second))
}

type pinAttempts struct {
	fails       int
	lockedUntil time.Time
	seenAt      time.Time
}

// PINService owns the runtime sign-in PIN: a short, memorable credential an
// operator types into a runtime's own web UI, replacing the pasted runtime
// key on that page. It never replaces the runtime key itself — that stays the
// machine-to-machine bearer credential the hub proxies with (see
// handler.MachineProxyHandler), and it is what authorizes changing the PIN.
//
// Only a bcrypt hash is persisted, so a PIN cannot be read back out; an
// operator who forgets theirs sets a new one from the hub (which authenticates
// with the runtime key) or reads the one logged at first boot.
type PINService struct {
	store port.Store

	mu       sync.Mutex
	attempts map[string]*pinAttempts
	// now is swappable in tests; nil means time.Now.
	now func() time.Time
}

// NewPINService creates a PIN service backed by st.
func NewPINService(st port.Store) *PINService {
	return &PINService{store: st, attempts: make(map[string]*pinAttempts)}
}

func (s *PINService) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

// ValidPIN reports whether pin is exactly PINLength ASCII digits.
func ValidPIN(pin string) bool {
	if len(pin) != PINLength {
		return false
	}
	for i := 0; i < len(pin); i++ {
		if pin[i] < '0' || pin[i] > '9' {
			return false
		}
	}
	return true
}

// weakPIN reports whether every digit is identical (000000) or the digits form
// a straight ascending or descending run (123456, 654321). Assumes ValidPIN.
func weakPIN(pin string) bool {
	same, up, down := true, true, true
	for i := 1; i < len(pin); i++ {
		d := int(pin[i]) - int(pin[i-1])
		if d != 0 {
			same = false
		}
		if d != 1 {
			up = false
		}
		if d != -1 {
			down = false
		}
	}
	return same || up || down
}

// Configured reports whether a PIN has been set on this process.
func (s *PINService) Configured() (bool, error) {
	hash, err := s.store.SignInPINHash()
	if err != nil {
		return false, err
	}
	return hash != "", nil
}

// Set replaces the sign-in PIN. Rejects anything that isn't PINLength digits,
// and the handful of runs an attacker guesses first. Clears every outstanding
// lockout: an operator who just proved key-level authority to rotate the PIN
// should not then be locked out by an attacker's earlier failures.
func (s *PINService) Set(pin string) error {
	if !ValidPIN(pin) {
		return ErrPINFormat
	}
	if weakPIN(pin) {
		return ErrPINWeak
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(pin), bcryptCost)
	if err != nil {
		return err
	}
	if err := s.store.SetSignInPINHash(string(hash)); err != nil {
		return err
	}
	s.mu.Lock()
	s.attempts = make(map[string]*pinAttempts)
	s.mu.Unlock()
	return nil
}

// EnsureSeeded sets a freshly generated random PIN when none is configured and
// returns it in the clear, so the caller can print it once to the process log —
// the only moment a PIN is ever recoverable. Returns "" when a PIN already
// exists (the common case on every boot after the first), leaving it untouched.
func (s *PINService) EnsureSeeded() (string, error) {
	configured, err := s.Configured()
	if err != nil || configured {
		return "", err
	}
	pin, err := GeneratePIN()
	if err != nil {
		return "", err
	}
	if err := s.Set(pin); err != nil {
		return "", err
	}
	return pin, nil
}

// GeneratePIN returns a uniformly random PINLength-digit PIN, retrying past the
// few values weakPIN rejects so a seeded PIN is never one Set would refuse.
func GeneratePIN() (string, error) {
	for {
		buf := make([]byte, PINLength)
		for i := range buf {
			n, err := rand.Int(rand.Reader, big.NewInt(10))
			if err != nil {
				return "", err
			}
			buf[i] = byte('0' + n.Int64())
		}
		if pin := string(buf); !weakPIN(pin) {
			return pin, nil
		}
	}
}

// Verify checks pin for the client identified by clientID (an IP string, or ""
// when the caller can't resolve one — all such callers then share one bucket,
// which is the conservative choice). On success the client's failure record is
// cleared; on failure it advances toward, or extends, a lockout.
//
// Returns ErrPINLocked while a lockout is in force — checked BEFORE the hash
// compare, so a locked-out client burns no bcrypt work.
func (s *PINService) Verify(pin, clientID string) error {
	if err := s.checkLock(clientID); err != nil {
		return err
	}
	hash, err := s.store.SignInPINHash()
	if err != nil {
		return err
	}
	if hash == "" {
		// Still counts as a failed attempt: without this an unconfigured
		// runtime is an unmetered oracle.
		s.recordFailure(clientID)
		return ErrPINNotSet
	}
	if !ValidPIN(pin) || bcrypt.CompareHashAndPassword([]byte(hash), []byte(pin)) != nil {
		s.recordFailure(clientID)
		return ErrPINWrong
	}
	s.mu.Lock()
	delete(s.attempts, clientID)
	s.mu.Unlock()
	return nil
}

func (s *PINService) checkLock(clientID string) error {
	now := s.clock()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked(now)
	a := s.attempts[clientID]
	if a == nil {
		return nil
	}
	if now.Before(a.lockedUntil) {
		return ErrPINLocked{RetryAfter: a.lockedUntil.Sub(now)}
	}
	return nil
}

func (s *PINService) recordFailure(clientID string) {
	now := s.clock()
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.attempts[clientID]
	if a == nil {
		a = &pinAttempts{}
		s.attempts[clientID] = a
	}
	a.fails++
	a.seenAt = now
	if a.fails%pinFailureBudget == 0 {
		// Every further budget's worth of failures doubles the window:
		// 1m after 5, 2m after 10, 4m after 15, capped at pinLockoutMax.
		window := pinLockoutBase << (a.fails/pinFailureBudget - 1)
		if window > pinLockoutMax || window <= 0 {
			window = pinLockoutMax
		}
		a.lockedUntil = now.Add(window)
	}
}

// sweepLocked drops records that are both unlocked and idle past pinAttemptTTL.
// Callers must hold s.mu.
func (s *PINService) sweepLocked(now time.Time) {
	for id, a := range s.attempts {
		if now.After(a.lockedUntil) && now.Sub(a.seenAt) > pinAttemptTTL {
			delete(s.attempts, id)
		}
	}
}

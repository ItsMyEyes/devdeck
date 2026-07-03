package service

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"

	"loom/backend/internal/store"
)

func newTestAuthService(t *testing.T) *AuthService {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	key := make([]byte, 32)
	return NewAuthService(store.New(db), key)
}

func TestRegisterCreatesFirstUser(t *testing.T) {
	svc := newTestAuthService(t)
	user, pendingToken, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if user.Email != "owner@example.com" {
		t.Errorf("Email = %q, want owner@example.com", user.Email)
	}
	if user.TotpEnabled {
		t.Error("TotpEnabled = true immediately after registration, want false")
	}
	if pendingToken == "" {
		t.Error("Register returned an empty pending token")
	}
}

func TestRegisterRejectsSecondUser(t *testing.T) {
	svc := newTestAuthService(t)
	if _, _, err := svc.Register("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	_, _, err := svc.Register("intruder@example.com", "another long enough password")
	if !errors.Is(err, ErrConflict) {
		t.Errorf("second Register error = %v, want ErrConflict", err)
	}
}

func TestRegisterRejectsWeakPassword(t *testing.T) {
	svc := newTestAuthService(t)
	_, _, err := svc.Register("owner@example.com", "short1")
	if !errors.Is(err, ErrValidation) {
		t.Errorf("Register with short password error = %v, want ErrValidation", err)
	}
}

func TestTotpEnrollmentRoundTrip(t *testing.T) {
	svc := newTestAuthService(t)
	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	secret, uri, err := svc.BeginTotpEnrollment(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if secret == "" || uri == "" {
		t.Fatal("BeginTotpEnrollment returned an empty secret or URI")
	}
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	backupCodes, err := svc.ConfirmTotpEnrollment(user.ID, code)
	if err != nil {
		t.Fatal(err)
	}
	if len(backupCodes) != backupCodeCount {
		t.Errorf("len(backupCodes) = %d, want %d", len(backupCodes), backupCodeCount)
	}
}

func TestConfirmTotpEnrollmentRejectsWrongCode(t *testing.T) {
	svc := newTestAuthService(t)
	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.BeginTotpEnrollment(user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmTotpEnrollment(user.ID, "000000"); !errors.Is(err, ErrValidation) {
		t.Errorf("ConfirmTotpEnrollment with wrong code error = %v, want ErrValidation", err)
	}
}

func TestLoginRejectsUnknownEmailGenerically(t *testing.T) {
	svc := newTestAuthService(t)
	if _, _, err := svc.Register("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Login("nobody@example.com", "whatever password")
	if !errors.Is(err, ErrUnauthorized) {
		t.Errorf("Login with unknown email error = %v, want ErrUnauthorized", err)
	}
}

func TestLoginLocksAccountAfterFiveFailures(t *testing.T) {
	svc := newTestAuthService(t)
	if _, _, err := svc.Register("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	fakeNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fakeNow }

	for i := 0; i < 5; i++ {
		if _, err := svc.Login("owner@example.com", "wrong password"); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("attempt %d: err = %v, want ErrUnauthorized", i+1, err)
		}
	}
	if _, err := svc.Login("owner@example.com", "wrong password"); !errors.Is(err, ErrLocked) {
		t.Fatalf("6th attempt err = %v, want ErrLocked", err)
	}
}

func TestLoginUnlocksAfterLockoutDurationPasses(t *testing.T) {
	svc := newTestAuthService(t)
	if _, _, err := svc.Register("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	fakeNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fakeNow }
	for i := 0; i < 5; i++ {
		_, _ = svc.Login("owner@example.com", "wrong password")
	}
	fakeNow = fakeNow.Add(6 * time.Minute) // past the 5-minute base lockout
	if _, err := svc.Login("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatalf("Login after lockout expired = %v, want nil", err)
	}
}

func TestLoginEscalatesLockoutDurationOnRepeatedLockouts(t *testing.T) {
	svc := newTestAuthService(t)
	if _, _, err := svc.Register("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	fakeNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fakeNow }

	for i := 0; i < 5; i++ { // first lockout: 5 minutes
		_, _ = svc.Login("owner@example.com", "wrong password")
	}
	fakeNow = fakeNow.Add(5*time.Minute + time.Second) // first lockout just expired

	for i := 0; i < 5; i++ { // second lockout: should now be 10 minutes
		_, _ = svc.Login("owner@example.com", "wrong password")
	}
	fakeNow = fakeNow.Add(9 * time.Minute) // still within the escalated 10-minute lock
	if _, err := svc.Login("owner@example.com", "correct horse battery staple"); !errors.Is(err, ErrLocked) {
		t.Fatalf("err = %v, want ErrLocked (escalated lockout should still be active)", err)
	}
	fakeNow = fakeNow.Add(2 * time.Minute) // now past the 10-minute escalated lock
	if _, err := svc.Login("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatalf("Login after escalated lockout expired = %v, want nil", err)
	}
}

func TestLoginResetsLockoutLevelOnSuccess(t *testing.T) {
	svc := newTestAuthService(t)
	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	fakeNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fakeNow }
	for i := 0; i < 5; i++ {
		_, _ = svc.Login("owner@example.com", "wrong password")
	}
	fakeNow = fakeNow.Add(6 * time.Minute)
	if _, err := svc.Login("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	updated, err := svc.store.UserByID(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.LockoutLevel != 0 {
		t.Errorf("LockoutLevel after successful login = %d, want 0", updated.LockoutLevel)
	}
}

func TestLockoutLevelDecaysAfter24HoursOfNoFailures(t *testing.T) {
	svc := newTestAuthService(t)
	if _, _, err := svc.Register("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	fakeNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fakeNow }

	for i := 0; i < 5; i++ { // first lockout escalates LockoutLevel to 1
		_, _ = svc.Login("owner@example.com", "wrong password")
	}
	fakeNow = fakeNow.Add(25 * time.Hour) // 25 hours of silence before failing again
	for i := 0; i < 5; i++ {
		_, _ = svc.Login("owner@example.com", "wrong password")
	}
	// If the ladder decayed back to level 0, this second lockout is 5
	// minutes, not the escalated 10 — so 6 minutes later it's unlocked.
	fakeNow = fakeNow.Add(6 * time.Minute)
	if _, err := svc.Login("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatalf("Login after decayed lockout expired = %v, want nil", err)
	}
}

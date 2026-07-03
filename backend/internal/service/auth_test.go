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

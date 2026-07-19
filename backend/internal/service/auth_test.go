package service

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"

	"devdeck/backend/internal/store"
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

func TestFullLoginFlowIssuesWorkingSession(t *testing.T) {
	svc := newTestAuthService(t)
	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	secret, _, err := svc.BeginTotpEnrollment(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	setupCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmTotpEnrollment(user.ID, setupCode); err != nil {
		t.Fatal(err)
	}

	loginPendingToken, err := svc.Login("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	loginCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	sessionToken, loggedInUser, err := svc.VerifyTotp(loginPendingToken, loginCode)
	if err != nil {
		t.Fatal(err)
	}
	if loggedInUser.Email != "owner@example.com" {
		t.Errorf("Email = %q, want owner@example.com", loggedInUser.Email)
	}
	current, err := svc.CurrentUser(sessionToken)
	if err != nil {
		t.Fatal(err)
	}
	if current.ID != user.ID {
		t.Errorf("CurrentUser ID = %q, want %q", current.ID, user.ID)
	}
}

func TestBackupCodeLoginIsSingleUse(t *testing.T) {
	svc := newTestAuthService(t)
	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	secret, _, err := svc.BeginTotpEnrollment(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	setupCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	backupCodes, err := svc.ConfirmTotpEnrollment(user.ID, setupCode)
	if err != nil {
		t.Fatal(err)
	}

	pendingToken, err := svc.Login("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.VerifyTotp(pendingToken, backupCodes[0]); err != nil {
		t.Fatalf("first use of backup code failed: %v", err)
	}

	pendingToken2, err := svc.Login("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.VerifyTotp(pendingToken2, backupCodes[0]); !errors.Is(err, ErrValidation) {
		t.Errorf("second use of the same backup code err = %v, want ErrValidation", err)
	}
}

func TestLogoutInvalidatesSession(t *testing.T) {
	svc := newTestAuthService(t)
	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	secret, _, err := svc.BeginTotpEnrollment(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	setupCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmTotpEnrollment(user.ID, setupCode); err != nil {
		t.Fatal(err)
	}
	pendingToken, err := svc.Login("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	loginCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	sessionToken, _, err := svc.VerifyTotp(pendingToken, loginCode)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Logout(sessionToken); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CurrentUser(sessionToken); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("CurrentUser after logout err = %v, want ErrUnauthorized", err)
	}
}

func TestCompleteLoginRefusedWhile2FARequired(t *testing.T) {
	svc := newTestAuthService(t)
	if !svc.TOTPRequired() {
		t.Fatal("2FA should be required by default")
	}
	_, pendingToken, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.CompleteLogin(pendingToken); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("CompleteLogin with 2FA required err = %v, want ErrUnauthorized", err)
	}
}

func TestCompleteLoginIssuesSessionWhen2FADisabled(t *testing.T) {
	svc := newTestAuthService(t)
	svc.SetTOTPRequired(false)
	if _, _, err := svc.Register("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	pendingToken, err := svc.Login("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	sessionToken, user, err := svc.CompleteLogin(pendingToken)
	if err != nil {
		t.Fatal(err)
	}
	if user.Email != "owner@example.com" {
		t.Errorf("Email = %q, want owner@example.com", user.Email)
	}
	if _, err := svc.CurrentUser(sessionToken); err != nil {
		t.Errorf("session from CompleteLogin is not valid: %v", err)
	}
	// The pending token must be consumed.
	if _, _, err := svc.CompleteLogin(pendingToken); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("reusing pending token err = %v, want ErrUnauthorized", err)
	}
}

func TestCompleteLoginRejectsBogusToken(t *testing.T) {
	svc := newTestAuthService(t)
	svc.SetTOTPRequired(false)
	if _, _, err := svc.CompleteLogin("bogus"); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("CompleteLogin with bogus token err = %v, want ErrUnauthorized", err)
	}
}

func TestKeySessionCreatesDesktopOperatorOnFirstRun(t *testing.T) {
	svc := newTestAuthService(t)

	token, user, err := svc.KeySession()
	if err != nil {
		t.Fatalf("KeySession: %v", err)
	}
	if user.Email != "operator@devdeck.desktop" {
		t.Fatalf("email = %q, want operator@devdeck.desktop", user.Email)
	}
	got, err := svc.CurrentUser(token)
	if err != nil || got.ID != user.ID {
		t.Fatalf("CurrentUser(token) = %+v, %v; want the operator user", got, err)
	}
}

func TestKeySessionReusesExistingDesktopOperator(t *testing.T) {
	svc := newTestAuthService(t)

	_, first, err := svc.KeySession()
	if err != nil {
		t.Fatal(err)
	}
	token2, second, err := svc.KeySession()
	if err != nil {
		t.Fatalf("second KeySession: %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("second call created a new user: %s != %s", second.ID, first.ID)
	}
	if _, err := svc.CurrentUser(token2); err != nil {
		t.Fatalf("second session invalid: %v", err)
	}
}

func TestKeySessionRejectsForeignOperatorAccount(t *testing.T) {
	svc := newTestAuthService(t)

	if _, _, err := svc.Register("me@example.com", "sufficiently-long-password"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.KeySession(); !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
}

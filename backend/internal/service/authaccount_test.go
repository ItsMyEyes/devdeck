package service

import (
	"errors"
	"testing"

	"devdeck/backend/internal/domain"
)

func TestUpdateAccountSetsEmailAndPasswordOnBootstrapAccount(t *testing.T) {
	svc := newTestAuthService(t)
	svc.SetTOTPRequired(false)

	_, user, err := svc.KeySession()
	if err != nil {
		t.Fatal(err)
	}
	if user.Email != domain.DesktopOperatorEmail {
		t.Fatalf("bootstrap email = %q, want %q", user.Email, domain.DesktopOperatorEmail)
	}
	if user.PasswordSet {
		t.Fatal("bootstrap account reports passwordSet = true; the throwaway password was never shown to anyone")
	}

	// No CurrentPassword: there is none the operator could know.
	updated, err := svc.UpdateAccount(user.ID, AccountUpdate{
		Email:    strPtr("owner@example.com"),
		Password: strPtr("correct horse battery staple"),
	})
	if err != nil {
		t.Fatalf("UpdateAccount: %v", err)
	}
	if updated.Email != "owner@example.com" {
		t.Errorf("email = %q, want owner@example.com", updated.Email)
	}
	if !updated.PasswordSet {
		t.Error("passwordSet = false after choosing a password")
	}

	// The whole point: the new credentials work at the normal login door.
	if _, err := svc.Login("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatalf("Login with the new credentials: %v", err)
	}
}

func TestKeySessionSurvivesAccountRename(t *testing.T) {
	svc := newTestAuthService(t)

	_, user, err := svc.KeySession()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateAccount(user.ID, AccountUpdate{Email: strPtr("owner@example.com")}); err != nil {
		t.Fatal(err)
	}

	// The desktop shell bootstraps through KeySession on every launch; a
	// rename must not cost it its way back in.
	token, after, err := svc.KeySession()
	if err != nil {
		t.Fatalf("KeySession after rename: %v", err)
	}
	if after.ID != user.ID {
		t.Fatalf("KeySession returned a different account: %s != %s", after.ID, user.ID)
	}
	if _, err := svc.CurrentUser(token); err != nil {
		t.Fatalf("session from the post-rename KeySession is invalid: %v", err)
	}
}

func TestUpdateAccountRequiresCurrentPasswordOnceSet(t *testing.T) {
	svc := newTestAuthService(t)
	svc.SetTOTPRequired(false)

	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !user.PasswordSet {
		t.Fatal("a registered account should report passwordSet = true")
	}

	if _, err := svc.UpdateAccount(user.ID, AccountUpdate{Password: strPtr("a whole new passphrase")}); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("missing current password: err = %v, want ErrUnauthorized", err)
	}
	if _, err := svc.UpdateAccount(user.ID, AccountUpdate{
		Password:        strPtr("a whole new passphrase"),
		CurrentPassword: "not the password",
	}); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("wrong current password: err = %v, want ErrUnauthorized", err)
	}

	if _, err := svc.UpdateAccount(user.ID, AccountUpdate{
		Password:        strPtr("a whole new passphrase"),
		CurrentPassword: "correct horse battery staple",
	}); err != nil {
		t.Fatalf("UpdateAccount with the right current password: %v", err)
	}
	if _, err := svc.Login("owner@example.com", "a whole new passphrase"); err != nil {
		t.Fatalf("Login with the new password: %v", err)
	}
	if _, err := svc.Login("owner@example.com", "correct horse battery staple"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("the old password still logs in: err = %v", err)
	}
}

func TestUpdateAccountRejectsWeakPasswordAndBadEmail(t *testing.T) {
	svc := newTestAuthService(t)

	_, user, err := svc.KeySession()
	if err != nil {
		t.Fatal(err)
	}
	for name, up := range map[string]AccountUpdate{
		"short password":  {Password: strPtr("short")},
		"common password": {Password: strPtr("password1234")},
		"blank email":     {Email: strPtr("   ")},
		"no at sign":      {Email: strPtr("owner.example.com")},
		"trailing at":     {Email: strPtr("owner@")},
		"embedded space":  {Email: strPtr("owner name@example.com")},
	} {
		if _, err := svc.UpdateAccount(user.ID, up); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: err = %v, want ErrValidation", name, err)
		}
	}
	if _, err := svc.UpdateAccount(user.ID, AccountUpdate{}); !errors.Is(err, ErrValidation) {
		t.Errorf("empty update: err = %v, want ErrValidation", err)
	}
}

func TestUpdateAccountTrimsEmail(t *testing.T) {
	svc := newTestAuthService(t)

	_, user, err := svc.KeySession()
	if err != nil {
		t.Fatal(err)
	}
	updated, err := svc.UpdateAccount(user.ID, AccountUpdate{Email: strPtr("  owner@example.com  ")})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Email != "owner@example.com" {
		t.Errorf("email = %q, want it trimmed to owner@example.com", updated.Email)
	}
}

func TestRevokeOtherSessionsKeepsTheCaller(t *testing.T) {
	svc := newTestAuthService(t)

	keep, user, err := svc.KeySession()
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := svc.KeySession()
	if err != nil {
		t.Fatal(err)
	}

	if err := svc.RevokeOtherSessions(user.ID, keep); err != nil {
		t.Fatalf("RevokeOtherSessions: %v", err)
	}
	if _, err := svc.CurrentUser(keep); err != nil {
		t.Errorf("the calling session was revoked: %v", err)
	}
	if _, err := svc.CurrentUser(other); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("the other session survived: err = %v, want ErrUnauthorized", err)
	}
}

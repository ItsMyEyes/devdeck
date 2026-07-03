package store

import (
	"testing"

	"loom/backend/internal/port"
)

func TestCreateUserPersistsWithDefaults(t *testing.T) {
	s := newTestStore(t)
	u, err := s.CreateUser("owner@example.com", "hashed-password", "2026-01-01T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if u.ID == "" {
		t.Fatal("CreateUser returned an empty ID")
	}
	if u.Email != "owner@example.com" || u.PasswordHash != "hashed-password" {
		t.Errorf("CreateUser = %+v, want Email=owner@example.com PasswordHash=hashed-password", u)
	}
	if u.TotpEnabled {
		t.Error("TotpEnabled = true for a freshly created user, want false")
	}
	if len(u.BackupCodeHashes) != 0 {
		t.Errorf("BackupCodeHashes = %v, want empty", u.BackupCodeHashes)
	}
}

func TestUserByEmailAndUserCount(t *testing.T) {
	s := newTestStore(t)
	if n, err := s.UserCount(); err != nil || n != 0 {
		t.Fatalf("UserCount before any user = (%d, %v), want (0, nil)", n, err)
	}
	created, err := s.CreateUser("owner@example.com", "hash", "2026-01-01T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	found, err := s.UserByEmail("owner@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if found.ID != created.ID {
		t.Errorf("UserByEmail ID = %q, want %q", found.ID, created.ID)
	}
	if n, err := s.UserCount(); err != nil || n != 1 {
		t.Fatalf("UserCount after one user = (%d, %v), want (1, nil)", n, err)
	}
	if _, err := s.UserByEmail("nobody@example.com"); err != ErrNotFound {
		t.Errorf("UserByEmail for unknown email = %v, want ErrNotFound", err)
	}
}

func TestUpdateUserAppliesPartialPatch(t *testing.T) {
	s := newTestStore(t)
	u, err := s.CreateUser("owner@example.com", "hash", "2026-01-01T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}

	secret := "encrypted-secret"
	updated, err := s.UpdateUser(u.ID, port.UserPatch{TotpSecretEnc: &secret})
	if err != nil {
		t.Fatal(err)
	}
	if updated.TotpSecretEnc != "encrypted-secret" {
		t.Errorf("TotpSecretEnc = %q, want encrypted-secret", updated.TotpSecretEnc)
	}
	if updated.Email != "owner@example.com" {
		t.Errorf("UpdateUser changed Email to %q, want it unchanged", updated.Email)
	}

	enabled := true
	codes := []string{"hash1", "hash2"}
	updated, err = s.UpdateUser(u.ID, port.UserPatch{TotpEnabled: &enabled, BackupCodeHashes: &codes})
	if err != nil {
		t.Fatal(err)
	}
	if !updated.TotpEnabled {
		t.Error("TotpEnabled = false, want true")
	}
	if len(updated.BackupCodeHashes) != 2 || updated.BackupCodeHashes[0] != "hash1" {
		t.Errorf("BackupCodeHashes = %v, want [hash1 hash2]", updated.BackupCodeHashes)
	}

	lockedUntil := "2026-01-01T00:05:00Z"
	updated, err = s.UpdateUser(u.ID, port.UserPatch{LockedUntil: &lockedUntil, HasLockedUntil: true})
	if err != nil {
		t.Fatal(err)
	}
	if updated.LockedUntil == nil || *updated.LockedUntil != lockedUntil {
		t.Errorf("LockedUntil = %v, want %q", updated.LockedUntil, lockedUntil)
	}

	updated, err = s.UpdateUser(u.ID, port.UserPatch{LockedUntil: nil, HasLockedUntil: true})
	if err != nil {
		t.Fatal(err)
	}
	if updated.LockedUntil != nil {
		t.Errorf("LockedUntil after explicit clear = %v, want nil", updated.LockedUntil)
	}
}

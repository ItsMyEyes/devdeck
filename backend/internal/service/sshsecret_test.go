package service

import (
	"path/filepath"
	"testing"

	"loom/backend/internal/store"
)

func newTestSSHSecretService(t *testing.T) (*SSHSecretService, *store.Store) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	key := make([]byte, 32) // all-zero is a valid AES-256 key for tests
	return NewSSHSecretService(st, key), st
}

func TestSSHSecretRoundtrip(t *testing.T) {
	svc, st := newTestSSHSecretService(t)
	c, err := st.CreateSSHConnection("a", "h", 22, "u", "password")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Set(c.ID, "password", "hunter2"); err != nil {
		t.Fatal(err)
	}
	got, ok, err := svc.Get(c.ID, "password")
	if err != nil || !ok || got != "hunter2" {
		t.Errorf("Get = (%q, %v, %v), want (hunter2, true, nil)", got, ok, err)
	}
	// The stored row must be ciphertext, not the plaintext.
	sec, err := st.SSHSecret(c.ID, "password")
	if err != nil {
		t.Fatal(err)
	}
	if sec.CipherText == "hunter2" || sec.CipherText == "" {
		t.Errorf("cipherText = %q, must be encrypted and non-empty", sec.CipherText)
	}
}

func TestSSHSecretGetMissingKind(t *testing.T) {
	svc, st := newTestSSHSecretService(t)
	c, _ := st.CreateSSHConnection("a", "h", 22, "u", "password")
	_, ok, err := svc.Get(c.ID, "passphrase")
	if err != nil || ok {
		t.Errorf("Get missing = (ok=%v, err=%v), want (false, nil)", ok, err)
	}
}

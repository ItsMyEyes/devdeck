package service

import (
	"path/filepath"
	"strings"
	"testing"

	"devdeck/backend/internal/store"
)

// newTestStore and testMasterKey are local to this file: the service package
// has no shared test-construction helper (each *_test.go file — e.g.
// sshsecret_test.go's newTestSSHSecretService, auth_test.go's
// newTestAuthService — defines its own store.Open/store.New + key inline).
func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return store.New(db)
}

func testMasterKey(t *testing.T) []byte {
	t.Helper()
	return make([]byte, 32) // all-zero is a valid AES-256 key for tests
}

// newTestDBConnection creates a real db_connections row and returns its ID.
// db_secrets.connection_id is a foreign key (ON DELETE CASCADE) enforced via
// PRAGMA foreign_keys = ON, so tests that store a secret must reference a
// connection that actually exists rather than an arbitrary literal ID.
func newTestDBConnection(t *testing.T, st *store.Store) string {
	t.Helper()
	c, err := st.CreateDBConnection("staging", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)
	if err != nil {
		t.Fatalf("create test db connection: %v", err)
	}
	return c.ID
}

func TestDBSecretRoundTrip(t *testing.T) {
	st := newTestStore(t)
	key := testMasterKey(t)
	svc := NewDBSecretService(st, key)
	connID := newTestDBConnection(t, st)

	if err := svc.Set(connID, "password", "s3cret"); err != nil {
		t.Fatalf("set: %v", err)
	}
	got, ok, err := svc.Get(connID, "password")
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got != "s3cret" {
		t.Fatalf("got %q, want %q", got, "s3cret")
	}
}

func TestDBSecretMissingReturnsNotOkWithoutError(t *testing.T) {
	st := newTestStore(t)
	svc := NewDBSecretService(st, testMasterKey(t))
	connID := newTestDBConnection(t, st)
	got, ok, err := svc.Get(connID, "password")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok || got != "" {
		t.Fatalf("got %q ok=%v, want empty/false", got, ok)
	}
}

func TestDBSecretIsEncryptedAtRest(t *testing.T) {
	st := newTestStore(t)
	svc := NewDBSecretService(st, testMasterKey(t))
	connID := newTestDBConnection(t, st)
	if err := svc.Set(connID, "password", "s3cret"); err != nil {
		t.Fatalf("set: %v", err)
	}
	row, err := st.DBSecretRow(connID, "password")
	if err != nil {
		t.Fatalf("read row: %v", err)
	}
	if strings.Contains(row.CipherText, "s3cret") {
		t.Fatal("plaintext password found in stored cipher_text")
	}
}

func TestDBSecretClearRemovesValue(t *testing.T) {
	st := newTestStore(t)
	svc := NewDBSecretService(st, testMasterKey(t))
	connID := newTestDBConnection(t, st)
	if err := svc.Set(connID, "password", "s3cret"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if err := svc.Clear(connID, "password"); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if _, ok, _ := svc.Get(connID, "password"); ok {
		t.Fatal("secret still present after Clear")
	}
}

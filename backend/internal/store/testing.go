package store

import (
	"path/filepath"
	"testing"
)

// NewTestStore opens a throwaway store backed by a temp-dir SQLite file, for
// use by tests in other packages (e.g. internal/handler).
func NewTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return New(db)
}

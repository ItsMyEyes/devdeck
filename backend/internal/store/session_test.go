package store

import (
	"testing"
	"time"
)

func TestSessionLifecycle(t *testing.T) {
	s := newTestStore(t)
	u, err := s.CreateUser("owner@example.com", "hash", "2026-01-01T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	if err := s.CreateSession(u.ID, "session-hash", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	userID, err := s.SessionUserID("session-hash", now)
	if err != nil {
		t.Fatal(err)
	}
	if userID != u.ID {
		t.Errorf("SessionUserID = %q, want %q", userID, u.ID)
	}

	// Expired session is treated as not found.
	if _, err := s.SessionUserID("session-hash", now.Add(2*time.Hour)); err != ErrNotFound {
		t.Errorf("SessionUserID after expiry = %v, want ErrNotFound", err)
	}

	// Recreate and explicitly delete.
	if err := s.CreateSession(u.ID, "session-hash-2", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteSession("session-hash-2"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SessionUserID("session-hash-2", now); err != ErrNotFound {
		t.Errorf("SessionUserID after DeleteSession = %v, want ErrNotFound", err)
	}
}

func TestPendingLoginLifecycle(t *testing.T) {
	s := newTestStore(t)
	u, err := s.CreateUser("owner@example.com", "hash", "2026-01-01T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	if err := s.CreatePendingLogin(u.ID, "pending-hash", now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	userID, err := s.PendingLoginUserID("pending-hash", now)
	if err != nil {
		t.Fatal(err)
	}
	if userID != u.ID {
		t.Errorf("PendingLoginUserID = %q, want %q", userID, u.ID)
	}
	if _, err := s.PendingLoginUserID("pending-hash", now.Add(3*time.Minute)); err != ErrNotFound {
		t.Errorf("PendingLoginUserID after expiry = %v, want ErrNotFound", err)
	}

	if err := s.CreatePendingLogin(u.ID, "pending-hash-2", now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := s.DeletePendingLogin("pending-hash-2"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PendingLoginUserID("pending-hash-2", now); err != ErrNotFound {
		t.Errorf("PendingLoginUserID after DeletePendingLogin = %v, want ErrNotFound", err)
	}
}

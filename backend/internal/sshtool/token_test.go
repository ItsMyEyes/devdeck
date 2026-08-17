package sshtool

import "testing"

func TestMintAndLookup(t *testing.T) {
	s := NewTokenStore()
	tok := s.Mint("ssh:c-1", "c-1")
	if len(tok) < 32 {
		t.Fatalf("token too short: %q", tok)
	}
	sess, ok := s.Lookup(tok)
	if !ok || sess.ThreadID != "ssh:c-1" || sess.ConnectionID != "c-1" {
		t.Fatalf("Lookup = %+v, %v", sess, ok)
	}
}

func TestMintReplacesPreviousTokenForThread(t *testing.T) {
	s := NewTokenStore()
	old := s.Mint("ssh:c-1", "c-1")
	fresh := s.Mint("ssh:c-1", "c-1")
	if old == fresh {
		t.Fatal("re-mint returned the same token")
	}
	if _, ok := s.Lookup(old); ok {
		t.Fatal("old token still valid after re-mint")
	}
	if _, ok := s.Lookup(fresh); !ok {
		t.Fatal("fresh token not valid")
	}
}

func TestRevokeThread(t *testing.T) {
	s := NewTokenStore()
	tok := s.Mint("ssh:c-1", "c-1")
	s.RevokeThread("ssh:c-1")
	if _, ok := s.Lookup(tok); ok {
		t.Fatal("token survived revocation")
	}
}

func TestLookupUnknownToken(t *testing.T) {
	if _, ok := NewTokenStore().Lookup("whatever"); ok {
		t.Fatal("unknown token accepted")
	}
}

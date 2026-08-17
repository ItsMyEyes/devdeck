package sshtool

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
)

// Session identifies which SSH thread and connection a thread token
// authenticates. It is what TokenStore.Lookup resolves a token to.
type Session struct {
	ThreadID     string
	ConnectionID string
}

// TokenStore is an in-memory map of thread tokens for the local
// `/api/agent-tools/ssh/*` HTTP API. Tokens are process-lifetime only: they
// are minted fresh whenever an SSH chat thread's agent session starts and
// are never written to disk, so there is nothing to persist and no schema
// to migrate — a process restart simply invalidates every outstanding
// token, and the next session start mints new ones.
type TokenStore struct {
	mu       sync.RWMutex
	tokens   map[string]Session // token -> session
	byThread map[string]string  // threadID -> current token
}

// NewTokenStore returns an empty TokenStore.
func NewTokenStore() *TokenStore {
	return &TokenStore{
		tokens:   make(map[string]Session),
		byThread: make(map[string]string),
	}
}

// Mint generates a fresh random token bound to threadID and connectionID,
// discarding any token previously minted for that thread so at most one
// token is ever valid per thread.
func (s *TokenStore) Mint(threadID, connectionID string) string {
	token := newTokenHex()

	s.mu.Lock()
	defer s.mu.Unlock()

	if old, ok := s.byThread[threadID]; ok {
		delete(s.tokens, old)
	}
	s.tokens[token] = Session{ThreadID: threadID, ConnectionID: connectionID}
	s.byThread[threadID] = token
	return token
}

// Lookup resolves a token back to its Session. ok is false for an unknown
// or revoked token.
func (s *TokenStore) Lookup(token string) (Session, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sess, ok := s.tokens[token]
	return sess, ok
}

// RevokeThread invalidates whatever token is currently held by threadID, if
// any.
func (s *TokenStore) RevokeThread(threadID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if tok, ok := s.byThread[threadID]; ok {
		delete(s.tokens, tok)
		delete(s.byThread, threadID)
	}
}

// newTokenHex returns a 64-character hex-encoded random identifier (32
// bytes from crypto/rand). It carries no cryptographic meaning beyond
// being unguessable — it is a session identifier, not a signed credential.
func newTokenHex() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand.Read only fails if the OS entropy source is
		// unavailable, which is unrecoverable for a security-sensitive
		// identifier; there is no safe fallback.
		panic("sshtool: crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(buf)
}

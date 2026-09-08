package store

import "time"

// CreateSession persists a new session row keyed by the SHA-256 hash of the
// opaque session token (never the raw token).
func (s *Store) CreateSession(userID, tokenHash string, expiresAt time.Time) error {
	_, err := s.db.Exec(
		`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
		tokenHash, userID, expiresAt.UTC().Format(time.RFC3339), time.Now().UTC().Format(time.RFC3339),
	)
	return err
}

// SessionUserID resolves a session token hash to its user ID, treating an
// expired session as not found (and deleting it).
func (s *Store) SessionUserID(tokenHash string, now time.Time) (string, error) {
	var userID, expiresAt string
	err := s.db.QueryRow(`SELECT user_id, expires_at FROM sessions WHERE id = ?`, tokenHash).
		Scan(&userID, &expiresAt)
	if err != nil {
		return "", mapNotFound(err)
	}
	exp, err := time.Parse(time.RFC3339, expiresAt)
	if err != nil {
		return "", err
	}
	if !now.Before(exp) {
		_ = s.DeleteSession(tokenHash)
		return "", ErrNotFound
	}
	return userID, nil
}

// DeleteUserSessionsExcept revokes every session belonging to a user apart
// from keepTokenHash. A credential change calls it so the browser that made
// the change stays signed in while any other session — including one an
// attacker holds — is invalidated on the spot.
func (s *Store) DeleteUserSessionsExcept(userID, keepTokenHash string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE user_id = ? AND id != ?`, userID, keepTokenHash)
	return err
}

// DeleteSession removes a session row (logout, or lazy expiry cleanup).
func (s *Store) DeleteSession(tokenHash string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE id = ?`, tokenHash)
	return err
}

// CreatePendingLogin persists a short-lived pending-login row keyed by the
// SHA-256 hash of the opaque pending token.
func (s *Store) CreatePendingLogin(userID, tokenHash string, expiresAt time.Time) error {
	_, err := s.db.Exec(
		`INSERT INTO pending_logins (id, user_id, expires_at) VALUES (?, ?, ?)`,
		tokenHash, userID, expiresAt.UTC().Format(time.RFC3339),
	)
	return err
}

// PendingLoginUserID resolves a pending-login token hash to its user ID,
// treating an expired entry as not found (and deleting it).
func (s *Store) PendingLoginUserID(tokenHash string, now time.Time) (string, error) {
	var userID, expiresAt string
	err := s.db.QueryRow(`SELECT user_id, expires_at FROM pending_logins WHERE id = ?`, tokenHash).
		Scan(&userID, &expiresAt)
	if err != nil {
		return "", mapNotFound(err)
	}
	exp, err := time.Parse(time.RFC3339, expiresAt)
	if err != nil {
		return "", err
	}
	if !now.Before(exp) {
		_ = s.DeletePendingLogin(tokenHash)
		return "", ErrNotFound
	}
	return userID, nil
}

// DeletePendingLogin removes a pending-login row once it's been consumed.
func (s *Store) DeletePendingLogin(tokenHash string) error {
	_, err := s.db.Exec(`DELETE FROM pending_logins WHERE id = ?`, tokenHash)
	return err
}

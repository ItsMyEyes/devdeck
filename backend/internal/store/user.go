package store

import (
	"database/sql"
	"encoding/json"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

const userColumns = `id, email, password_hash, totp_secret_enc, totp_enabled, backup_code_hashes,
	failed_attempts, lockout_level, locked_until, last_failed_at, password_set, desktop_operator, created_at`

func scanUser(sc scanner) (domain.User, error) {
	var u domain.User
	var totpEnabled, passwordSet, desktopOperator int
	var backupCodesJSON string
	var lockedUntil, lastFailedAt sql.NullString
	err := sc.Scan(&u.ID, &u.Email, &u.PasswordHash, &u.TotpSecretEnc, &totpEnabled, &backupCodesJSON,
		&u.FailedAttempts, &u.LockoutLevel, &lockedUntil, &lastFailedAt, &passwordSet, &desktopOperator, &u.CreatedAt)
	if err != nil {
		return u, err
	}
	u.TotpEnabled = totpEnabled != 0
	u.PasswordSet = passwordSet != 0
	u.DesktopOperator = desktopOperator != 0
	if err := json.Unmarshal([]byte(backupCodesJSON), &u.BackupCodeHashes); err != nil {
		return u, err
	}
	if lockedUntil.Valid {
		v := lockedUntil.String
		u.LockedUntil = &v
	}
	if lastFailedAt.Valid {
		v := lastFailedAt.String
		u.LastFailedAt = &v
	}
	return u, nil
}

func (s *Store) userByID(id string) (domain.User, error) {
	u, err := scanUser(s.db.QueryRow(`SELECT `+userColumns+` FROM users WHERE id = ?`, id))
	if err != nil {
		return domain.User{}, mapNotFound(err)
	}
	return u, nil
}

// UserByID looks up a user by ID.
func (s *Store) UserByID(id string) (domain.User, error) {
	return s.userByID(id)
}

// UserByEmail looks up a user by email.
func (s *Store) UserByEmail(email string) (domain.User, error) {
	u, err := scanUser(s.db.QueryRow(`SELECT `+userColumns+` FROM users WHERE email = ?`, email))
	if err != nil {
		return domain.User{}, mapNotFound(err)
	}
	return u, nil
}

// DesktopOperatorUser returns the account KeySession auto-created for the
// desktop shell, whatever the operator has since renamed it to. Not found when
// this hub's only account was registered by hand.
func (s *Store) DesktopOperatorUser() (domain.User, error) {
	u, err := scanUser(s.db.QueryRow(
		`SELECT ` + userColumns + ` FROM users WHERE desktop_operator = 1 ORDER BY created_at, id LIMIT 1`))
	if err != nil {
		return domain.User{}, mapNotFound(err)
	}
	return u, nil
}

// UserCount returns the number of registered users (0 or 1 in the
// single-operator model; the service layer enforces the cap).
func (s *Store) UserCount() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// CreateUser creates a new user with default (unenrolled, unlocked) auth state.
func (s *Store) CreateUser(email, passwordHash, createdAt string) (domain.User, error) {
	id := idGen("u-")
	if _, err := s.db.Exec(
		`INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
		id, email, passwordHash, createdAt,
	); err != nil {
		return domain.User{}, err
	}
	return s.userByID(id)
}

// UpdateUser applies a partial patch to a user's auth state.
func (s *Store) UpdateUser(id string, p port.UserPatch) (domain.User, error) {
	if _, err := s.userByID(id); err != nil {
		return domain.User{}, err
	}
	if err := firstErr(
		setStr(s.db, "users", "email", id, p.Email),
		setStr(s.db, "users", "password_hash", id, p.PasswordHash),
		setBool(s.db, "users", "password_set", id, p.PasswordSet),
		setBool(s.db, "users", "desktop_operator", id, p.DesktopOperator),
		setStr(s.db, "users", "totp_secret_enc", id, p.TotpSecretEnc),
		setBool(s.db, "users", "totp_enabled", id, p.TotpEnabled),
		setJSONStrSlice(s.db, "users", "backup_code_hashes", id, p.BackupCodeHashes),
		setInt(s.db, "users", "failed_attempts", id, p.FailedAttempts),
		setInt(s.db, "users", "lockout_level", id, p.LockoutLevel),
		setStr(s.db, "users", "last_failed_at", id, p.LastFailedAt),
	); err != nil {
		return domain.User{}, err
	}
	if p.HasLockedUntil {
		if _, err := s.db.Exec(`UPDATE users SET locked_until = ? WHERE id = ?`, p.LockedUntil, id); err != nil {
			return domain.User{}, err
		}
	}
	return s.userByID(id)
}

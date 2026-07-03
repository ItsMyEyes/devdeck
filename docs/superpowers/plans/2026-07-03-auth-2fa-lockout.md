# Authentication + TOTP 2FA + Escalating Lockout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mandatory email/password registration (single operator), mandatory TOTP 2FA, server-side session-cookie auth, and an escalating per-account lockout after repeated failed logins — gating every existing `/api/*` route and the `/ws/terminal` WebSocket.

**Architecture:** Follows the existing `handler → service → store (port.Store)` layering. New `AuthService` owns password hashing (bcrypt), TOTP (RFC 6238 via `pquerna/otp`), AES-GCM-encrypted TOTP secrets, and the lockout escalation math (testable via an injectable clock). New `users`/`sessions`/`pending_logins` SQLite tables. A `RequireAuth` middleware wraps the whole mux except a small public-path allowlist.

**Tech Stack:** Go 1.25 stdlib `net/http`, `golang.org/x/crypto/bcrypt` (already transitively vendored), `github.com/pquerna/otp` (new), SQLite via `modernc.org/sqlite`. Frontend: React 19, TanStack Router, `@tanstack/react-query`, `qrcode` (new) for client-side QR rendering.

## Global Constraints

- Single operator only: `POST /api/auth/register` is rejected with 409 once one user exists.
- Session auth via `HttpOnly; Secure; SameSite=Strict` cookies, never JWT.
- Lockout is tracked per account (email), not per-IP: 5 consecutive failures locks the account for `5min × 2^lockoutLevel`, capped at 24h; a successful login resets the ladder to 0; 24 hours with no failures also decays the ladder back to 0.
- 2FA is mandatory TOTP (RFC 6238) with 10 one-time backup codes; no SMS/email OTP.
- Error responses are always exactly `{"error":"<message>"}` — CONTRACTS.md forbids adding fields like `retryAfter`. Any extra detail (e.g. lockout expiry) goes inside the message string.
- Domain types mirror between `backend/internal/domain/models.go` and `frontend/src/store/types.ts`; sensitive fields use the existing `json:"-"` tag convention (see `Worktree.ProjectID`), not a separate internal type.
- Never persist credentials/tokens to the zustand `persist` store — `useLoomStore`'s `partialize` must keep only persisting `sidebarOpen`.
- Run `go vet ./backend/...` and `cd frontend && npm run typecheck` before every commit that touches their respective side.
- Spec: `docs/superpowers/specs/2026-07-03-auth-2fa-design.md`.

---

## Task 1: Schema + domain `User` type

**Files:**
- Modify: `backend/internal/store/db.go` (schema const)
- Modify: `backend/internal/domain/models.go`
- Test: `backend/internal/store/db_test.go` (new)

**Interfaces:**
- Produces: `domain.User` struct (fields: `ID, Email, TotpEnabled, CreatedAt` exported/JSON; `PasswordHash, TotpSecretEnc, BackupCodeHashes, FailedAttempts, LockoutLevel, LockedUntil, LastFailedAt` tagged `json:"-"`). Later tasks read/write these exact field names.
- Produces: SQLite tables `users`, `sessions`, `pending_logins` per the design doc's schema.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/store/db_test.go`:

```go
package store

import (
	"path/filepath"
	"testing"
)

func TestOpenCreatesAuthTables(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, table := range []string{"users", "sessions", "pending_logins"} {
		var name string
		err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&name)
		if err != nil {
			t.Errorf("table %q not created: %v", table, err)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/store/... -run TestOpenCreatesAuthTables -v`
Expected: FAIL — table not found for `users` (and `sessions`, `pending_logins`).

- [ ] **Step 3: Add the tables to the schema**

In `backend/internal/store/db.go`, insert this block into the `schema` const, right after the existing `CREATE TABLE IF NOT EXISTS settings (...)` block and before the `INSERT OR IGNORE INTO settings ...` line:

```sql
CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,
  totp_secret_enc    TEXT NOT NULL DEFAULT '',
  totp_enabled       INTEGER NOT NULL DEFAULT 0,
  backup_code_hashes TEXT NOT NULL DEFAULT '[]',
  failed_attempts    INTEGER NOT NULL DEFAULT 0,
  lockout_level      INTEGER NOT NULL DEFAULT 0,
  locked_until       TEXT,
  last_failed_at     TEXT,
  created_at         TEXT NOT NULL
);

-- id is the SHA-256 hash of the opaque session token, never the raw token,
-- so a DB dump alone can't be replayed as a valid session.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Short-lived (2 min) token issued after password success, before TOTP is
-- verified, and reused for the mandatory post-registration TOTP enrollment.
CREATE TABLE IF NOT EXISTS pending_logins (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
```

- [ ] **Step 4: Add the `User` domain type**

In `backend/internal/domain/models.go`, add at the end of the file:

```go
// User mirrors the frontend User type. Sensitive fields are tagged json:"-"
// and never serialize into an API response — same mechanism already used
// for Worktree.ProjectID / Issue.ProjectID.
type User struct {
	ID               string   `json:"id"`
	Email            string   `json:"email"`
	TotpEnabled      bool     `json:"totpEnabled"`
	CreatedAt        string   `json:"createdAt"`
	PasswordHash     string   `json:"-"`
	TotpSecretEnc    string   `json:"-"`
	BackupCodeHashes []string `json:"-"`
	FailedAttempts   int      `json:"-"`
	LockoutLevel     int      `json:"-"`
	LockedUntil      *string  `json:"-"`
	LastFailedAt     *string  `json:"-"`
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && go test ./internal/store/... -run TestOpenCreatesAuthTables -v`
Expected: PASS

- [ ] **Step 6: Run the full backend test suite and vet to check for regressions**

Run: `cd backend && go vet ./... && go test ./...`
Expected: all PASS (existing tests untouched by this change)

- [ ] **Step 7: Commit**

```bash
git add backend/internal/store/db.go backend/internal/store/db_test.go backend/internal/domain/models.go
git commit -m "feat(auth): add users/sessions/pending_logins schema and User domain type"
```

---

## Task 2: Crypto & backup-code helpers

**Files:**
- Create: `backend/internal/service/authcrypto.go`
- Test: `backend/internal/service/authcrypto_test.go`

**Interfaces:**
- Consumes: nothing new (only `golang.org/x/crypto/bcrypt`, already transitively vendored — importing it directly and running `go mod tidy` promotes it to a direct dependency).
- Produces: `const bcryptCost = 12`; `encryptSecret(key []byte, plaintext string) (string, error)`; `decryptSecret(key []byte, encoded string) (string, error)`; `generateBackupCodes(n int) ([]string, error)`; `hashBackupCode(code string) (string, error)`; `matchBackupCode(hashes []string, code string) int` (returns the matching index, or -1). All used by `AuthService` in Task 6+.

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/service/authcrypto_test.go`:

```go
package service

import "testing"

func TestEncryptDecryptSecretRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	encrypted, err := encryptSecret(key, "JBSWY3DPEHPK3PXP")
	if err != nil {
		t.Fatal(err)
	}
	if encrypted == "JBSWY3DPEHPK3PXP" {
		t.Fatal("encryptSecret returned the plaintext unchanged")
	}
	decrypted, err := decryptSecret(key, encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if decrypted != "JBSWY3DPEHPK3PXP" {
		t.Errorf("decryptSecret = %q, want %q", decrypted, "JBSWY3DPEHPK3PXP")
	}
}

func TestDecryptSecretFailsWithWrongKey(t *testing.T) {
	key1 := make([]byte, 32)
	key2 := make([]byte, 32)
	key2[0] = 1
	encrypted, err := encryptSecret(key1, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decryptSecret(key2, encrypted); err == nil {
		t.Error("decryptSecret with the wrong key should fail, got nil error")
	}
}

func TestGenerateBackupCodesAreUniqueAndCorrectLength(t *testing.T) {
	codes, err := generateBackupCodes(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(codes) != 10 {
		t.Fatalf("len(codes) = %d, want 10", len(codes))
	}
	seen := map[string]bool{}
	for _, c := range codes {
		if len(c) != 10 {
			t.Errorf("code %q has length %d, want 10", c, len(c))
		}
		if seen[c] {
			t.Errorf("duplicate backup code %q", c)
		}
		seen[c] = true
	}
}

func TestMatchBackupCodeFindsAndRejects(t *testing.T) {
	hash, err := hashBackupCode("ABCD123456")
	if err != nil {
		t.Fatal(err)
	}
	hashes := []string{hash}
	if idx := matchBackupCode(hashes, "ABCD123456"); idx != 0 {
		t.Errorf("matchBackupCode = %d, want 0", idx)
	}
	if idx := matchBackupCode(hashes, "WRONGCODE1"); idx != -1 {
		t.Errorf("matchBackupCode = %d, want -1", idx)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/service/... -run 'TestEncryptDecrypt|TestGenerateBackupCodes|TestMatchBackupCode' -v`
Expected: FAIL (build error — `encryptSecret` etc. undefined)

- [ ] **Step 3: Implement**

Create `backend/internal/service/authcrypto.go`:

```go
package service

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"

	"golang.org/x/crypto/bcrypt"
)

// bcryptCost is used for both password and backup-code hashing.
const bcryptCost = 12

// encryptSecret encrypts plaintext with AES-256-GCM using key (must be 32
// bytes) and returns a base64-encoded "nonce||ciphertext" blob.
func encryptSecret(key []byte, plaintext string) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// decryptSecret reverses encryptSecret.
func decryptSecret(key []byte, encoded string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(data) < gcm.NonceSize() {
		return "", errors.New("ciphertext too short")
	}
	nonce, ciphertext := data[:gcm.NonceSize()], data[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

// generateBackupCodes returns n random 10-character uppercase alphanumeric
// backup codes, e.g. "7K2F9QXB4M". The alphabet excludes O/0/I/1 to avoid
// visual ambiguity when a user copies a code by hand.
func generateBackupCodes(n int) ([]string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	codes := make([]string, n)
	for i := range codes {
		b := make([]byte, 10)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		for j, v := range b {
			b[j] = alphabet[int(v)%len(alphabet)]
		}
		codes[i] = string(b)
	}
	return codes, nil
}

// hashBackupCode bcrypt-hashes a backup code for storage.
func hashBackupCode(code string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(code), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// matchBackupCode returns the index of the first hash in hashes that code
// matches, or -1 if none match.
func matchBackupCode(hashes []string, code string) int {
	for i, h := range hashes {
		if bcrypt.CompareHashAndPassword([]byte(h), []byte(code)) == nil {
			return i
		}
	}
	return -1
}
```

- [ ] **Step 4: Tidy modules and run tests**

Run:
```bash
cd backend && go mod tidy && go test ./internal/service/... -run 'TestEncryptDecrypt|TestGenerateBackupCodes|TestMatchBackupCode' -v
```
Expected: PASS. Confirm in `backend/go.mod` that `golang.org/x/crypto` moved from the `// indirect` block to the direct `require` block.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/authcrypto.go backend/internal/service/authcrypto_test.go backend/go.mod backend/go.sum
git commit -m "feat(auth): add AES-GCM secret encryption and backup-code helpers"
```

---

## Task 3: Store — user CRUD

**Files:**
- Modify: `backend/internal/port/store.go` (interface + `UserPatch`)
- Modify: `backend/internal/store/helpers.go` (add `setBool`, `setJSONStrSlice`)
- Create: `backend/internal/store/user.go`
- Test: `backend/internal/store/user_test.go`

**Interfaces:**
- Consumes: `domain.User` (Task 1), `idGen`, `mapNotFound`, `firstErr`, `setStr`, `setInt`, `scanner` (existing `helpers.go`).
- Produces (added to `port.Store`): `CreateUser(email, passwordHash, createdAt string) (domain.User, error)`, `UserByEmail(email string) (domain.User, error)`, `UserByID(id string) (domain.User, error)`, `UserCount() (int, error)`, `UpdateUser(id string, p UserPatch) (domain.User, error)`. `UserPatch` fields: `TotpSecretEnc *string`, `TotpEnabled *bool`, `BackupCodeHashes *[]string`, `FailedAttempts *int`, `LockoutLevel *int`, `LockedUntil *string`, `HasLockedUntil bool`, `LastFailedAt *string`. These exact names are consumed by `AuthService` starting in Task 6.

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/store/user_test.go`:

```go
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/store/... -run 'TestCreateUser|TestUserByEmail|TestUpdateUser' -v`
Expected: FAIL (build error — `CreateUser`, `port.UserPatch` etc. undefined)

- [ ] **Step 3: Add interface methods and `UserPatch` to `port.Store`**

In `backend/internal/port/store.go`, add to the `Store` interface (after the `// Seed` line, before its closing brace is fine, or grouped near the top — place it in its own section for clarity):

```go
	// Users (single-operator: at most one row ever exists)
	CreateUser(email, passwordHash, createdAt string) (domain.User, error)
	UserByEmail(email string) (domain.User, error)
	UserByID(id string) (domain.User, error)
	UserCount() (int, error)
	UpdateUser(id string, p UserPatch) (domain.User, error)
```

And add this patch type alongside the other `*Patch` types in the same file:

```go
// UserPatch carries optional fields for a partial user update.
type UserPatch struct {
	TotpSecretEnc    *string
	TotpEnabled      *bool
	BackupCodeHashes *[]string
	FailedAttempts   *int
	LockoutLevel     *int
	LockedUntil      *string
	HasLockedUntil   bool // true when the "lockedUntil" field was explicitly set (allows clearing to null)
	LastFailedAt     *string
}
```

- [ ] **Step 4: Add `setBool` and `setJSONStrSlice` helpers**

In `backend/internal/store/helpers.go`, add near `setStr`/`setInt`:

```go
// setBool applies an optional scalar bool update to a column.
func setBool(db *sql.DB, table, col, id string, v *bool) error {
	if v == nil {
		return nil
	}
	_, err := db.Exec("UPDATE "+table+" SET "+col+" = ? WHERE id = ?", boolInt(*v), id)
	return err
}

// setJSONStrSlice applies an optional JSON-encoded []string update to a column.
func setJSONStrSlice(db *sql.DB, table, col, id string, v *[]string) error {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(*v)
	if err != nil {
		return err
	}
	_, err = db.Exec("UPDATE "+table+" SET "+col+" = ? WHERE id = ?", string(b), id)
	return err
}
```

(`encoding/json` is already imported in `helpers.go` for `domain` decoding elsewhere — if the build reports it missing, add `"encoding/json"` to the import block.)

- [ ] **Step 5: Implement `store/user.go`**

Create `backend/internal/store/user.go`:

```go
package store

import (
	"database/sql"
	"encoding/json"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

const userColumns = `id, email, password_hash, totp_secret_enc, totp_enabled, backup_code_hashes,
	failed_attempts, lockout_level, locked_until, last_failed_at, created_at`

func scanUser(sc scanner) (domain.User, error) {
	var u domain.User
	var totpEnabled int
	var backupCodesJSON string
	var lockedUntil, lastFailedAt sql.NullString
	err := sc.Scan(&u.ID, &u.Email, &u.PasswordHash, &u.TotpSecretEnc, &totpEnabled, &backupCodesJSON,
		&u.FailedAttempts, &u.LockoutLevel, &lockedUntil, &lastFailedAt, &u.CreatedAt)
	if err != nil {
		return u, err
	}
	u.TotpEnabled = totpEnabled != 0
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && go vet ./... && go test ./internal/store/... -run 'TestCreateUser|TestUserByEmail|TestUpdateUser' -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/internal/port/store.go backend/internal/store/helpers.go backend/internal/store/user.go backend/internal/store/user_test.go
git commit -m "feat(auth): add user CRUD to the store layer"
```

---

## Task 4: Store — session & pending-login CRUD

**Files:**
- Modify: `backend/internal/port/store.go`
- Create: `backend/internal/store/session.go`
- Test: `backend/internal/store/session_test.go`

**Interfaces:**
- Produces (added to `port.Store`): `CreateSession(userID, tokenHash string, expiresAt time.Time) error`, `SessionUserID(tokenHash string, now time.Time) (string, error)` (returns `ErrNotFound` if missing or expired, and deletes expired rows on read), `DeleteSession(tokenHash string) error`, `CreatePendingLogin(userID, tokenHash string, expiresAt time.Time) error`, `PendingLoginUserID(tokenHash string, now time.Time) (string, error)`, `DeletePendingLogin(tokenHash string) error`. `AuthService` (Task 6+) calls these with its own injectable clock, mirroring the existing `RunDueRecurringInvoicesAt(now time.Time)` precedent in `store/recurring_schedule.go`.

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/store/session_test.go`:

```go
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/store/... -run 'TestSessionLifecycle|TestPendingLoginLifecycle' -v`
Expected: FAIL (build error — methods undefined)

- [ ] **Step 3: Add interface methods to `port.Store`**

In `backend/internal/port/store.go`, add (and add `"time"` to the file's import block):

```go
	// Sessions and pending (post-password, pre-TOTP) logins
	CreateSession(userID, tokenHash string, expiresAt time.Time) error
	SessionUserID(tokenHash string, now time.Time) (string, error)
	DeleteSession(tokenHash string) error
	CreatePendingLogin(userID, tokenHash string, expiresAt time.Time) error
	PendingLoginUserID(tokenHash string, now time.Time) (string, error)
	DeletePendingLogin(tokenHash string) error
```

- [ ] **Step 4: Implement `store/session.go`**

Create `backend/internal/store/session.go`:

```go
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go vet ./... && go test ./internal/store/... -v`
Expected: PASS (all store package tests, including pre-existing ones)

- [ ] **Step 6: Commit**

```bash
git add backend/internal/port/store.go backend/internal/store/session.go backend/internal/store/session_test.go
git commit -m "feat(auth): add session and pending-login CRUD to the store layer"
```

---

## Task 5: Service error sentinels + `handleStoreErr` mapping

**Files:**
- Modify: `backend/internal/service/errors.go`
- Modify: `backend/internal/handler/middleware.go`
- Test: `backend/internal/handler/middleware_test.go`

**Interfaces:**
- Produces: `service.ErrUnauthorized` (maps to HTTP 401), `service.ErrLocked` (maps to HTTP 423, via `http.StatusLocked`). Consumed by `AuthService` (Task 6+) and `handleStoreErr`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/internal/handler/middleware_test.go`:

```go
func TestHandleStoreErrMapsUnauthorizedTo401(t *testing.T) {
	rec := httptest.NewRecorder()
	err := fmt.Errorf("invalid email or password: %w", service.ErrUnauthorized)
	if !handleStoreErr(rec, err) {
		t.Fatal("expected handleStoreErr to report an error was handled")
	}
	if rec.Code != 401 {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestHandleStoreErrMapsLockedTo423(t *testing.T) {
	rec := httptest.NewRecorder()
	err := fmt.Errorf("account locked until 2026-01-01T00:05:00Z: %w", service.ErrLocked)
	if !handleStoreErr(rec, err) {
		t.Fatal("expected handleStoreErr to report an error was handled")
	}
	if rec.Code != 423 {
		t.Errorf("status = %d, want 423", rec.Code)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/handler/... -run 'TestHandleStoreErrMapsUnauthorized|TestHandleStoreErrMapsLocked' -v`
Expected: FAIL (build error — `service.ErrUnauthorized`/`service.ErrLocked` undefined)

- [ ] **Step 3: Add the sentinels**

In `backend/internal/service/errors.go`, add:

```go
// ErrUnauthorized indicates invalid credentials or an invalid/expired
// session or pending-login token. Wrap it with fmt.Errorf("...: %w",
// ErrUnauthorized) — handleStoreErr maps it to HTTP 401.
var ErrUnauthorized = errors.New("unauthorized")

// ErrLocked indicates the account is locked out after repeated failed
// login attempts. Wrap it with fmt.Errorf("...: %w", ErrLocked) —
// handleStoreErr maps it to HTTP 423.
var ErrLocked = errors.New("locked")
```

- [ ] **Step 4: Extend `handleStoreErr`**

In `backend/internal/handler/middleware.go`, add two branches to `handleStoreErr`, after the existing `service.ErrConflict` branch and before the generic 500 fallback:

```go
	if errors.Is(err, service.ErrUnauthorized) {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return true
	}
	if errors.Is(err, service.ErrLocked) {
		writeErr(w, http.StatusLocked, err.Error())
		return true
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go vet ./... && go test ./internal/handler/... -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/internal/service/errors.go backend/internal/handler/middleware.go backend/internal/handler/middleware_test.go
git commit -m "feat(auth): add ErrUnauthorized/ErrLocked sentinels mapped to 401/423"
```

---

## Task 6: `AuthService` — Register + TOTP enrollment

**Files:**
- Create: `backend/internal/service/auth.go`
- Test: `backend/internal/service/auth_test.go`

**Interfaces:**
- Consumes: `port.Store` (Tasks 3-4), `domain.User` (Task 1), `encryptSecret`/`decryptSecret`/`generateBackupCodes`/`hashBackupCode`/`bcryptCost` (Task 2), `service.ErrValidation`/`ErrConflict` (existing), new dependency `github.com/pquerna/otp/totp`.
- Produces: `type AuthService struct { store port.Store; authKey []byte; now func() time.Time }` (field name `store`, matching the existing `WorktreeService`/`ProjectService` convention — tests in the same package set `svc.now` directly). `NewAuthService(store port.Store, authKey []byte) *AuthService`. `(a *AuthService) Register(email, password string) (domain.User, string, error)` (returns user + a pending-login token). `(a *AuthService) BeginTotpEnrollment(userID string) (secret, otpauthURI string, err error)`. `(a *AuthService) ConfirmTotpEnrollment(userID, code string) ([]string, error)` (returns plaintext backup codes). `(a *AuthService) PendingUserID(pendingToken string) (string, error)` (resolves a pending token without consuming it — used by the handler's TOTP-setup step). Helpers `randomToken() (string, error)` and `hashToken(token string) string` are also defined here and reused by Tasks 7-8.

- [ ] **Step 1: Add the new dependency**

Run: `cd backend && go get github.com/pquerna/otp && go mod tidy`

- [ ] **Step 2: Write the failing tests**

Create `backend/internal/service/auth_test.go`:

```go
package service

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"

	"loom/backend/internal/store"
)

func newTestAuthService(t *testing.T) *AuthService {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	key := make([]byte, 32)
	return NewAuthService(store.New(db), key)
}

func TestRegisterCreatesFirstUser(t *testing.T) {
	svc := newTestAuthService(t)
	user, pendingToken, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if user.Email != "owner@example.com" {
		t.Errorf("Email = %q, want owner@example.com", user.Email)
	}
	if user.TotpEnabled {
		t.Error("TotpEnabled = true immediately after registration, want false")
	}
	if pendingToken == "" {
		t.Error("Register returned an empty pending token")
	}
}

func TestRegisterRejectsSecondUser(t *testing.T) {
	svc := newTestAuthService(t)
	if _, _, err := svc.Register("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	_, _, err := svc.Register("intruder@example.com", "another long enough password")
	if !errors.Is(err, ErrConflict) {
		t.Errorf("second Register error = %v, want ErrConflict", err)
	}
}

func TestRegisterRejectsWeakPassword(t *testing.T) {
	svc := newTestAuthService(t)
	_, _, err := svc.Register("owner@example.com", "short1")
	if !errors.Is(err, ErrValidation) {
		t.Errorf("Register with short password error = %v, want ErrValidation", err)
	}
}

func TestTotpEnrollmentRoundTrip(t *testing.T) {
	svc := newTestAuthService(t)
	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	secret, uri, err := svc.BeginTotpEnrollment(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if secret == "" || uri == "" {
		t.Fatal("BeginTotpEnrollment returned an empty secret or URI")
	}
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	backupCodes, err := svc.ConfirmTotpEnrollment(user.ID, code)
	if err != nil {
		t.Fatal(err)
	}
	if len(backupCodes) != backupCodeCount {
		t.Errorf("len(backupCodes) = %d, want %d", len(backupCodes), backupCodeCount)
	}
}

func TestConfirmTotpEnrollmentRejectsWrongCode(t *testing.T) {
	svc := newTestAuthService(t)
	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.BeginTotpEnrollment(user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmTotpEnrollment(user.ID, "000000"); !errors.Is(err, ErrValidation) {
		t.Errorf("ConfirmTotpEnrollment with wrong code error = %v, want ErrValidation", err)
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && go test ./internal/service/... -run 'TestRegister|TestTotpEnrollment|TestConfirmTotpEnrollment' -v`
Expected: FAIL (build error — `AuthService` etc. undefined)

- [ ] **Step 4: Implement**

Create `backend/internal/service/auth.go`:

```go
package service

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

const (
	pendingLoginTTL = 2 * time.Minute
	backupCodeCount = 10
)

// commonPasswords is a small blocklist of well-known weak passwords, checked
// in addition to the minimum-length rule (NIST 800-63B favors length over
// arbitrary character-class complexity rules).
var commonPasswords = map[string]bool{
	"password1234":       true,
	"password123456":     true,
	"letmein123456":      true,
	"qwertyuiop123":      true,
	"123456789012":       true,
	"correcthorsebattery": true,
	"welcometotheteam":   true,
	"iloveyou123456":     true,
	"administrator1":     true,
	"changeme123456":     true,
}

func validatePassword(password string) error {
	if len(password) < 12 {
		return fmt.Errorf("password must be at least 12 characters: %w", ErrValidation)
	}
	if commonPasswords[strings.ToLower(password)] {
		return fmt.Errorf("password is too common: %w", ErrValidation)
	}
	return nil
}

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// AuthService owns registration, TOTP enrollment/verification, login, and
// session lifecycle. now is overridden by tests to make the lockout
// escalation math deterministic.
type AuthService struct {
	store   port.Store
	authKey []byte
	now     func() time.Time
}

// NewAuthService creates an auth service. authKey must be 32 bytes
// (AES-256) and is used to encrypt TOTP secrets at rest.
func NewAuthService(store port.Store, authKey []byte) *AuthService {
	return &AuthService{store: store, authKey: authKey, now: time.Now}
}

func (a *AuthService) issuePendingLogin(userID string) (string, error) {
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	if err := a.store.CreatePendingLogin(userID, hashToken(token), a.now().Add(pendingLoginTTL)); err != nil {
		return "", err
	}
	return token, nil
}

// PendingUserID resolves a pending-login token to a user ID without
// consuming it — used by the TOTP-setup step, which the user may retry.
func (a *AuthService) PendingUserID(pendingToken string) (string, error) {
	userID, err := a.store.PendingLoginUserID(hashToken(pendingToken), a.now())
	if err != nil {
		return "", fmt.Errorf("invalid or expired login: %w", ErrUnauthorized)
	}
	return userID, nil
}

// Register creates the single operator account. It rejects a second
// registration with ErrConflict. The new account has TotpEnabled=false, so
// it immediately issues a pending-login token (the same mechanism the
// post-password step of Login uses) so the caller can hand off straight
// into TOTP enrollment.
func (a *AuthService) Register(email, password string) (domain.User, string, error) {
	count, err := a.store.UserCount()
	if err != nil {
		return domain.User{}, "", err
	}
	if count > 0 {
		return domain.User{}, "", fmt.Errorf("registration closed: %w", ErrConflict)
	}
	if err := validatePassword(password); err != nil {
		return domain.User{}, "", err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return domain.User{}, "", err
	}
	createdAt := a.now().UTC().Format(time.RFC3339)
	user, err := a.store.CreateUser(email, string(hash), createdAt)
	if err != nil {
		return domain.User{}, "", err
	}
	pendingToken, err := a.issuePendingLogin(user.ID)
	if err != nil {
		return domain.User{}, "", err
	}
	return user, pendingToken, nil
}

// BeginTotpEnrollment generates a new TOTP secret, encrypts it at rest, and
// returns both the raw secret (for tests) and the otpauth:// URI the
// frontend renders as a QR code.
func (a *AuthService) BeginTotpEnrollment(userID string) (secret, otpauthURI string, err error) {
	user, err := a.store.UserByID(userID)
	if err != nil {
		return "", "", err
	}
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      "Loom",
		AccountName: user.Email,
	})
	if err != nil {
		return "", "", err
	}
	encrypted, err := encryptSecret(a.authKey, key.Secret())
	if err != nil {
		return "", "", err
	}
	if _, err := a.store.UpdateUser(userID, port.UserPatch{TotpSecretEnc: &encrypted}); err != nil {
		return "", "", err
	}
	return key.Secret(), key.String(), nil
}

// ConfirmTotpEnrollment verifies the enrollment code, enables 2FA, and
// returns a fresh set of one-time backup codes (shown to the user exactly
// once; only their bcrypt hashes are persisted).
func (a *AuthService) ConfirmTotpEnrollment(userID, code string) ([]string, error) {
	user, err := a.store.UserByID(userID)
	if err != nil {
		return nil, err
	}
	secret, err := decryptSecret(a.authKey, user.TotpSecretEnc)
	if err != nil {
		return nil, err
	}
	if !totp.Validate(code, secret) {
		return nil, fmt.Errorf("invalid verification code: %w", ErrValidation)
	}
	codes, err := generateBackupCodes(backupCodeCount)
	if err != nil {
		return nil, err
	}
	hashes := make([]string, len(codes))
	for i, c := range codes {
		h, err := hashBackupCode(c)
		if err != nil {
			return nil, err
		}
		hashes[i] = h
	}
	enabled := true
	if _, err := a.store.UpdateUser(userID, port.UserPatch{TotpEnabled: &enabled, BackupCodeHashes: &hashes}); err != nil {
		return nil, err
	}
	return codes, nil
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go vet ./... && go test ./internal/service/... -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/internal/service/auth.go backend/internal/service/auth_test.go backend/go.mod backend/go.sum
git commit -m "feat(auth): add AuthService register and TOTP enrollment"
```

---

## Task 7: `AuthService` — Login + lockout escalation

**Files:**
- Modify: `backend/internal/service/auth.go`
- Modify: `backend/internal/service/auth_test.go`

**Interfaces:**
- Consumes: everything from Task 6, plus `store.ErrNotFound` (new import of the concrete `store` package, needed to translate "no such email" into the same generic `ErrUnauthorized` as "wrong password" — no user enumeration).
- Produces: `(a *AuthService) Login(email, password string) (string, error)` (returns a pending-login token on success). This is consumed by the handler in Task 9.

- [ ] **Step 1: Write the failing tests**

Add to `backend/internal/service/auth_test.go`:

```go
func TestLoginRejectsUnknownEmailGenerically(t *testing.T) {
	svc := newTestAuthService(t)
	if _, _, err := svc.Register("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Login("nobody@example.com", "whatever password")
	if !errors.Is(err, ErrUnauthorized) {
		t.Errorf("Login with unknown email error = %v, want ErrUnauthorized", err)
	}
}

func TestLoginLocksAccountAfterFiveFailures(t *testing.T) {
	svc := newTestAuthService(t)
	if _, _, err := svc.Register("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	fakeNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fakeNow }

	for i := 0; i < 5; i++ {
		if _, err := svc.Login("owner@example.com", "wrong password"); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("attempt %d: err = %v, want ErrUnauthorized", i+1, err)
		}
	}
	if _, err := svc.Login("owner@example.com", "wrong password"); !errors.Is(err, ErrLocked) {
		t.Fatalf("6th attempt err = %v, want ErrLocked", err)
	}
}

func TestLoginUnlocksAfterLockoutDurationPasses(t *testing.T) {
	svc := newTestAuthService(t)
	if _, _, err := svc.Register("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	fakeNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fakeNow }
	for i := 0; i < 5; i++ {
		_, _ = svc.Login("owner@example.com", "wrong password")
	}
	fakeNow = fakeNow.Add(6 * time.Minute) // past the 5-minute base lockout
	if _, err := svc.Login("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatalf("Login after lockout expired = %v, want nil", err)
	}
}

func TestLoginEscalatesLockoutDurationOnRepeatedLockouts(t *testing.T) {
	svc := newTestAuthService(t)
	if _, _, err := svc.Register("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	fakeNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fakeNow }

	for i := 0; i < 5; i++ { // first lockout: 5 minutes
		_, _ = svc.Login("owner@example.com", "wrong password")
	}
	fakeNow = fakeNow.Add(5*time.Minute + time.Second) // first lockout just expired

	for i := 0; i < 5; i++ { // second lockout: should now be 10 minutes
		_, _ = svc.Login("owner@example.com", "wrong password")
	}
	fakeNow = fakeNow.Add(9 * time.Minute) // still within the escalated 10-minute lock
	if _, err := svc.Login("owner@example.com", "correct horse battery staple"); !errors.Is(err, ErrLocked) {
		t.Fatalf("err = %v, want ErrLocked (escalated lockout should still be active)", err)
	}
	fakeNow = fakeNow.Add(2 * time.Minute) // now past the 10-minute escalated lock
	if _, err := svc.Login("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatalf("Login after escalated lockout expired = %v, want nil", err)
	}
}

func TestLoginResetsLockoutLevelOnSuccess(t *testing.T) {
	svc := newTestAuthService(t)
	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	fakeNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fakeNow }
	for i := 0; i < 5; i++ {
		_, _ = svc.Login("owner@example.com", "wrong password")
	}
	fakeNow = fakeNow.Add(6 * time.Minute)
	if _, err := svc.Login("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	updated, err := svc.store.UserByID(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.LockoutLevel != 0 {
		t.Errorf("LockoutLevel after successful login = %d, want 0", updated.LockoutLevel)
	}
}

func TestLockoutLevelDecaysAfter24HoursOfNoFailures(t *testing.T) {
	svc := newTestAuthService(t)
	if _, _, err := svc.Register("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	fakeNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fakeNow }

	for i := 0; i < 5; i++ { // first lockout escalates LockoutLevel to 1
		_, _ = svc.Login("owner@example.com", "wrong password")
	}
	fakeNow = fakeNow.Add(25 * time.Hour) // 25 hours of silence before failing again
	for i := 0; i < 5; i++ {
		_, _ = svc.Login("owner@example.com", "wrong password")
	}
	// If the ladder decayed back to level 0, this second lockout is 5
	// minutes, not the escalated 10 — so 6 minutes later it's unlocked.
	fakeNow = fakeNow.Add(6 * time.Minute)
	if _, err := svc.Login("owner@example.com", "correct horse battery staple"); err != nil {
		t.Fatalf("Login after decayed lockout expired = %v, want nil", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/service/... -run 'TestLogin|TestLockoutLevelDecays' -v`
Expected: FAIL (build error — `Login` undefined)

- [ ] **Step 3: Implement**

Add to `backend/internal/service/auth.go` (add `"errors"` and `"loom/backend/internal/store"` to the imports):

```go
const (
	lockoutThreshold  = 5
	baseLockout       = 5 * time.Minute
	maxLockout        = 24 * time.Hour
	lockoutDecayAfter = 24 * time.Hour
	maxLockoutLevel   = 9 // baseLockout * 2^9 (42.7h) already exceeds maxLockout; caps the shift below
)

func (a *AuthService) isLocked(user domain.User) (bool, time.Time) {
	if user.LockedUntil == nil {
		return false, time.Time{}
	}
	lockedUntil, err := time.Parse(time.RFC3339, *user.LockedUntil)
	if err != nil {
		return false, time.Time{}
	}
	if a.now().Before(lockedUntil) {
		return true, lockedUntil
	}
	return false, time.Time{}
}

// recordFailedAttempt applies the escalating-lockout algorithm: 5 failures
// locks the account for 5min × 2^lockoutLevel (capped at 24h); a clean 24h
// since the last failure decays lockoutLevel back to 0 first.
func (a *AuthService) recordFailedAttempt(user domain.User) error {
	now := a.now()
	failedAttempts := user.FailedAttempts + 1
	lockoutLevel := user.LockoutLevel
	if user.LastFailedAt != nil {
		if lastFailed, err := time.Parse(time.RFC3339, *user.LastFailedAt); err == nil {
			if now.Sub(lastFailed) > lockoutDecayAfter {
				lockoutLevel = 0
			}
		}
	}

	patch := port.UserPatch{}
	nowStr := now.UTC().Format(time.RFC3339)
	patch.LastFailedAt = &nowStr

	if failedAttempts >= lockoutThreshold {
		duration := baseLockout * time.Duration(uint64(1)<<uint(lockoutLevel))
		if duration > maxLockout {
			duration = maxLockout
		}
		lockedUntilStr := now.Add(duration).UTC().Format(time.RFC3339)
		patch.LockedUntil = &lockedUntilStr
		patch.HasLockedUntil = true
		nextLevel := lockoutLevel + 1
		if nextLevel > maxLockoutLevel {
			nextLevel = maxLockoutLevel
		}
		patch.LockoutLevel = &nextLevel
		zero := 0
		patch.FailedAttempts = &zero
	} else {
		patch.FailedAttempts = &failedAttempts
		patch.LockoutLevel = &lockoutLevel
	}
	_, err := a.store.UpdateUser(user.ID, patch)
	return err
}

// Login verifies email+password and, on success, issues a pending-login
// token for the caller to complete with VerifyTotp. It never distinguishes
// "no such account" from "wrong password" in its error, to avoid account
// enumeration.
func (a *AuthService) Login(email, password string) (string, error) {
	user, err := a.store.UserByEmail(email)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", fmt.Errorf("invalid email or password: %w", ErrUnauthorized)
		}
		return "", err
	}
	if locked, lockedUntil := a.isLocked(user); locked {
		return "", fmt.Errorf("account locked until %s: %w", lockedUntil.Format(time.RFC3339), ErrLocked)
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		if err := a.recordFailedAttempt(user); err != nil {
			return "", err
		}
		return "", fmt.Errorf("invalid email or password: %w", ErrUnauthorized)
	}
	zero := 0
	if _, err := a.store.UpdateUser(user.ID, port.UserPatch{FailedAttempts: &zero, LockoutLevel: &zero}); err != nil {
		return "", err
	}
	return a.issuePendingLogin(user.ID)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go vet ./... && go test ./internal/service/... -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/auth.go backend/internal/service/auth_test.go
git commit -m "feat(auth): add Login with escalating per-account lockout"
```

---

## Task 8: `AuthService` — VerifyTotp, Logout, CurrentUser

**Files:**
- Modify: `backend/internal/service/auth.go`
- Modify: `backend/internal/service/auth_test.go`

**Interfaces:**
- Produces: `(a *AuthService) VerifyTotp(pendingToken, code string) (string, domain.User, error)` (returns a session token; accepts either a TOTP code or a single-use backup code), `(a *AuthService) Logout(sessionToken string) error`, `(a *AuthService) CurrentUser(sessionToken string) (domain.User, error)`. Consumed by the handler in Task 9 and the middleware in Task 10.

- [ ] **Step 1: Write the failing tests**

Add to `backend/internal/service/auth_test.go`:

```go
func TestFullLoginFlowIssuesWorkingSession(t *testing.T) {
	svc := newTestAuthService(t)
	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	secret, _, err := svc.BeginTotpEnrollment(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	setupCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmTotpEnrollment(user.ID, setupCode); err != nil {
		t.Fatal(err)
	}

	loginPendingToken, err := svc.Login("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	loginCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	sessionToken, loggedInUser, err := svc.VerifyTotp(loginPendingToken, loginCode)
	if err != nil {
		t.Fatal(err)
	}
	if loggedInUser.Email != "owner@example.com" {
		t.Errorf("Email = %q, want owner@example.com", loggedInUser.Email)
	}
	current, err := svc.CurrentUser(sessionToken)
	if err != nil {
		t.Fatal(err)
	}
	if current.ID != user.ID {
		t.Errorf("CurrentUser ID = %q, want %q", current.ID, user.ID)
	}
}

func TestBackupCodeLoginIsSingleUse(t *testing.T) {
	svc := newTestAuthService(t)
	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	secret, _, err := svc.BeginTotpEnrollment(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	setupCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	backupCodes, err := svc.ConfirmTotpEnrollment(user.ID, setupCode)
	if err != nil {
		t.Fatal(err)
	}

	pendingToken, err := svc.Login("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.VerifyTotp(pendingToken, backupCodes[0]); err != nil {
		t.Fatalf("first use of backup code failed: %v", err)
	}

	pendingToken2, err := svc.Login("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.VerifyTotp(pendingToken2, backupCodes[0]); !errors.Is(err, ErrValidation) {
		t.Errorf("second use of the same backup code err = %v, want ErrValidation", err)
	}
}

func TestLogoutInvalidatesSession(t *testing.T) {
	svc := newTestAuthService(t)
	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	secret, _, err := svc.BeginTotpEnrollment(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	setupCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmTotpEnrollment(user.ID, setupCode); err != nil {
		t.Fatal(err)
	}
	pendingToken, err := svc.Login("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	loginCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	sessionToken, _, err := svc.VerifyTotp(pendingToken, loginCode)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Logout(sessionToken); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CurrentUser(sessionToken); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("CurrentUser after logout err = %v, want ErrUnauthorized", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/service/... -run 'TestFullLoginFlow|TestBackupCodeLoginIsSingleUse|TestLogoutInvalidatesSession' -v`
Expected: FAIL (build error — `VerifyTotp`/`Logout`/`CurrentUser` undefined)

- [ ] **Step 3: Implement**

Add to `backend/internal/service/auth.go`:

```go
const sessionTTL = 30 * 24 * time.Hour

func (a *AuthService) issueSession(userID string) (string, error) {
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	if err := a.store.CreateSession(userID, hashToken(token), a.now().Add(sessionTTL)); err != nil {
		return "", err
	}
	return token, nil
}

// VerifyTotp completes a login started by Login (or the pending state left
// by Register/BeginTotpEnrollment), accepting either a live TOTP code or a
// single-use backup code, and issues a real session on success.
func (a *AuthService) VerifyTotp(pendingToken, code string) (string, domain.User, error) {
	userID, err := a.store.PendingLoginUserID(hashToken(pendingToken), a.now())
	if err != nil {
		return "", domain.User{}, fmt.Errorf("invalid or expired login: %w", ErrUnauthorized)
	}
	user, err := a.store.UserByID(userID)
	if err != nil {
		return "", domain.User{}, err
	}
	secret, err := decryptSecret(a.authKey, user.TotpSecretEnc)
	if err != nil {
		return "", domain.User{}, err
	}

	if totp.Validate(code, secret) {
		return a.completeVerification(pendingToken, userID, user)
	}
	if idx := matchBackupCode(user.BackupCodeHashes, code); idx >= 0 {
		remaining := append(append([]string{}, user.BackupCodeHashes[:idx]...), user.BackupCodeHashes[idx+1:]...)
		if _, err := a.store.UpdateUser(userID, port.UserPatch{BackupCodeHashes: &remaining}); err != nil {
			return "", domain.User{}, err
		}
		return a.completeVerification(pendingToken, userID, user)
	}
	return "", domain.User{}, fmt.Errorf("invalid verification code: %w", ErrValidation)
}

func (a *AuthService) completeVerification(pendingToken, userID string, user domain.User) (string, domain.User, error) {
	sessionToken, err := a.issueSession(userID)
	if err != nil {
		return "", domain.User{}, err
	}
	_ = a.store.DeletePendingLogin(hashToken(pendingToken))
	return sessionToken, user, nil
}

// Logout deletes the session row, invalidating the token immediately.
func (a *AuthService) Logout(sessionToken string) error {
	return a.store.DeleteSession(hashToken(sessionToken))
}

// CurrentUser resolves a session token to its user, used by GET /api/auth/me
// and the RequireAuth middleware.
func (a *AuthService) CurrentUser(sessionToken string) (domain.User, error) {
	userID, err := a.store.SessionUserID(hashToken(sessionToken), a.now())
	if err != nil {
		return domain.User{}, fmt.Errorf("unauthorized: %w", ErrUnauthorized)
	}
	return a.store.UserByID(userID)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go vet ./... && go test ./internal/service/... -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/auth.go backend/internal/service/auth_test.go
git commit -m "feat(auth): add TOTP/backup-code login verification, logout, and session lookup"
```

---

## Task 9: Handler — `auth.go` endpoints + cookie helpers

**Files:**
- Create: `backend/internal/handler/auth.go`
- Test: `backend/internal/handler/auth_test.go`

**Interfaces:**
- Consumes: `service.AuthService` (Tasks 6-8), `decodeBody`/`writeJSON`/`writeErr`/`handleStoreErr` (existing `middleware.go`).
- Produces: `type AuthHandler struct { svc *service.AuthService }`, `NewAuthHandler(svc *service.AuthService) *AuthHandler`, methods `PostRegister`, `PostLogin`, `PostTotpSetup`, `PostTotpVerifySetup`, `PostTotpVerify`, `PostLogout`, `GetMe` (all `func(w http.ResponseWriter, r *http.Request)`), and cookie name constants `sessionCookieName = "loom_session"`, `pendingCookieName = "loom_pending"` — consumed by `RequireAuth` in Task 10 and route registration in Task 10.

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/handler/auth_test.go`:

```go
package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"

	"loom/backend/internal/service"
	"loom/backend/internal/store"
)

func newTestAuthHandler(t *testing.T) *AuthHandler {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	key := make([]byte, 32)
	return NewAuthHandler(service.NewAuthService(store.New(db), key))
}

func jsonBody(t *testing.T, v any) *bytes.Buffer {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.NewBuffer(b)
}

func cookieFrom(rec *httptest.ResponseRecorder, name string) string {
	for _, c := range rec.Result().Cookies() {
		if c.Name == name {
			return c.Value
		}
	}
	return ""
}

func TestRegisterLoginTotpFullFlow(t *testing.T) {
	h := newTestAuthHandler(t)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", jsonBody(t, map[string]string{
		"email": "owner@example.com", "password": "correct horse battery staple",
	}))
	h.PostRegister(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register status = %d, want 201, body=%s", rec.Code, rec.Body)
	}
	pendingCookie := cookieFrom(rec, pendingCookieName)
	if pendingCookie == "" {
		t.Fatal("register did not set the pending cookie")
	}

	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/api/auth/register", jsonBody(t, map[string]string{
		"email": "intruder@example.com", "password": "another long enough password",
	}))
	h.PostRegister(rec2, req2)
	if rec2.Code != http.StatusConflict {
		t.Errorf("second register status = %d, want 409", rec2.Code)
	}

	setupRec := httptest.NewRecorder()
	setupReq := httptest.NewRequest(http.MethodPost, "/api/auth/totp/setup", nil)
	setupReq.AddCookie(&http.Cookie{Name: pendingCookieName, Value: pendingCookie})
	h.PostTotpSetup(setupRec, setupReq)
	if setupRec.Code != http.StatusOK {
		t.Fatalf("totp setup status = %d, want 200, body=%s", setupRec.Code, setupRec.Body)
	}
	var setupResp struct {
		OtpauthUri string `json:"otpauthUri"`
	}
	if err := json.Unmarshal(setupRec.Body.Bytes(), &setupResp); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(setupResp.OtpauthUri)
	if err != nil {
		t.Fatal(err)
	}
	secret := u.Query().Get("secret")
	if secret == "" {
		t.Fatal("otpauth URI missing secret query param")
	}

	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	confirmRec := httptest.NewRecorder()
	confirmReq := httptest.NewRequest(http.MethodPost, "/api/auth/totp/verify-setup", jsonBody(t, map[string]string{"code": code}))
	confirmReq.AddCookie(&http.Cookie{Name: pendingCookieName, Value: pendingCookie})
	h.PostTotpVerifySetup(confirmRec, confirmReq)
	if confirmRec.Code != http.StatusOK {
		t.Fatalf("verify-setup status = %d, want 200, body=%s", confirmRec.Code, confirmRec.Body)
	}

	loginRec := httptest.NewRecorder()
	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", jsonBody(t, map[string]string{
		"email": "owner@example.com", "password": "correct horse battery staple",
	}))
	h.PostLogin(loginRec, loginReq)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login status = %d, want 200, body=%s", loginRec.Code, loginRec.Body)
	}
	loginPendingCookie := cookieFrom(loginRec, pendingCookieName)

	loginCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	verifyRec := httptest.NewRecorder()
	verifyReq := httptest.NewRequest(http.MethodPost, "/api/auth/totp/verify", jsonBody(t, map[string]string{"code": loginCode}))
	verifyReq.AddCookie(&http.Cookie{Name: pendingCookieName, Value: loginPendingCookie})
	h.PostTotpVerify(verifyRec, verifyReq)
	if verifyRec.Code != http.StatusOK {
		t.Fatalf("totp verify status = %d, want 200, body=%s", verifyRec.Code, verifyRec.Body)
	}
	sessionCookie := cookieFrom(verifyRec, sessionCookieName)
	if sessionCookie == "" {
		t.Fatal("totp verify did not set the session cookie")
	}

	meRec := httptest.NewRecorder()
	meReq := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	meReq.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionCookie})
	h.GetMe(meRec, meReq)
	if meRec.Code != http.StatusOK {
		t.Fatalf("me status = %d, want 200, body=%s", meRec.Code, meRec.Body)
	}

	logoutRec := httptest.NewRecorder()
	logoutReq := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	logoutReq.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionCookie})
	h.PostLogout(logoutRec, logoutReq)
	if logoutRec.Code != http.StatusNoContent {
		t.Errorf("logout status = %d, want 204", logoutRec.Code)
	}

	meRec2 := httptest.NewRecorder()
	meReq2 := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	meReq2.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionCookie})
	h.GetMe(meRec2, meReq2)
	if meRec2.Code != http.StatusUnauthorized {
		t.Errorf("me after logout status = %d, want 401", meRec2.Code)
	}
}

func TestLoginLockoutReturns423(t *testing.T) {
	h := newTestAuthHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", jsonBody(t, map[string]string{
		"email": "owner@example.com", "password": "correct horse battery staple",
	}))
	h.PostRegister(rec, req)

	for i := 0; i < 5; i++ {
		badRec := httptest.NewRecorder()
		badReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", jsonBody(t, map[string]string{
			"email": "owner@example.com", "password": "wrong password",
		}))
		h.PostLogin(badRec, badReq)
	}
	lockedRec := httptest.NewRecorder()
	lockedReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", jsonBody(t, map[string]string{
		"email": "owner@example.com", "password": "wrong password",
	}))
	h.PostLogin(lockedRec, lockedReq)
	if lockedRec.Code != http.StatusLocked {
		t.Fatalf("status = %d, want 423, body=%s", lockedRec.Code, lockedRec.Body)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/handler/... -run 'TestRegisterLoginTotpFullFlow|TestLoginLockoutReturns423' -v`
Expected: FAIL (build error — `AuthHandler` etc. undefined)

- [ ] **Step 3: Implement**

Create `backend/internal/handler/auth.go`:

```go
package handler

import (
	"net/http"
	"time"

	"loom/backend/internal/service"
)

const (
	sessionCookieName = "loom_session"
	pendingCookieName = "loom_pending"
)

// AuthHandler handles registration, login, TOTP enrollment/verification,
// logout, and the current-user endpoint.
type AuthHandler struct {
	svc *service.AuthService
}

// NewAuthHandler creates an auth handler.
func NewAuthHandler(svc *service.AuthService) *AuthHandler {
	return &AuthHandler{svc: svc}
}

func setAuthCookie(w http.ResponseWriter, name, value string, maxAge time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(maxAge.Seconds()),
	})
}

func clearAuthCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
	})
}

func cookieValue(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return c.Value
}

// PostRegister handles POST /api/auth/register.
func (h *AuthHandler) PostRegister(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	user, pendingToken, err := h.svc.Register(body.Email, body.Password)
	if handleStoreErr(w, err) {
		return
	}
	setAuthCookie(w, pendingCookieName, pendingToken, 2*time.Minute)
	writeJSON(w, http.StatusCreated, user)
}

// PostLogin handles POST /api/auth/login.
func (h *AuthHandler) PostLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	pendingToken, err := h.svc.Login(body.Email, body.Password)
	if handleStoreErr(w, err) {
		return
	}
	setAuthCookie(w, pendingCookieName, pendingToken, 2*time.Minute)
	writeJSON(w, http.StatusOK, map[string]string{"status": "totp_required"})
}

// pendingUserID resolves the pending-login cookie to a user ID, falling
// back to an established session. Writes a 401 and returns ok=false if
// neither is valid.
func (h *AuthHandler) pendingUserID(w http.ResponseWriter, r *http.Request) (string, bool) {
	if pendingToken := cookieValue(r, pendingCookieName); pendingToken != "" {
		if userID, err := h.svc.PendingUserID(pendingToken); err == nil {
			return userID, true
		}
	}
	if sessionToken := cookieValue(r, sessionCookieName); sessionToken != "" {
		if user, err := h.svc.CurrentUser(sessionToken); err == nil {
			return user.ID, true
		}
	}
	writeErr(w, http.StatusUnauthorized, "unauthorized")
	return "", false
}

// PostTotpSetup handles POST /api/auth/totp/setup.
func (h *AuthHandler) PostTotpSetup(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.pendingUserID(w, r)
	if !ok {
		return
	}
	_, otpauthURI, err := h.svc.BeginTotpEnrollment(userID)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"otpauthUri": otpauthURI})
}

// PostTotpVerifySetup handles POST /api/auth/totp/verify-setup.
func (h *AuthHandler) PostTotpVerifySetup(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.pendingUserID(w, r)
	if !ok {
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	backupCodes, err := h.svc.ConfirmTotpEnrollment(userID, body.Code)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"backupCodes": backupCodes})
}

// PostTotpVerify handles POST /api/auth/totp/verify, completing login.
func (h *AuthHandler) PostTotpVerify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	sessionToken, user, err := h.svc.VerifyTotp(cookieValue(r, pendingCookieName), body.Code)
	if handleStoreErr(w, err) {
		return
	}
	clearAuthCookie(w, pendingCookieName)
	setAuthCookie(w, sessionCookieName, sessionToken, 30*24*time.Hour)
	writeJSON(w, http.StatusOK, user)
}

// PostLogout handles POST /api/auth/logout.
func (h *AuthHandler) PostLogout(w http.ResponseWriter, r *http.Request) {
	_ = h.svc.Logout(cookieValue(r, sessionCookieName))
	clearAuthCookie(w, sessionCookieName)
	w.WriteHeader(http.StatusNoContent)
}

// GetMe handles GET /api/auth/me.
func (h *AuthHandler) GetMe(w http.ResponseWriter, r *http.Request) {
	user, err := h.svc.CurrentUser(cookieValue(r, sessionCookieName))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, user)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go vet ./... && go test ./internal/handler/... -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handler/auth.go backend/internal/handler/auth_test.go
git commit -m "feat(auth): add auth HTTP handlers with cookie-based session issuance"
```

---

## Task 10: Middleware `RequireAuth` + `main.go` wiring

**Files:**
- Modify: `backend/internal/handler/middleware.go`
- Modify: `backend/internal/handler/middleware_test.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `service.AuthService.CurrentUser` (Task 8), `handler.AuthHandler` (Task 9), cookie name constants (Task 9).
- Produces: `func RequireAuth(svc *service.AuthService) func(http.Handler) http.Handler`, and in `main.go` a `loadOrCreateAuthKey(dbPath string) ([]byte, error)` helper (env var `LOOM_AUTH_KEY`, base64-encoded 32 bytes, or an auto-generated key persisted to `auth.key` beside the DB — matches the app's existing zero-config local-app pattern, e.g. `defaultDBPath()`).

- [ ] **Step 1: Write the failing tests**

Add to `backend/internal/handler/middleware_test.go` (add imports `"net/http/httptest"` if not already present, `"path/filepath"`, `"time"`, `"loom/backend/internal/store"`, `"github.com/pquerna/otp/totp"`):

```go
func newTestAuthServiceForMiddleware(t *testing.T) *service.AuthService {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return service.NewAuthService(store.New(db), make([]byte, 32))
}

func TestRequireAuthAllowsPublicPathWithoutCookie(t *testing.T) {
	svc := newTestAuthServiceForMiddleware(t)
	called := false
	mw := RequireAuth(svc)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/auth/login", nil))
	if !called {
		t.Error("RequireAuth blocked a public path")
	}
}

func TestRequireAuthBlocksProtectedPathWithoutCookie(t *testing.T) {
	svc := newTestAuthServiceForMiddleware(t)
	called := false
	mw := RequireAuth(svc)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces", nil))
	if called {
		t.Error("RequireAuth let a protected path through without a session cookie")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestRequireAuthBlocksTerminalWebsocketPathWithoutCookie(t *testing.T) {
	svc := newTestAuthServiceForMiddleware(t)
	called := false
	mw := RequireAuth(svc)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ws/terminal", nil))
	if called {
		t.Error("RequireAuth let /ws/terminal through without a session cookie")
	}
}

func TestRequireAuthAllowsProtectedPathWithValidCookie(t *testing.T) {
	svc := newTestAuthServiceForMiddleware(t)
	user, _, err := svc.Register("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	secret, _, err := svc.BeginTotpEnrollment(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	setupCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmTotpEnrollment(user.ID, setupCode); err != nil {
		t.Fatal(err)
	}
	pendingToken, err := svc.Login("owner@example.com", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	loginCode, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	sessionToken, _, err := svc.VerifyTotp(pendingToken, loginCode)
	if err != nil {
		t.Fatal(err)
	}

	called := false
	mw := RequireAuth(svc)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/workspaces", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionToken})
	mw.ServeHTTP(rec, req)
	if !called {
		t.Errorf("RequireAuth blocked a valid session, status = %d, body=%s", rec.Code, rec.Body)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/handler/... -run TestRequireAuth -v`
Expected: FAIL (build error — `RequireAuth` undefined)

- [ ] **Step 3: Implement `RequireAuth`**

Add to `backend/internal/handler/middleware.go` (add `"loom/backend/internal/service"` to imports if not already present from Task 5):

```go
// RequireAuth returns middleware requiring a valid session cookie for every
// request except a small public-path allowlist. It protects both the JSON
// API and the /ws/terminal WebSocket upgrade (arbitrary shell access) since
// both are registered on the same mux.
func RequireAuth(svc *service.AuthService) func(http.Handler) http.Handler {
	publicPaths := map[string]bool{
		"/api/health":                  true,
		"/api/auth/register":           true,
		"/api/auth/login":              true,
		"/api/auth/totp/setup":         true,
		"/api/auth/totp/verify-setup":  true,
		"/api/auth/totp/verify":        true,
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if publicPaths[r.URL.Path] {
				next.ServeHTTP(w, r)
				return
			}
			if !strings.HasPrefix(r.URL.Path, "/api") && r.URL.Path != "/ws/terminal" {
				next.ServeHTTP(w, r) // static SPA assets stay public
				return
			}
			cookie, err := r.Cookie(sessionCookieName)
			if err != nil {
				writeErr(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			if _, err := svc.CurrentUser(cookie.Value); err != nil {
				writeErr(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
```

(`strings` is already imported in `middleware.go` for `JSONErrorMiddleware`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go vet ./... && go test ./internal/handler/... -v`
Expected: PASS

- [ ] **Step 5: Wire into `main.go`**

In `backend/cmd/server/main.go`, add to the import block: `"crypto/rand"`, `"encoding/base64"`, `"fmt"`, `"strings"`.

Add this function near `defaultDBPath`/`envOr`:

```go
// loadOrCreateAuthKey resolves the AES-256 key used to encrypt TOTP secrets
// at rest. LOOM_AUTH_KEY (base64, 32 bytes) takes precedence; otherwise a
// key is generated once and persisted beside the database, matching the
// app's zero-config local-app model (see defaultDBPath).
func loadOrCreateAuthKey(dbPath string) ([]byte, error) {
	if envKey := os.Getenv("LOOM_AUTH_KEY"); envKey != "" {
		key, err := base64.StdEncoding.DecodeString(envKey)
		if err != nil || len(key) != 32 {
			return nil, fmt.Errorf("LOOM_AUTH_KEY must be a base64-encoded 32-byte key")
		}
		return key, nil
	}
	keyPath := filepath.Join(filepath.Dir(dbPath), "auth.key")
	if data, err := os.ReadFile(keyPath); err == nil {
		key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
		if err != nil || len(key) != 32 {
			return nil, fmt.Errorf("corrupt auth key file %s", keyPath)
		}
		return key, nil
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.WriteFile(keyPath, []byte(base64.StdEncoding.EncodeToString(key)), 0o600); err != nil {
		return nil, err
	}
	return key, nil
}
```

After `st := store.New(db)`, add:

```go
	authKey, err := loadOrCreateAuthKey(*dbPath)
	if err != nil {
		log.Fatalf("auth key: %v", err)
	}
	authSvc := service.NewAuthService(st, authKey)
	authH := handler.NewAuthHandler(authSvc)
```

Add route registrations, grouped near the top with the other public-ish routes:

```go
	mux.HandleFunc("POST /api/auth/register", authH.PostRegister)
	mux.HandleFunc("POST /api/auth/login", authH.PostLogin)
	mux.HandleFunc("POST /api/auth/totp/setup", authH.PostTotpSetup)
	mux.HandleFunc("POST /api/auth/totp/verify-setup", authH.PostTotpVerifySetup)
	mux.HandleFunc("POST /api/auth/totp/verify", authH.PostTotpVerify)
	mux.HandleFunc("POST /api/auth/logout", authH.PostLogout)
	mux.HandleFunc("GET /api/auth/me", authH.GetMe)
```

Change the middleware chain line from:

```go
	root := handler.CorsMiddleware(handler.JSONErrorMiddleware(mux))
```

to:

```go
	root := handler.CorsMiddleware(handler.JSONErrorMiddleware(handler.RequireAuth(authSvc)(mux)))
```

- [ ] **Step 6: Build and manually verify**

Run:
```bash
cd backend && go build ./... && go vet ./...
```
Expected: builds cleanly.

Then manually verify the gate is live:
```bash
cd backend && go run ./cmd/server --db /tmp/loom-auth-check.db --open=false &
sleep 1
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8989/api/workspaces
# Expect: 401 (protected route rejects without a session cookie)
curl -s -X POST http://127.0.0.1:8989/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@example.com","password":"correct horse battery staple"}'
# Expect: 201 with {"id":"u-...","email":"owner@example.com","totpEnabled":false,"createdAt":"..."}
kill %1
rm -f /tmp/loom-auth-check.db /tmp/loom-auth-check.db-wal /tmp/loom-auth-check.db-shm /tmp/auth.key
```

- [ ] **Step 7: Document the new env var**

In `COMMANDS.md`, add to the bullet list under "The Go backend accepts flags:":

```markdown
- `LOOM_AUTH_KEY` — base64-encoded 32-byte AES key used to encrypt TOTP
  secrets at rest (env only, no flag). If unset, a key is generated once and
  stored as `auth.key` beside the database.
```

- [ ] **Step 8: Run the full backend suite**

Run: `cd backend && go vet ./... && go test ./...`
Expected: all PASS

- [ ] **Step 9: Commit**

```bash
git add backend/internal/handler/middleware.go backend/internal/handler/middleware_test.go backend/cmd/server/main.go COMMANDS.md
git commit -m "feat(auth): gate all API routes and /ws/terminal behind RequireAuth"
```

---

## Task 11: Frontend — `User` type + `api.ts` auth functions

**Files:**
- Modify: `frontend/src/store/types.ts`
- Modify: `frontend/src/lib/api.ts`

**Interfaces:**
- Produces: `interface User { id: string; email: string; totpEnabled: boolean; createdAt: string }` and functions `register`, `login`, `setupTotp`, `verifyTotpSetup`, `verifyTotp`, `logout`, `fetchMe` in `api.ts`. Consumed by `authQueries.ts` in Task 12.

- [ ] **Step 1: Add the `User` type**

In `frontend/src/store/types.ts`, add:

```ts
/** The single Loom operator account. Never carries a password or TOTP secret. */
export interface User {
  id: string
  email: string
  totpEnabled: boolean
  createdAt: string
}
```

- [ ] **Step 2: Add auth API functions**

In `frontend/src/lib/api.ts`, add `User` to the existing `import type { ... } from '@/store/types'` block, and append at the end of the file:

```ts
export interface RegisterBody {
  email: string
  password: string
}

export interface LoginBody {
  email: string
  password: string
}

export interface TotpCodeBody {
  code: string
}

export interface TotpSetupResponse {
  otpauthUri: string
}

export interface TotpVerifySetupResponse {
  backupCodes: string[]
}

export interface LoginResponse {
  status: 'totp_required'
}

export function register(body: RegisterBody): Promise<User> {
  return request<User>('POST', '/auth/register', body)
}

export function login(body: LoginBody): Promise<LoginResponse> {
  return request<LoginResponse>('POST', '/auth/login', body)
}

export function setupTotp(): Promise<TotpSetupResponse> {
  return request<TotpSetupResponse>('POST', '/auth/totp/setup')
}

export function verifyTotpSetup(body: TotpCodeBody): Promise<TotpVerifySetupResponse> {
  return request<TotpVerifySetupResponse>('POST', '/auth/totp/verify-setup', body)
}

export function verifyTotp(body: TotpCodeBody): Promise<User> {
  return request<User>('POST', '/auth/totp/verify', body)
}

export function logout(): Promise<void> {
  return request<void>('POST', '/auth/logout')
}

export function fetchMe(): Promise<User> {
  return request<User>('GET', '/auth/me')
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/store/types.ts frontend/src/lib/api.ts
git commit -m "feat(auth): add User type and auth API client functions"
```

---

## Task 12: Frontend — `qrcode` dependency + `authQueries.ts` hooks

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/src/features/data/keys.ts`
- Create: `frontend/src/features/data/authQueries.ts`

**Interfaces:**
- Consumes: `register`/`login`/`setupTotp`/`verifyTotpSetup`/`verifyTotp`/`logout`/`fetchMe` (Task 11).
- Produces: `qk.me` query key; `meQueryOptions` (shared between `useMe()` and the root route guard in Task 16 so both use the exact same `retry: false` behavior); hooks `useMe`, `useRegister`, `useLogin`, `useSetupTotp`, `useVerifyTotpSetup`, `useVerifyTotp`, `useLogout`. Consumed by the route files in Tasks 13-16.

- [ ] **Step 1: Install the QR code library**

Run:
```bash
cd frontend && npm install qrcode && npm install -D @types/qrcode
```

- [ ] **Step 2: Add the `me` query key**

In `frontend/src/features/data/keys.ts`, add to the `qk` object:

```ts
  me: ['me'] as const,
```

- [ ] **Step 3: Create the auth query hooks**

Create `frontend/src/features/data/authQueries.ts`:

```ts
// React-query hooks for authentication endpoints.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchMe, login, logout, register, setupTotp, verifyTotp, verifyTotpSetup } from '@/lib/api'
import { qk } from '@/features/data/keys'

/** Shared so the root route guard's ensureQueryData and useMe() behave identically. */
export const meQueryOptions = {
  queryKey: qk.me,
  queryFn: fetchMe,
  retry: false,
} as const

export function useMe() {
  return useQuery(meQueryOptions)
}

export function useRegister() {
  return useMutation({ mutationFn: register })
}

export function useLogin() {
  return useMutation({ mutationFn: login })
}

export function useSetupTotp() {
  return useMutation({ mutationFn: setupTotp })
}

export function useVerifyTotpSetup() {
  return useMutation({ mutationFn: verifyTotpSetup })
}

export function useVerifyTotp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: verifyTotp,
    onSuccess: (user) => queryClient.setQueryData(qk.me, user),
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: logout,
    onSuccess: () => queryClient.setQueryData(qk.me, undefined),
  })
}
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/features/data/keys.ts frontend/src/features/data/authQueries.ts
git commit -m "feat(auth): add qrcode dependency and auth query hooks"
```

---

## Task 13: Frontend — `login.tsx` route

**Files:**
- Create: `frontend/src/routes/login.tsx`

**Interfaces:**
- Consumes: `useLogin`, `useVerifyTotp` (Task 12), `Button`/`Input`/`Label` (existing `components/ui/`), `ApiError` (existing `lib/api.ts`).
- Produces: route `/login`, referenced by the root guard redirect in Task 16 and the `register.tsx`/`2fa-setup.tsx` navigation in Tasks 14-15.

- [ ] **Step 1: Create the route**

Create `frontend/src/routes/login.tsx`:

```tsx
import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api'
import { useLogin, useVerifyTotp } from '@/features/data/authQueries'

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const login = useLogin()
  const verifyTotp = useVerifyTotp()
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submitCredentials() {
    setError(null)
    login.mutate(
      { email, password },
      {
        onSuccess: () => setStep('totp'),
        onError: (err) => setError(err instanceof ApiError ? err.message : 'Login failed'),
      },
    )
  }

  function submitTotp() {
    setError(null)
    verifyTotp.mutate(
      { code },
      {
        onSuccess: () => navigate({ to: '/' }),
        onError: (err) => setError(err instanceof ApiError ? err.message : 'Invalid code'),
      },
    )
  }

  const lockedUntilMatch = error?.match(/until (\S+)/)

  return (
    <div className="flex h-screen w-full items-center justify-center bg-loom-bg text-loom-fg">
      <div className="w-[360px]">
        <h1 className="mb-6 text-lg font-medium">Sign in to Loom</h1>

        {step === 'credentials' && (
          <>
            <Label>Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mb-4"
              autoFocus
            />
            <Label>Password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitCredentials()}
              className="mb-5"
            />
            {error && (
              <p className="mb-4 text-[12px] text-loom-red-soft">
                {lockedUntilMatch ? `Too many attempts. Try again after ${lockedUntilMatch[1]}.` : error}
              </p>
            )}
            <Button onClick={submitCredentials} disabled={login.isPending} className="w-full">
              {login.isPending ? 'Signing in…' : 'Continue →'}
            </Button>
            <p className="mt-4 text-center text-[12px] text-loom-muted">
              First time? <Link to="/register" className="underline">Create an account</Link>
            </p>
          </>
        )}

        {step === 'totp' && (
          <>
            <Label>Authenticator code</Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitTotp()}
              placeholder="6-digit code or backup code"
              className="mb-5"
              autoFocus
            />
            {error && <p className="mb-4 text-[12px] text-loom-red-soft">{error}</p>}
            <Button onClick={submitTotp} disabled={verifyTotp.isPending} className="w-full">
              {verifyTotp.isPending ? 'Verifying…' : 'Verify →'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors (TanStack Router's Vite plugin regenerates `routeTree.gen.ts` automatically when the dev server is running; if typecheck complains about an unknown route, run `cd frontend && npx @tanstack/router-plugin --target react` first per `COMMANDS.md`)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/routes/login.tsx frontend/src/routeTree.gen.ts
git commit -m "feat(auth): add login route with credentials + TOTP steps"
```

---

## Task 14: Frontend — `register.tsx` route

**Files:**
- Create: `frontend/src/routes/register.tsx`

**Interfaces:**
- Consumes: `useRegister` (Task 12).
- Produces: route `/register`, navigates to `/2fa-setup` (Task 15) on success.

- [ ] **Step 1: Create the route**

Create `frontend/src/routes/register.tsx`:

```tsx
import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api'
import { useRegister } from '@/features/data/authQueries'

export const Route = createFileRoute('/register')({
  component: RegisterPage,
})

function RegisterPage() {
  const navigate = useNavigate()
  const register = useRegister()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit() {
    setError(null)
    register.mutate(
      { email, password },
      {
        onSuccess: () => navigate({ to: '/2fa-setup' }),
        onError: (err) => setError(err instanceof ApiError ? err.message : 'Registration failed'),
      },
    )
  }

  return (
    <div className="flex h-screen w-full items-center justify-center bg-loom-bg text-loom-fg">
      <div className="w-[360px]">
        <h1 className="mb-1 text-lg font-medium">Create the Loom operator account</h1>
        <p className="mb-6 text-[12px] text-loom-muted">
          One account per install. Two-factor setup is required next.
        </p>
        <Label>Email</Label>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mb-4"
          autoFocus
        />
        <Label>Password</Label>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="at least 12 characters"
          className="mb-5"
        />
        {error && <p className="mb-4 text-[12px] text-loom-red-soft">{error}</p>}
        <Button onClick={submit} disabled={register.isPending} className="w-full">
          {register.isPending ? 'Creating…' : 'Create account →'}
        </Button>
        <p className="mt-4 text-center text-[12px] text-loom-muted">
          Already have an account? <Link to="/login" className="underline">Sign in</Link>
        </p>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/routes/register.tsx frontend/src/routeTree.gen.ts
git commit -m "feat(auth): add register route"
```

---

## Task 15: Frontend — `2fa-setup.tsx` route

**Files:**
- Create: `frontend/src/routes/2fa-setup.tsx`

**Interfaces:**
- Consumes: `useSetupTotp`, `useVerifyTotpSetup` (Task 12), `qrcode` (Task 12).
- Produces: route `/2fa-setup`, navigates to `/login` once backup codes are acknowledged (no session exists yet at this point — TOTP enrollment alone doesn't log the user in; a real login with the newly-enrolled 2FA is still required).

- [ ] **Step 1: Create the route**

Create `frontend/src/routes/2fa-setup.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import QRCode from 'qrcode'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api'
import { useSetupTotp, useVerifyTotpSetup } from '@/features/data/authQueries'

export const Route = createFileRoute('/2fa-setup')({
  component: TotpSetupPage,
})

function TotpSetupPage() {
  const navigate = useNavigate()
  const setupTotp = useSetupTotp()
  const verifyTotpSetup = useVerifyTotpSetup()
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)

  useEffect(() => {
    setupTotp.mutate(undefined, {
      onSuccess: async (res) => {
        setQrDataUrl(await QRCode.toDataURL(res.otpauthUri))
      },
      onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not start 2FA setup'),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function submit() {
    setError(null)
    verifyTotpSetup.mutate(
      { code },
      {
        onSuccess: (res) => setBackupCodes(res.backupCodes),
        onError: (err) => setError(err instanceof ApiError ? err.message : 'Invalid code'),
      },
    )
  }

  if (backupCodes) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-loom-bg text-loom-fg">
        <div className="w-[400px]">
          <h1 className="mb-1 text-lg font-medium">Save your backup codes</h1>
          <p className="mb-4 text-[12px] text-loom-muted">
            Each code works once, if you lose your authenticator. They will not be shown again.
          </p>
          <div className="mb-6 grid grid-cols-2 gap-2 rounded-lg border border-loom-border-strong bg-loom-elevated p-3 font-mono text-[12.5px]">
            {backupCodes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <Button onClick={() => navigate({ to: '/login' })} className="w-full">
            I've saved these — sign in →
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen w-full items-center justify-center bg-loom-bg text-loom-fg">
      <div className="w-[360px]">
        <h1 className="mb-1 text-lg font-medium">Set up two-factor authentication</h1>
        <p className="mb-4 text-[12px] text-loom-muted">
          Scan this QR code with an authenticator app (Google Authenticator, Authy, 1Password).
        </p>
        {qrDataUrl && (
          <img src={qrDataUrl} alt="TOTP QR code" className="mb-4 h-[200px] w-[200px] rounded-lg bg-white p-2" />
        )}
        <Label>6-digit code</Label>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="mb-5"
          autoFocus
        />
        {error && <p className="mb-4 text-[12px] text-loom-red-soft">{error}</p>}
        <Button onClick={submit} disabled={verifyTotpSetup.isPending} className="w-full">
          {verifyTotpSetup.isPending ? 'Verifying…' : 'Enable 2FA →'}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/routes/2fa-setup.tsx frontend/src/routeTree.gen.ts
git commit -m "feat(auth): add TOTP setup route with QR code and backup codes"
```

---

## Task 16: Frontend — root route guard + end-to-end verification

**Files:**
- Modify: `frontend/src/routes/__root.tsx`

**Interfaces:**
- Consumes: `meQueryOptions` (Task 12).
- Produces: a `beforeLoad` guard on every route except `/login`, `/register`, `/2fa-setup`, redirecting to `/login` when `GET /api/auth/me` fails.

- [ ] **Step 1: Add the guard**

Replace the contents of `frontend/src/routes/__root.tsx` with:

```tsx
import { createRootRouteWithContext, Outlet, redirect } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { meQueryOptions } from '@/features/data/authQueries'

export interface RouterContext {
  queryClient: QueryClient
}

const PUBLIC_PATHS = new Set(['/login', '/register', '/2fa-setup'])

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    if (PUBLIC_PATHS.has(location.pathname)) return
    try {
      await context.queryClient.ensureQueryData(meQueryOptions)
    } catch {
      throw redirect({ to: '/login' })
    }
  },
  component: RootComponent,
})

function RootComponent() {
  return (
    <>
      <Outlet />
      <Toaster
        theme="dark"
        position="bottom-center"
        toastOptions={{
          style: {
            background: 'var(--loom-elevated)',
            border: '1px solid var(--loom-border-accent)',
            color: 'var(--loom-fg-2)',
            fontSize: '12.5px',
            fontFamily: 'var(--font-sans)',
          },
        }}
      />
    </>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors

- [ ] **Step 3: Full-stack manual verification**

Run: `cd frontend && npm run dev` (starts both Vite on :5173 and the Go backend on :8989)

In a browser at `http://localhost:5173`:
1. You should be redirected to `/login` (no account exists yet).
2. Click "Create an account", register with a 12+ character password.
3. You land on `/2fa-setup`. Scan the QR code with an authenticator app (Google Authenticator, Authy, or similar), enter the 6-digit code, confirm the backup codes are shown.
4. Click through to `/login`, sign in with the same email/password, then enter the current 6-digit code from your authenticator app.
5. Confirm you land on the normal workspace shell (`/`) and can navigate around.
6. Open a new private/incognito window, hit `http://localhost:5173/w/...` directly — confirm it redirects to `/login` (no session cookie there).
7. Back in the logged-in window, log out (add a logout affordance to the header for this check if none exists yet, or call `POST /api/auth/logout` via the browser devtools console using `fetch('/api/auth/logout', {method:'POST'})`) and confirm `/api/auth/me` then returns 401 and the app redirects to `/login`.
8. On `/login`, deliberately enter the wrong password 5 times — confirm the 6th attempt shows the "Too many attempts" message with a timestamp, and that trying again immediately still fails.

- [ ] **Step 4: Run the full test suites one more time**

Run:
```bash
cd backend && go vet ./... && go test ./...
cd frontend && npm run typecheck
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/routes/__root.tsx
git commit -m "feat(auth): gate the whole SPA behind a root route auth guard"
```

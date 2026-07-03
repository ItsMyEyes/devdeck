# Authentication + TOTP 2FA + Escalating Lockout — Design

## Context

Loom currently has **zero authentication**. Every `/api/*` route and the `/ws/terminal`
WebSocket (which grants arbitrary shell access via PTY) are open to anyone who can
reach the loopback port. This adds mandatory email/password registration, mandatory
TOTP-based 2FA, session-cookie auth, and an escalating account-lockout policy for
repeated failed logins.

Confirmed scope decisions (from brainstorming):
- **Single operator only** — matches Loom's "one operator, many companies" design.
  Registration is a one-time setup step; a second `POST /api/auth/register` is
  rejected once one user exists. No roles/admin/user-management UI.
- **Server-side session cookie** (opaque random token, hashed in SQLite), not JWT —
  trivially revocable, fits the existing `port.Store` pattern.
- **Lockout tracked per account (email)**, not per-IP.
- **Lockout escalation capped at 24h**, decaying back to the 5-minute base after
  24 hours with no failed attempts.
- **2FA is TOTP via authenticator app** (RFC 6238), with one-time backup codes for
  device loss. Registration itself only collects email + password; TOTP enrollment
  is a mandatory follow-up step before the account is usable.

Out of scope (explicitly deferred, flag if wrong):
- No "forgot password" email flow (no SMTP infrastructure exists). Backup codes are
  the only recovery path for a lost authenticator device.
- No multi-user management UI (roles, invites).

## Architecture

Follows the canonical feature order from `ARCHITECTURE.md`: domain types → `port.Store`
interface + patch types → `internal/store/` impl → `internal/service/` → `internal/handler/`
→ route registration in `main.go` → `frontend/src/lib/api.ts` → query hooks → UI/routes.

### Data model

Add to `backend/internal/domain/models.go` (mirrored in `frontend/src/store/types.ts`).
Sensitive fields use the existing `json:"-"` convention already used for
`Worktree.ProjectID` / `Issue.ProjectID` — same mechanism, so no new pattern is
introduced:

```go
// User mirrors the frontend User type. Sensitive fields are tagged json:"-"
// and never serialize to API responses.
type User struct {
	ID               string     `json:"id"`
	Email            string     `json:"email"`
	TotpEnabled      bool       `json:"totpEnabled"`
	CreatedAt        string     `json:"createdAt"`
	PasswordHash     string     `json:"-"`
	TotpSecretEnc    string     `json:"-"`
	BackupCodeHashes []string   `json:"-"`
	FailedAttempts   int        `json:"-"`
	LockoutLevel     int        `json:"-"`
	LockedUntil      *string    `json:"-"`
	LastFailedAt     *string    `json:"-"`
}
```

Frontend `User` type in `types.ts` only ever needs `{ id, email, totpEnabled, createdAt }`
— the `json:"-"` fields never cross the wire, so there's nothing to mirror for them.

Sessions and pending-2FA-login tokens are backend-internal concepts (never
serialized to the frontend), so they don't need a `domain` type — they're plain
structs/params inside the `store` package, same tier as SQL-only concerns.

New SQLite tables (added to the `schema` const in `backend/internal/store/db.go`,
following the existing `CREATE TABLE IF NOT EXISTS` style — no migration needed
since these are brand-new tables, not new columns on existing ones):

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

-- Short-lived (2 min) token issued after password success, before TOTP is verified.
CREATE TABLE IF NOT EXISTS pending_logins (
  id         TEXT PRIMARY KEY,  -- SHA-256 hash of the token, same reasoning as sessions
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
```

IDs: `idGen("u-")` for users, matching the existing type-prefixed hex convention
(`ws-`, `p-`, `w-`, `co-`, ...). Session/pending-login rows are keyed by token
hash, not a generated ID.

### Store layer (`backend/internal/port/store.go`, `backend/internal/store/user.go`, `session.go`)

New `port.Store` methods, following the exact naming/shape conventions already in
the interface (`CreateX`, `UpdateX` with a `*Patch`, methods return `(domain.X, error)`):

```go
CreateUser(email, passwordHash string) (domain.User, error)
UserByEmail(email string) (domain.User, error)
UserByID(id string) (domain.User, error)
UserCount() (int, error)
UpdateUser(id string, p UserPatch) (domain.User, error)

CreateSession(userID, tokenHash string, expiresAt time.Time) error
SessionUserID(tokenHash string) (string, error) // ErrNotFound if missing/expired
DeleteSession(tokenHash string) error

CreatePendingLogin(userID, tokenHash string, expiresAt time.Time) error
PendingLoginUserID(tokenHash string) (string, error) // ErrNotFound if missing/expired
DeletePendingLogin(tokenHash string) error
```

`UserPatch` follows the existing optional-pointer-field pattern (see `IssuePatch`):

```go
type UserPatch struct {
	TotpSecretEnc    *string
	TotpEnabled      *bool
	BackupCodeHashes *[]string
	FailedAttempts   *int
	LockoutLevel     *int
	LockedUntil      *string
	HasLockedUntil   bool // allows explicit clear-to-null
	LastFailedAt     *string
}
```

Store implementation in `backend/internal/store/user.go` and `session.go` follows the
exact `scanX`/`XByID`/`CreateX`/`UpdateX` style shown in `store/company.go`, reusing
`idGen`, `mapNotFound`, `firstErr`, `setStr`/`setInt`/new `setBool`/`setStrSlice`
helpers in `store/helpers.go`.

### Service layer (`backend/internal/service/auth.go`)

New sentinel errors in `service/errors.go` (extending the existing
`ErrValidation`/`ErrConflict` pattern) so `handleStoreErr` stays the single place
that maps errors to HTTP status, per CONTRACTS.md:

```go
var ErrUnauthorized = errors.New("unauthorized") // -> 401
var ErrLocked       = errors.New("locked")       // -> 423
```

`handleStoreErr` in `handler/middleware.go` gets two more `errors.Is` branches for
these, exactly like the existing `ErrValidation`/`ErrConflict` branches.

`AuthService` methods:

- `Register(email, password string) (domain.User, pendingToken string, err error)` —
  rejects with `ErrConflict` if `UserCount() > 0`. Validates password length (min
  12 chars) and checks against a small hardcoded common-password blocklist,
  returning `ErrValidation` on failure. Hashes with
  `bcrypt.GenerateFromPassword(..., 12)`. Since the new account has
  `TotpEnabled = false`, it immediately issues a `pending_logins` row (same
  mechanism the post-password step of `Login` uses) so the handler can set the
  same `loom_pending` cookie and hand off straight into the TOTP-enrollment step
  — there's no separate "registered but not yet in any pending/session state" limbo.
- `BeginTotpEnrollment(userID string) (secret, otpauthURI string, err error)` —
  generates a TOTP secret (`github.com/pquerna/otp/totp.Generate`), encrypts it
  with AES-GCM (key from `LOOM_AUTH_KEY` env var) before persisting via
  `UpdateUser`, returns the `otpauth://` URI for client-side QR rendering.
- `ConfirmTotpEnrollment(userID, code string) (backupCodes []string, err error)` —
  verifies the code against the pending secret, flips `TotpEnabled = true`,
  generates 10 backup codes, stores their bcrypt hashes, returns the plaintext
  codes once (never persisted or logged in plaintext).
- `Login(email, password string) (pendingToken string, err error)` — checks
  `LockedUntil`; if still locked, returns `ErrLocked`. Verifies password with
  `bcrypt.CompareHashAndPassword`. On failure, calls `recordFailedAttempt` (below)
  and returns `ErrUnauthorized` with a generic message (same message for "no such
  user" and "wrong password" — no enumeration). On success, resets
  `FailedAttempts`/`LockoutLevel` to 0, issues a `pending_logins` row (2 min TTL,
  random 32-byte token, only its SHA-256 hash stored) and returns the raw token.
- `VerifyTotp(pendingToken, code string) (sessionToken string, user domain.User, err error)`
  — resolves the pending login, verifies the TOTP code (constant-time, via
  `totp.Validate`) or a backup code (bcrypt compare against stored hashes,
  single-use — remove the matched hash from `BackupCodeHashes` on success), deletes
  the pending-login row, creates a `sessions` row (30-day TTL, random 32-byte
  token, only its hash stored), returns the raw token.
- `Logout(sessionToken string) error` — deletes the session row.
- `CurrentUser(sessionToken string) (domain.User, error)` — resolves session → user,
  used by both `GET /api/auth/me` and the auth middleware.

**Lockout algorithm** (in `recordFailedAttempt`):
```
FailedAttempts += 1
if FailedAttempts >= 5:
    duration = min(5min * 2^LockoutLevel, 24h)
    LockedUntil = now + duration
    LockoutLevel += 1
    FailedAttempts = 0
if LastFailedAt != nil and now - LastFailedAt > 24h:
    LockoutLevel = 0   // decay: a clean 24h resets the ladder to the 5-min base
LastFailedAt = now
```
A successful login (`Login` on password match) resets `FailedAttempts = 0` and
`LockoutLevel = 0` unconditionally — proof of legitimate access clears the slate.

### Handler layer (`backend/internal/handler/auth.go`)

```
POST /api/auth/register        {email, password}        -> User (201)
POST /api/auth/login           {email, password}         -> {status:"totp_required"} + Set-Cookie? no —
                                                              pending token goes in a short-lived,
                                                              HttpOnly "loom_pending" cookie, not the body,
                                                              so the frontend never touches raw tokens.
POST /api/auth/totp/setup      (requires pending or authed) -> {otpauthUri}
POST /api/auth/totp/verify-setup {code}                   -> {backupCodes: [...]}, flips totpEnabled
POST /api/auth/totp/verify     {code}                     -> User (200), sets "loom_session" cookie,
                                                              clears "loom_pending" cookie
POST /api/auth/logout          ()                         -> 204, clears "loom_session" cookie
GET  /api/auth/me              ()                         -> User (200) or 401
```

Cookies: `HttpOnly; Secure; SameSite=Strict; Path=/`. (`Secure` is technically
moot for loopback HTTP in local dev, but costs nothing and is correct if Loom is
ever reverse-proxied over TLS.) Locked-out `POST /api/auth/login` responses
include a `retryAfter` (RFC3339 timestamp) in the JSON body alongside the 423
status so the frontend can show a countdown.

### Auth middleware (`backend/internal/handler/middleware.go`)

New `RequireAuth(st *store.Store) func(http.Handler) http.Handler`. Public paths
(checked by exact prefix match, bypass the session check): `/api/auth/register`,
`/api/auth/login`, `/api/auth/totp/setup`, `/api/auth/totp/verify-setup`,
`/api/auth/totp/verify`, `/api/health`. Everything else under `/api/*`, plus
`/ws/terminal` (arbitrary shell access — must not be left open), requires a valid
`loom_session` cookie; on failure returns `401 {"error":"unauthorized"}` for HTTP
requests, or closes the connection before upgrading for the WebSocket case.

Wiring in `main.go` — inserted between the existing two middleware layers, same
"wrap the handler" style already used:
```go
root := handler.CorsMiddleware(handler.JSONErrorMiddleware(handler.RequireAuth(st)(mux)))
```
Static SPA asset serving (`mux.Handle("/", webui.Handler())`) stays public — the
SPA shell loads for anyone, but every API call it makes is gated, and the
frontend route guard (below) redirects to `/login` before rendering anything
sensitive.

### Frontend

- **Types** (`frontend/src/store/types.ts`): add
  `interface User { id: string; email: string; totpEnabled: boolean; createdAt: string }`.
- **API client** (`frontend/src/lib/api.ts`): add `register`, `login`,
  `setupTotp`, `verifyTotpSetup`, `verifyTotp`, `logout`, `fetchMe` following the
  existing `request<T>()` wrapper exactly (no changes needed there — cookies ride
  along automatically via same-origin `fetch` defaults).
- **Query hooks** (`frontend/src/features/data/authQueries.ts`, new file): thin
  `useMutation`/`useQuery` wrappers per the existing `queries.ts` pattern,
  including `useMe()` with `retry: false` (401 is an expected, not exceptional,
  result).
- **Routes** (new top-level files, sibling to `index.tsx`, no parent layout):
  `login.tsx`, `register.tsx`, `2fa-setup.tsx`. Each is a plain form built from
  the existing `Label` + `Input` + `Button` primitives (see
  `NewWorkspaceDialog.tsx` for the established form-submission idiom), using
  local `useState` for credential fields — **not** the persisted zustand store,
  since `useLoomStore`'s `persist` middleware only ever partializes `sidebarOpen`
  and must never gain a credential field.
- **Route guard**: add a `beforeLoad` to `__root.tsx` (currently has none) that
  does `qc.ensureQueryData({ queryKey: ['me'], queryFn: fetchMe })` and
  `throw redirect({ to: '/login' })` on failure — mirroring the existing
  try/catch-redirect idiom already used in `w.$wsId.tsx`. `/login`, `/register`,
  `/2fa-setup` opt out of this check (they must be reachable while unauthenticated).
- **QR rendering**: add the `qrcode` npm package to render the `otpauthUri`
  client-side during 2FA setup — no new Go image dependency needed.

### New dependencies

- Backend: `golang.org/x/crypto/bcrypt` — already present transitively, promote
  to a direct `require` via `go mod tidy`. `github.com/pquerna/otp` — new
  dependency for RFC 6238 TOTP; deliberately not hand-rolled, since a subtly
  wrong HOTP/TOTP implementation is a real, silent security bug and this library
  is small and well-audited.
- Frontend: `qrcode` (+ `@types/qrcode`) for client-side QR rendering.
- New env var: `LOOM_AUTH_KEY` (AES-256 key for encrypting TOTP secrets at rest),
  documented in `COMMANDS.md`.

### Testing

- Backend: table-driven unit tests for the lockout escalation/decay math (inject
  a fake clock), `store/user_test.go` and `store/session_test.go` following the
  exact `newTestStore(t)` + real-tempfile-SQLite pattern from `company_test.go`,
  `service/auth_test.go` for Register/Login/VerifyTotp business logic, and
  `handler` tests using `httptest` for the full register → login → totp round trip.
- Frontend: manual verification in a real browser (register, scan QR with an
  actual authenticator app, wrong-password lockout countdown, backup-code login)
  since this is a security-critical flow that's hard to meaningfully unit-test.

# SSH Management Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-14-ssh-management-design.md` (approved). This plan implements build-order phase 1 only: **connections CRUD + secrets model + interactive shell (password/key auth, TOFU host keys).**

**Goal:** An operator can save an SSH connection to any host (password or private-key auth), open an interactive shell to it as a workspace tile, and have the host's key pinned trust-on-first-use with hard-block + explicit accept on mismatch.

**Architecture:** New `backend/internal/sshmgr` package (sibling of `internal/terminal`) dials hosts with `golang.org/x/crypto/ssh` and bridges a PTY-backed remote shell onto a WebSocket speaking the exact same frame protocol as the existing terminal gateway (`{"t":"i","d":...}` stdin, `{"t":"r","cols","rows"}` resize, raw output frames). `SSHConnection`/`SSHSecret` rows live in the hub's SQLite (operator-global, like `Machine` — NOT per-runtime like `Worktree`); secrets are AES-256-GCM blobs encrypted with the existing auth master key and never serialize to clients. The frontend gets a `Machines`-style settings page (`/w/$wsId/ssh`) and a new `ssh-shell` tile kind in the workspace canvas.

**Phase 1 simplifications (stored in schema, not yet wired):** `ExecutorMachineID` routing (the hub always dials in phase 1), `JumpConnectionID` bastion chaining (phase 3), keychain `StorageKind` (Tauri phase), SFTP (phase 2), port forwarding (phase 3). The schema and domain types carry these fields now so later phases don't rework the data model.

**Tech Stack:** Go 1.22+ (`net/http` enhanced mux patterns), `golang.org/x/crypto/ssh` v0.51.0 (already a direct dep in `backend/go.mod`), `nhooyr.io/websocket`, SQLite via the existing `store` package; React 19 + TanStack Router/Query + zustand + xterm.js on the frontend.

## Global Constraints

- All REST errors use the `{"error":"message"}` envelope via `writeErr`/`handleStoreErr` — never raw SQL/library errors (CONTRACTS.md).
- All persistence goes through the `port.Store` interface; raw SQL only inside `backend/internal/store/`.
- Domain types must stay in sync: `backend/internal/domain/models.go` ⇄ `frontend/src/store/types.ts`.
- Frontend imports use the `@/*` alias; `verbatimModuleSyntax` is on — type-only imports MUST use `import type`.
- Never edit `frontend/src/routeTree.gen.ts` — `npm run typecheck` regenerates it via its `pretypecheck` vite build.
- Convergence files touched by this plan — `backend/cmd/server/main.go`, `backend/internal/domain/models.go`, `backend/internal/port/store.go`, `frontend/src/store/types.ts`, `frontend/src/store/useLoomStore.ts` — must only be edited by strictly sequential tasks. **Never run two tasks of this plan in parallel.**
- Secrets are write-only through the API: they ride in on create/update bodies and never appear in any response (unlike `Machine.Key`, which is deliberately distributed).
- ID convention: SSH connections use the `sc-` prefix via `idGen("sc-")`.
- WS auth: `handler.RequireAuth` already protects every `/ws/` path (cookie or hub key), so the new `/ws/ssh` route needs no extra auth code.
- Backend commands run from `backend/` (Go module root is `backend/go.mod`, module `loom/backend`); frontend commands from `frontend/`.

## File Structure

```
backend/
  internal/domain/models.go            MODIFY  + SSHConnection, SSHSecret structs
  internal/port/store.go               MODIFY  + SSH CRUD/secret methods, SSHConnectionPatch
  internal/store/db.go                 MODIFY  + ssh_connections, ssh_secrets tables
  internal/store/ssh.go                CREATE  store impl (scan/CRUD/host-key/secrets)
  internal/store/ssh_test.go           CREATE  store tests
  internal/service/sshsecret.go        CREATE  SSHSecretService (encrypt/decrypt via authcrypto.go)
  internal/service/sshsecret_test.go   CREATE  roundtrip tests
  internal/handler/ssh.go              CREATE  SSHHandler (CRUD + accept-hostkey)
  internal/handler/ssh_test.go         CREATE  handler tests
  internal/sshmgr/dialer.go            CREATE  Dialer: auth methods + TOFU host-key callback
  internal/sshmgr/server.go            CREATE  WS shell server (frame bridge)
  internal/sshmgr/testserver_test.go   CREATE  in-process SSH server test helper
  internal/sshmgr/dialer_test.go       CREATE  dialer tests
  internal/sshmgr/server_test.go       CREATE  WS integration tests
  cmd/server/main.go                   MODIFY  wire handler + sshmgr, hub-only routes
frontend/src/
  store/types.ts                       MODIFY  + SSHConnection, ModuleView 'ssh'
  lib/api.ts                           MODIFY  + SSH CRUD functions
  lib/sshClient.ts                     CREATE  sshShellWsUrl helper
  features/data/keys.ts                MODIFY  + qk.sshConnections
  features/data/queries.ts             MODIFY  + SSH hooks
  features/tabs/tileTree.ts            MODIFY  + 'ssh-shell' TileTab kind + factory
  features/tabs/tileTree.ssh.test.ts   CREATE  standalone tile tests (npx tsx)
  features/tabs/WorkspaceTileCanvas.tsx MODIFY + sshShell renderer/resolver plumbing
  features/tabs/WorkspaceTileArea.tsx  MODIFY  + SSHShellPane renderer wiring
  features/terminal/Terminal.tsx       MODIFY  export TERMINAL_THEME (rename of local THEME)
  features/ssh/SSHTerminal.tsx         CREATE  xterm ⇄ /ws/ssh wiring
  features/ssh/SSHShellPane.tsx        CREATE  tile body wrapper
  features/ssh/SSHConnectionsModule.tsx CREATE list page
  features/ssh/SSHConnectionDialog.tsx CREATE  add/edit dialog
  routes/w.$wsId.ssh.tsx               CREATE  route
  features/sidebar/SidebarNav.tsx      MODIFY  + SSH nav item
  features/overlays/GlobalOverlays.tsx MODIFY  mount SSHConnectionDialog
  features/overlays/ConfirmDeleteDialog.tsx MODIFY + 'ssh' delete kind
  store/useLoomStore.ts                MODIFY  + sshDialog state, openSSHShellTab, EditKind 'ssh'
```

---

### Task 1: Backend domain types, schema, and store CRUD

**Files:**
- Modify: `backend/internal/domain/models.go` (insert after the `Machine` struct, line ~207)
- Modify: `backend/internal/store/db.go` (insert into the `schema` const, after the `machines` table at line ~174)
- Modify: `backend/internal/port/store.go` (interface block after `MachineByID` line ~84; patch struct after `MachinePatch` line ~182)
- Create: `backend/internal/store/ssh.go`
- Test: `backend/internal/store/ssh_test.go`

**Interfaces:**
- Consumes: `idGen`, `mapNotFound`, `ErrNotFound`, `setStr`, `setInt`, `firstErr`, `scanner` from `store/helpers.go`; `newTestStore(t)` from `store/worktree_test.go`.
- Produces (later tasks rely on these exact signatures):
  - `domain.SSHConnection{ID, Name, Host string; Port int; Username, AuthType string; JumpConnectionID, ExecutorMachineID, HostKeyFingerprint *string}`
  - `domain.SSHSecret{ConnectionID, Kind, StorageKind, CipherText string; KeychainRef *string}` (all `json:"-"`)
  - `port.SSHConnectionPatch{Name, Host *string; Port *int; Username, AuthType *string}`
  - `(*store.Store) SSHConnections() ([]domain.SSHConnection, error)`
  - `(*store.Store) CreateSSHConnection(name, host string, portNum int, username, authType string) (domain.SSHConnection, error)`
  - `(*store.Store) UpdateSSHConnection(id string, p port.SSHConnectionPatch) (domain.SSHConnection, error)` — clears the pinned host key only when `p.Host` names a host different from the stored one
  - `(*store.Store) DeleteSSHConnection(id string) error`
  - `(*store.Store) SSHConnectionByID(id string) (domain.SSHConnection, error)`
  - `(*store.Store) SetSSHHostKey(id string, fingerprint *string) error` (nil clears)
  - `(*store.Store) UpsertSSHSecret(connectionID, kind, cipherText string) error`
  - `(*store.Store) SSHSecret(connectionID, kind string) (domain.SSHSecret, error)`

- [ ] **Step 1: Write the failing store test**

Create `backend/internal/store/ssh_test.go`:

```go
package store

import (
	"strings"
	"testing"

	"loom/backend/internal/port"
)

func TestCreateSSHConnectionRoundtrip(t *testing.T) {
	st := newTestStore(t)
	c, err := st.CreateSSHConnection("prod-web", "web.example.com", 2222, "deploy", "password")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(c.ID, "sc-") {
		t.Errorf("ID = %q, want sc- prefix", c.ID)
	}
	if c.Port != 2222 || c.Username != "deploy" || c.AuthType != "password" {
		t.Errorf("fields not persisted: %+v", c)
	}
	if c.HostKeyFingerprint != nil || c.JumpConnectionID != nil || c.ExecutorMachineID != nil {
		t.Errorf("nullable fields must start nil: %+v", c)
	}
	list, err := st.SSHConnections()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != c.ID {
		t.Errorf("SSHConnections() = %+v, want the created row", list)
	}
}

func TestUpdateSSHConnectionPatchesFields(t *testing.T) {
	st := newTestStore(t)
	c, _ := st.CreateSSHConnection("a", "old.example.com", 22, "root", "password")
	name, portNum := "b", 2200
	got, err := st.UpdateSSHConnection(c.ID, port.SSHConnectionPatch{Name: &name, Port: &portNum})
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "b" || got.Port != 2200 || got.Host != "old.example.com" {
		t.Errorf("patch result = %+v", got)
	}
}

func TestUpdateSSHConnectionHostChangeClearsPinnedKey(t *testing.T) {
	st := newTestStore(t)
	c, _ := st.CreateSSHConnection("a", "old.example.com", 22, "root", "password")
	fp := "SHA256:abc"
	if err := st.SetSSHHostKey(c.ID, &fp); err != nil {
		t.Fatal(err)
	}
	host := "new.example.com"
	got, err := st.UpdateSSHConnection(c.ID, port.SSHConnectionPatch{Host: &host})
	if err != nil {
		t.Fatal(err)
	}
	if got.HostKeyFingerprint != nil {
		t.Errorf("fingerprint = %q, want cleared after host change", *got.HostKeyFingerprint)
	}
}

func TestUpdateSSHConnectionNonHostPatchKeepsPinnedKey(t *testing.T) {
	st := newTestStore(t)
	c, _ := st.CreateSSHConnection("a", "same.example.com", 22, "root", "password")
	fp := "SHA256:abc"
	if err := st.SetSSHHostKey(c.ID, &fp); err != nil {
		t.Fatal(err)
	}
	// Patching only the name (and even re-sending the SAME host, as the edit
	// dialog does) must NOT clear the pin — only an actual host change does.
	name, host := "renamed", "same.example.com"
	got, err := st.UpdateSSHConnection(c.ID, port.SSHConnectionPatch{Name: &name, Host: &host})
	if err != nil {
		t.Fatal(err)
	}
	if got.HostKeyFingerprint == nil || *got.HostKeyFingerprint != fp {
		t.Errorf("fingerprint = %v, want preserved when host is unchanged", got.HostKeyFingerprint)
	}
}

func TestSetSSHHostKeyPinAndClear(t *testing.T) {
	st := newTestStore(t)
	c, _ := st.CreateSSHConnection("a", "h", 22, "u", "password")
	fp := "SHA256:abc"
	if err := st.SetSSHHostKey(c.ID, &fp); err != nil {
		t.Fatal(err)
	}
	got, _ := st.SSHConnectionByID(c.ID)
	if got.HostKeyFingerprint == nil || *got.HostKeyFingerprint != fp {
		t.Fatalf("fingerprint not pinned: %+v", got.HostKeyFingerprint)
	}
	if err := st.SetSSHHostKey(c.ID, nil); err != nil {
		t.Fatal(err)
	}
	got, _ = st.SSHConnectionByID(c.ID)
	if got.HostKeyFingerprint != nil {
		t.Errorf("fingerprint = %q, want cleared", *got.HostKeyFingerprint)
	}
	if err := st.SetSSHHostKey("sc-missing", &fp); err != ErrNotFound {
		t.Errorf("missing id err = %v, want ErrNotFound", err)
	}
}

func TestUpsertSSHSecretReplaces(t *testing.T) {
	st := newTestStore(t)
	c, _ := st.CreateSSHConnection("a", "h", 22, "u", "password")
	if err := st.UpsertSSHSecret(c.ID, "password", "cipher-1"); err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertSSHSecret(c.ID, "password", "cipher-2"); err != nil {
		t.Fatal(err)
	}
	sec, err := st.SSHSecret(c.ID, "password")
	if err != nil {
		t.Fatal(err)
	}
	if sec.CipherText != "cipher-2" || sec.StorageKind != "db" {
		t.Errorf("secret = %+v, want replaced cipher-2", sec)
	}
	if _, err := st.SSHSecret(c.ID, "passphrase"); err != ErrNotFound {
		t.Errorf("missing kind err = %v, want ErrNotFound", err)
	}
}

func TestDeleteSSHConnectionCascadesSecrets(t *testing.T) {
	st := newTestStore(t)
	c, _ := st.CreateSSHConnection("a", "h", 22, "u", "password")
	_ = st.UpsertSSHSecret(c.ID, "password", "cipher")
	if err := st.DeleteSSHConnection(c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SSHConnectionByID(c.ID); err != ErrNotFound {
		t.Errorf("connection err = %v, want ErrNotFound", err)
	}
	if _, err := st.SSHSecret(c.ID, "password"); err != ErrNotFound {
		t.Errorf("secret err = %v, want ErrNotFound (cascade)", err)
	}
	if err := st.DeleteSSHConnection(c.ID); err != ErrNotFound {
		t.Errorf("double delete err = %v, want ErrNotFound", err)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/store/ -run SSH -v`
Expected: compile FAILURE — `st.CreateSSHConnection undefined` (and the other new methods).

- [ ] **Step 3: Add the domain types**

In `backend/internal/domain/models.go`, insert after the closing brace of the `Machine` struct (line ~207), before the `FsEntry` comment:

```go
// SSHConnection is a saved connection to an arbitrary external SSH host —
// a separate concept from Machine (an already-running Loom runtime trusted
// via a shared key). Mirrors the frontend SSHConnection type. Credentials
// live in SSHSecret rows, never on this struct.
type SSHConnection struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	// AuthType is "password" or "privatekey".
	AuthType string `json:"authType"`
	// JumpConnectionID chains to another SSHConnection for bastion hops.
	// Stored since phase 1 so the schema never needs reworking, but only
	// used once jump-host chaining ships (build-order phase 3).
	JumpConnectionID *string `json:"jumpConnectionId"`
	// ExecutorMachineID selects which Machine dials this host; nil = the
	// hub itself. Phase 1 always executes on the hub regardless — routing
	// ships with a later phase.
	ExecutorMachineID *string `json:"executorMachineId"`
	// HostKeyFingerprint is the TOFU-pinned SHA256 host-key fingerprint,
	// set on the first successful connect; later mismatches hard-block.
	HostKeyFingerprint *string `json:"hostKeyFingerprint"`
}

// SSHSecret is one encrypted credential for an SSHConnection. Every field
// is json:"-": unlike Machine.Key (deliberately distributed to clients),
// SSH credentials never serialize into any API response.
type SSHSecret struct {
	ConnectionID string  `json:"-"`
	Kind         string  `json:"-"` // "password" | "privatekey" | "passphrase"
	StorageKind  string  `json:"-"` // "db" today; "keychain" arrives with the Tauri phase
	CipherText   string  `json:"-"` // base64 "nonce||ciphertext" (AES-256-GCM)
	KeychainRef  *string `json:"-"`
}
```

- [ ] **Step 4: Add the tables to the schema**

In `backend/internal/store/db.go`, inside the `schema` const, insert after the `machines` table block (line ~174) and before the `settings` table:

```sql
CREATE TABLE IF NOT EXISTS ssh_connections (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL DEFAULT '',
  host                 TEXT NOT NULL DEFAULT '',
  port                 INTEGER NOT NULL DEFAULT 22,
  username             TEXT NOT NULL DEFAULT '',
  auth_type            TEXT NOT NULL DEFAULT 'password',
  jump_connection_id   TEXT,
  executor_machine_id  TEXT,
  host_key_fingerprint TEXT
);

CREATE TABLE IF NOT EXISTS ssh_secrets (
  connection_id TEXT NOT NULL REFERENCES ssh_connections(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  storage_kind  TEXT NOT NULL DEFAULT 'db',
  cipher_text   TEXT NOT NULL DEFAULT '',
  keychain_ref  TEXT,
  PRIMARY KEY (connection_id, kind)
);
```

(`CREATE TABLE IF NOT EXISTS` is the codebase's migration mechanism for new tables — existing DBs pick these up on next startup with no ALTER needed.)

- [ ] **Step 5: Extend the port.Store interface**

In `backend/internal/port/store.go`, insert after the Machines block (after `MachineByID(id string) (domain.Machine, error)`, line ~84):

```go
	// SSH connections (operator-global registry, hub role only — see
	// docs/superpowers/specs/2026-07-14-ssh-management-design.md). Secrets
	// are stored separately, encrypted by the service layer.
	SSHConnections() ([]domain.SSHConnection, error)
	CreateSSHConnection(name, host string, portNum int, username, authType string) (domain.SSHConnection, error)
	UpdateSSHConnection(id string, p SSHConnectionPatch) (domain.SSHConnection, error)
	DeleteSSHConnection(id string) error
	SSHConnectionByID(id string) (domain.SSHConnection, error)
	SetSSHHostKey(id string, fingerprint *string) error
	UpsertSSHSecret(connectionID, kind, cipherText string) error
	SSHSecret(connectionID, kind string) (domain.SSHSecret, error)
```

And insert after the `MachinePatch` struct (line ~182):

```go
// SSHConnectionPatch carries optional fields for a partial SSH-connection
// update. Secrets are not patched here — they go through SSHSecretService.
// Jump-host / executor fields arrive with their own build-order phases.
type SSHConnectionPatch struct {
	Name     *string
	Host     *string
	Port     *int
	Username *string
	AuthType *string
}
```

- [ ] **Step 6: Implement the store**

Create `backend/internal/store/ssh.go`:

```go
package store

import (
	"database/sql"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

const sshConnCols = `id, name, host, port, username, auth_type, jump_connection_id, executor_machine_id, host_key_fingerprint`

func scanSSHConnection(sc scanner) (domain.SSHConnection, error) {
	var c domain.SSHConnection
	var jump, executor, fingerprint sql.NullString
	err := sc.Scan(&c.ID, &c.Name, &c.Host, &c.Port, &c.Username, &c.AuthType, &jump, &executor, &fingerprint)
	if err != nil {
		return c, err
	}
	if jump.Valid {
		v := jump.String
		c.JumpConnectionID = &v
	}
	if executor.Valid {
		v := executor.String
		c.ExecutorMachineID = &v
	}
	if fingerprint.Valid {
		v := fingerprint.String
		c.HostKeyFingerprint = &v
	}
	return c, nil
}

// SSHConnections returns all saved SSH connections, most recently created first.
func (s *Store) SSHConnections() ([]domain.SSHConnection, error) {
	rows, err := s.db.Query(`SELECT ` + sshConnCols + ` FROM ssh_connections ORDER BY rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.SSHConnection{}
	for rows.Next() {
		c, err := scanSSHConnection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SSHConnectionByID returns a single saved SSH connection.
func (s *Store) SSHConnectionByID(id string) (domain.SSHConnection, error) {
	c, err := scanSSHConnection(s.db.QueryRow(`SELECT `+sshConnCols+` FROM ssh_connections WHERE id = ?`, id))
	if err != nil {
		return domain.SSHConnection{}, mapNotFound(err)
	}
	return c, nil
}

// CreateSSHConnection saves a new SSH connection (secrets are stored
// separately via UpsertSSHSecret).
func (s *Store) CreateSSHConnection(name, host string, portNum int, username, authType string) (domain.SSHConnection, error) {
	id := idGen("sc-")
	if _, err := s.db.Exec(`INSERT INTO ssh_connections (id, name, host, port, username, auth_type) VALUES (?, ?, ?, ?, ?, ?)`,
		id, name, host, portNum, username, authType); err != nil {
		return domain.SSHConnection{}, err
	}
	return s.SSHConnectionByID(id)
}

// UpdateSSHConnection applies a partial update. Changing the host to a
// different value also clears the pinned host-key fingerprint: a different
// host presents a different key, and a stale pin would hard-block every
// future connect. A patch that re-sends the SAME host (as the edit dialog
// does, since it always includes every field) must NOT disturb the pin —
// so this compares against the stored host rather than merely checking
// whether p.Host was provided.
func (s *Store) UpdateSSHConnection(id string, p port.SSHConnectionPatch) (domain.SSHConnection, error) {
	existing, err := s.SSHConnectionByID(id)
	if err != nil {
		return domain.SSHConnection{}, err
	}
	if err := firstErr(
		setStr(s.db, "ssh_connections", "name", id, p.Name),
		setStr(s.db, "ssh_connections", "host", id, p.Host),
		setInt(s.db, "ssh_connections", "port", id, p.Port),
		setStr(s.db, "ssh_connections", "username", id, p.Username),
		setStr(s.db, "ssh_connections", "auth_type", id, p.AuthType),
	); err != nil {
		return domain.SSHConnection{}, err
	}
	if p.Host != nil && *p.Host != existing.Host {
		if err := s.SetSSHHostKey(id, nil); err != nil {
			return domain.SSHConnection{}, err
		}
	}
	return s.SSHConnectionByID(id)
}

// DeleteSSHConnection deletes a saved connection; its secrets cascade.
func (s *Store) DeleteSSHConnection(id string) error {
	res, err := s.db.Exec(`DELETE FROM ssh_connections WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetSSHHostKey pins (or, with nil, clears) a connection's TOFU host-key
// fingerprint.
func (s *Store) SetSSHHostKey(id string, fingerprint *string) error {
	res, err := s.db.Exec(`UPDATE ssh_connections SET host_key_fingerprint = ? WHERE id = ?`, fingerprint, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// UpsertSSHSecret stores (replacing any previous value) one encrypted
// credential for a connection. cipherText is the base64 blob produced by
// the service layer's AES-256-GCM encryption — never plaintext.
func (s *Store) UpsertSSHSecret(connectionID, kind, cipherText string) error {
	_, err := s.db.Exec(`INSERT INTO ssh_secrets (connection_id, kind, storage_kind, cipher_text)
		VALUES (?, ?, 'db', ?)
		ON CONFLICT(connection_id, kind) DO UPDATE SET cipher_text = excluded.cipher_text, storage_kind = 'db'`,
		connectionID, kind, cipherText)
	return err
}

// SSHSecret returns one stored credential row (still encrypted).
func (s *Store) SSHSecret(connectionID, kind string) (domain.SSHSecret, error) {
	var sec domain.SSHSecret
	var ref sql.NullString
	err := s.db.QueryRow(`SELECT connection_id, kind, storage_kind, cipher_text, keychain_ref FROM ssh_secrets WHERE connection_id = ? AND kind = ?`,
		connectionID, kind).Scan(&sec.ConnectionID, &sec.Kind, &sec.StorageKind, &sec.CipherText, &ref)
	if err != nil {
		return domain.SSHSecret{}, mapNotFound(err)
	}
	if ref.Valid {
		v := ref.String
		sec.KeychainRef = &v
	}
	return sec, nil
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/store/ -run SSH -v`
Expected: PASS (6 tests). Then run the full store package to catch regressions: `go test ./internal/store/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/internal/domain/models.go backend/internal/store/db.go backend/internal/port/store.go backend/internal/store/ssh.go backend/internal/store/ssh_test.go
git commit -m "feat(store): add SSH connection + secret persistence with TOFU host-key column"
```

---

### Task 2: SSH secret encryption service

**Files:**
- Create: `backend/internal/service/sshsecret.go`
- Test: `backend/internal/service/sshsecret_test.go`

**Interfaces:**
- Consumes: `encryptSecret(key []byte, plaintext string) (string, error)` / `decryptSecret(key []byte, encoded string) (string, error)` (unexported, same package — `backend/internal/service/authcrypto.go`); `port.Store.UpsertSSHSecret` / `SSHSecret` from Task 1; `store.ErrNotFound`.
- Produces:
  - `service.NewSSHSecretService(st port.Store, key []byte) *SSHSecretService`
  - `(*SSHSecretService) Set(connectionID, kind, plaintext string) error`
  - `(*SSHSecretService) Get(connectionID, kind string) (string, bool, error)` — `ok=false, err=nil` when the kind isn't stored. This exact `Get` signature is what `sshmgr.SecretSource` (Task 4) declares.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/service/sshsecret_test.go`:

```go
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/service/ -run SSHSecret -v`
Expected: compile FAILURE — `undefined: NewSSHSecretService`.

- [ ] **Step 3: Implement the service**

Create `backend/internal/service/sshsecret.go`:

```go
package service

import (
	"errors"

	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

// SSHSecretService encrypts SSH credentials into the ssh_secrets table and
// decrypts them for the SSH dialer. It reuses the AES-256-GCM helpers in
// authcrypto.go, keyed by the same master key as TOTP secret storage.
// Unlike Machine.Key (deliberately distributed to clients for direct-first
// connections), these secrets never leave the server.
type SSHSecretService struct {
	st  port.Store
	key []byte
}

func NewSSHSecretService(st port.Store, key []byte) *SSHSecretService {
	return &SSHSecretService{st: st, key: key}
}

// Set encrypts plaintext and stores it as connectionID's credential of the
// given kind ("password" | "privatekey" | "passphrase"), replacing any
// previous value of that kind.
func (s *SSHSecretService) Set(connectionID, kind, plaintext string) error {
	ct, err := encryptSecret(s.key, plaintext)
	if err != nil {
		return err
	}
	return s.st.UpsertSSHSecret(connectionID, kind, ct)
}

// Get decrypts connectionID's credential of the given kind. ok is false
// (with a nil error) when no credential of that kind is stored.
func (s *SSHSecretService) Get(connectionID, kind string) (string, bool, error) {
	sec, err := s.st.SSHSecret(connectionID, kind)
	if errors.Is(err, store.ErrNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	plaintext, err := decryptSecret(s.key, sec.CipherText)
	if err != nil {
		return "", false, err
	}
	return plaintext, true, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/service/ -run SSHSecret -v`
Expected: PASS (2 tests). Then `go test ./internal/service/` — Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/sshsecret.go backend/internal/service/sshsecret_test.go
git commit -m "feat(service): encrypt SSH credentials at rest with the auth master key"
```

---

### Task 3: SSH connections HTTP handler + hub-only routes

**Files:**
- Create: `backend/internal/handler/ssh.go`
- Test: `backend/internal/handler/ssh_test.go`
- Modify: `backend/cmd/server/main.go` (handler construction ~line 237; route block ~line 393)

**Interfaces:**
- Consumes: `writeJSON`, `writeErr`, `handleStoreErr`, `decodeBody`, `str` from `handler` package; Task 1 store methods; Task 2 `SSHSecretService.Set`/`Get`.
- Produces:
  - `handler.NewSSHHandler(st *store.Store, secrets *service.SSHSecretService) *SSHHandler`
  - Routes (hub-only): `GET/POST /api/ssh/connections`, `PATCH/DELETE /api/ssh/connections/{id}`, `POST /api/ssh/connections/{id}/accept-hostkey`
  - JSON contract the frontend (Task 6) mirrors: create body `{name, host, port?, username, authType, password?, privateKey?, passphrase?}`; responses are `domain.SSHConnection` (secrets never present); accept-hostkey returns 204.

- [ ] **Step 1: Write the failing handler test**

Create `backend/internal/handler/ssh_test.go`:

```go
package handler

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"loom/backend/internal/service"
	"loom/backend/internal/store"
)

func newTestSSHHandler(t *testing.T) *SSHHandler {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	return NewSSHHandler(st, service.NewSSHSecretService(st, make([]byte, 32)))
}

func TestPostSSHConnectionValidatesRequiredFields(t *testing.T) {
	h := newTestSSHHandler(t)
	rec := httptest.NewRecorder()
	h.PostConnection(rec, httptest.NewRequest(http.MethodPost, "/api/ssh/connections",
		strings.NewReader(`{"name":"web"}`))) // missing host + username
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestPostSSHConnectionRejectsBadAuthType(t *testing.T) {
	h := newTestSSHHandler(t)
	rec := httptest.NewRecorder()
	h.PostConnection(rec, httptest.NewRequest(http.MethodPost, "/api/ssh/connections",
		strings.NewReader(`{"name":"web","host":"h","username":"u","authType":"agent","password":"x"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestPostSSHConnectionRequiresMatchingSecret(t *testing.T) {
	h := newTestSSHHandler(t)
	rec := httptest.NewRecorder()
	h.PostConnection(rec, httptest.NewRequest(http.MethodPost, "/api/ssh/connections",
		strings.NewReader(`{"name":"web","host":"h","username":"u","authType":"password"}`))) // no password
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestSSHConnectionCRUDRoundtripNeverLeaksSecrets(t *testing.T) {
	h := newTestSSHHandler(t)
	rec := httptest.NewRecorder()
	h.PostConnection(rec, httptest.NewRequest(http.MethodPost, "/api/ssh/connections",
		strings.NewReader(`{"name":"web","host":"web.example.com","port":2222,"username":"deploy","authType":"password","password":"hunter2"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d, body %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "hunter2") {
		t.Fatalf("create response leaked the password: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.GetConnections(rec, httptest.NewRequest(http.MethodGet, "/api/ssh/connections", nil))
	body := rec.Body.String()
	if !strings.Contains(body, `"host":"web.example.com"`) || !strings.Contains(body, `"port":2222`) {
		t.Errorf("list body = %s, want the created connection", body)
	}
	if strings.Contains(body, "hunter2") {
		t.Errorf("list body leaked secret material: %s", body)
	}
}

func TestPatchSSHConnectionUpdatesFieldsAndSecrets(t *testing.T) {
	h := newTestSSHHandler(t)
	conn, err := h.st.CreateSSHConnection("web", "h", 22, "u", "password")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /api/ssh/connections/{id}", h.PatchConnection)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/ssh/connections/"+conn.ID,
		strings.NewReader(`{"name":"web-2","password":"new-secret"}`)))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"name":"web-2"`) {
		t.Fatalf("patch status=%d body=%s", rec.Code, rec.Body.String())
	}
	got, ok, err := h.secrets.Get(conn.ID, "password")
	if err != nil || !ok || got != "new-secret" {
		t.Errorf("stored password = (%q, %v, %v), want new-secret", got, ok, err)
	}
}

func TestPostAcceptHostKeyClearsPin(t *testing.T) {
	h := newTestSSHHandler(t)
	conn, _ := h.st.CreateSSHConnection("web", "h", 22, "u", "password")
	fp := "SHA256:abc"
	if err := h.st.SetSSHHostKey(conn.ID, &fp); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/ssh/connections/{id}/accept-hostkey", h.PostAcceptHostKey)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/ssh/connections/"+conn.ID+"/accept-hostkey", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	got, _ := h.st.SSHConnectionByID(conn.ID)
	if got.HostKeyFingerprint != nil {
		t.Errorf("fingerprint = %q, want cleared", *got.HostKeyFingerprint)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/handler/ -run SSH -v`
Expected: compile FAILURE — `undefined: NewSSHHandler`.

- [ ] **Step 3: Implement the handler**

Create `backend/internal/handler/ssh.go`:

```go
package handler

import (
	"net/http"

	"loom/backend/internal/port"
	"loom/backend/internal/service"
	"loom/backend/internal/store"
)

// SSHHandler handles the hub's saved-SSH-connection registry. Secrets ride
// in on create/update bodies, are encrypted at rest via SSHSecretService,
// and never serialize back out (domain.SSHSecret is json:"-" throughout).
type SSHHandler struct {
	st      *store.Store
	secrets *service.SSHSecretService
}

func NewSSHHandler(st *store.Store, secrets *service.SSHSecretService) *SSHHandler {
	return &SSHHandler{st: st, secrets: secrets}
}

func validSSHAuthType(t string) bool {
	return t == "password" || t == "privatekey"
}

// sshSecretFields are the write-only credential fields accepted alongside
// connection fields on create/update. Blank/absent means "leave unchanged".
type sshSecretFields struct {
	Password   *string `json:"password"`
	PrivateKey *string `json:"privateKey"`
	Passphrase *string `json:"passphrase"`
}

func (h *SSHHandler) storeSecrets(connectionID string, s sshSecretFields) error {
	if s.Password != nil && *s.Password != "" {
		if err := h.secrets.Set(connectionID, "password", *s.Password); err != nil {
			return err
		}
	}
	if s.PrivateKey != nil && *s.PrivateKey != "" {
		if err := h.secrets.Set(connectionID, "privatekey", *s.PrivateKey); err != nil {
			return err
		}
	}
	if s.Passphrase != nil && *s.Passphrase != "" {
		if err := h.secrets.Set(connectionID, "passphrase", *s.Passphrase); err != nil {
			return err
		}
	}
	return nil
}

// GetConnections lists saved SSH connections (never their secrets).
func (h *SSHHandler) GetConnections(w http.ResponseWriter, r *http.Request) {
	list, err := h.st.SSHConnections()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (h *SSHHandler) PostConnection(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     *string `json:"name"`
		Host     *string `json:"host"`
		Port     *int    `json:"port"`
		Username *string `json:"username"`
		AuthType *string `json:"authType"`
		sshSecretFields
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if str(body.Name) == "" || str(body.Host) == "" || str(body.Username) == "" {
		writeErr(w, http.StatusBadRequest, "name, host and username are required")
		return
	}
	authType := str(body.AuthType)
	if !validSSHAuthType(authType) {
		writeErr(w, http.StatusBadRequest, "authType must be \"password\" or \"privatekey\"")
		return
	}
	portNum := 22
	if body.Port != nil {
		portNum = *body.Port
	}
	if portNum < 1 || portNum > 65535 {
		writeErr(w, http.StatusBadRequest, "port must be between 1 and 65535")
		return
	}
	if authType == "password" && (body.Password == nil || *body.Password == "") {
		writeErr(w, http.StatusBadRequest, "password is required for password auth")
		return
	}
	if authType == "privatekey" && (body.PrivateKey == nil || *body.PrivateKey == "") {
		writeErr(w, http.StatusBadRequest, "privateKey is required for privatekey auth")
		return
	}
	conn, err := h.st.CreateSSHConnection(str(body.Name), str(body.Host), portNum, str(body.Username), authType)
	if handleStoreErr(w, err) {
		return
	}
	if handleStoreErr(w, h.storeSecrets(conn.ID, body.sshSecretFields)) {
		return
	}
	writeJSON(w, http.StatusOK, conn)
}

func (h *SSHHandler) PatchConnection(w http.ResponseWriter, r *http.Request) {
	var body struct {
		port.SSHConnectionPatch
		sshSecretFields
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.AuthType != nil && !validSSHAuthType(*body.AuthType) {
		writeErr(w, http.StatusBadRequest, "authType must be \"password\" or \"privatekey\"")
		return
	}
	if body.Port != nil && (*body.Port < 1 || *body.Port > 65535) {
		writeErr(w, http.StatusBadRequest, "port must be between 1 and 65535")
		return
	}
	conn, err := h.st.UpdateSSHConnection(r.PathValue("id"), body.SSHConnectionPatch)
	if handleStoreErr(w, err) {
		return
	}
	if handleStoreErr(w, h.storeSecrets(conn.ID, body.sshSecretFields)) {
		return
	}
	writeJSON(w, http.StatusOK, conn)
}

func (h *SSHHandler) DeleteConnection(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteSSHConnection(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PostAcceptHostKey clears the connection's pinned host-key fingerprint
// after a host-key-changed block, so the next connect re-pins whatever key
// the host presents — the operator's explicit "accept new key".
func (h *SSHHandler) PostAcceptHostKey(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.SetSSHHostKey(r.PathValue("id"), nil)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/handler/ -run SSH -v`
Expected: PASS (6 tests). Then `go test ./internal/handler/` — Expected: PASS.

- [ ] **Step 5: Wire the handler and routes in main.go**

In `backend/cmd/server/main.go`:

(a) After `machineH := handler.NewMachineHandler(st, healthCache)` (line ~237), add:

```go
	sshSecrets := service.NewSSHSecretService(st, authKey)
	sshH := handler.NewSSHHandler(st, sshSecrets)
```

(b) Inside the existing hub-only machines block (after `mux.Handle("/api/machines/{id}/proxy/{rest...}", ...)`, line ~393, still inside its `if !isRuntime { ... }`), add:

```go
		// SSH connection registry — hub-scoped like the machine registry.
		mux.HandleFunc("GET /api/ssh/connections", sshH.GetConnections)
		mux.HandleFunc("POST /api/ssh/connections", sshH.PostConnection)
		mux.HandleFunc("PATCH /api/ssh/connections/{id}", sshH.PatchConnection)
		mux.HandleFunc("DELETE /api/ssh/connections/{id}", sshH.DeleteConnection)
		mux.HandleFunc("POST /api/ssh/connections/{id}/accept-hostkey", sshH.PostAcceptHostKey)
```

(`--role both` hubs get these too, since `isRuntime` is false there.)

- [ ] **Step 6: Verify the server builds and vets clean**

Run: `cd backend && go build ./... && go vet ./...`
Expected: no output (success).

- [ ] **Step 7: Commit**

```bash
git add backend/internal/handler/ssh.go backend/internal/handler/ssh_test.go backend/cmd/server/main.go
git commit -m "feat(handler): SSH connection CRUD + accept-hostkey endpoints (hub role)"
```

---

### Task 4: sshmgr dialer with TOFU host keys

**Files:**
- Create: `backend/internal/sshmgr/dialer.go`
- Create: `backend/internal/sshmgr/testserver_test.go` (in-process SSH server helper)
- Test: `backend/internal/sshmgr/dialer_test.go`

**Interfaces:**
- Consumes: `domain.SSHConnection` (Task 1). The `SecretSource` interface below is intentionally shape-identical to `service.SSHSecretService.Get` (Task 2); `ConnStore` is satisfied by `*store.Store` (Task 1).
- Produces:
  - `sshmgr.NewDialer(store ConnStore, secrets SecretSource) *Dialer`
  - `(*Dialer) Dial(ctx context.Context, connectionID string) (*ssh.Client, error)`
  - `sshmgr.ErrHostKeyChanged` sentinel
  - Test helpers reused by Task 5: `startTestSSHServer(t, authorizedKey)`, `fakeConnStore`, `fakeSecrets`, `testConn(t, addr)`

- [ ] **Step 1: Write the in-process SSH test server helper**

Create `backend/internal/sshmgr/testserver_test.go`:

```go
package sshmgr

import (
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"testing"

	"golang.org/x/crypto/ssh"
)

// startTestSSHServer runs a minimal in-process SSH server for tests — the
// standard way to exercise golang.org/x/crypto/ssh without a real host. It
// accepts password auth (user "tester" / password "secret") and, when
// authorizedKey is non-nil, public-key auth for exactly that key. Session
// channels ack pty-req/shell/window-change requests and echo stdin back to
// stdout. Returns the listener address and the host key's SHA256 fingerprint.
func startTestSSHServer(t *testing.T, authorizedKey ssh.PublicKey) (addr, fingerprint string) {
	t.Helper()
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		t.Fatal(err)
	}

	cfg := &ssh.ServerConfig{
		PasswordCallback: func(md ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
			if md.User() == "tester" && string(pass) == "secret" {
				return nil, nil
			}
			return nil, fmt.Errorf("wrong credentials for %q", md.User())
		},
	}
	if authorizedKey != nil {
		want := string(authorizedKey.Marshal())
		cfg.PublicKeyCallback = func(md ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if string(key.Marshal()) == want {
				return nil, nil
			}
			return nil, fmt.Errorf("unknown public key for %q", md.User())
		}
	}
	cfg.AddHostKey(hostSigner)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			go serveTestSSHConn(nc, cfg)
		}
	}()
	return ln.Addr().String(), ssh.FingerprintSHA256(hostSigner.PublicKey())
}

func serveTestSSHConn(nc net.Conn, cfg *ssh.ServerConfig) {
	sc, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		return
	}
	defer sc.Close()
	go ssh.DiscardRequests(reqs)
	for newCh := range chans {
		if newCh.ChannelType() != "session" {
			newCh.Reject(ssh.UnknownChannelType, "only session channels in tests")
			continue
		}
		ch, chReqs, err := newCh.Accept()
		if err != nil {
			continue
		}
		go func(chReqs <-chan *ssh.Request) {
			for req := range chReqs {
				if req.WantReply {
					ok := req.Type == "pty-req" || req.Type == "shell" || req.Type == "window-change"
					_ = req.Reply(ok, nil)
				}
			}
		}(chReqs)
		go func(ch ssh.Channel) {
			_, _ = io.Copy(ch, ch) // echo stdin -> stdout
			_ = ch.Close()
		}(ch)
	}
}
```

- [ ] **Step 2: Write the failing dialer tests**

Create `backend/internal/sshmgr/dialer_test.go`:

```go
package sshmgr

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"net"
	"strconv"
	"testing"

	"golang.org/x/crypto/ssh"

	"loom/backend/internal/domain"
)

type fakeConnStore struct {
	conn domain.SSHConnection
	err  error
}

func (f *fakeConnStore) SSHConnectionByID(id string) (domain.SSHConnection, error) {
	if f.err != nil {
		return domain.SSHConnection{}, f.err
	}
	return f.conn, nil
}

func (f *fakeConnStore) SetSSHHostKey(id string, fingerprint *string) error {
	f.conn.HostKeyFingerprint = fingerprint
	return nil
}

type fakeSecrets map[string]string

func (f fakeSecrets) Get(connectionID, kind string) (string, bool, error) {
	v, ok := f[kind]
	return v, ok, nil
}

func testConn(t *testing.T, addr string) domain.SSHConnection {
	t.Helper()
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	portNum, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatal(err)
	}
	return domain.SSHConnection{ID: "sc-test", Name: "test", Host: host, Port: portNum, Username: "tester", AuthType: "password"}
}

func TestDialPasswordAuthPinsHostKeyOnFirstConnect(t *testing.T) {
	addr, fingerprint := startTestSSHServer(t, nil)
	st := &fakeConnStore{conn: testConn(t, addr)}
	d := NewDialer(st, fakeSecrets{"password": "secret"})

	client, err := d.Dial(context.Background(), "sc-test")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	client.Close()
	if st.conn.HostKeyFingerprint == nil || *st.conn.HostKeyFingerprint != fingerprint {
		t.Errorf("pinned = %v, want %s", st.conn.HostKeyFingerprint, fingerprint)
	}
}

func TestDialAcceptsMatchingPinnedKey(t *testing.T) {
	addr, fingerprint := startTestSSHServer(t, nil)
	c := testConn(t, addr)
	c.HostKeyFingerprint = &fingerprint
	d := NewDialer(&fakeConnStore{conn: c}, fakeSecrets{"password": "secret"})
	client, err := d.Dial(context.Background(), "sc-test")
	if err != nil {
		t.Fatalf("Dial with matching pin: %v", err)
	}
	client.Close()
}

func TestDialBlocksChangedHostKey(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	pinned := "SHA256:doesnotmatchanything"
	c := testConn(t, addr)
	c.HostKeyFingerprint = &pinned
	d := NewDialer(&fakeConnStore{conn: c}, fakeSecrets{"password": "secret"})
	if _, err := d.Dial(context.Background(), "sc-test"); !errors.Is(err, ErrHostKeyChanged) {
		t.Errorf("err = %v, want ErrHostKeyChanged", err)
	}
}

func TestDialWrongPasswordFails(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	d := NewDialer(&fakeConnStore{conn: testConn(t, addr)}, fakeSecrets{"password": "wrong"})
	if _, err := d.Dial(context.Background(), "sc-test"); err == nil {
		t.Error("Dial with wrong password succeeded, want auth error")
	}
}

func TestDialMissingSecretFails(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	d := NewDialer(&fakeConnStore{conn: testConn(t, addr)}, fakeSecrets{})
	if _, err := d.Dial(context.Background(), "sc-test"); err == nil {
		t.Error("Dial with no stored password succeeded, want error")
	}
}

func TestDialPrivateKeyAuth(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := string(pem.EncodeToMemory(block))

	addr, _ := startTestSSHServer(t, sshPub)
	c := testConn(t, addr)
	c.AuthType = "privatekey"
	d := NewDialer(&fakeConnStore{conn: c}, fakeSecrets{"privatekey": keyPEM})
	client, err := d.Dial(context.Background(), "sc-test")
	if err != nil {
		t.Fatalf("Dial with private key: %v", err)
	}
	client.Close()
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/sshmgr/ -v`
Expected: compile FAILURE — `undefined: NewDialer`, `undefined: ErrHostKeyChanged`.

- [ ] **Step 4: Implement the dialer**

Create `backend/internal/sshmgr/dialer.go`:

```go
// Package sshmgr manages SSH connections to arbitrary external hosts — an
// interactive shell now; SFTP and port forwarding in later phases (see
// docs/superpowers/specs/2026-07-14-ssh-management-design.md). It is a
// sibling of internal/terminal, not an extension of it: sessions are backed
// by golang.org/x/crypto/ssh instead of a local PTY, and Phase 1 always
// executes on this process (ExecutorMachineID routing and jump-host
// chaining are later phases).
package sshmgr

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"

	"golang.org/x/crypto/ssh"

	"loom/backend/internal/domain"
)

const dialTimeout = 10 * time.Second

// SecretSource decrypts a connection's stored credential of the given kind
// ("password" | "privatekey" | "passphrase"); ok is false when none is
// stored. Implemented by service.SSHSecretService.
type SecretSource interface {
	Get(connectionID, kind string) (string, bool, error)
}

// ConnStore is the slice of port.Store the dialer needs: reading a saved
// connection and pinning its TOFU host-key fingerprint.
type ConnStore interface {
	SSHConnectionByID(id string) (domain.SSHConnection, error)
	SetSSHHostKey(id string, fingerprint *string) error
}

// ErrHostKeyChanged means the host presented a key that does not match the
// connection's pinned fingerprint — possible MITM. The operator must
// explicitly accept the new key (POST /api/ssh/connections/{id}/accept-hostkey)
// before the next connect can proceed.
var ErrHostKeyChanged = errors.New("host key changed")

// Dialer opens authenticated ssh.Clients for saved connections.
type Dialer struct {
	store   ConnStore
	secrets SecretSource
}

func NewDialer(store ConnStore, secrets SecretSource) *Dialer {
	return &Dialer{store: store, secrets: secrets}
}

// Dial connects to the saved connection and completes the SSH handshake.
// TOFU host keys: an empty fingerprint is pinned on the first successful
// key exchange; a pinned fingerprint must match exactly or the dial fails
// with ErrHostKeyChanged.
func (d *Dialer) Dial(ctx context.Context, connectionID string) (*ssh.Client, error) {
	conn, err := d.store.SSHConnectionByID(connectionID)
	if err != nil {
		return nil, err
	}
	auth, err := d.authMethods(conn)
	if err != nil {
		return nil, err
	}
	cfg := &ssh.ClientConfig{
		User:            conn.Username,
		Auth:            auth,
		HostKeyCallback: d.hostKeyCallback(conn),
		Timeout:         dialTimeout,
	}
	addr := net.JoinHostPort(conn.Host, fmt.Sprint(conn.Port))
	nc, err := (&net.Dialer{Timeout: dialTimeout}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", addr, err)
	}
	sc, chans, reqs, err := ssh.NewClientConn(nc, addr, cfg)
	if err != nil {
		nc.Close()
		return nil, err
	}
	return ssh.NewClient(sc, chans, reqs), nil
}

func (d *Dialer) authMethods(conn domain.SSHConnection) ([]ssh.AuthMethod, error) {
	switch conn.AuthType {
	case "password":
		pw, ok, err := d.secrets.Get(conn.ID, "password")
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("connection %s has no stored password", conn.ID)
		}
		return []ssh.AuthMethod{ssh.Password(pw)}, nil
	case "privatekey":
		keyPEM, ok, err := d.secrets.Get(conn.ID, "privatekey")
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("connection %s has no stored private key", conn.ID)
		}
		passphrase, hasPassphrase, err := d.secrets.Get(conn.ID, "passphrase")
		if err != nil {
			return nil, err
		}
		var signer ssh.Signer
		if hasPassphrase && passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(keyPEM), []byte(passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(keyPEM))
		}
		if err != nil {
			return nil, fmt.Errorf("parse private key: %w", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	}
	return nil, fmt.Errorf("unsupported auth type %q", conn.AuthType)
}

// hostKeyCallback implements TOFU pinning against the connection's stored
// SHA256 fingerprint.
func (d *Dialer) hostKeyCallback(conn domain.SSHConnection) ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		fp := ssh.FingerprintSHA256(key)
		if conn.HostKeyFingerprint == nil || *conn.HostKeyFingerprint == "" {
			return d.store.SetSSHHostKey(conn.ID, &fp)
		}
		if *conn.HostKeyFingerprint != fp {
			return fmt.Errorf("%w: pinned %s, host presented %s — accept the new key from the SSH page to continue", ErrHostKeyChanged, *conn.HostKeyFingerprint, fp)
		}
		return nil
	}
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/sshmgr/ -v`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/internal/sshmgr/
git commit -m "feat(sshmgr): SSH dialer with password/key auth and TOFU host-key pinning"
```

---

### Task 5: sshmgr WebSocket shell server + main.go wiring

**Files:**
- Create: `backend/internal/sshmgr/server.go`
- Test: `backend/internal/sshmgr/server_test.go`
- Modify: `backend/cmd/server/main.go` (imports; sshmgr construction next to the Task 3 handler wiring; WS route in the hub-only block)

**Interfaces:**
- Consumes: `(*Dialer).Dial` (Task 4); test helpers `startTestSSHServer`/`fakeConnStore`/`fakeSecrets`/`testConn` (Task 4); frame protocol contract from `internal/terminal` (`{"t":"i","d":...}`, `{"t":"r","cols","rows"}`).
- Produces:
  - `sshmgr.NewServer(dialer *Dialer) *Server`
  - `(*Server) HandleWS(w http.ResponseWriter, r *http.Request)` — query params `connection`, `cols`, `rows`
  - Route: `/ws/ssh` (hub role; already auth-protected by the `/ws/` prefix middleware). This exact URL shape is what `frontend/src/lib/sshClient.ts` (Task 6) builds.
  - Error contract: connect/auth/host-key failures arrive as a text frame `[ssh error: ...]` before the socket closes; clean shell exit sends `[ssh session ended]`.

- [ ] **Step 1: Write the failing WS integration tests**

Create `backend/internal/sshmgr/server_test.go`:

```go
package sshmgr

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

func TestHandleWSRunsInteractiveShell(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	st := &fakeConnStore{conn: testConn(t, addr)}
	srv := NewServer(NewDialer(st, fakeSecrets{"password": "secret"}))

	httpServer := httptest.NewServer(http.HandlerFunc(srv.HandleWS))
	defer httpServer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "?connection=sc-test&cols=80&rows=24"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial ssh WebSocket: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })

	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"t":"i","d":"LOOM_SSH_ECHO_OK"}`)); err != nil {
		t.Fatalf("write stdin frame: %v", err)
	}
	var output []byte
	for !bytes.Contains(output, []byte("LOOM_SSH_ECHO_OK")) {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read ssh output (got %q so far): %v", output, err)
		}
		output = append(output, data...)
	}
}

func TestHandleWSSurfacesDialErrors(t *testing.T) {
	addr, _ := startTestSSHServer(t, nil)
	st := &fakeConnStore{conn: testConn(t, addr)}
	srv := NewServer(NewDialer(st, fakeSecrets{"password": "wrong"}))

	httpServer := httptest.NewServer(http.HandlerFunc(srv.HandleWS))
	defer httpServer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "?connection=sc-test&cols=80&rows=24"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial ssh WebSocket: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })

	var output []byte
	for !bytes.Contains(output, []byte("[ssh error:")) {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read error frame (got %q so far): %v", output, err)
		}
		output = append(output, data...)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/sshmgr/ -run HandleWS -v`
Expected: compile FAILURE — `undefined: NewServer`.

- [ ] **Step 3: Implement the WS server**

Create `backend/internal/sshmgr/server.go`:

```go
package sshmgr

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"golang.org/x/crypto/ssh"
	"nhooyr.io/websocket"
)

// frame mirrors the PTY WebSocket protocol in internal/terminal:
// {"t":"i","d":"..."} for stdin, {"t":"r","cols":N,"rows":N} for resize.
// Output travels as raw frames, so the frontend's existing xterm wiring
// works unchanged against this endpoint.
type frame struct {
	T    string `json:"t"`
	D    string `json:"d,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

// Server upgrades /ws/ssh requests into interactive SSH shells.
type Server struct {
	dialer *Dialer
}

func NewServer(dialer *Dialer) *Server {
	return &Server{dialer: dialer}
}

func clampInt(raw string, def, min, max int) int {
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

// HandleWS runs one SSH shell per WebSocket connection. Unlike the local
// terminal server there is no reattach registry (yet): the remote shell's
// lifetime is the socket's lifetime, and a reconnect starts a fresh shell.
func (s *Server) HandleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		// permessage-deflate breaks WebKit's WebSocket client under
		// sustained output — same hard-won setting as terminal.HandleWS.
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		log.Printf("ssh: websocket accept: %v", err)
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)

	q := r.URL.Query()
	connectionID := q.Get("connection")
	cols := clampInt(q.Get("cols"), 80, 1, 500)
	rows := clampInt(q.Get("rows"), 24, 1, 300)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	if connectionID == "" {
		writeText(ctx, conn, "\r\n[ssh error: missing connection id]\r\n")
		return
	}
	if err := s.runShell(ctx, cancel, conn, connectionID, cols, rows); err != nil {
		log.Printf("ssh: connection %s session failed: %v", connectionID, err)
		writeText(ctx, conn, fmt.Sprintf("\r\n[ssh error: %v]\r\n", err))
	}
}

// runShell dials the saved connection, opens a PTY-backed shell session,
// and bridges it to the WebSocket until either side ends.
func (s *Server) runShell(ctx context.Context, cancel context.CancelFunc, conn *websocket.Conn, connectionID string, cols, rows int) error {
	client, err := s.dialer.Dial(ctx, connectionID)
	if err != nil {
		return err
	}
	defer client.Close()

	sess, err := client.NewSession()
	if err != nil {
		return fmt.Errorf("open session: %w", err)
	}
	defer sess.Close()

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		return fmt.Errorf("request pty: %w", err)
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		return fmt.Errorf("open stdin: %w", err)
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		return fmt.Errorf("open stdout: %w", err)
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		return fmt.Errorf("open stderr: %w", err)
	}
	if err := sess.Shell(); err != nil {
		return fmt.Errorf("start shell: %w", err)
	}

	go keepalive(ctx, conn)
	go pumpOutput(ctx, conn, stdout)
	go pumpOutput(ctx, conn, stderr)
	go func() {
		_ = sess.Wait() // remote shell exited (or the transport died)
		writeText(ctx, conn, "\r\n[ssh session ended]\r\n")
		cancel() // unblock the frame loop below
	}()

	// WebSocket -> remote shell (stdin / resize), until either side closes.
	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			return nil // client closed, or the shell-exit goroutine cancelled ctx
		}
		var f frame
		if err := json.Unmarshal(msg, &f); err != nil {
			continue
		}
		if f.T == "i" {
			if _, err := stdin.Write([]byte(f.D)); err != nil {
				return nil
			}
		} else if f.T == "r" && f.Cols > 0 && f.Rows > 0 {
			newCols := clampInt(fmt.Sprint(f.Cols), cols, 1, 500)
			newRows := clampInt(fmt.Sprint(f.Rows), rows, 1, 300)
			_ = sess.WindowChange(newRows, newCols)
		}
	}
}

// pumpOutput copies remote output to the socket as binary frames. Binary
// (not text) avoids invalid-UTF-8 frames when raw terminal bytes split
// mid-rune; the frontend's xterm onmessage handles both.
func pumpOutput(ctx context.Context, conn *websocket.Conn, r io.Reader) {
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if werr := conn.Write(ctx, websocket.MessageBinary, buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func writeText(ctx context.Context, conn *websocket.Conn, s string) {
	_ = conn.Write(ctx, websocket.MessageText, []byte(s))
}

// keepalive pings every 30s and returns when the peer stops answering —
// same tuning as internal/terminal's keepalive.
func keepalive(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := conn.Ping(ctx); err != nil {
				return
			}
		}
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/sshmgr/ -v`
Expected: PASS (all 8 sshmgr tests, including Task 4's).

- [ ] **Step 5: Wire the WS server in main.go**

In `backend/cmd/server/main.go`:

(a) Add `"loom/backend/internal/sshmgr"` to the import block (alphabetical, near `"loom/backend/internal/service"`).

(b) Directly under the Task 3 lines (`sshSecrets := ...` / `sshH := ...`), add:

```go
	sshSrv := sshmgr.NewServer(sshmgr.NewDialer(st, sshSecrets))
```

(c) Inside the hub-only SSH route block added in Task 3, after the accept-hostkey route, add:

```go
		// Phase 1 executes every SSH session on the hub itself;
		// ExecutorMachineID routing to runtimes is a later phase.
		mux.HandleFunc("/ws/ssh", sshSrv.HandleWS)
```

(No method prefix on the pattern — WebSocket upgrades are GETs but the existing `/ws/terminal` and `/ws/lsp` routes use bare patterns; match that. `RequireAuth` already guards every `/ws/` path.)

- [ ] **Step 6: Verify the server builds, vets, and the whole backend still passes**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: all packages PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/sshmgr/server.go backend/internal/sshmgr/server_test.go backend/cmd/server/main.go
git commit -m "feat(sshmgr): WebSocket shell bridge on /ws/ssh with terminal frame protocol"
```

---

### Task 6: Frontend data layer (types, API, query hooks, WS URL helper)

**Files:**
- Modify: `frontend/src/store/types.ts` (after the `Machine` interface, line ~143; `ModuleView` union, line ~189)
- Modify: `frontend/src/lib/api.ts` (type import at top; functions after `fetchMachineHealth`, line ~656)
- Create: `frontend/src/lib/sshClient.ts`
- Modify: `frontend/src/features/data/keys.ts` (after the `machineHealth` entry)
- Modify: `frontend/src/features/data/queries.ts` (imports; hooks after the machine hooks, line ~185)

**Interfaces:**
- Consumes: `request<T>` from `lib/api.ts`; `qk` from `keys.ts`; the REST contract from Task 3; the `/ws/ssh?connection=&cols=&rows=` URL shape from Task 5.
- Produces (used by Tasks 7–8):
  - `SSHConnection` type in `@/store/types` (mirrors `domain.SSHConnection` field-for-field)
  - `ModuleView` includes `'ssh'`
  - `CreateSSHConnectionBody`, `UpdateSSHConnectionBody` in `@/lib/api`
  - Hooks: `useSSHConnections()`, `useCreateSSHConnection()`, `useUpdateSSHConnection()`, `useDeleteSSHConnection()`, `useAcceptSSHHostKey()`
  - `sshShellWsUrl(connectionId: string, cols: number, rows: number): string`

- [ ] **Step 1: Add the domain type + ModuleView entry**

In `frontend/src/store/types.ts`, insert after the closing brace of the `Machine` interface (line ~143):

```ts
/** A saved SSH connection (operator-global registry — mirrors the backend's
 *  domain.SSHConnection). Secrets are write-only: they ride on create/update
 *  requests and never serialize back, unlike Machine.key which clients need
 *  for direct-first connections. */
export interface SSHConnection {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privatekey'
  jumpConnectionId: string | null
  executorMachineId: string | null
  hostKeyFingerprint: string | null
}
```

And change the `ModuleView` line (line ~189) from:

```ts
export type ModuleView = 'agents' | 'management' | 'news' | 'todos' | 'invoices' | 'tools' | 'browser' | 'machines'
```

to:

```ts
export type ModuleView = 'agents' | 'management' | 'news' | 'todos' | 'invoices' | 'tools' | 'browser' | 'machines' | 'ssh'
```

- [ ] **Step 2: Add the API functions**

In `frontend/src/lib/api.ts`: add `SSHConnection` to the existing `import type { ... } from '@/store/types'` list at the top of the file. Then append after `fetchMachineHealth` (line ~656):

```ts
// ---- SSH connections (hub registry; secrets are write-only) ----

export interface CreateSSHConnectionBody {
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privatekey'
  password?: string
  privateKey?: string
  passphrase?: string
}

export type UpdateSSHConnectionBody = Partial<CreateSSHConnectionBody>

export function fetchSSHConnections(): Promise<SSHConnection[]> {
  return request<SSHConnection[]>('GET', '/ssh/connections')
}

export function createSSHConnection(body: CreateSSHConnectionBody): Promise<SSHConnection> {
  return request<SSHConnection>('POST', '/ssh/connections', body)
}

export function updateSSHConnection(id: string, patch: UpdateSSHConnectionBody): Promise<SSHConnection> {
  return request<SSHConnection>('PATCH', `/ssh/connections/${id}`, patch)
}

export function deleteSSHConnection(id: string): Promise<void> {
  return request<void>('DELETE', `/ssh/connections/${id}`)
}

/** Clears a pinned host key after a "host key changed" block, so the next
 *  connect re-pins whatever key the host presents. */
export function acceptSSHHostKey(id: string): Promise<void> {
  return request<void>('POST', `/ssh/connections/${id}/accept-hostkey`)
}
```

- [ ] **Step 3: Add the query key + hooks**

In `frontend/src/features/data/keys.ts`, add after the `machineHealth` entry:

```ts
  sshConnections: ['sshConnections'] as const,
```

In `frontend/src/features/data/queries.ts`: add `fetchSSHConnections`, `createSSHConnection`, `updateSSHConnection`, `deleteSSHConnection`, `acceptSSHHostKey` to the value imports from `@/lib/api`, and `CreateSSHConnectionBody`, `UpdateSSHConnectionBody` to its type imports (respect `import type`). Then append after `useMachineHealth` (line ~185, after the machines section):

```ts
// ---- SSH connections ----

export function useSSHConnections() {
  return useQuery({ queryKey: qk.sshConnections, queryFn: fetchSSHConnections, staleTime: 10_000 })
}

export function useCreateSSHConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateSSHConnectionBody) => createSSHConnection(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.sshConnections }),
  })
}

export function useUpdateSSHConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateSSHConnectionBody }) => updateSSHConnection(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.sshConnections }),
  })
}

export function useDeleteSSHConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteSSHConnection(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.sshConnections }),
  })
}

export function useAcceptSSHHostKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => acceptSSHHostKey(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.sshConnections }),
  })
}
```

- [ ] **Step 4: Create the WS URL helper**

Create `frontend/src/lib/sshClient.ts`:

```ts
// WS URL for an interactive SSH shell (server: backend/internal/sshmgr).
// Phase 1 always executes SSH sessions on the hub — the page's own origin —
// so unlike terminalClient.ts there is no per-machine direct-first
// resolution here yet; that arrives with ExecutorMachineID routing.

export function sshShellWsUrl(connectionId: string, cols: number, rows: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const query = new URLSearchParams({ connection: connectionId, cols: String(cols), rows: String(rows) })
  return `${proto}://${window.location.host}/ws/ssh?${query.toString()}`
}
```

- [ ] **Step 5: Verify typecheck passes**

Run: `cd frontend && npm run typecheck`
Expected: PASS (the `pretypecheck` vite build also regenerates `routeTree.gen.ts`; that's expected and must not be hand-edited).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/store/types.ts frontend/src/lib/api.ts frontend/src/lib/sshClient.ts frontend/src/features/data/keys.ts frontend/src/features/data/queries.ts
git commit -m "feat(frontend): SSH connection types, API client, and query hooks"
```

---

### Task 7: `ssh-shell` tile kind, shell pane, and canvas wiring

**Files:**
- Modify: `frontend/src/features/tabs/tileTree.ts` (`TileTab` union line ~14; factory after `createBrowserTab` line ~82)
- Test: `frontend/src/features/tabs/tileTree.ssh.test.ts` (create)
- Modify: `frontend/src/store/useLoomStore.ts` (`openSSHShellTab` action + interface entry + `createSSHShellTab` import)
- Modify: `frontend/src/features/terminal/Terminal.tsx` (export the theme, lines 20 + 109)
- Create: `frontend/src/features/ssh/SSHTerminal.tsx`
- Create: `frontend/src/features/ssh/SSHShellPane.tsx`
- Modify: `frontend/src/features/tabs/WorkspaceTileCanvas.tsx` (7 dispatch sites, detailed below)
- Modify: `frontend/src/features/tabs/WorkspaceTileArea.tsx` (renderer + resolver)

**Interfaces:**
- Consumes: `sshShellWsUrl`, `useSSHConnections` (Task 6); `inputFrame`/`resizeFrame` from `@/lib/terminalClient`; `openTileTab`/`closeTileTab`/`createDefaultTileLayout`/`findTileLeaf` from `tileTree.ts`.
- Produces (used by Task 8):
  - `createSSHShellTab(connectionId: string): TileTab` — id is `` `ssh-${connectionId}` `` so re-opening focuses the existing tab
  - `useLoomStore` action `openSSHShellTab(wsId: string, connectionId: string): void`
  - `SSHShellTileTab` exported from `WorkspaceTileCanvas.tsx`
  - `TERMINAL_THEME` exported from `Terminal.tsx`

**Why one task:** adding `ssh-shell` to the `TileTab` union immediately breaks type-narrowing in `WorkspaceTileCanvas.tsx`'s final-else dispatch branches, so the union change and all canvas dispatch sites must land together to keep `npm run typecheck` green.

- [ ] **Step 1: Write the failing tile test**

Create `frontend/src/features/tabs/tileTree.ssh.test.ts`:

```ts
/**
 * Plain assertion-based tests for the ssh-shell tile kind in tileTree.ts.
 * Same standalone-harness convention as ../terminal/paneTree.test.ts (no
 * Vitest/Jest is configured in this project). Run manually with:
 *
 *   npx tsx src/features/tabs/tileTree.ssh.test.ts
 */

import { closeTileTab, createDefaultTileLayout, createSSHShellTab, findTileLeaf, openTileTab } from './tileTree'

let passed = 0

function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

check('createSSHShellTab derives a stable id from the connection id', () => {
  const tab = createSSHShellTab('sc-1a2b3c4d')
  assert(tab.kind === 'ssh-shell', 'kind is ssh-shell')
  assert(tab.id === 'ssh-sc-1a2b3c4d', `id is derived (got ${tab.id})`)
  assert(tab.connectionId === 'sc-1a2b3c4d', 'connectionId is kept')
})

check('openTileTab adds an ssh-shell tab and makes it active', () => {
  const layout = openTileTab(createDefaultTileLayout(), createSSHShellTab('sc-1'))
  const leaf = findTileLeaf(layout.root, layout.focusedLeafId)
  assert(leaf?.type === 'leaf', 'focused leaf exists')
  assert(leaf.tabs.some((t) => t.id === 'ssh-sc-1'), 'ssh tab is in the leaf')
  assert(leaf.activeTabId === 'ssh-sc-1', 'ssh tab is active')
})

check('re-opening the same connection focuses the existing tab instead of duplicating', () => {
  let layout = openTileTab(createDefaultTileLayout(), createSSHShellTab('sc-1'))
  layout = openTileTab(layout, createSSHShellTab('sc-1'))
  const leaf = findTileLeaf(layout.root, layout.focusedLeafId)
  assert(leaf?.type === 'leaf', 'focused leaf exists')
  const sshTabs = leaf.tabs.filter((t) => t.kind === 'ssh-shell')
  assert(sshTabs.length === 1, `exactly one ssh tab (got ${sshTabs.length})`)
})

check('closeTileTab removes an ssh-shell tab', () => {
  let layout = openTileTab(createDefaultTileLayout(), createSSHShellTab('sc-1'))
  const leaf = findTileLeaf(layout.root, layout.focusedLeafId)
  assert(leaf?.type === 'leaf', 'focused leaf exists')
  layout = closeTileTab(layout, leaf.id, 'ssh-sc-1')
  const after = findTileLeaf(layout.root, layout.focusedLeafId)
  assert(after?.type === 'leaf' && !after.tabs.some((t) => t.id === 'ssh-sc-1'), 'ssh tab removed')
})

console.log(`\n${passed} checks passed`)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx tsx src/features/tabs/tileTree.ssh.test.ts`
Expected: FAILURE — `createSSHShellTab` is not exported from `./tileTree`.

- [ ] **Step 3: Add the tile kind + factory**

In `frontend/src/features/tabs/tileTree.ts`, change the `TileTab` union (line ~14) from:

```ts
export type TileTab =
  | { kind: 'agents'; id: 'agents' }
  | { kind: 'worktree'; id: string; projectId: string; wtId: string }
  | { kind: 'browser'; id: string }
```

to:

```ts
export type TileTab =
  | { kind: 'agents'; id: 'agents' }
  | { kind: 'worktree'; id: string; projectId: string; wtId: string }
  | { kind: 'browser'; id: string }
  | { kind: 'ssh-shell'; id: string; connectionId: string }
```

And add after `createBrowserTab` (line ~82):

```ts
/** An ssh-shell tile's id is derived from its connection id, so opening the
 *  same saved connection twice focuses the existing shell instead of
 *  spawning a second one (same dedupe contract as worktree tabs). */
export function createSSHShellTab(connectionId: string): TileTab {
  return { kind: 'ssh-shell', id: `ssh-${connectionId}`, connectionId }
}
```

- [ ] **Step 4: Run the tile test to verify it passes**

Run: `cd frontend && npx tsx src/features/tabs/tileTree.ssh.test.ts`
Expected: `4 checks passed`. (Typecheck is NOT expected to pass yet — the canvas dispatch sites break until Step 6; that's the point of this task's single-commit scope.)

- [ ] **Step 5: Add the store action**

In `frontend/src/store/useLoomStore.ts`:

(a) Add `createSSHShellTab` to the existing import from `@/features/tabs/tileTree` (the one that already imports `createBrowserTab`, `createDefaultTileLayout`, `openTileTab`, ...).

(b) In the `LoomState` interface, next to `openBrowserTab`'s declaration, add:

```ts
  openSSHShellTab: (wsId: string, connectionId: string) => void
```

(c) In the store implementation, directly after the `openBrowserTab` action (line ~341), add:

```ts
      openSSHShellTab: (wsId, connectionId) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId] ?? createDefaultTileLayout()
          s.workspaceTileLayouts[wsId] = openTileTab(layout, createSSHShellTab(connectionId))
        }),
```

- [ ] **Step 6: Export the terminal theme and create the SSH pane components**

In `frontend/src/features/terminal/Terminal.tsx`, change line 20 from `const THEME = {` to `export const TERMINAL_THEME = {` and its single usage (line ~109) from `theme: THEME,` to `theme: TERMINAL_THEME,`.

Create `frontend/src/features/ssh/SSHTerminal.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { inputFrame, resizeFrame } from '@/lib/terminalClient'
import { sshShellWsUrl } from '@/lib/sshClient'
import { TERMINAL_THEME } from '@/features/terminal/Terminal'

/** xterm.js wired to the hub's /ws/ssh gateway for one saved connection.
 *  Unlike the worktree Terminal there is no server-side reattach registry:
 *  the remote shell lives exactly as long as this socket, so a dropped
 *  connection is NOT silently retried (that would open a fresh shell and
 *  discard remote state without the user asking) — Enter reconnects. */
export function SSHTerminal({ connectionId }: { connectionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new XTerm({
      fontFamily: "'Geist Mono', ui-monospace, monospace",
      fontSize: 12.5,
      lineHeight: 1.35,
      cursorBlink: true,
      convertEol: false,
      theme: TERMINAL_THEME,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    fit.fit()

    let disposed = false
    let ws: WebSocket | null = null

    const connect = () => {
      if (disposed) return
      const socket = new WebSocket(sshShellWsUrl(connectionId, term.cols, term.rows))
      socket.binaryType = 'arraybuffer'
      ws = socket
      socket.onmessage = (ev) => {
        if (typeof ev.data === 'string') term.write(ev.data)
        else if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data))
      }
      socket.onclose = () => {
        if (disposed) return
        ws = null
        term.write('\r\n\x1b[38;5;102m[ssh session closed — press Enter to reconnect]\x1b[0m\r\n')
      }
      socket.onerror = () => {
        term.write('\r\n\x1b[38;5;210m[ssh connection error]\x1b[0m\r\n')
      }
    }

    connect()

    const onData = term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(inputFrame(data))
      } else if (!ws && data.includes('\r')) {
        // Enter on a dead session opens a fresh shell (no history replay —
        // the remote shell died with the previous socket).
        term.reset()
        connect()
      }
    })
    const onResize = term.onResize(({ cols, rows }) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(resizeFrame(cols, rows))
    })

    // Trailing-edge debounce, mirroring Terminal.tsx: fold resize bursts
    // (mobile keyboard, divider drags) into a single fit + SIGWINCH.
    let fitTimer: number | undefined
    const ro = new ResizeObserver(() => {
      if (fitTimer !== undefined) window.clearTimeout(fitTimer)
      fitTimer = window.setTimeout(() => {
        fitTimer = undefined
        try {
          fit.fit()
        } catch {
          /* host detached */
        }
      }, 150)
    })
    ro.observe(host)
    term.focus()

    return () => {
      disposed = true
      if (fitTimer !== undefined) window.clearTimeout(fitTimer)
      ro.disconnect()
      onData.dispose()
      onResize.dispose()
      if (ws) {
        ws.onclose = null
        ws.onmessage = null
        ws.onerror = null
        ws.close()
      }
      term.dispose()
    }
  }, [connectionId])

  return <div ref={hostRef} className="h-full w-full" />
}
```

Create `frontend/src/features/ssh/SSHShellPane.tsx`:

```tsx
import { SSHTerminal } from './SSHTerminal'

/** Tile body for the 'ssh-shell' tab kind — same chrome as the worktree
 *  terminal renderer in ExpandedTerminal.tsx. */
export function SSHShellPane({ connectionId }: { connectionId: string }) {
  return (
    <div className="h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden bg-loom-terminal px-3 py-2">
      <SSHTerminal key={connectionId} connectionId={connectionId} />
    </div>
  )
}
```

- [ ] **Step 7: Wire the canvas dispatch sites**

In `frontend/src/features/tabs/WorkspaceTileCanvas.tsx`, make these edits (all seven — miss one and typecheck fails):

(1) Add `Cable` to the lucide-react import (the one with `Globe`, `LayoutGrid`, `Plus`, `X`).

(2) After the two `Extract` type aliases (line ~19), add:

```ts
export type SSHShellTileTab = Extract<TileTab, { kind: 'ssh-shell' }>
```

(3) In `WorkspaceTileCanvasProps.renderers`, after the `browser` entry, add:

```ts
    sshShell: (ctx: { leafId: string; tab: SSHShellTileTab }) => ReactNode
```

and after the `resolveBrowserTab` prop, add:

```ts
  /** Live title for an ssh-shell tab, resolved from the SSH connections
   *  query (mirrors `resolveBrowserTab`'s contract). */
  resolveSSHShellTab: (tab: SSHShellTileTab) => { label: string } | undefined
```

(4) In `TileRenderContext`, after `resolveBrowserTab`, add:

```ts
  resolveSSHShellTab: WorkspaceTileCanvasProps['resolveSSHShellTab']
```

(5) Replace the whole `leafShortTitle` function (line ~77) with:

```ts
function leafShortTitle(
  leaf: TileLeaf,
  resolveWorktreeTab: WorkspaceTileCanvasProps['resolveWorktreeTab'],
  resolveBrowserTab: WorkspaceTileCanvasProps['resolveBrowserTab'],
  resolveSSHShellTab: WorkspaceTileCanvasProps['resolveSSHShellTab'],
): string {
  const tab = leaf.tabs.find((t) => t.id === leaf.activeTabId) ?? leaf.tabs[0]
  if (!tab) return ''
  if (tab.kind === 'agents') return 'Agents'
  if (tab.kind === 'browser') return resolveBrowserTab(tab)?.label ?? 'Browser'
  if (tab.kind === 'ssh-shell') return resolveSSHShellTab(tab)?.label ?? 'SSH'
  return resolveWorktreeTab(tab)?.short ?? tab.wtId
}
```

and update its call site in the `workspaceTitle` memo (line ~447) to:

```ts
      .map((leaf) => leafShortTitle(leaf, resolveWorktreeTab, resolveBrowserTab, resolveSSHShellTab))
      .filter(Boolean)
    return titles.length > 1 ? `Workspace (${titles.join(' + ')})` : null
  }, [root, resolveWorktreeTab, resolveBrowserTab, resolveSSHShellTab])
```

(6) In `TileTabButton`: add `resolveSSHShellTab: WorkspaceTileCanvasProps['resolveSSHShellTab']` to both its props destructuring and its props type (next to `resolveBrowserTab`), then insert this branch between the `worktree` and `browser` branches (line ~289):

```tsx
  if (tab.kind === 'ssh-shell') {
    const info = resolveSSHShellTab(tab)
    if (!info) return null
    return (
      <div ref={setNodeRef} {...attributes} {...listeners} className={wrapperClass(isDragging)}>
        <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5">
          <Cable size={12} />
          <span className="truncate">{info.label}</span>
        </button>
        {closeButton(info.label)}
      </div>
    )
  }
```

and add `resolveSSHShellTab={ctx.resolveSSHShellTab}` at `TileTabButton`'s call site in `TileLeafHeader` (line ~351, next to `resolveBrowserTab={ctx.resolveBrowserTab}`).

(7) In `TileLeafView`'s body dispatch (line ~394), change:

```tsx
            {tab.kind === 'agents'
              ? ctx.renderers.agents({ leafId: leaf.id })
              : tab.kind === 'worktree'
                ? ctx.renderers.worktree({ leafId: leaf.id, tab })
                : ctx.renderers.browser({ leafId: leaf.id, tab })}
```

to:

```tsx
            {tab.kind === 'agents'
              ? ctx.renderers.agents({ leafId: leaf.id })
              : tab.kind === 'worktree'
                ? ctx.renderers.worktree({ leafId: leaf.id, tab })
                : tab.kind === 'ssh-shell'
                  ? ctx.renderers.sshShell({ leafId: leaf.id, tab })
                  : ctx.renderers.browser({ leafId: leaf.id, tab })}
```

Then in the main `WorkspaceTileCanvas` component: add `resolveSSHShellTab,` to the props destructuring (after `resolveBrowserTab,`, line ~428) and `resolveSSHShellTab,` to the `ctx: TileRenderContext` literal (line ~504). Finally, in the `DragOverlay` block (line ~526), change the icon ternary to:

```tsx
            {dragTab.kind === 'agents' ? (
              <LayoutGrid size={12} />
            ) : dragTab.kind === 'worktree' ? (
              <StatusDot color={resolveWorktreeTab(dragTab)?.color ?? '#6b7280'} />
            ) : dragTab.kind === 'ssh-shell' ? (
              <Cable size={12} />
            ) : (
              <Globe size={12} />
            )}
```

and the label ternary to:

```tsx
              {dragTab.kind === 'agents'
                ? 'Agents'
                : dragTab.kind === 'worktree'
                  ? (resolveWorktreeTab(dragTab)?.label ?? dragTab.wtId)
                  : dragTab.kind === 'ssh-shell'
                    ? (resolveSSHShellTab(dragTab)?.label ?? 'SSH')
                    : (resolveBrowserTab(dragTab)?.label ?? 'Browser')}
```

- [ ] **Step 8: Wire WorkspaceTileArea**

In `frontend/src/features/tabs/WorkspaceTileArea.tsx`:

(a) Imports: add `useSSHConnections` to the import from `@/features/data/queries`; add `SSHShellTileTab` to the `import type { BrowserTileTab, WorktreeTileTab } from './WorkspaceTileCanvas'` line; add `import { SSHShellPane } from '@/features/ssh/SSHShellPane'`.

(b) After `const machines = useMachines().data ?? []`, add:

```ts
  const sshConnections = useSSHConnections().data ?? []
```

(c) After the `resolveBrowserTab` function (line ~168), add:

```ts
  function resolveSSHShellTab(tab: SSHShellTileTab) {
    const connection = sshConnections.find((c) => c.id === tab.connectionId)
    return { label: connection?.name ?? 'SSH' }
  }
```

(d) In the `renderers` prop object, after the `browser` entry, add:

```tsx
          sshShell: ({ tab }) => <SSHShellPane connectionId={tab.connectionId} />,
```

(e) After `resolveBrowserTab={resolveBrowserTab}`, add:

```tsx
        resolveSSHShellTab={resolveSSHShellTab}
```

(No change needed in `navigateToTab` or `handleCloseTab`: ssh-shell tabs take the existing non-worktree else-branch for navigation, and closing the tab unmounts `SSHTerminal`, whose effect cleanup closes the socket — which ends the remote shell, since the session's lifetime is the socket's.)

- [ ] **Step 9: Verify typecheck and both standalone test scripts pass**

Run: `cd frontend && npm run typecheck && npx tsx src/features/tabs/tileTree.ssh.test.ts && npx tsx src/features/terminal/paneTree.test.ts`
Expected: typecheck PASS, `4 checks passed`, and paneTree's full pass count (no regression).

- [ ] **Step 10: Commit**

```bash
git add frontend/src/features/tabs/tileTree.ts frontend/src/features/tabs/tileTree.ssh.test.ts frontend/src/store/useLoomStore.ts frontend/src/features/terminal/Terminal.tsx frontend/src/features/ssh/SSHTerminal.tsx frontend/src/features/ssh/SSHShellPane.tsx frontend/src/features/tabs/WorkspaceTileCanvas.tsx frontend/src/features/tabs/WorkspaceTileArea.tsx
git commit -m "feat(frontend): ssh-shell workspace tile kind with xterm pane over /ws/ssh"
```

---

### Task 8: SSH connections page (module, dialog, route, nav, overlays)

**Files:**
- Modify: `frontend/src/store/useLoomStore.ts` (`EditKind` line 23; `SSHDialogState` next to `MachineDialogState` line ~64; interface entries; init line ~291; actions after the machine-dialog actions line ~472)
- Create: `frontend/src/features/ssh/SSHConnectionsModule.tsx`
- Create: `frontend/src/features/ssh/SSHConnectionDialog.tsx`
- Create: `frontend/src/routes/w.$wsId.ssh.tsx`
- Modify: `frontend/src/features/sidebar/SidebarNav.tsx` (icon import; `items` array line ~49)
- Modify: `frontend/src/features/overlays/GlobalOverlays.tsx` (mount the dialog)
- Modify: `frontend/src/features/overlays/ConfirmDeleteDialog.tsx` (`bodyFor` + delete branch)

**Interfaces:**
- Consumes: Task 6 hooks (`useSSHConnections`, `useCreateSSHConnection`, `useUpdateSSHConnection`, `useDeleteSSHConnection`, `useAcceptSSHHostKey`); Task 7's `openSSHShellTab` store action; `SSHConnection` type; existing UI kit (`Button`, `Dialog`, `Input`, `Label`, `Select`), `useScope`, `DataLoading`.
- Produces: route `/w/$wsId/ssh`; store state `sshDialog: SSHDialogState` with actions `openAddSSHConnection()`, `openEditSSHConnection(conn: SSHConnection)`, `closeSSHDialog()`, `setSSHDialog(patch: Partial<SSHDialogState>)`; `EditKind` includes `'ssh'`.

- [ ] **Step 1: Add the store dialog state**

In `frontend/src/store/useLoomStore.ts`:

(a) Change line 23 from:

```ts
export type EditKind = 'worktree' | 'project' | 'workspace' | 'machine'
```

to:

```ts
export type EditKind = 'worktree' | 'project' | 'workspace' | 'machine' | 'ssh'
```

(`EditKind` doubles as the confirm-delete kind — `confirmDelete: { kind: EditKind; ... }`. `EditDrawer` is unaffected: it only ever renders kinds passed to `openEdit`, which is never called with `'ssh'`.)

(b) Add `SSHConnection` to the `import type { ... } from './types'` list at the top.

(c) After the `MachineDialogState` interface (line ~70), add:

```ts
interface SSHDialogState {
  open: boolean
  editingId: string | null
  name: string
  host: string
  /** Kept as the text field's raw string; parsed + validated on submit. */
  port: string
  username: string
  authType: 'password' | 'privatekey'
  password: string
  privateKey: string
  passphrase: string
}
```

(d) In the `LoomState` interface, next to the machine-dialog entries, add:

```ts
  sshDialog: SSHDialogState
  openAddSSHConnection: () => void
  openEditSSHConnection: (conn: SSHConnection) => void
  closeSSHDialog: () => void
  setSSHDialog: (patch: Partial<SSHDialogState>) => void
```

(e) In the store initializer, after the `machineDialog: ...` line (line ~291), add:

```ts
      sshDialog: { open: false, editingId: null, name: '', host: '', port: '22', username: '', authType: 'password', password: '', privateKey: '', passphrase: '' },
```

(f) After the `setMachineDialog` action (line ~472), add:

```ts
      openAddSSHConnection: () =>
        set(
          (s) =>
            void (s.sshDialog = {
              open: true,
              editingId: null,
              name: '',
              host: '',
              port: '22',
              username: '',
              authType: 'password',
              password: '',
              privateKey: '',
              passphrase: '',
            }),
        ),
      openEditSSHConnection: (conn) =>
        set(
          (s) =>
            void (s.sshDialog = {
              open: true,
              editingId: conn.id,
              name: conn.name,
              host: conn.host,
              port: String(conn.port),
              username: conn.username,
              authType: conn.authType,
              password: '',
              privateKey: '',
              passphrase: '',
            }),
        ),
      closeSSHDialog: () => set((s) => void (s.sshDialog.open = false)),
      setSSHDialog: (patch) => set((s) => void Object.assign(s.sshDialog, patch)),
```

- [ ] **Step 2: Create the list module**

Create `frontend/src/features/ssh/SSHConnectionsModule.tsx`:

```tsx
import { Cable, Plus, RotateCcw } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { DataLoading } from '@/features/screens/DataLoading'
import { useScope } from '@/features/useScope'
import type { SSHConnection } from '@/store/types'
import { useAcceptSSHHostKey, useSSHConnections } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

function HostKeyBadge({ connection }: { connection: SSHConnection }) {
  const acceptHostKey = useAcceptSSHHostKey()
  const showToast = useLoomStore((s) => s.showToast)
  if (!connection.hostKeyFingerprint) {
    return <span className="font-mono text-[10.5px] text-loom-dim">key: trust on first connect</span>
  }
  return (
    <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-loom-dim-2">
      <span className="max-w-[180px] truncate" title={connection.hostKeyFingerprint}>
        {connection.hostKeyFingerprint}
      </span>
      <button
        type="button"
        aria-label="Reset pinned host key"
        title="Reset pinned host key (re-pins on next connect)"
        onClick={() =>
          acceptHostKey.mutate(connection.id, {
            onSuccess: () => showToast(`Host key for "${connection.name}" reset — re-pins on next connect`),
          })
        }
        className="cursor-pointer p-0.5 text-loom-muted-2 hover:text-loom-accent-soft"
      >
        <RotateCcw size={11} />
      </button>
    </span>
  )
}

function SSHConnectionRow({ connection }: { connection: SSHConnection }) {
  const navigate = useNavigate()
  const { wsId } = useScope()
  const openEditSSHConnection = useLoomStore((s) => s.openEditSSHConnection)
  const openSSHShellTab = useLoomStore((s) => s.openSSHShellTab)
  const askDelete = useLoomStore((s) => s.askDelete)

  function openShell() {
    if (!wsId) return
    openSSHShellTab(wsId, connection.id)
    navigate({ to: '/w/$wsId', params: { wsId } })
  }

  return (
    <div className="flex items-center gap-3 border-b border-loom-border px-3 py-2.5">
      <Cable size={14} className="flex-none text-loom-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate font-mono text-[12.5px] text-loom-fg-2">{connection.name}</div>
          <span className="flex-none rounded-full border border-loom-border px-2 py-0.5 font-mono text-[10.5px] text-loom-dim-2">
            {connection.authType === 'password' ? 'password' : 'private key'}
          </span>
        </div>
        <div className="truncate font-mono text-[10.5px] text-loom-dim-2">
          {connection.username}@{connection.host}:{connection.port}
        </div>
      </div>
      <HostKeyBadge connection={connection} />
      <Button size="sm" onClick={openShell}>
        Shell
      </Button>
      <Button variant="secondary" size="sm" onClick={() => openEditSSHConnection(connection)}>
        Edit
      </Button>
      <Button variant="destructive" size="sm" onClick={() => askDelete('ssh', connection.id, connection.name)}>
        Delete
      </Button>
    </div>
  )
}

export function SSHConnectionsModule() {
  const { data: connections, isLoading, error, refetch } = useSSHConnections()
  const openAddSSHConnection = useLoomStore((s) => s.openAddSSHConnection)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-none items-center gap-2.5 border-b border-loom-border px-4 py-3">
        <h1 className="flex-1 font-mono text-[13px] font-medium text-loom-fg">SSH</h1>
        <Button size="sm" onClick={openAddSSHConnection}>
          <Plus size={13} />
          Add connection
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex h-[120px] items-center justify-center">
            <DataLoading compact label="loading connections…" />
          </div>
        ) : error ? (
          <div className="flex h-[120px] flex-col items-center justify-center gap-3 px-4">
            <span className="text-center font-mono text-xs text-loom-dim-2">
              {error instanceof Error ? error.message : 'Failed to load SSH connections'}
            </span>
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : !connections || connections.length === 0 ? (
          <div className="flex h-[120px] items-center justify-center font-mono text-xs text-loom-dim-2">
            No SSH connections yet
          </div>
        ) : (
          connections.map((c) => <SSHConnectionRow key={c.id} connection={c} />)
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create the add/edit dialog**

Create `frontend/src/features/ssh/SSHConnectionDialog.tsx`:

```tsx
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useCreateSSHConnection, useUpdateSSHConnection } from '@/features/data/queries'
import type { CreateSSHConnectionBody, UpdateSSHConnectionBody } from '@/lib/api'
import { useLoomStore } from '@/store/useLoomStore'

const AUTH_OPTIONS = [
  { value: 'password', label: 'Password' },
  { value: 'privatekey', label: 'Private key' },
]

export function SSHConnectionDialog() {
  const dialog = useLoomStore((s) => s.sshDialog)
  const setDialog = useLoomStore((s) => s.setSSHDialog)
  const close = useLoomStore((s) => s.closeSSHDialog)
  const showToast = useLoomStore((s) => s.showToast)
  const createConnection = useCreateSSHConnection()
  const updateConnection = useUpdateSSHConnection()

  const isEdit = dialog.editingId !== null
  const busy = createConnection.isPending || updateConnection.isPending
  const portNum = Number.parseInt(dialog.port, 10)
  const portOK = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535
  // On create the auth secret is required; on edit a blank secret means "keep the stored one".
  const secretOK =
    isEdit || (dialog.authType === 'password' ? dialog.password.length > 0 : dialog.privateKey.length > 0)
  const canSubmit =
    dialog.name.trim().length > 0 &&
    dialog.host.trim().length > 0 &&
    dialog.username.trim().length > 0 &&
    portOK &&
    secretOK &&
    !busy

  function submit() {
    if (!canSubmit) return
    const base = {
      name: dialog.name.trim(),
      host: dialog.host.trim(),
      port: portNum,
      username: dialog.username.trim(),
      authType: dialog.authType,
    }
    const secrets: UpdateSSHConnectionBody = {}
    if (dialog.password) secrets.password = dialog.password
    if (dialog.privateKey) secrets.privateKey = dialog.privateKey
    if (dialog.passphrase) secrets.passphrase = dialog.passphrase

    const onError = (err: unknown) =>
      showToast(err instanceof Error ? err.message : 'Failed to save SSH connection')

    if (dialog.editingId) {
      updateConnection.mutate(
        { id: dialog.editingId, patch: { ...base, ...secrets } },
        {
          onSuccess: () => {
            close()
            showToast(`Updated SSH connection "${base.name}"`)
          },
          onError,
        },
      )
    } else {
      const body: CreateSSHConnectionBody = { ...base, ...secrets }
      createConnection.mutate(body, {
        onSuccess: () => {
          close()
          showToast(`Added SSH connection "${base.name}"`)
        },
        onError,
      })
    }
  }

  return (
    <Dialog open={dialog.open} onOpenChange={(o) => !o && !busy && close()} width={480}>
      <DialogTitle>{isEdit ? 'Edit SSH connection' : 'Add SSH connection'}</DialogTitle>
      <DialogDescription className="mb-[18px]">
        Any SSH host — not limited to registered machines. Credentials are encrypted at rest and never sent back
        to the browser.
      </DialogDescription>

      <Label>Name</Label>
      <Input
        value={dialog.name}
        disabled={busy}
        onChange={(e) => setDialog({ name: e.target.value })}
        placeholder="prod-web"
        className="mb-3 font-mono"
      />

      <div className="mb-3 flex gap-3">
        <div className="min-w-0 flex-1">
          <Label>Host</Label>
          <Input
            value={dialog.host}
            disabled={busy}
            onChange={(e) => setDialog({ host: e.target.value })}
            placeholder="web.example.com"
            className="font-mono"
          />
        </div>
        <div className="w-[90px] flex-none">
          <Label>Port</Label>
          <Input
            value={dialog.port}
            disabled={busy}
            onChange={(e) => setDialog({ port: e.target.value })}
            placeholder="22"
            className="font-mono"
          />
        </div>
      </div>

      <Label>Username</Label>
      <Input
        value={dialog.username}
        disabled={busy}
        onChange={(e) => setDialog({ username: e.target.value })}
        placeholder="deploy"
        className="mb-3 font-mono"
      />

      <Label>Auth</Label>
      <Select
        value={dialog.authType}
        onValueChange={(v) => setDialog({ authType: v as 'password' | 'privatekey' })}
        options={AUTH_OPTIONS}
        aria-label="Auth method"
      />

      {dialog.authType === 'password' ? (
        <div className="mt-3">
          <Label>Password</Label>
          <Input
            value={dialog.password}
            disabled={busy}
            type="password"
            onChange={(e) => setDialog({ password: e.target.value })}
            placeholder={isEdit ? 'unchanged' : ''}
            className="mb-5 font-mono"
          />
        </div>
      ) : (
        <div className="mt-3">
          <Label>Private key (PEM)</Label>
          <textarea
            value={dialog.privateKey}
            disabled={busy}
            onChange={(e) => setDialog({ privateKey: e.target.value })}
            placeholder={isEdit ? 'unchanged' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
            rows={4}
            className="mb-3 w-full resize-y rounded-lg border border-loom-border-strong bg-loom-bg px-2.5 py-2 font-mono text-[11px] text-loom-fg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <Label>Passphrase (optional)</Label>
          <Input
            value={dialog.passphrase}
            disabled={busy}
            type="password"
            onChange={(e) => setDialog({ passphrase: e.target.value })}
            placeholder={isEdit ? 'unchanged' : ''}
            className="mb-5 font-mono"
          />
        </div>
      )}

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          {isEdit ? 'Save' : 'Add'}
        </Button>
      </div>
    </Dialog>
  )
}
```

- [ ] **Step 4: Create the route and register the nav + overlays**

Create `frontend/src/routes/w.$wsId.ssh.tsx`:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { SSHConnectionsModule } from '@/features/ssh/SSHConnectionsModule'

export const Route = createFileRoute('/w/$wsId/ssh')({
  component: SSHRoute,
})

function SSHRoute() {
  return <SSHConnectionsModule />
}
```

In `frontend/src/features/sidebar/SidebarNav.tsx`: add `Cable` to the lucide-react import, and add to the `items` array after the machines entry (line ~55):

```ts
    { key: 'ssh', label: 'SSH', Icon: Cable, badge: 0 },
```

(`goto`'s generic else-branch already navigates to `/w/$wsId/ssh` for this key.)

In `frontend/src/features/overlays/GlobalOverlays.tsx`, add the import and mount:

```tsx
import { SSHConnectionDialog } from '@/features/ssh/SSHConnectionDialog'
```

and add `<SSHConnectionDialog />` after `<MachineDialog />` inside the fragment.

- [ ] **Step 5: Wire the delete confirmation**

In `frontend/src/features/overlays/ConfirmDeleteDialog.tsx`:

(a) Add `useDeleteSSHConnection` to the import list from `@/features/data/queries`.

(b) In `bodyFor`, before the final `return`, add:

```ts
  if (kind === 'ssh')
    return `This removes SSH connection "${name}" and its stored credentials. The remote host itself is not touched.`
```

(c) In the component, next to `const deleteMachine = useDeleteMachine()`, add:

```ts
  const deleteSSHConnection = useDeleteSSHConnection()
```

(d) In `onDelete`, insert a branch between the `kind === 'machine'` block and the final `else`:

```ts
    } else if (kind === 'ssh') {
      deleteSSHConnection.mutate(id, {
        onSuccess: () => {
          cancelConfirm()
          toast()
        },
      })
    } else {
```

- [ ] **Step 6: Verify typecheck (which also regenerates the route tree)**

Run: `cd frontend && npm run typecheck`
Expected: PASS. The `pretypecheck` vite build regenerates `src/routeTree.gen.ts` to include `/w/$wsId/ssh` — do not edit that file manually; commit the regenerated version.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/store/useLoomStore.ts frontend/src/features/ssh/SSHConnectionsModule.tsx frontend/src/features/ssh/SSHConnectionDialog.tsx frontend/src/routes/w.\$wsId.ssh.tsx frontend/src/routeTree.gen.ts frontend/src/features/sidebar/SidebarNav.tsx frontend/src/features/overlays/GlobalOverlays.tsx frontend/src/features/overlays/ConfirmDeleteDialog.tsx
git commit -m "feat(frontend): SSH connections page with add/edit dialog and shell launcher"
```

---

### Task 9: Full verification sweep + manual smoke test

**Files:** none created — this task gates the phase.

- [ ] **Step 1: Backend gate**

Run: `cd backend && go vet ./... && go test ./...`
Expected: all packages PASS, vet silent.

- [ ] **Step 2: Frontend gate**

Run: `cd frontend && npm run typecheck && npx tsx src/features/tabs/tileTree.ssh.test.ts && npx tsx src/features/terminal/paneTree.test.ts`
Expected: typecheck PASS; `4 checks passed`; paneTree full pass count.

- [ ] **Step 3: Manual smoke test (requires a reachable SSH host)**

1. Start the stack: `cd frontend && npm run dev` (starts the Go hub on :8989 + Vite).
2. Sidebar → **SSH** → **Add connection**: fill name/host/port/username, pick auth, enter the credential → **Add**. The row appears with "key: trust on first connect".
3. Click **Shell** → the workspace opens an `ssh-shell` tab; the remote prompt appears; typing works; resizing the pane reflows the remote TTY.
4. Back on the SSH page: the row now shows the pinned `SHA256:...` fingerprint.
5. Negative path: edit the connection to a wrong password (or point it at a host whose key differs) → the shell pane prints `[ssh error: ...]` instead of a prompt. For a host-key mismatch, the reset button (↺) next to the fingerprint clears the pin and the next connect succeeds and re-pins.
6. Exit the remote shell (`exit`) → pane prints `[ssh session ended]`; pressing Enter opens a fresh shell.

- [ ] **Step 4: Update COMMANDS.md if it documents WS routes** (check whether `COMMANDS.md` lists `/ws/terminal`; if it does, add `/ws/ssh` alongside it — if it doesn't mention WS routes, skip this step; no other docs need changes for phase 1).

- [ ] **Step 5: Final commit (if Step 4 changed anything)**

```bash
git add COMMANDS.md
git commit -m "docs: note /ws/ssh route"
```

---

## Out of scope for this plan (later build-order phases)

- **SFTP** browse/CRUD/transfers (`/api/ssh/connections/{id}/sftp/...`, `pkg/sftp`) — phase 2.
- **Port forwarding** (`-L`/`-R`/`-D` headless sessions) and **jump-host chaining** (`JumpConnectionID` resolution) — phase 3.
- **ExecutorMachineID routing** (runtime executes, hub proxies the WS) and the **keychain `StorageKind`** + executor-locking rule (Tauri app) — later phases. The schema, domain types, and API shapes added here already carry the fields these need.
- **Shell reattach/grace-TTL registry** for SSH sessions (the spec deliberately keeps SSH out of `internal/terminal`'s registry; if reconnect-with-history is wanted later, it's a new `sshmgr` registry, not a retrofit).

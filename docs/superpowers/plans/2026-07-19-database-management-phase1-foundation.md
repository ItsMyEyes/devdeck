# Database Management — Phase 1: Registry Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the hub-side connection registry for the database module — domain types, persistence, encrypted credentials, saved queries, and the validation rules that reject unsafe TLS modes and unsafe executor machines — with no driver code yet.

**Architecture:** Mirrors the existing SSH registry exactly (`ssh_connections` + `ssh_secrets` + `SSHSecretService`). Connections are hub data; credentials live in a separate table encrypted with AES-256-GCM under the same master key as TOTP secrets. Validation is a standalone package so drivers and handlers share one rule set.

**Tech Stack:** Go 1.25, stdlib `net/http` (Go 1.22 mux), `modernc.org/sqlite`, React 19 + TypeScript 5.7 (types only in this phase).

**Spec:** `docs/superpowers/specs/2026-07-19-database-management-design.md`

## Global Constraints

- All API responses use the `{"error":"message"}` envelope. Never add `success`, `data`, `code`, or `status` fields. (`CONTRACTS.md`)
- Go handlers use `handleStoreErr()` for store errors; raw SQL errors never reach the client.
- All persistence goes through `port.Store`. Never call `db.Query()` / `db.Exec()` outside `internal/store/`.
- Store methods return `(domain.X, error)`, never `(*domain.X, error)`. Update methods accept a `*Patch` struct.
- Partial updates use pointer fields; `nil` means "not provided".
- `domain/models.go` and `frontend/src/store/types.ts` must stay in sync.
- Frontend imports use the `@/*` alias; `verbatimModuleSyntax` is on, so type-only imports use `import type`.
- Never edit `frontend/src/routeTree.gen.ts` — it is generated.
- Verify with `go vet ./...` and `go test ./...` in `backend/`, `npm run typecheck` in `frontend/`.

**Convergence files — these tasks must NOT run in parallel with each other:** Task 1 (`domain/models.go`, `store/types.ts`), Task 2 (`port/store.go`, `store/db.go`), Task 6 (`cmd/server/main.go`).

---

### Task 1: Domain types (hub + frontend)

**Files:**
- Modify: `backend/internal/domain/models.go` (append after `SSHSecret`, ~line 245)
- Modify: `frontend/src/store/types.ts` (append near `SSHConnection`, ~line 149; and `ModuleView` at line 206)

**Interfaces:**
- Produces: `domain.DBConnection`, `domain.DBSecret`, `domain.DBSavedQuery`; TS `DBConnection`, `DBSavedQuery`, `DBEngine`, `ModuleView` gains `'database'`.

- [ ] **Step 1: Add Go domain types**

Append to `backend/internal/domain/models.go`:

```go
// DBConnection is a saved connection to an external SQL database — the
// registry behind the Database module. Credentials live in DBSecret rows,
// never on this struct, exactly like SSHConnection/SSHSecret.
type DBConnection struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Group    string `json:"group"`
	Engine   string `json:"engine"`   // "postgres" | "mysql" | "sqlite"
	Host     string `json:"host"`     // ignored for sqlite
	Port     int    `json:"port"`     // ignored for sqlite
	Username string `json:"username"` // ignored for sqlite
	Database string `json:"database"` // initial database; for sqlite: file path
	SSLMode  string `json:"sslMode"`

	// ExecutorMachineID selects which Machine dials this database;
	// nil = the hub itself.
	ExecutorMachineID *string `json:"executorMachineId"`
	// TunnelConnectionID references an SSHConnection used as a tunnel;
	// nil = direct connection.
	TunnelConnectionID *string `json:"tunnelConnectionId"`
	// IsProduction colors the tab, forces extra confirmation on commits and
	// DDL, and rejects unverified TLS modes. An error-reduction affordance,
	// NOT a security control — the operator holds full credentials either way.
	IsProduction bool `json:"isProduction"`
	// ServerCertFingerprint is a TOFU-pinned SHA256 fingerprint of the database
	// server's TLS certificate, for private CAs. Mirrors
	// SSHConnection.HostKeyFingerprint: set on first connect, mismatch blocks.
	ServerCertFingerprint *string `json:"serverCertFingerprint"`
}

// DBSecret is one encrypted credential for a DBConnection. Every field is
// json:"-": these never serialize into any API response.
type DBSecret struct {
	ConnectionID string  `json:"-"`
	Kind         string  `json:"-"` // "password" | "ca_cert" | "client_cert" | "client_key"
	StorageKind  string  `json:"-"` // "db" today; "keychain" with the Tauri phase
	CipherText   string  `json:"-"` // base64 "nonce||ciphertext" (AES-256-GCM)
	KeychainRef  *string `json:"-"`
}

// DBSavedQuery is a named SQL snippet attached to a connection — the
// "Queries" node in the object tree.
type DBSavedQuery struct {
	ID           string `json:"id"`
	ConnectionID string `json:"connectionId"`
	Name         string `json:"name"`
	SQL          string `json:"sql"`
	UpdatedAt    string `json:"updatedAt"`
}
```

- [ ] **Step 2: Add matching frontend types**

Append to `frontend/src/store/types.ts`:

```ts
export type DBEngine = 'postgres' | 'mysql' | 'sqlite'

/** Mirrors backend domain.DBConnection. Secrets are write-only: they ride on
 *  create/update bodies and never come back in a response. */
export interface DBConnection {
  id: string
  name: string
  group: string
  engine: DBEngine
  host: string
  port: number
  username: string
  database: string
  sslMode: string
  executorMachineId: string | null
  tunnelConnectionId: string | null
  isProduction: boolean
  serverCertFingerprint: string | null
}

/** Mirrors backend domain.DBSavedQuery. */
export interface DBSavedQuery {
  id: string
  connectionId: string
  name: string
  sql: string
  updatedAt: string
}
```

- [ ] **Step 3: Extend ModuleView**

In `frontend/src/store/types.ts` line 206, change:

```ts
export type ModuleView = 'agents' | 'management' | 'news' | 'todos' | 'invoices' | 'tools' | 'browser' | 'machines' | 'ssh' | 'database'
```

- [ ] **Step 4: Verify both sides compile**

Run: `cd backend && go build ./... && cd ../frontend && npm run typecheck`
Expected: both succeed with no output errors.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/domain/models.go frontend/src/store/types.ts
git commit -m "feat(db): add DBConnection, DBSecret, DBSavedQuery domain types"
```

---

### Task 2: Schema, migration, and store CRUD

**Files:**
- Modify: `backend/internal/store/db.go` (schema block after `ssh_secrets`, ~line 196; migration func after `migrateSSHConnectionColumns`, ~line 380)
- Create: `backend/internal/store/dbconn.go`
- Create: `backend/internal/store/dbconn_test.go`
- Modify: `backend/internal/port/store.go` (add methods + patch struct)

**Interfaces:**
- Consumes: `domain.DBConnection`, `domain.DBSecret`, `domain.DBSavedQuery` (Task 1).
- Produces: `port.Store` methods `DBConnections()`, `DBConnectionByID(id)`, `CreateDBConnection(...)`, `UpdateDBConnection(id, p)`, `DeleteDBConnection(id)`, `SetDBServerCertFingerprint(id, fp)`, `UpsertDBSecret(connID, kind, cipherText)`, `DBSecretRow(connID, kind)`, `DeleteDBSecret(connID, kind)`, `DBSavedQueries(connID)`, `CreateDBSavedQuery(connID, name, sql, updatedAt)`, `UpdateDBSavedQuery(id, updatedAt, p)`, `DeleteDBSavedQuery(id)`; and `port.DBConnectionPatch`, `port.DBSavedQueryPatch`.

- [ ] **Step 1: Write the failing store test**

Create `backend/internal/store/dbconn_test.go`:

```go
package store

import "testing"

func TestCreateAndReadDBConnection(t *testing.T) {
	s := newTestStore(t)
	got, err := s.CreateDBConnection("staging", "Depoharkam", "postgres", "localhost", 5433, "transform_user", "warehouse", "verify-full", nil, nil, true)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if got.Name != "staging" || got.Engine != "postgres" || got.Port != 5433 {
		t.Fatalf("unexpected row: %+v", got)
	}
	if !got.IsProduction {
		t.Fatal("IsProduction not persisted")
	}
	if got.ExecutorMachineID != nil || got.TunnelConnectionID != nil || got.ServerCertFingerprint != nil {
		t.Fatalf("expected nil optionals, got %+v", got)
	}

	back, err := s.DBConnectionByID(got.ID)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if back != got {
		t.Fatalf("round trip mismatch:\n got %+v\nwant %+v", back, got)
	}
}

func TestUpdateDBConnectionPatchesOnlyProvidedFields(t *testing.T) {
	s := newTestStore(t)
	c, _ := s.CreateDBConnection("staging", "", "postgres", "localhost", 5433, "u", "warehouse", "verify-full", nil, nil, false)

	newName := "staging-renamed"
	got, err := s.UpdateDBConnection(c.ID, port.DBConnectionPatch{Name: &newName})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if got.Name != newName {
		t.Fatalf("name = %q, want %q", got.Name, newName)
	}
	if got.Database != "warehouse" || got.Port != 5433 {
		t.Fatalf("unprovided fields changed: %+v", got)
	}
}

func TestDeleteDBConnectionCascadesSecrets(t *testing.T) {
	s := newTestStore(t)
	c, _ := s.CreateDBConnection("s", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)
	if err := s.UpsertDBSecret(c.ID, "password", "cipher"); err != nil {
		t.Fatalf("upsert secret: %v", err)
	}
	if err := s.DeleteDBConnection(c.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.DBSecretRow(c.ID, "password"); err != ErrNotFound {
		t.Fatalf("secret survived cascade: err = %v", err)
	}
}

func TestDBConnectionByIDNotFound(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.DBConnectionByID("nope"); err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}
```

Add the `port` import to the test file's import block. Check how existing store tests construct a store — read `backend/internal/store/ssh_test.go` and reuse its helper (it is likely `newTestStore(t)`; if the helper has a different name, use that name consistently throughout this file).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/store/ -run TestCreateAndReadDBConnection -v`
Expected: FAIL — compile error, `s.CreateDBConnection` undefined.

- [ ] **Step 3: Add the schema**

In `backend/internal/store/db.go`, immediately after the `ssh_secrets` table block (~line 196), add:

```sql
CREATE TABLE IF NOT EXISTS db_connections (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL DEFAULT '',
  group_name              TEXT NOT NULL DEFAULT '',
  engine                  TEXT NOT NULL DEFAULT 'postgres',
  host                    TEXT NOT NULL DEFAULT '',
  port                    INTEGER NOT NULL DEFAULT 5432,
  username                TEXT NOT NULL DEFAULT '',
  database_name           TEXT NOT NULL DEFAULT '',
  ssl_mode                TEXT NOT NULL DEFAULT 'verify-full',
  executor_machine_id     TEXT,
  tunnel_connection_id    TEXT,
  is_production           INTEGER NOT NULL DEFAULT 0,
  server_cert_fingerprint TEXT
);

CREATE TABLE IF NOT EXISTS db_secrets (
  connection_id TEXT NOT NULL REFERENCES db_connections(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  storage_kind  TEXT NOT NULL DEFAULT 'db',
  cipher_text   TEXT NOT NULL DEFAULT '',
  keychain_ref  TEXT,
  PRIMARY KEY (connection_id, kind)
);

CREATE TABLE IF NOT EXISTS db_saved_queries (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES db_connections(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT '',
  sql_text      TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT ''
);
```

`database_name` and `sql_text` avoid the SQLite reserved words `database` and `sql`. No migration function is needed — these are brand-new `CREATE TABLE IF NOT EXISTS` statements, which run on both fresh and existing databases.

Confirm `PRAGMA foreign_keys = ON` is already set where the connection is opened in `db.go`; the cascade test depends on it. If it is not set, add it alongside the other pragmas.

- [ ] **Step 4: Add the port interface methods**

In `backend/internal/port/store.go`, after the SSH block (~line 96), add:

```go
	// Database connections (Database module registry)
	DBConnections() ([]domain.DBConnection, error)
	DBConnectionByID(id string) (domain.DBConnection, error)
	CreateDBConnection(name, group, engine, host string, portNum int, username, database, sslMode string, executorMachineID, tunnelConnectionID *string, isProduction bool) (domain.DBConnection, error)
	UpdateDBConnection(id string, p DBConnectionPatch) (domain.DBConnection, error)
	DeleteDBConnection(id string) error
	SetDBServerCertFingerprint(id, fingerprint string) error

	UpsertDBSecret(connectionID, kind, cipherText string) error
	DBSecretRow(connectionID, kind string) (domain.DBSecret, error)
	DeleteDBSecret(connectionID, kind string) error

	DBSavedQueries(connectionID string) ([]domain.DBSavedQuery, error)
	CreateDBSavedQuery(connectionID, name, sqlText, updatedAt string) (domain.DBSavedQuery, error)
	UpdateDBSavedQuery(id, updatedAt string, p DBSavedQueryPatch) (domain.DBSavedQuery, error)
	DeleteDBSavedQuery(id string) error
```

And near `SSHConnectionPatch` (~line 198), add:

```go
// DBConnectionPatch carries optional fields for a partial database-connection
// update. Secrets are not patched here — they go through DBSecretService.
type DBConnectionPatch struct {
	Name     *string
	Group    *string
	Engine   *string
	Host     *string
	Port     *int
	Username *string
	Database *string
	SSLMode  *string

	ExecutorMachineID     *string
	HasExecutorMachineID  bool
	TunnelConnectionID    *string
	HasTunnelConnectionID bool

	IsProduction *bool
}

// DBSavedQueryPatch carries optional fields for a partial saved-query update.
type DBSavedQueryPatch struct {
	Name *string
	SQL  *string
}
```

`Has*` bools follow the partial-update convention in `CONTRACTS.md`: they distinguish "key absent" (leave alone) from "key present but null" (clear the value).

- [ ] **Step 5: Implement the store**

Create `backend/internal/store/dbconn.go`:

```go
package store

import (
	"database/sql"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

const dbConnCols = `id, name, group_name, engine, host, port, username, database_name, ssl_mode, executor_machine_id, tunnel_connection_id, is_production, server_cert_fingerprint`

func scanDBConnection(sc scanner) (domain.DBConnection, error) {
	var c domain.DBConnection
	var executor, tunnel, fingerprint sql.NullString
	err := sc.Scan(&c.ID, &c.Name, &c.Group, &c.Engine, &c.Host, &c.Port, &c.Username,
		&c.Database, &c.SSLMode, &executor, &tunnel, &c.IsProduction, &fingerprint)
	if err != nil {
		return c, err
	}
	if executor.Valid {
		v := executor.String
		c.ExecutorMachineID = &v
	}
	if tunnel.Valid {
		v := tunnel.String
		c.TunnelConnectionID = &v
	}
	if fingerprint.Valid {
		v := fingerprint.String
		c.ServerCertFingerprint = &v
	}
	return c, nil
}

// DBConnections returns all saved database connections, newest first.
func (s *Store) DBConnections() ([]domain.DBConnection, error) {
	rows, err := s.db.Query(`SELECT ` + dbConnCols + ` FROM db_connections ORDER BY rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.DBConnection{}
	for rows.Next() {
		c, err := scanDBConnection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// DBConnectionByID returns a single saved database connection.
func (s *Store) DBConnectionByID(id string) (domain.DBConnection, error) {
	c, err := scanDBConnection(s.db.QueryRow(`SELECT `+dbConnCols+` FROM db_connections WHERE id = ?`, id))
	if err != nil {
		return domain.DBConnection{}, mapNotFound(err)
	}
	return c, nil
}

// CreateDBConnection saves a new connection (secrets go through UpsertDBSecret).
func (s *Store) CreateDBConnection(name, group, engine, host string, portNum int, username, database, sslMode string, executorMachineID, tunnelConnectionID *string, isProduction bool) (domain.DBConnection, error) {
	id := idGen("dbc-")
	if _, err := s.db.Exec(`INSERT INTO db_connections (id, name, group_name, engine, host, port, username, database_name, ssl_mode, executor_machine_id, tunnel_connection_id, is_production) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, name, group, engine, host, portNum, username, database, sslMode, executorMachineID, tunnelConnectionID, isProduction); err != nil {
		return domain.DBConnection{}, err
	}
	return s.DBConnectionByID(id)
}

// UpdateDBConnection applies a partial update. Nil pointers are left alone;
// the Has* flags allow explicitly clearing the nullable reference columns.
func (s *Store) UpdateDBConnection(id string, p port.DBConnectionPatch) (domain.DBConnection, error) {
	if err := firstErr(
		setStr(s.db, "db_connections", "name", id, p.Name),
		setStr(s.db, "db_connections", "group_name", id, p.Group),
		setStr(s.db, "db_connections", "engine", id, p.Engine),
		setStr(s.db, "db_connections", "host", id, p.Host),
		setInt(s.db, "db_connections", "port", id, p.Port),
		setStr(s.db, "db_connections", "username", id, p.Username),
		setStr(s.db, "db_connections", "database_name", id, p.Database),
		setStr(s.db, "db_connections", "ssl_mode", id, p.SSLMode),
	); err != nil {
		return domain.DBConnection{}, err
	}
	if p.HasExecutorMachineID {
		if _, err := s.db.Exec(`UPDATE db_connections SET executor_machine_id = ? WHERE id = ?`, p.ExecutorMachineID, id); err != nil {
			return domain.DBConnection{}, err
		}
	}
	if p.HasTunnelConnectionID {
		if _, err := s.db.Exec(`UPDATE db_connections SET tunnel_connection_id = ? WHERE id = ?`, p.TunnelConnectionID, id); err != nil {
			return domain.DBConnection{}, err
		}
	}
	if p.IsProduction != nil {
		if _, err := s.db.Exec(`UPDATE db_connections SET is_production = ? WHERE id = ?`, *p.IsProduction, id); err != nil {
			return domain.DBConnection{}, err
		}
	}
	return s.DBConnectionByID(id)
}

// DeleteDBConnection removes a connection; secrets and saved queries cascade.
func (s *Store) DeleteDBConnection(id string) error {
	res, err := s.db.Exec(`DELETE FROM db_connections WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// SetDBServerCertFingerprint pins the TOFU server certificate fingerprint.
func (s *Store) SetDBServerCertFingerprint(id, fingerprint string) error {
	res, err := s.db.Exec(`UPDATE db_connections SET server_cert_fingerprint = ? WHERE id = ?`, fingerprint, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}
```

Before writing this file, read `backend/internal/store/ssh.go` and `backend/internal/store/helpers.go` to confirm the real names of `setStr`, `setInt`, `firstErr`, `requireAffected`, `mapNotFound`, `idGen`, and `scanner`. Use whatever those helpers are actually called — the shapes above match `ssh.go` but the helper names must be verified, not assumed. If `firstErr` or `requireAffected` does not exist, follow the exact error-handling shape used in `UpdateSSHConnection` and `DeleteSSHConnection` instead.

- [ ] **Step 6: Implement secrets and saved queries in the same file**

Append to `backend/internal/store/dbconn.go`:

```go
// UpsertDBSecret stores (or replaces) one encrypted credential for a connection.
func (s *Store) UpsertDBSecret(connectionID, kind, cipherText string) error {
	_, err := s.db.Exec(`INSERT INTO db_secrets (connection_id, kind, storage_kind, cipher_text) VALUES (?, ?, 'db', ?)
		ON CONFLICT(connection_id, kind) DO UPDATE SET cipher_text = excluded.cipher_text, storage_kind = 'db'`,
		connectionID, kind, cipherText)
	return err
}

// DBSecretRow returns one encrypted credential row.
func (s *Store) DBSecretRow(connectionID, kind string) (domain.DBSecret, error) {
	var sec domain.DBSecret
	var ref sql.NullString
	err := s.db.QueryRow(`SELECT connection_id, kind, storage_kind, cipher_text, keychain_ref FROM db_secrets WHERE connection_id = ? AND kind = ?`,
		connectionID, kind).Scan(&sec.ConnectionID, &sec.Kind, &sec.StorageKind, &sec.CipherText, &ref)
	if err != nil {
		return domain.DBSecret{}, mapNotFound(err)
	}
	if ref.Valid {
		v := ref.String
		sec.KeychainRef = &v
	}
	return sec, nil
}

// DeleteDBSecret removes one credential kind for a connection. Deleting a
// credential that was never stored is not an error — the caller's intent
// ("this connection should not have a password") is satisfied either way.
func (s *Store) DeleteDBSecret(connectionID, kind string) error {
	_, err := s.db.Exec(`DELETE FROM db_secrets WHERE connection_id = ? AND kind = ?`, connectionID, kind)
	return err
}

// DBSavedQueries returns a connection's saved SQL snippets, newest first.
func (s *Store) DBSavedQueries(connectionID string) ([]domain.DBSavedQuery, error) {
	rows, err := s.db.Query(`SELECT id, connection_id, name, sql_text, updated_at FROM db_saved_queries WHERE connection_id = ? ORDER BY rowid DESC`, connectionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.DBSavedQuery{}
	for rows.Next() {
		var q domain.DBSavedQuery
		if err := rows.Scan(&q.ID, &q.ConnectionID, &q.Name, &q.SQL, &q.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

// CreateDBSavedQuery stores a new named SQL snippet.
func (s *Store) CreateDBSavedQuery(connectionID, name, sqlText, updatedAt string) (domain.DBSavedQuery, error) {
	id := idGen("dbq-")
	if _, err := s.db.Exec(`INSERT INTO db_saved_queries (id, connection_id, name, sql_text, updated_at) VALUES (?, ?, ?, ?, ?)`,
		id, connectionID, name, sqlText, updatedAt); err != nil {
		return domain.DBSavedQuery{}, err
	}
	return s.dbSavedQueryByID(id)
}

func (s *Store) dbSavedQueryByID(id string) (domain.DBSavedQuery, error) {
	var q domain.DBSavedQuery
	err := s.db.QueryRow(`SELECT id, connection_id, name, sql_text, updated_at FROM db_saved_queries WHERE id = ?`, id).
		Scan(&q.ID, &q.ConnectionID, &q.Name, &q.SQL, &q.UpdatedAt)
	if err != nil {
		return domain.DBSavedQuery{}, mapNotFound(err)
	}
	return q, nil
}

// UpdateDBSavedQuery applies a partial update and always bumps updated_at.
func (s *Store) UpdateDBSavedQuery(id, updatedAt string, p port.DBSavedQueryPatch) (domain.DBSavedQuery, error) {
	if err := firstErr(
		setStr(s.db, "db_saved_queries", "name", id, p.Name),
		setStr(s.db, "db_saved_queries", "sql_text", id, p.SQL),
	); err != nil {
		return domain.DBSavedQuery{}, err
	}
	if _, err := s.db.Exec(`UPDATE db_saved_queries SET updated_at = ? WHERE id = ?`, updatedAt, id); err != nil {
		return domain.DBSavedQuery{}, err
	}
	return s.dbSavedQueryByID(id)
}

// DeleteDBSavedQuery removes a saved SQL snippet.
func (s *Store) DeleteDBSavedQuery(id string) error {
	res, err := s.db.Exec(`DELETE FROM db_saved_queries WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}
```

- [ ] **Step 7: Add a saved-query test**

Append to `backend/internal/store/dbconn_test.go`:

```go
func TestSavedQueryRoundTripAndCascade(t *testing.T) {
	s := newTestStore(t)
	c, _ := s.CreateDBConnection("s", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)

	q, err := s.CreateDBSavedQuery(c.ID, "top assets", "SELECT 1", "2026-07-19T00:00:00Z")
	if err != nil {
		t.Fatalf("create query: %v", err)
	}
	list, err := s.DBSavedQueries(c.ID)
	if err != nil || len(list) != 1 || list[0].ID != q.ID {
		t.Fatalf("list = %+v, err = %v", list, err)
	}

	newSQL := "SELECT 2"
	upd, err := s.UpdateDBSavedQuery(q.ID, "2026-07-20T00:00:00Z", port.DBSavedQueryPatch{SQL: &newSQL})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if upd.SQL != newSQL || upd.Name != "top assets" || upd.UpdatedAt != "2026-07-20T00:00:00Z" {
		t.Fatalf("unexpected update result: %+v", upd)
	}

	if err := s.DeleteDBConnection(c.ID); err != nil {
		t.Fatalf("delete conn: %v", err)
	}
	after, err := s.DBSavedQueries(c.ID)
	if err != nil {
		t.Fatalf("list after cascade: %v", err)
	}
	if len(after) != 0 {
		t.Fatalf("saved queries survived cascade: %+v", after)
	}
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/store/ -run 'TestCreateAndReadDBConnection|TestUpdateDBConnectionPatchesOnlyProvidedFields|TestDeleteDBConnectionCascadesSecrets|TestDBConnectionByIDNotFound|TestSavedQueryRoundTripAndCascade' -v`
Expected: PASS for all five tests.

- [ ] **Step 9: Verify the whole backend still builds**

Run: `cd backend && go vet ./... && go test ./...`
Expected: no vet findings, all packages pass. Any other implementation of `port.Store` (mocks in `handler` or `service` tests) must gain the new methods — if `go vet` reports an unimplemented interface, add the missing methods to that mock returning zero values and `nil`.

- [ ] **Step 10: Commit**

```bash
git add backend/internal/store/db.go backend/internal/store/dbconn.go backend/internal/store/dbconn_test.go backend/internal/port/store.go
git commit -m "feat(db): add db_connections schema and store CRUD"
```

---

### Task 3: DBSecretService

**Files:**
- Create: `backend/internal/service/dbsecret.go`
- Create: `backend/internal/service/dbsecret_test.go`

**Interfaces:**
- Consumes: `port.Store.UpsertDBSecret`, `.DBSecretRow`, `.DeleteDBSecret` (Task 2); `encryptSecret` / `decryptSecret` from `service/authcrypto.go`.
- Produces: `service.NewDBSecretService(st port.Store, key []byte) *DBSecretService` with methods `Set(connectionID, kind, plaintext string) error`, `Get(connectionID, kind string) (string, bool, error)`, `Clear(connectionID, kind string) error`.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/service/dbsecret_test.go`:

```go
package service

import (
	"strings"
	"testing"
)

func TestDBSecretRoundTrip(t *testing.T) {
	st := newTestStore(t)
	key := testMasterKey(t)
	svc := NewDBSecretService(st, key)

	if err := svc.Set("dbc-1", "password", "s3cret"); err != nil {
		t.Fatalf("set: %v", err)
	}
	got, ok, err := svc.Get("dbc-1", "password")
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got != "s3cret" {
		t.Fatalf("got %q, want %q", got, "s3cret")
	}
}

func TestDBSecretMissingReturnsNotOkWithoutError(t *testing.T) {
	svc := NewDBSecretService(newTestStore(t), testMasterKey(t))
	got, ok, err := svc.Get("dbc-missing", "password")
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
	if err := svc.Set("dbc-1", "password", "s3cret"); err != nil {
		t.Fatalf("set: %v", err)
	}
	row, err := st.DBSecretRow("dbc-1", "password")
	if err != nil {
		t.Fatalf("read row: %v", err)
	}
	if strings.Contains(row.CipherText, "s3cret") {
		t.Fatal("plaintext password found in stored cipher_text")
	}
}

func TestDBSecretClearRemovesValue(t *testing.T) {
	svc := NewDBSecretService(newTestStore(t), testMasterKey(t))
	_ = svc.Set("dbc-1", "password", "s3cret")
	if err := svc.Clear("dbc-1", "password"); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if _, ok, _ := svc.Get("dbc-1", "password"); ok {
		t.Fatal("secret still present after Clear")
	}
}
```

Read `backend/internal/service/sshsecret_test.go` first and reuse its exact store-construction and master-key helpers. If they are named differently from `newTestStore` / `testMasterKey`, use the real names throughout this file rather than adding duplicates.

Note: these tests store secrets against connection IDs that do not exist as `db_connections` rows. If the foreign key rejects that, create a real connection row first via `st.CreateDBConnection(...)` and use its returned ID — adjust all four tests consistently.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/service/ -run TestDBSecret -v`
Expected: FAIL — `NewDBSecretService` undefined.

- [ ] **Step 3: Implement the service**

Create `backend/internal/service/dbsecret.go`:

```go
package service

import (
	"errors"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/store"
)

// DBSecretService encrypts database credentials into the db_secrets table and
// decrypts them for the driver layer. It reuses the AES-256-GCM helpers in
// authcrypto.go, keyed by the same master key as TOTP and SSH secrets.
// These values never leave the server: unlike Machine.Key, which is
// deliberately distributed to clients, a database password is only ever sent
// onward to a runtime executor over an authenticated tailnet/TLS hop.
type DBSecretService struct {
	st  port.Store
	key []byte
}

func NewDBSecretService(st port.Store, key []byte) *DBSecretService {
	return &DBSecretService{st: st, key: key}
}

// Set encrypts plaintext and stores it as connectionID's credential of the
// given kind ("password" | "ca_cert" | "client_cert" | "client_key"),
// replacing any previous value of that kind.
func (s *DBSecretService) Set(connectionID, kind, plaintext string) error {
	ct, err := encryptSecret(s.key, plaintext)
	if err != nil {
		return err
	}
	return s.st.UpsertDBSecret(connectionID, kind, ct)
}

// Get decrypts connectionID's credential of the given kind. ok is false
// (with a nil error) when no credential of that kind is stored.
func (s *DBSecretService) Get(connectionID, kind string) (string, bool, error) {
	sec, err := s.st.DBSecretRow(connectionID, kind)
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

// Clear removes one credential kind for a connection.
func (s *DBSecretService) Clear(connectionID, kind string) error {
	return s.st.DeleteDBSecret(connectionID, kind)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/service/ -run TestDBSecret -v`
Expected: PASS for all four tests.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/dbsecret.go backend/internal/service/dbsecret_test.go
git commit -m "feat(db): add DBSecretService for encrypted credential storage"
```

---

### Task 4: Connection validation rules

**Files:**
- Create: `backend/internal/service/dbvalidate.go`
- Create: `backend/internal/service/dbvalidate_test.go`

This task implements the two security rules from the spec that are pure logic: the TLS policy and the executor-machine transport rule. They live in `service` so both the hub handler (Task 5) and the execution path (Phase 2) enforce identical rules.

**Interfaces:**
- Consumes: `domain.DBConnection` (Task 1), `domain.Machine`.
- Produces:
  - `service.ValidEngines = []string{"postgres", "mysql", "sqlite"}`
  - `service.ValidateEngine(engine string) error`
  - `service.ValidateSSLMode(engine, sslMode string, isProduction bool) error`
  - `service.ValidateExecutorURL(rawURL string) error`
  - `service.DefaultPortForEngine(engine string) int`

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/service/dbvalidate_test.go`:

```go
package service

import "testing"

func TestValidateSSLModeRejectsUnverifiedModesForProduction(t *testing.T) {
	// "require" encrypts but does NOT verify the server certificate, so a
	// man-in-the-middle presenting any certificate is accepted. This is the
	// mode operators most often assume is safe.
	for _, mode := range []string{"disable", "allow", "prefer", "require"} {
		if err := ValidateSSLMode("postgres", mode, true); err == nil {
			t.Errorf("sslMode %q accepted for a production connection, want rejection", mode)
		}
	}
}

func TestValidateSSLModeAllowsVerifiedModesForProduction(t *testing.T) {
	for _, mode := range []string{"verify-ca", "verify-full"} {
		if err := ValidateSSLMode("postgres", mode, true); err != nil {
			t.Errorf("sslMode %q rejected for production: %v", mode, err)
		}
	}
}

func TestValidateSSLModeAllowsWeakModesForNonProduction(t *testing.T) {
	if err := ValidateSSLMode("postgres", "require", false); err != nil {
		t.Errorf("require rejected for non-production connection: %v", err)
	}
}

func TestValidateSSLModeMySQLUnverifiedModes(t *testing.T) {
	for _, mode := range []string{"false", "skip-verify", "preferred"} {
		if err := ValidateSSLMode("mysql", mode, true); err == nil {
			t.Errorf("mysql tls mode %q accepted for production, want rejection", mode)
		}
	}
	if err := ValidateSSLMode("mysql", "true", true); err != nil {
		t.Errorf("mysql tls=true rejected for production: %v", err)
	}
}

func TestValidateSSLModeSQLiteIgnoresTLS(t *testing.T) {
	// SQLite is a local file; no network, so no TLS policy applies.
	if err := ValidateSSLMode("sqlite", "", true); err != nil {
		t.Errorf("sqlite production connection rejected over TLS mode: %v", err)
	}
}

func TestValidateSSLModeRejectsUnknownMode(t *testing.T) {
	if err := ValidateSSLMode("postgres", "banana", false); err == nil {
		t.Error("unknown sslMode accepted, want rejection")
	}
}

func TestValidateExecutorURLAcceptsHTTPSAndTailnet(t *testing.T) {
	ok := []string{
		"https://runtime.example.com:8989",
		"http://runtime.tail1234.ts.net:8989",
		"http://100.101.102.103:8989", // CGNAT range used by Tailscale
	}
	for _, u := range ok {
		if err := ValidateExecutorURL(u); err != nil {
			t.Errorf("ValidateExecutorURL(%q) = %v, want nil", u, err)
		}
	}
}

func TestValidateExecutorURLRejectsPlaintextPublicHosts(t *testing.T) {
	// A decrypted database password travels to the executor. Over plain http
	// to a non-tailnet host that password crosses the network in the clear.
	bad := []string{
		"http://1.2.3.4:8989",
		"http://runtime.example.com:8989",
		"http://203.0.113.9",
	}
	for _, u := range bad {
		if err := ValidateExecutorURL(u); err == nil {
			t.Errorf("ValidateExecutorURL(%q) = nil, want rejection", u)
		}
	}
}

func TestValidateExecutorURLRejectsMalformed(t *testing.T) {
	for _, u := range []string{"", "not a url", "ftp://host", "runtime.example.com"} {
		if err := ValidateExecutorURL(u); err == nil {
			t.Errorf("ValidateExecutorURL(%q) = nil, want rejection", u)
		}
	}
}

func TestValidateEngine(t *testing.T) {
	for _, e := range ValidEngines {
		if err := ValidateEngine(e); err != nil {
			t.Errorf("ValidateEngine(%q) = %v, want nil", e, err)
		}
	}
	for _, e := range []string{"", "mongodb", "redis", "oracle"} {
		if err := ValidateEngine(e); err == nil {
			t.Errorf("ValidateEngine(%q) = nil, want rejection", e)
		}
	}
}
```

Note the `mongodb` and `redis` cases: those are Pieces B and C in the spec and must be rejected until their drivers exist, rather than accepted and failing at connect time.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/service/ -run 'TestValidate' -v`
Expected: FAIL — `ValidateSSLMode`, `ValidateExecutorURL`, `ValidateEngine`, `ValidEngines` undefined.

- [ ] **Step 3: Implement the validators**

Create `backend/internal/service/dbvalidate.go`:

```go
package service

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// ValidEngines lists the SQL engines supported today. MongoDB and Redis are
// Pieces B and C of the design and are deliberately rejected here until their
// drivers exist — accepting them would fail confusingly at connect time.
var ValidEngines = []string{"postgres", "mysql", "sqlite"}

func ValidateEngine(engine string) error {
	for _, e := range ValidEngines {
		if engine == e {
			return nil
		}
	}
	return fmt.Errorf("unsupported engine %q; supported: %s", engine, strings.Join(ValidEngines, ", "))
}

// DefaultPortForEngine returns the conventional port, used to prefill the
// connection form. SQLite is file-based and has no port.
func DefaultPortForEngine(engine string) int {
	switch engine {
	case "postgres":
		return 5432
	case "mysql":
		return 3306
	default:
		return 0
	}
}

// verifiedSSLModes are the modes that actually authenticate the server.
//
// The subtle case is PostgreSQL's "require": it encrypts the connection but
// performs no certificate validation whatsoever, so an attacker in the path
// can present a self-signed certificate and be accepted. Encryption without
// authentication does not prevent a man-in-the-middle. MySQL's "skip-verify"
// and "preferred" have the same property.
var verifiedSSLModes = map[string]map[string]bool{
	"postgres": {"verify-ca": true, "verify-full": true},
	"mysql":    {"true": true, "verify-ca": true, "verify-identity": true},
}

var knownSSLModes = map[string]map[string]bool{
	"postgres": {"disable": true, "allow": true, "prefer": true, "require": true, "verify-ca": true, "verify-full": true},
	"mysql":    {"false": true, "true": true, "skip-verify": true, "preferred": true, "verify-ca": true, "verify-identity": true},
}

// ValidateSSLMode checks that sslMode is known for the engine and, for
// production connections, that it actually verifies the server certificate.
func ValidateSSLMode(engine, sslMode string, isProduction bool) error {
	if engine == "sqlite" {
		return nil // local file; no transport to protect
	}
	known, ok := knownSSLModes[engine]
	if !ok {
		return fmt.Errorf("unsupported engine %q", engine)
	}
	if !known[sslMode] {
		modes := make([]string, 0, len(known))
		for m := range known {
			modes = append(modes, m)
		}
		return fmt.Errorf("unknown sslMode %q for %s", sslMode, engine)
		_ = modes
	}
	if !isProduction {
		return nil
	}
	if !verifiedSSLModes[engine][sslMode] {
		return fmt.Errorf("sslMode %q does not verify the server certificate, which is not allowed for a connection marked production; use a verifying mode and supply a CA certificate if the server uses a private CA", sslMode)
	}
	return nil
}

// ValidateExecutorURL enforces that a Machine may only act as a database
// executor when the hub can reach it over an authenticated, encrypted path.
//
// The hub sends a decrypted database password to the executor. Over plain
// http:// to a host outside the tailnet, that password crosses the network in
// cleartext. Tailscale hosts are accepted over http:// because WireGuard
// already encrypts and authenticates that path.
func ValidateExecutorURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid executor machine URL: %v", err)
	}
	if u.Scheme == "https" {
		return nil
	}
	if u.Scheme != "http" {
		return fmt.Errorf("executor machine URL must use http or https, got %q", u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("executor machine URL has no host")
	}
	if strings.HasSuffix(host, ".ts.net") {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && isTailscaleCGNAT(ip) {
		return nil
	}
	return fmt.Errorf("executor machine %q uses plain http outside the tailnet; database credentials would cross the network unencrypted — use https or a tailnet address", rawURL)
}

// tailscaleCGNAT is the 100.64.0.0/10 carrier-grade NAT range Tailscale
// assigns to tailnet nodes.
var tailscaleCGNAT = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

func isTailscaleCGNAT(ip net.IP) bool {
	v4 := ip.To4()
	return v4 != nil && tailscaleCGNAT.Contains(v4)
}
```

Remove the stray `modes` variable and the unreachable `_ = modes` line when writing the file — build the mode list into the error message or drop it entirely; do not leave dead code.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/service/ -run 'TestValidate' -v`
Expected: PASS for all nine tests.

- [ ] **Step 5: Run vet**

Run: `cd backend && go vet ./internal/service/`
Expected: no findings.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/service/dbvalidate.go backend/internal/service/dbvalidate_test.go
git commit -m "feat(db): add TLS policy and executor URL validation"
```

---

### Task 5: Hub CRUD handlers

**Files:**
- Create: `backend/internal/handler/db.go`
- Create: `backend/internal/handler/db_test.go`

**Interfaces:**
- Consumes: `store.Store` (Task 2), `service.DBSecretService` (Task 3), `service.Validate*` (Task 4).
- Produces: `handler.NewDBHandler(st *store.Store, secrets *service.DBSecretService) *DBHandler` with methods `GetConnections`, `PostConnection`, `PatchConnection`, `DeleteConnection`, `PostSecret`, `GetSavedQueries`, `PostSavedQuery`, `PatchSavedQuery`, `DeleteSavedQuery`.

- [ ] **Step 1: Write the failing handler tests**

Create `backend/internal/handler/db_test.go`. Read `backend/internal/handler/ssh_test.go` first and copy its harness (test server construction, request helpers, store fixture) rather than inventing a new one.

```go
package handler

import (
	"net/http"
	"strings"
	"testing"
)

func TestPostConnectionRejectsProductionWithUnverifiedTLS(t *testing.T) {
	srv := newDBTestServer(t)
	body := `{"name":"prod","engine":"postgres","host":"db.internal","port":5432,
	          "username":"u","database":"app","sslMode":"require","isProduction":true}`
	res := srv.post(t, "/api/db/connections", body)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.Code)
	}
	if !strings.Contains(res.Body.String(), "verify") {
		t.Fatalf("error should explain certificate verification, got %s", res.Body.String())
	}
}

func TestPostConnectionRejectsUnsupportedEngine(t *testing.T) {
	srv := newDBTestServer(t)
	res := srv.post(t, "/api/db/connections", `{"name":"r","engine":"redis","host":"h","port":6379}`)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.Code)
	}
}

func TestPostConnectionRejectsPlaintextExecutorMachine(t *testing.T) {
	srv := newDBTestServer(t)
	m := srv.createMachine(t, "public-runtime", "http://203.0.113.9:8989")
	body := `{"name":"c","engine":"postgres","host":"h","port":5432,"username":"u",
	          "database":"d","sslMode":"verify-full","executorMachineId":"` + m.ID + `"}`
	res := srv.post(t, "/api/db/connections", body)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", res.Code, res.Body.String())
	}
}

func TestPostConnectionAcceptsTailnetExecutorMachine(t *testing.T) {
	srv := newDBTestServer(t)
	m := srv.createMachine(t, "tailnet-runtime", "http://runtime.tail1234.ts.net:8989")
	body := `{"name":"c","engine":"postgres","host":"h","port":5432,"username":"u",
	          "database":"d","sslMode":"verify-full","executorMachineId":"` + m.ID + `"}`
	res := srv.post(t, "/api/db/connections", body)
	if res.Code != http.StatusOK && res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 2xx; body = %s", res.Code, res.Body.String())
	}
}

func TestPostConnectionRejectsUnknownExecutorMachine(t *testing.T) {
	srv := newDBTestServer(t)
	body := `{"name":"c","engine":"postgres","host":"h","port":5432,"username":"u",
	          "database":"d","sslMode":"verify-full","executorMachineId":"m-nope"}`
	res := srv.post(t, "/api/db/connections", body)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.Code)
	}
}

func TestPasswordNeverAppearsInAnyResponse(t *testing.T) {
	srv := newDBTestServer(t)
	body := `{"name":"c","engine":"postgres","host":"h","port":5432,"username":"u",
	          "database":"d","sslMode":"verify-full","password":"s3cret"}`
	created := srv.post(t, "/api/db/connections", body)
	if strings.Contains(created.Body.String(), "s3cret") {
		t.Fatal("password echoed in create response")
	}
	list := srv.get(t, "/api/db/connections")
	if strings.Contains(list.Body.String(), "s3cret") {
		t.Fatal("password echoed in list response")
	}
	if strings.Contains(list.Body.String(), "password") {
		t.Fatalf("list response mentions a password field at all: %s", list.Body.String())
	}
}

func TestDeleteConnectionReturns204(t *testing.T) {
	srv := newDBTestServer(t)
	created := srv.post(t, "/api/db/connections", `{"name":"c","engine":"sqlite","database":"/tmp/x.db","sslMode":""}`)
	id := srv.idOf(t, created)
	res := srv.delete(t, "/api/db/connections/"+id)
	if res.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", res.Code)
	}
}

func TestPatchConnectionRevalidatesTLSPolicy(t *testing.T) {
	srv := newDBTestServer(t)
	created := srv.post(t, "/api/db/connections", `{"name":"c","engine":"postgres","host":"h","port":5432,"username":"u","database":"d","sslMode":"require","isProduction":false}`)
	id := srv.idOf(t, created)
	// Flipping an existing weak-TLS connection to production must be rejected,
	// not silently accepted because the sslMode field was not part of the patch.
	res := srv.patch(t, "/api/db/connections/"+id, `{"isProduction":true}`)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", res.Code, res.Body.String())
	}
}
```

`TestPatchConnectionRevalidatesTLSPolicy` is the important one: validation must run against the **merged** post-patch state, not just the fields present in the request body.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/handler/ -run 'TestPostConnection|TestPassword|TestDeleteConnection|TestPatchConnection' -v`
Expected: FAIL — `newDBTestServer` and the handler are undefined.

- [ ] **Step 3: Implement the handler**

Create `backend/internal/handler/db.go`, following the structure of `handler/ssh.go`:

```go
package handler

import (
	"net/http"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

// DBHandler serves the hub's database-connection registry. Credentials ride
// in on create/update bodies, are encrypted at rest via DBSecretService, and
// never serialize back out (domain.DBSecret is json:"-" throughout).
type DBHandler struct {
	st      *store.Store
	secrets *service.DBSecretService
}

func NewDBHandler(st *store.Store, secrets *service.DBSecretService) *DBHandler {
	return &DBHandler{st: st, secrets: secrets}
}

// dbSecretFields are the write-only credential fields accepted alongside
// connection fields. Absent means "leave unchanged".
type dbSecretFields struct {
	Password   *string `json:"password"`
	CACert     *string `json:"caCert"`
	ClientCert *string `json:"clientCert"`
	ClientKey  *string `json:"clientKey"`
}

type dbConnectionBody struct {
	Name               *string `json:"name"`
	Group              *string `json:"group"`
	Engine             *string `json:"engine"`
	Host               *string `json:"host"`
	Port               *int    `json:"port"`
	Username           *string `json:"username"`
	Database           *string `json:"database"`
	SSLMode            *string `json:"sslMode"`
	ExecutorMachineID  *string `json:"executorMachineId"`
	TunnelConnectionID *string `json:"tunnelConnectionId"`
	IsProduction       *bool   `json:"isProduction"`
	dbSecretFields
}
```

Then implement, in this file:

- `GetConnections` — `writeJSON(w, http.StatusOK, list)` from `h.st.DBConnections()`, `handleStoreErr` on error.
- `PostConnection` — `decodeBody`, then in order: `service.ValidateEngine`, `service.ValidateSSLMode(engine, sslMode, isProduction)`, executor validation (below), tunnel validation (below); each failure is `writeErr(w, http.StatusBadRequest, err.Error())` and return. Then `h.st.CreateDBConnection(...)`, then persist any non-empty secret fields via `h.secrets.Set(id, kind, value)`, then `writeJSON(w, http.StatusOK, created)`.
- `PatchConnection` — load the existing row with `h.st.DBConnectionByID(id)`, build the **merged** effective values (patch field if present, else existing), run the same four validations against the merged values, then apply `port.DBConnectionPatch` and persist secrets. This is what `TestPatchConnectionRevalidatesTLSPolicy` checks.
- `DeleteConnection` — `h.st.DeleteDBConnection(id)`, then `w.WriteHeader(http.StatusNoContent)`.
- `PostSecret` — body `{"kind":"...","value":"..."}`; reject a `kind` outside `password|ca_cert|client_cert|client_key` with 400; an empty `value` calls `h.secrets.Clear`. Respond `204`.
- `GetSavedQueries` / `PostSavedQuery` / `PatchSavedQuery` / `DeleteSavedQuery` — straight delegation to the Task 2 store methods, with `time.Now().UTC().Format(time.RFC3339)` for `updatedAt`.

Two shared validation helpers, mirroring `validateExecutorMachine` in `ssh.go`:

```go
// validateDBExecutor checks the machine exists and that the hub may send
// decrypted credentials to it over its registered URL.
func (h *DBHandler) validateDBExecutor(machineID string) error {
	m, err := h.st.MachineByID(machineID)
	if err != nil {
		return fmt.Errorf("executor machine %s not found", machineID)
	}
	return service.ValidateExecutorURL(m.URL)
}

// validateDBTunnel checks that tunnelID names an existing SSH connection.
func (h *DBHandler) validateDBTunnel(tunnelID string) error {
	if _, err := h.st.SSHConnectionByID(tunnelID); err != nil {
		return fmt.Errorf("tunnel connection %s not found", tunnelID)
	}
	return nil
}
```

Reuse `nilIfEmpty` from `ssh.go` for the optional reference fields — the frontend's "none" option submits `""` rather than omitting the key. Since both handlers live in package `handler`, call the existing function rather than redefining it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/handler/ -run 'TestPostConnection|TestPassword|TestDeleteConnection|TestPatchConnection' -v`
Expected: PASS for all eight tests.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handler/db.go backend/internal/handler/db_test.go
git commit -m "feat(db): add hub connection registry handlers with TLS and executor validation"
```

---

### Task 6: Route registration

**Files:**
- Modify: `backend/cmd/server/main.go` (service wiring ~line 242, hub route block ~line 412)

**Interfaces:**
- Consumes: `handler.NewDBHandler`, `service.NewDBSecretService`.
- Produces: the hub routes listed below.

- [ ] **Step 1: Wire the service and handler**

In `backend/cmd/server/main.go`, next to the SSH wiring (~line 242):

```go
	dbSecrets := service.NewDBSecretService(st, authKey)
	dbH := handler.NewDBHandler(st, dbSecrets)
```

- [ ] **Step 2: Register the routes**

Inside the same hub-only block that holds the SSH registry routes (~line 412), add:

```go
		// Database connection registry — hub-scoped like the SSH registry.
		// Execution endpoints arrive in phase 2; this phase is registry only.
		mux.HandleFunc("GET /api/db/connections", dbH.GetConnections)
		mux.HandleFunc("POST /api/db/connections", dbH.PostConnection)
		mux.HandleFunc("PATCH /api/db/connections/{id}", dbH.PatchConnection)
		mux.HandleFunc("DELETE /api/db/connections/{id}", dbH.DeleteConnection)
		mux.HandleFunc("POST /api/db/connections/{id}/secret", dbH.PostSecret)

		mux.HandleFunc("GET /api/db/connections/{id}/queries", dbH.GetSavedQueries)
		mux.HandleFunc("POST /api/db/connections/{id}/queries", dbH.PostSavedQuery)
		mux.HandleFunc("PATCH /api/db/queries/{qid}", dbH.PatchSavedQuery)
		mux.HandleFunc("DELETE /api/db/queries/{qid}", dbH.DeleteSavedQuery)
```

These belong in the hub block, not the runtime block: `--role runtime` must not serve the registry.

- [ ] **Step 3: Verify the server builds and the full suite passes**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: build succeeds, no vet findings, all tests pass.

- [ ] **Step 4: Smoke-test the endpoint by hand**

Run the hub locally per `COMMANDS.md`, then:

```bash
curl -s -X POST localhost:8989/api/db/connections \
  -H 'Content-Type: application/json' \
  -d '{"name":"local pg","engine":"postgres","host":"localhost","port":5433,"username":"transform_user","database":"warehouse","sslMode":"verify-full","password":"secret"}'
curl -s localhost:8989/api/db/connections
```

Expected: the create returns the connection JSON with no `password` field anywhere; the list shows the same row. If the server requires auth, include the session cookie or `Authorization: Bearer <key>` as `COMMANDS.md` describes.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/server/main.go
git commit -m "feat(db): register hub database registry routes"
```

---

## Phase 1 Self-Review

Checked against `docs/superpowers/specs/2026-07-19-database-management-design.md`:

**Spec coverage for this phase.** Data model → Task 1, 2. Credential storage (`DBSecretService`, same AES-256-GCM key) → Task 3. TLS policy table, including the `require` trap and the `IsProduction` rejection → Task 4, enforced in Task 5. Hub→runtime transport hardening (`https` or tailnet only) → Task 4, enforced in Task 5. Registry API surface (connections + secret + saved queries) → Task 5, 6. Secrets never serialize → Task 1 (`json:"-"`) and asserted in Task 5.

**Deferred to later phases, by design:** driver interfaces and `DBCaps`, all introspection and query execution, table stats, paging, filtering, row-identity ladder, DDL, SSH tunnel dialing, runtime `/api/db/*` routes, audit logging, and every frontend component. `GET /api/db/engines` also lands in Phase 2, since it returns capabilities that do not exist yet.

**Known deviations from the spec's build order.** The spec listed SQLite driver work as step 2; here it moves to Phase 2 so that Phase 1 ends on a coherent, independently reviewable boundary — a working registry with no execution surface.

**Type consistency.** `DBConnectionPatch` field names in Task 2 match their use in Task 5. Store method names in the Task 2 `port.Store` block match the calls in Tasks 3 and 5. `DBSecretRow` is deliberately named differently from the domain type `DBSecret` to avoid a method/type collision on `Store`.

**Open items for the implementer, flagged rather than hidden:**
- Helper names in `store/helpers.go` (`setStr`, `setInt`, `firstErr`, `requireAffected`, `mapNotFound`, `idGen`, `scanner`) are used as written in Task 2 but must be verified against the real file; `ssh.go` is the reference.
- Test harness names in `service` and `handler` tests must be taken from `sshsecret_test.go` and `ssh_test.go` rather than introduced fresh.
- If `PRAGMA foreign_keys` is not enabled, the cascade tests in Task 2 will fail and the pragma must be added.

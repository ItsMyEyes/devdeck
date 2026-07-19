# Database Management (Navicat-style) — Design

Status: approved (brainstorming 2026-07-19)
Scope: **Piece A — SQL engines only** (PostgreSQL, MySQL/MariaDB, SQLite).
MongoDB (Piece B) and Redis (Piece C) are explicitly out of scope here; this
design only reserves the extension points they will attach to.

## Goal

Give the operator a Navicat-class database client inside DevDeck: a grouped
connection registry, an object tree (server → database → schema → tables /
views / matviews / functions), an editable data grid, table DDL design, and a
SQL editor with saved queries — reachable from the workspace sidebar rail
alongside SSH, Runtimes, and Tools.

Success: the operator can register a Postgres/MySQL/SQLite connection, browse
its objects, read and edit rows, alter table structure, and run ad-hoc SQL —
without leaving DevDeck and without DB credentials ever reaching the browser.

## Decisions (from brainstorming)

1. **Decomposed into A → B → C.** Piece A (SQL) builds all shared foundations —
   registry, encrypted credentials, executor routing, tab shell. Mongo and
   Redis attach later as additional drivers with their own tree/editor shapes.
   Rationale: Redis has no tables, columns, schemas, or DDL; Mongo documents are
   schemaless and nested. Forcing all five into one interface produces a union
   of mostly-inapplicable methods and per-engine branching throughout the UI.
2. **Full editing.** Editable grid + DDL (create/alter/drop table, indexes,
   constraints, views/matviews/functions), plus a read-only generated-DDL tab.
3. **Hybrid executor.** `DBConnection.ExecutorMachineID` is optional: `nil` =
   the hub dials the database; set = that runtime machine dials it. Mirrors
   `SSHConnection.ExecutorMachineID`.
4. **Row-identity ladder with a `rowsAffected` guard** for grid writes
   (see "Row identity" below).
5. **Registry mirrors the SSH pattern**: folder groups, credentials in a
   separate encrypted table, optional SSH tunnel via an existing
   `SSHConnection`, and an `IsProduction` flag.
6. **Execution is always hub-mediated, never direct-first** — a deliberate
   departure from the worktree/PTY pattern, because direct-first would require
   the browser to hold DB credentials.

## Approaches considered

**Registry on hub, execution hybrid (chosen).** Connections are organizational
data, so they live on the hub next to `ssh_connections`. Execution is where the
network topology matters, so it is routed per-connection. Costs one extra hop
for runtime-executed queries.

**Everything on the hub.** Simplest — no new runtime endpoints. Rejected: a
Postgres listening only on a machine's loopback (the case in the reference
screenshot, `localhost:5433`) would be unreachable.

**Runtime-only, direct-first from the browser.** Fastest path, consistent with
worktrees/PTY. Rejected: the browser would need the DB password, which
contradicts how `SSHSecret` is handled today.

## Data model

Three new hub tables. Types must be added to **both**
`backend/internal/domain/models.go` and `frontend/src/store/types.ts`
(convergence files — serialize these edits, see `ORCHESTRATION.md`).

```go
// DBConnection is a saved connection to an external SQL database. Credentials
// live in DBSecret rows, never on this struct — same split as SSHConnection.
type DBConnection struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Group    string `json:"group"`    // folder in the tree; "" = ungrouped
	Engine   string `json:"engine"`   // "postgres" | "mysql" | "sqlite"
	Host     string `json:"host"`     // ignored for sqlite
	Port     int    `json:"port"`     // ignored for sqlite
	Username string `json:"username"` // ignored for sqlite
	Database string `json:"database"` // initial database; for sqlite: file path
	SSLMode  string `json:"sslMode"`  // see "TLS policy"

	// ExecutorMachineID selects which Machine dials this database;
	// nil = the hub itself.
	ExecutorMachineID *string `json:"executorMachineId"`
	// TunnelConnectionID references a registered SSHConnection used as a
	// tunnel; nil = direct connection.
	TunnelConnectionID *string `json:"tunnelConnectionId"`
	// IsProduction colors the tab, forces extra confirmation on data commits
	// and DDL, and rejects unverified TLS modes. It is an error-reduction
	// affordance, NOT a security control — the operator holds full credentials
	// either way.
	IsProduction bool `json:"isProduction"`
	// ServerCertFingerprint is a TOFU-pinned SHA256 fingerprint of the database
	// server's TLS certificate, used when a private CA is unavailable.
	// Mirrors SSHConnection.HostKeyFingerprint: set on first successful
	// connect, later mismatches hard-block.
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

// DBSavedQuery is a named SQL snippet attached to a connection — the "Queries"
// node in the object tree.
type DBSavedQuery struct {
	ID           string `json:"id"`
	ConnectionID string `json:"connectionId"`
	Name         string `json:"name"`
	SQL          string `json:"sql"`
	UpdatedAt    string `json:"updatedAt"`
}
```

`DBSecretService` is a structural copy of `SSHSecretService`: `encryptSecret` /
`decryptSecret` from `authcrypto.go`, keyed by the same master key. **No new
secret-storage mechanism is introduced.**

## Driver abstraction

Capability-split interfaces in `backend/internal/port/dbdriver.go`, so later
engines implement only what applies:

```go
type DBDriver interface {
	Open(ctx context.Context, d DSNDescriptor) (DBConn, error)
	Capabilities() DBCaps
}

type DBCaps struct {
	Schemas       bool   // postgres: true; mysql, sqlite: false
	MatViews      bool   // postgres only
	Functions     bool
	RowIdentifier string // "ctid" | "rowid" | "" (mysql has none)
	SQLDialect    string
}

type Introspector interface {
	Tree(ctx context.Context, path TreePath) ([]TreeNode, error)
	Columns(ctx context.Context, obj ObjectRef) ([]ColumnMeta, error)
	Indexes(ctx context.Context, obj ObjectRef) ([]IndexMeta, error)
}
type QueryRunner interface {
	Query(ctx context.Context, sql string, args []any) (ResultSet, error)
	Exec(ctx context.Context, sql string, args []any) (ExecResult, error)
}
type RowWriter interface {
	Plan(ctx context.Context, e RowEdit) (WritePlan, error)
}
type DDLReader interface {
	ShowCreate(ctx context.Context, obj ObjectRef) (string, error)
}
type DDLWriter interface {
	AlterTable(ctx context.Context, p TablePlan) ([]string, error)
}
```

`DBCaps` is served to the frontend by `GET /api/db/engines` so the UI renders
tree nodes and toolbar actions from capabilities rather than
`if (engine === 'mysql')` branching. When
Redis arrives it implements `Introspector` with different node shapes and
simply does not implement `RowWriter` / `DDLWriter` / `DDLReader`.

Driver implementations live in `backend/internal/dbdriver/{postgres,mysql,sqlite}/`.
Postgres uses `jackc/pgx/v5` (stdlib mode), MySQL uses `go-sql-driver/mysql`,
SQLite reuses the existing `modernc.org/sqlite` (no CGO).

## Execution & routing

```
Browser ──POST /api/db/connections/{id}/query──→ Hub
                                                  │ decrypt DBSecret
                                    ┌─────────────┴─────────────┐
                          ExecutorMachineID == nil        != nil
                                    │                           │
                              hub dials DB          machineclient → Runtime
                                                     (Bearer machine.Key)
                                                            │
                                                     runtime dials DB
```

- The hub decrypts credentials and, for runtime execution, sends a
  **connection descriptor** (including the password and, when tunneling, the
  resolved SSH credentials) to the runtime over `machineclient`.
- The runtime holds a pooled `*sql.DB` per descriptor hash with an idle timeout
  (default 5 min). It never writes credentials to disk.
- **Direct-first is deliberately not used here.** Cost: one extra hop of
  latency for runtime-executed queries. Benefit: DB credentials never reach the
  browser.

New runtime routes (key-auth only, per `CONTRACTS.md`):
`POST /api/db/exec`, `POST /api/db/introspect`, `POST /api/db/close`.

## Result sizing

Server-side paging, default 500 rows per page. Keyset pagination when an
ordered primary key exists, `LIMIT`/`OFFSET` otherwise. A query is never fully
materialized in hub or browser memory. `ResultSet` carries `truncated bool` so
the grid can show an explicit "showing first N rows" affordance rather than
silently lying about completeness.

## Row identity (grid writes)

Descend only when the level above is unavailable:

1. **Primary key** — always preferred.
2. **Non-null unique index.**
3. **Engine row identifier** — Postgres `ctid`, SQLite `rowid` (skipped for
   `WITHOUT ROWID` tables). Both address exactly one physical row, so
   PK-less tables remain safely editable on those engines.

   Caveat that must be honored: **`ctid` is not stable.** An `UPDATE` or
   `VACUUM` by another session moves the row, so a `ctid` captured when the
   grid was loaded may point at a different row (or nothing) by commit time.
   Therefore a level-3 write predicate is always `WHERE ctid = ? AND <all
   loaded old column values match>`, executed inside the commit transaction,
   with the same `rowsAffected == 1` guard. `ctid` narrows the scan; the
   old-value comparison proves identity. SQLite `rowid` is stable in practice
   but uses the same predicate for uniformity.
4. **All-column `WHERE`** — remaining case, in practice MySQL without a PK.

Every write executes inside a transaction. For level 4 the executor checks
`rowsAffected`; if it is not exactly 1 it **rolls back and rejects** with
`"condition matched N rows"`. Level 4 additionally refuses to build predicates
over `float`, `json`, and `blob` columns, where equality comparison is either
unreliable or invalid (MySQL errors on `WHERE json_col = ?`); such a table is
reported read-only with the reason shown in the UI.

Edits accumulate as pending changes (visually marked cells). **Commit** shows
the exact SQL to be executed before running it as one transaction; any failure
rolls back the whole batch.

## TLS policy

`sslMode` alone is insufficient — the failure mode below is the one most often
missed:

| Postgres `sslmode` | Encrypted | Cert verified | MITM possible |
|---|---|---|---|
| `disable` | no | — | yes, total |
| `prefer` / `allow` | opportunistic | no | yes |
| `require` | yes | **no** | **yes** |
| `verify-ca` | yes | chain only | partial |
| `verify-full` | yes | chain + hostname | no |

Rules:
- Default for new connections: **`verify-full`**.
- Connections with `IsProduction` **reject** `disable` / `prefer` / `allow` /
  `require` at the validation layer (400), not merely warn.
- Private/self-signed CAs are supported via a per-connection CA certificate
  stored as `DBSecret` kind `"ca_cert"`, so `verify-full` stays usable without
  downgrading.
- Last resort: TOFU pin of the server certificate fingerprint
  (`DBConnection.ServerCertFingerprint`), mirroring `SSHConnection.HostKeyFingerprint` —
  pinned on first connect, hard-block on later mismatch.
- MySQL equivalence: `tls=skip-verify` and `tls=preferred` are treated exactly
  like `require` above and rejected for production connections.
- SQLite is file-local; TLS rules do not apply.

## Hub → runtime transport hardening

The descriptor sent to a runtime carries a decrypted DB password. Today
`machine.URL` may be any `http://` URL, so a machine registered as
`http://<public-ip>:8989` would carry that password in plaintext across the
public internet.

Rule: a Machine may be used as `ExecutorMachineID` **only** when its URL is
`https://` or a tailnet host (`*.ts.net`, or an address inside the
`100.64.0.0/10` CGNAT range). Otherwise saving the connection is rejected (400)
with an explanatory message. This is validated at connection-save time and
re-checked at execution time (the machine URL can change afterward).

## SSH tunnel

When `TunnelConnectionID` is set, the executor (hub or runtime) opens the
tunnel using the referenced `SSHConnection` and its existing credentials. The
tunnel **must** go through the established TOFU host-key verification;
`InsecureIgnoreHostKey` must not appear anywhere in this path. An unverified
tunnel would create the MITM exposure it is meant to prevent.

## Residual risks (stated deliberately)

1. A compromised runtime sees DB passwords in plaintext, since it must dial the
   database itself. At-rest encryption does not mitigate this. The only control
   is choosing which machines act as executors.
2. `IsProduction` is not a security boundary — same operator, same credentials.
3. The operator can point a connection at an arbitrary host:port, so the hub can
   reach internal services. For a DB client this is intended behavior, not a
   flaw; cloud metadata endpoints (`169.254.169.254`, link-local ranges) are
   nonetheless blocked, following the existing `reject_metadata_ssrf` pattern.

## Audit

Reuse `handler/audit.go`. Every **data commit** and every **DDL statement**
records actor, connection id, exact SQL, and affected row count. `SELECT`
statement bodies are not recorded, to keep the log from ballooning.

## API surface (hub)

All responses use the `{"error":"message"}` envelope; handlers use
`handleStoreErr()` (`CONTRACTS.md`).

```
GET    /api/db/connections                     → []DBConnection (never secrets)
POST   /api/db/connections                     → create (validates TLS + executor URL)
PATCH  /api/db/connections/{id}                → port.DBConnectionPatch
DELETE /api/db/connections/{id}                → 204
POST   /api/db/connections/{id}/test           → {"ok":true} | {"ok":false,"reason":...}
POST   /api/db/connections/{id}/secret         → write-only; body {"kind","value"}
                                                 kind ∈ password|ca_cert|client_cert|client_key
GET    /api/db/engines                         → map[engine]DBCaps (static, drives UI)

POST   /api/db/connections/{id}/tree           → []TreeNode (lazy, per TreePath)
POST   /api/db/connections/{id}/columns        → []ColumnMeta
POST   /api/db/connections/{id}/query          → ResultSet (paged)
POST   /api/db/connections/{id}/commit         → apply pending row edits (txn)
POST   /api/db/connections/{id}/ddl/preview    → []string (generated statements)
POST   /api/db/connections/{id}/ddl/apply      → apply table/index/constraint plan
GET    /api/db/connections/{id}/queries        → []DBSavedQuery
POST   /api/db/connections/{id}/queries        → create
PATCH  /api/db/queries/{qid}                   → update
DELETE /api/db/queries/{qid}                   → 204
```

Editing a connection returns no password; the form shows an empty field marked
"stored" rather than the real value.

## Frontend / UI

New sidebar rail entry `{ key: 'database', label: 'Database', Icon: Database }`
in `SidebarNav.tsx`, route `frontend/src/routes/w.$wsId.database.tsx` rendering
`DatabaseModule`, following the `w.$wsId.ssh.tsx` → `SSHConnectionsModule`
pattern exactly. `ModuleView` in `store/types.ts` gains `'database'`.

Feature directory `frontend/src/features/database/`:

| Component | Responsibility |
|---|---|
| `DatabaseModule.tsx` | Layout shell: tree pane + tab area |
| `DBObjectTree.tsx` | Lazy tree, grouped by folder; nodes driven by `DBCaps` |
| `DBConnectionDialog.tsx` | Create/edit connection, TLS + executor + tunnel fields |
| `DBTableGrid.tsx` | Virtualized editable grid, pending-change marking |
| `DBCommitDialog.tsx` | Shows exact SQL before commit; extra step when `IsProduction` |
| `DBTableDesigner.tsx` | Column / index / constraint editor → DDL plan |
| `DBDDLView.tsx` | Read-only generated `CREATE` statement, copyable |
| `DBSqlEditor.tsx` | SQL editor + result grid + saved queries |
| `dbTabs.ts` | Per-connection open-object tab state |

Visual language follows `PRODUCT.md`: dense, calm, terminal-native; teal accent
as state only. Production connections get a warning-colored tab treatment —
this is the one place accent-as-alarm is warranted.

Server state via `@tanstack/react-query`, matching `features/data/queries`.
All imports use the `@/*` alias; `import type` for type-only imports
(`verbatimModuleSyntax`).

## Error handling

- Connection failure, TLS verification failure, and host-key mismatch surface
  as distinct, actionable messages — never a generic "could not connect".
- A cert-fingerprint mismatch is a hard block with an explicit remediation note,
  never a dismissible warning.
- Raw driver errors never reach the client verbatim; they are mapped, with the
  original logged server-side.
- Read-only tables state the reason ("no primary key and unusable column types
  for fallback matching"), not just a disabled state.

## Testing

- **Driver conformance suite** — one shared table-driven suite run against all
  three engines, covering introspection, paging, row-identity selection, and
  write planning. Postgres/MySQL via testcontainers-style ephemeral instances,
  SQLite in-memory; skipped with a clear message when Docker is unavailable.
- **Row-identity unit tests** — each ladder level, including the level-4
  `rowsAffected != 1` rollback and the float/json/blob refusal.
- **TLS policy tests** — production connections reject each unverified mode;
  fingerprint mismatch blocks.
- **Executor URL validation tests** — `http://` public host rejected,
  `https://` and tailnet hosts accepted, re-checked at execution time.
- **Handler tests** — follow `handler/ssh_test.go`; assert secrets never appear
  in any response body.
- **Frontend** — `npm run typecheck` plus unit tests for pending-change and
  tab-state reducers.

## Build order (for the implementation plan)

1. Domain types, store schema + migrations, `port.Store` methods, `DBSecretService`.
2. Driver interfaces + SQLite driver (no Docker needed → fastest feedback loop).
3. Hub CRUD handlers, TLS policy validation, executor URL validation.
4. Introspection + tree endpoint; Postgres and MySQL drivers.
5. Query execution + paging; runtime `/api/db/*` routes and descriptor transport.
6. Row-identity ladder + commit path + audit.
7. DDL read (`ShowCreate`) then DDL write (table/index/constraint plans).
8. SSH tunnel integration.
9. Frontend: route + rail + tree + connection dialog.
10. Frontend: grid, commit dialog, designer, SQL editor, saved queries.

Steps 1 and 3 touch convergence files (`domain/models.go`, `port/store.go`,
`store/types.ts`, `main.go`) and must not be edited by parallel agents —
serialize them or fold them into a single integration step (`ORCHESTRATION.md`).

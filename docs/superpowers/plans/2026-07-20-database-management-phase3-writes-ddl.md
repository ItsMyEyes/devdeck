# Database Management — Phase 3: Row Writes, DDL & Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the read-only database module from Phases 1–2 writable — an editable-grid commit path with a row-identity ladder and transactional `rowsAffected` guard, table/index DDL (create/alter/drop), `ShowCreate`, and two hardening items Phase 2 left open: SSH tunnels are declared but not dialed, and nothing blocks a connection from pointing at a cloud metadata endpoint.

**Architecture:** All SQL generation stays in `dbquery` — engine-agnostic, unit-tested without a live database, consuming only `port.DBCaps` and a `Placeholder` function, exactly like Phase 2's filter and paging compilers. Drivers stay thin: each new capability is a one-to-a-few-line wrapper calling a `dbquery.Build*` function plus a transactional exec helper. `RowWriter` and `DDLWriter`/`DDLReader` are deliberately **not** part of `port.DBConn` — they are type-asserted at the call site, so a future engine (Mongo, Redis) can implement `Introspector` alone and simply not support writes. Every new hub endpoint reuses the existing `dispatch()`/`runtimeRun()`/`runOp()` machinery from `handler/dbexec.go`, so it works identically whether the connection executes on the hub or on a runtime, with no new routing concept.

**Tech Stack:** Go 1.25, `database/sql` transactions (`sql.Tx`), the existing `jackc/pgx/v5`, `go-sql-driver/mysql`, `modernc.org/sqlite` drivers, `golang.org/x/crypto/ssh` (`dbdriver.OpenTunnel`, already implemented and unit-tested — this plan wires it in, it does not build it).

**Spec:** `docs/superpowers/specs/2026-07-19-database-management-design.md`
**Depends on:** Phase 1 (`docs/superpowers/plans/2026-07-19-database-management-phase1-foundation.md`) and Phase 2 (`docs/superpowers/plans/2026-07-19-database-management-phase2-read-execution.md`) — both fully implemented; verified with `go build ./... && go vet ./... && go test ./...` before this plan was written.

## Starting state (read this before Task 1)

Confirmed by direct inspection of the current tree — not assumed:

- `port.DBConn` is `Introspector + QueryRunner + StatsReader + Close() error`. `QueryRunner.Exec(ctx, sql, args) (ExecResult, error)` **already exists and is fully implemented by all three drivers**, but has zero call sites anywhere in `handler/` or `service/`. This plan is its first consumer, via the new `RowWriter`/`DDLWriter` layer — nothing about `Exec` itself changes.
- `DBCaps.RowIdentifier` is `"ctid"` (postgres), `"rowid"` (sqlite), `""` (mysql) — declared today but **never read anywhere**. No query currently selects `ctid`/`rowid`, and no code compares it. The row-identity ladder is 100% new logic.
- **`pgdrv.Open` and `mysqldrv.Open` currently hard-reject any `DSNDescriptor` with `Tunnel != nil`**, even though `dbdriver.OpenTunnel` (`backend/internal/dbdriver/tunnel.go`) is a complete, unit-tested, TOFU-pinned SSH dial primitive. It is simply not called from either network driver yet. Task 6 closes this.
- **`GET`/`POST /api/db/connections/{id}/indexes` does not exist.** `Introspector.Indexes` is implemented by all three drivers but was never exposed over HTTP in Phase 2. Task 7 adds it — the row-identity ladder needs it (level 2: non-null unique index).
- **The `reject_metadata_ssrf` pattern the design spec references (line 394) does not exist anywhere in this codebase.** It is an aspirational reference, not real code. `service.ValidateExecutorURL` is the closest thing and only governs the *executor machine's* URL, not a `DBConnection`'s own `Host`. Task 5 builds the real guard.
- No audit table exists and none is being added here. `handler/audit.go` is generic HTTP access-log middleware (request/response body capture, capped 2048B, redacting fields matching `password|secret|token|otp|code`) already wired into every `/api` route via `AccessLog`. The design spec says to reuse it for commit/DDL audit rather than add new plumbing; Task 11 adds one test confirming a commit's SQL and `rowsAffected` actually survive into that log, closing the loop rather than taking it on faith.
- `handleStoreErr` maps `service.ErrConflict` → 409, `service.ErrValidation` → 400, `service.ErrUnauthorized` → 401, `service.ErrLocked` → 423, `store.ErrNotFound` → 404 (`backend/internal/handler/middleware.go`). This plan does **not** reuse that path for the rows-affected conflict — `dispatch()`/`runtimeRun()` use `mapDriverErr` + `writeErr` directly, not `handleStoreErr`, and a commit conflict has to survive a hub→runtime JSON hop where a typed Go error cannot. Task 8 builds a parallel, narrower mechanism for exactly that one case (`machineclient.RemoteError` + `statusForDBErr`).

## Global Constraints

- All API responses use the `{"error":"message"}` envelope. (`CONTRACTS.md`)
- Go handlers use `handleStoreErr()` for store errors; driver/commit errors in the DB module go through `mapDriverErr()` + `writeErr()`, matching the existing `dispatch()`/`runtimeRun()` pattern — never return a raw driver error to a client.
- All persistence goes through `port.Store`. `dbdriver`/`dbquery` talk to *external* databases and stay exempt, exactly as in Phase 2.
- `domain/models.go` and `frontend/src/store/types.ts` stay in sync — **this plan adds no new domain types**, so neither file changes. Row edits, statements, and DDL plans are transient request/response shapes in `port`, never persisted.
- Runtime routes (`/api/db/introspect`, `/api/db/exec`) are key-auth only; new ops ride the existing routes, no new runtime endpoints are added.
- Verify with `go vet ./...` and `go test ./...` in `backend/`.
- Row cap 500/5000 and statement timeout 30s (Phase 2) are unchanged and are **not** relaxed for writes — every write and DDL statement runs through `dbdriver.WithStatementTimeout`, same as every read.
- Every write executes inside a transaction (`database/sql`'s `*sql.Tx`); any statement failure — including an `ExpectRowsAffected` mismatch — rolls back the whole batch.

**Convergence files — do not edit these from parallel agents:** `backend/cmd/server/main.go` (all new-route registration is deliberately deferred to Task 11, a single integration step, mirroring how Phase 2 did all of its route wiring in one final task), `backend/internal/port/dbdriver.go` (Task 1 only — every later task depends on its types), `backend/internal/handler/dbexec.go` (Tasks 7, 8, 9, 10 all add fields to `runtimeDBRequest` and cases to `runOp`/`allowed` maps — serialize these four tasks, do not run them in parallel). `backend/internal/domain/models.go`, `backend/internal/port/store.go`, and `backend/go.mod` are **not touched anywhere in this plan** — no new domain types, no new store methods, no new dependencies.

---

### Task 1: Row-identity, write, and DDL types

**Files:**
- Modify: `backend/internal/port/dbdriver.go`
- Modify: `backend/internal/port/dbdriver_test.go`

**Interfaces:**
- Consumes: everything already in `port/dbdriver.go` (Phase 2).
- Produces: everything below. Every later task in this plan consumes these names, so they must not drift.

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/port/dbdriver_test.go` (same file, same package, alongside the existing `TestCapsMatrixIsStable`):

```go
func TestRowIdentityLevelsAreDistinct(t *testing.T) {
	levels := []RowIdentityLevel{IdentityNone, IdentityPrimaryKey, IdentityUniqueIndex, IdentityRowPointer, IdentityAllColumns}
	seen := map[RowIdentityLevel]bool{}
	for _, l := range levels {
		if seen[l] {
			t.Fatalf("duplicate RowIdentityLevel value %q", l)
		}
		seen[l] = true
	}
}

func TestErrRowsAffectedMismatchIsAStableSentinel(t *testing.T) {
	wrapped := fmt.Errorf("statement affected 0 rows, expected 1: %w", ErrRowsAffectedMismatch)
	if !errors.Is(wrapped, ErrRowsAffectedMismatch) {
		t.Fatal("wrapped error does not unwrap to ErrRowsAffectedMismatch")
	}
}
```

Add `"errors"` and `"fmt"` to the test file's imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/port/ -run 'TestRowIdentityLevelsAreDistinct|TestErrRowsAffectedMismatch' -v`
Expected: FAIL — `RowIdentityLevel`, `IdentityNone`, etc. undefined.

- [ ] **Step 3: Add the types**

In `backend/internal/port/dbdriver.go`, add `"errors"` to the import block (it currently imports only `"context"`), then append after the existing `StatsReader` interface at the end of the file:

```go
// --- row-identity ladder (Phase 3) ------------------------------------------

// RowIdentityLevel names which rung of the row-identity ladder a table uses
// for writes. Descend only when the level above is unavailable — a stronger
// identity always wins when one exists. String-typed so it travels usefully
// in JSON if a future "why is this table read-only" endpoint surfaces it.
type RowIdentityLevel string

const (
	IdentityNone        RowIdentityLevel = "none" // no level applies; table is read-only
	IdentityPrimaryKey  RowIdentityLevel = "primary_key"
	IdentityUniqueIndex RowIdentityLevel = "unique_index"
	IdentityRowPointer  RowIdentityLevel = "row_pointer" // ctid / rowid
	IdentityAllColumns  RowIdentityLevel = "all_columns"
)

// RowIdentityPlan is the resolved write-identity strategy for one table,
// computed fresh from its live columns and indexes on every commit — never
// trusted from the client, the same discipline CompileFilters already applies
// to column names.
type RowIdentityPlan struct {
	Level RowIdentityLevel `json:"level"`
	// KeyColumns are the columns compared in the identity predicate: the PK or
	// unique-index columns at levels 1–2, every column at level 3 (ctid/rowid
	// alone is not stable — see RowPointerColumn), and every comparable column
	// at level 4.
	KeyColumns []string `json:"keyColumns,omitempty"`
	// RowPointerColumn is the engine's physical row-address column name
	// ("ctid"/"rowid"), set only at IdentityRowPointer.
	RowPointerColumn string `json:"rowPointerColumn,omitempty"`
	ReadOnly         bool   `json:"readOnly"`
	Reason           string `json:"reason,omitempty"`
}

// RowEdit is one pending grid edit, expressed so the server can rebuild the
// identity predicate without trusting the client's view of the schema.
type RowEdit struct {
	Object ObjectRef `json:"object"`
	Kind   string    `json:"kind"` // "insert" | "update" | "delete"
	// OldValues carries every loaded column's value at read time, keyed by
	// column name. Required for "update"/"delete" — it is what proves row
	// identity at IdentityRowPointer and IdentityAllColumns. Ignored for
	// "insert".
	OldValues map[string]any `json:"oldValues,omitempty"`
	// NewValues carries changed columns only for "update", or every column for
	// "insert". Ignored for "delete".
	NewValues map[string]any `json:"newValues,omitempty"`
	// RowPointer is the ctid/rowid value captured at read time. Required only
	// when the resolved identity level is IdentityRowPointer; ignored
	// otherwise, since ctid is not itself stable and only narrows the scan —
	// the old-value comparison is what actually proves identity.
	RowPointer any `json:"rowPointer,omitempty"`
}

// Statement is one SQL statement queued inside a transactional commit.
type Statement struct {
	SQL  string
	Args []any
	// ExpectRowsAffected, when non-nil, makes the executing transaction roll
	// back and return ErrRowsAffectedMismatch if the statement's actual
	// rows-affected count does not equal this value. Set for update/delete
	// (always 1: the identity predicate is built to match exactly one row);
	// left nil for insert and for DDL, neither of which has a meaningful
	// expectation.
	ExpectRowsAffected *int64
}

// CommitResult is the outcome of a transactional multi-statement commit.
type CommitResult struct {
	Results   []ExecResult `json:"results"`
	ElapsedMS int64        `json:"elapsedMs"`
}

// ErrRowsAffectedMismatch means a Statement's ExpectRowsAffected did not
// match reality — another session changed or removed the row between when
// the grid loaded it and when this commit ran. It is a stale-read conflict,
// not a driver fault: callers map it to HTTP 409, not 500.
var ErrRowsAffectedMismatch = errors.New("rows affected did not match expected count")

// RowWriter is implemented by drivers that support editable-grid writes.
// Deliberately not part of DBConn: a future engine can implement Introspector
// alone and simply not satisfy this interface, exactly as the package doc for
// DBCaps already describes for Redis/Mongo.
type RowWriter interface {
	// CommitEdits resolves each edit's row-identity strategy against its
	// object's live schema, compiles it to a statement, and executes the
	// whole batch inside one transaction.
	CommitEdits(ctx context.Context, edits []RowEdit) (CommitResult, error)
}

// --- DDL (Phase 3) -----------------------------------------------------------

// ColumnPlan describes one column's desired shape in a TablePlan.
type ColumnPlan struct {
	Name         string  `json:"name"`
	DataType     string  `json:"dataType"`
	Nullable     bool    `json:"nullable"`
	Default      *string `json:"default"`
	IsPrimaryKey bool    `json:"isPrimaryKey"`
}

// IndexPlan describes one index's desired shape in a TablePlan.
type IndexPlan struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Unique  bool      `json:"unique"`
}

// TablePlan describes a table structure change. Columns/Indexes are the FULL
// desired end state for "create" and "alter" — for "alter", drivers diff
// against the object's introspected current state to produce ALTER
// statements; a column present in both current and desired is left
// untouched, since the ALTER syntax for changing a column's type diverges
// sharply across engines (and SQLite has none at all short of a table
// rebuild). Ignored for "drop".
type TablePlan struct {
	Object  ObjectRef    `json:"object"`
	Kind    string       `json:"kind"` // "create" | "alter" | "drop"
	Columns []ColumnPlan `json:"columns,omitempty"`
	Indexes []IndexPlan  `json:"indexes,omitempty"`
}

// DDLReader is implemented by drivers that can render an object's CREATE
// statement. Not part of DBConn, for the same reason as RowWriter.
type DDLReader interface {
	ShowCreate(ctx context.Context, obj ObjectRef) (string, error)
}

// DDLWriter is implemented by drivers that support table/index DDL. Not part
// of DBConn, for the same reason as RowWriter.
type DDLWriter interface {
	// Plan renders the exact statements p implies without executing them, for
	// a "preview before apply" step.
	Plan(ctx context.Context, p TablePlan) ([]string, error)
	// Apply executes p's statements inside one transaction.
	Apply(ctx context.Context, p TablePlan) (CommitResult, error)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go build ./internal/port/ && go test ./internal/port/ -v`
Expected: build succeeds, all tests including the two new ones pass.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/port/dbdriver.go backend/internal/port/dbdriver_test.go
git commit -m "feat(db): add row-identity, write, and DDL types to the driver interfaces"
```

---

### Task 2: Row-identity ladder resolver

**Files:**
- Create: `backend/internal/dbquery/identity.go`
- Create: `backend/internal/dbquery/identity_test.go`

**Interfaces:**
- Consumes: `port.ColumnMeta`, `port.IndexMeta`, `port.DBCaps`, `port.RowIdentityPlan` (Task 1).
- Produces: `dbquery.ResolveRowIdentity(cols []port.ColumnMeta, indexes []port.IndexMeta, caps port.DBCaps) port.RowIdentityPlan`

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/dbquery/identity_test.go`:

```go
package dbquery

import (
	"testing"

	"devdeck/backend/internal/port"
)

func TestResolveRowIdentityPrefersPrimaryKey(t *testing.T) {
	cols := []port.ColumnMeta{
		{Name: "id", IsPrimaryKey: true},
		{Name: "email"},
	}
	idxs := []port.IndexMeta{{Name: "email_uq", Columns: []string{"email"}, Unique: true}}
	plan := ResolveRowIdentity(cols, idxs, pgCaps)
	if plan.Level != port.IdentityPrimaryKey {
		t.Fatalf("Level = %q, want primary_key", plan.Level)
	}
	if len(plan.KeyColumns) != 1 || plan.KeyColumns[0] != "id" {
		t.Fatalf("KeyColumns = %v, want [id]", plan.KeyColumns)
	}
}

func TestResolveRowIdentityFallsBackToNonNullUniqueIndex(t *testing.T) {
	cols := []port.ColumnMeta{{Name: "email"}, {Name: "name"}}
	idxs := []port.IndexMeta{{Name: "email_uq", Columns: []string{"email"}, Unique: true, Nullable: false}}
	plan := ResolveRowIdentity(cols, idxs, pgCaps)
	if plan.Level != port.IdentityUniqueIndex {
		t.Fatalf("Level = %q, want unique_index", plan.Level)
	}
	if len(plan.KeyColumns) != 1 || plan.KeyColumns[0] != "email" {
		t.Fatalf("KeyColumns = %v, want [email]", plan.KeyColumns)
	}
}

func TestResolveRowIdentitySkipsNullableUniqueIndex(t *testing.T) {
	// A NULL in a unique index does not participate in uniqueness the way SQL
	// treats NULLs, so it cannot address a row on its own.
	cols := []port.ColumnMeta{{Name: "email"}}
	idxs := []port.IndexMeta{{Name: "email_uq", Columns: []string{"email"}, Unique: true, Nullable: true}}
	plan := ResolveRowIdentity(cols, idxs, pgCaps)
	if plan.Level == port.IdentityUniqueIndex {
		t.Fatal("nullable unique index accepted as identity, want fall-through")
	}
}

func TestResolveRowIdentityFallsBackToRowPointer(t *testing.T) {
	cols := []port.ColumnMeta{{Name: "name"}, {Name: "score", Comparable: true}}
	plan := ResolveRowIdentity(cols, nil, pgCaps)
	if plan.Level != port.IdentityRowPointer {
		t.Fatalf("Level = %q, want row_pointer", plan.Level)
	}
	if plan.RowPointerColumn != "ctid" {
		t.Fatalf("RowPointerColumn = %q, want ctid", plan.RowPointerColumn)
	}
	if len(plan.KeyColumns) != 2 {
		t.Fatalf("KeyColumns = %v, want every loaded column for the old-value comparison", plan.KeyColumns)
	}
}

func TestResolveRowIdentityFallsBackToAllColumnsOnMySQL(t *testing.T) {
	// MySQL's RowIdentifier is "", so it never reaches IdentityRowPointer.
	mysqlCaps := port.DBCaps{QuoteChar: "`", RowIdentifier: ""}
	cols := []port.ColumnMeta{
		{Name: "name", Comparable: true},
		{Name: "payload", Comparable: false}, // json: excluded
	}
	plan := ResolveRowIdentity(cols, nil, mysqlCaps)
	if plan.Level != port.IdentityAllColumns {
		t.Fatalf("Level = %q, want all_columns", plan.Level)
	}
	if len(plan.KeyColumns) != 1 || plan.KeyColumns[0] != "name" {
		t.Fatalf("KeyColumns = %v, want only the comparable column", plan.KeyColumns)
	}
}

func TestResolveRowIdentityReadOnlyWhenNoComparableColumns(t *testing.T) {
	mysqlCaps := port.DBCaps{QuoteChar: "`", RowIdentifier: ""}
	cols := []port.ColumnMeta{{Name: "payload", Comparable: false}}
	plan := ResolveRowIdentity(cols, nil, mysqlCaps)
	if !plan.ReadOnly {
		t.Fatal("expected ReadOnly when no column is comparable and no identifier exists")
	}
	if plan.Reason == "" {
		t.Fatal("ReadOnly must explain itself so the UI can surface the reason")
	}
}
```

`pgCaps` is already defined in `backend/internal/dbquery/filter_test.go` (`port.DBCaps{QuoteChar: `"`, Schemas: true}`) — same package, reused as-is; it has no `RowIdentifier` set, so add it here instead since `TestResolveRowIdentityFallsBackToRowPointer` needs one. Define a package-level `pgCapsWithCtid` in this file instead of mutating the shared fixture:

Replace every use of `pgCaps` above with `pgCapsWithCtid` and add at the top of the file, after the imports:

```go
var pgCapsWithCtid = port.DBCaps{QuoteChar: `"`, Schemas: true, RowIdentifier: "ctid"}
```

(Use `pgCapsWithCtid` in place of `pgCaps` in all five tests above that reference it.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/dbquery/ -run TestResolveRowIdentity -v`
Expected: FAIL — `ResolveRowIdentity` undefined.

- [ ] **Step 3: Implement the resolver**

Create `backend/internal/dbquery/identity.go`:

```go
// Package dbquery — row-identity ladder.
package dbquery

import "devdeck/backend/internal/port"

// ResolveRowIdentity picks the row-identity ladder level for a table from its
// live, freshly introspected columns and indexes — never from anything the
// client supplied, the same discipline CompileFilters applies to column
// names. Descend only when the level above is unavailable:
//
//  1. Primary key — always preferred.
//  2. A non-null unique index — a NULL in a unique index does not
//     participate in SQL's uniqueness comparison, so a nullable one cannot
//     reliably address a row.
//  3. The engine's physical row pointer (ctid/rowid). KeyColumns is set to
//     every loaded column here, not just the pointer: ctid is not stable
//     across a VACUUM or a concurrent UPDATE, so the write predicate compares
//     the pointer AND every old value together — the pointer narrows the
//     scan, the value comparison proves identity.
//  4. Every comparable column — float, json, and blob columns are excluded
//     (ColumnMeta.Comparable), since their equality comparison is either
//     unreliable or, for MySQL json, a runtime error.
//
// A table with none of the above is read-only; ReadOnly explains why.
func ResolveRowIdentity(cols []port.ColumnMeta, indexes []port.IndexMeta, caps port.DBCaps) port.RowIdentityPlan {
	var pkCols []string
	for _, c := range cols {
		if c.IsPrimaryKey {
			pkCols = append(pkCols, c.Name)
		}
	}
	if len(pkCols) > 0 {
		return port.RowIdentityPlan{Level: port.IdentityPrimaryKey, KeyColumns: pkCols}
	}

	for _, idx := range indexes {
		if idx.Unique && !idx.Nullable && len(idx.Columns) > 0 {
			return port.RowIdentityPlan{Level: port.IdentityUniqueIndex, KeyColumns: idx.Columns}
		}
	}

	if caps.RowIdentifier != "" {
		names := make([]string, len(cols))
		for i, c := range cols {
			names[i] = c.Name
		}
		return port.RowIdentityPlan{
			Level:            port.IdentityRowPointer,
			RowPointerColumn: caps.RowIdentifier,
			KeyColumns:       names,
		}
	}

	var comparable []string
	for _, c := range cols {
		if c.Comparable {
			comparable = append(comparable, c.Name)
		}
	}
	if len(comparable) == 0 {
		return port.RowIdentityPlan{
			Level:    port.IdentityNone,
			ReadOnly: true,
			Reason:   "no primary key, unique index, or row identifier, and no column is safely comparable for a fallback match",
		}
	}
	return port.RowIdentityPlan{Level: port.IdentityAllColumns, KeyColumns: comparable}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/dbquery/ -run TestResolveRowIdentity -v`
Expected: PASS for all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/dbquery/identity.go backend/internal/dbquery/identity_test.go
git commit -m "feat(db): add row-identity ladder resolver"
```

---

### Task 3: Row-write SQL compiler and commit-statement builder

**Files:**
- Create: `backend/internal/dbquery/write.go`
- Create: `backend/internal/dbquery/write_test.go`

**Interfaces:**
- Consumes: `port.RowEdit`, `port.RowIdentityPlan`, `port.Statement`, `port.ColumnMeta`, `port.ObjectRef`, `port.Introspector` (Task 1, Phase 2), `dbquery.ResolveRowIdentity` (Task 2), `dbquery.QuoteIdent`/`QuoteObject`/`Placeholder` (Phase 2).
- Produces:
  - `dbquery.CompileInsert(obj port.ObjectRef, values map[string]any, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (string, []any, error)`
  - `dbquery.CompileUpdate(obj port.ObjectRef, plan port.RowIdentityPlan, oldValues, newValues map[string]any, rowPointer any, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (string, []any, error)`
  - `dbquery.CompileDelete(obj port.ObjectRef, plan port.RowIdentityPlan, oldValues map[string]any, rowPointer any, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (string, []any, error)`
  - `dbquery.BuildStatement(edit port.RowEdit, plan port.RowIdentityPlan, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (port.Statement, error)`
  - `dbquery.BuildCommitStatements(ctx context.Context, introspector port.Introspector, edits []port.RowEdit, caps port.DBCaps, ph Placeholder) ([]port.Statement, error)` — this is the single entry point every driver's `CommitEdits` will call in Task 4.

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/dbquery/write_test.go`:

```go
package dbquery

import (
	"context"
	"errors"
	"strings"
	"testing"

	"devdeck/backend/internal/port"
)

func TestCompileInsertBindsValuesAndQuotesColumns(t *testing.T) {
	sql, args, err := CompileInsert(
		port.ObjectRef{Name: "assets"},
		map[string]any{"id": 1, "name": "o'brien"},
		testCols, pgCaps, DollarPlaceholder)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if strings.Contains(sql, "o'brien") {
		t.Fatalf("value interpolated into SQL: %s", sql)
	}
	if !strings.Contains(sql, `"id"`) || !strings.Contains(sql, `"name"`) {
		t.Fatalf("columns not quoted: %s", sql)
	}
	if len(args) != 2 {
		t.Fatalf("args = %v, want 2", args)
	}
}

func TestCompileInsertRejectsUnknownColumn(t *testing.T) {
	_, _, err := CompileInsert(port.ObjectRef{Name: "assets"},
		map[string]any{"id; DROP TABLE t": 1}, testCols, pgCaps, DollarPlaceholder)
	if err == nil {
		t.Fatal("unknown column accepted, want rejection")
	}
}

func TestCompileUpdateBuildsSetAndPrimaryKeyPredicate(t *testing.T) {
	plan := port.RowIdentityPlan{Level: port.IdentityPrimaryKey, KeyColumns: []string{"id"}}
	sql, args, err := CompileUpdate(port.ObjectRef{Name: "assets"}, plan,
		map[string]any{"id": 7}, map[string]any{"name": "new"}, nil,
		testCols, pgCaps, DollarPlaceholder)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.Contains(sql, "SET") || !strings.Contains(sql, "WHERE") {
		t.Fatalf("malformed update: %s", sql)
	}
	if !strings.Contains(sql, `"id" = $2`) {
		t.Fatalf("expected the predicate to continue placeholder numbering after SET: %s", sql)
	}
	if len(args) != 2 || args[0] != "new" || args[1] != 7 {
		t.Fatalf("args = %v, want [new 7]", args)
	}
}

func TestCompileUpdateRowPointerLevelComparesRowPointerAndAllOldValues(t *testing.T) {
	plan := port.RowIdentityPlan{
		Level: port.IdentityRowPointer, RowPointerColumn: "ctid",
		KeyColumns: []string{"id", "name", "score", "payload", "blob_col"},
	}
	sql, args, err := CompileUpdate(port.ObjectRef{Name: "assets"}, plan,
		map[string]any{"id": 1, "name": "old", "score": 1.5, "payload": "{}", "blob_col": []byte("x")},
		map[string]any{"name": "new"}, "(0,1)",
		testCols, pgCaps, DollarPlaceholder)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.Contains(sql, `"ctid" = `) {
		t.Fatalf("ctid predicate missing: %s", sql)
	}
	// 1 SET value + ctid + 5 old-value columns = 7 bound args.
	if len(args) != 7 {
		t.Fatalf("args = %v (%d), want 7", args, len(args))
	}
}

func TestCompileUpdateMissingOldValueIsRejected(t *testing.T) {
	plan := port.RowIdentityPlan{Level: port.IdentityPrimaryKey, KeyColumns: []string{"id"}}
	_, _, err := CompileUpdate(port.ObjectRef{Name: "assets"}, plan,
		map[string]any{}, map[string]any{"name": "new"}, nil,
		testCols, pgCaps, DollarPlaceholder)
	if err == nil {
		t.Fatal("missing old value for the identity column accepted, want rejection")
	}
}

func TestCompileUpdateReadOnlyPlanIsRejected(t *testing.T) {
	plan := port.RowIdentityPlan{Level: port.IdentityNone, ReadOnly: true, Reason: "no identity"}
	_, _, err := CompileUpdate(port.ObjectRef{Name: "assets"}, plan,
		map[string]any{}, map[string]any{"name": "new"}, nil,
		testCols, pgCaps, DollarPlaceholder)
	if err == nil {
		t.Fatal("read-only plan accepted, want rejection")
	}
}

func TestCompileUpdateEmptyNewValuesIsRejected(t *testing.T) {
	plan := port.RowIdentityPlan{Level: port.IdentityPrimaryKey, KeyColumns: []string{"id"}}
	_, _, err := CompileUpdate(port.ObjectRef{Name: "assets"}, plan,
		map[string]any{"id": 1}, map[string]any{}, nil,
		testCols, pgCaps, DollarPlaceholder)
	if err == nil {
		t.Fatal("update with no changed columns accepted, want rejection")
	}
}

func TestCompileDeleteBuildsPredicateOnly(t *testing.T) {
	plan := port.RowIdentityPlan{Level: port.IdentityPrimaryKey, KeyColumns: []string{"id"}}
	sql, args, err := CompileDelete(port.ObjectRef{Name: "assets"}, plan,
		map[string]any{"id": 3}, nil, testCols, pgCaps, DollarPlaceholder)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.HasPrefix(sql, "DELETE FROM") {
		t.Fatalf("not a DELETE: %s", sql)
	}
	if len(args) != 1 || args[0] != 3 {
		t.Fatalf("args = %v, want [3]", args)
	}
}

func TestBuildStatementSetsExpectRowsAffectedForUpdateAndDelete(t *testing.T) {
	plan := port.RowIdentityPlan{Level: port.IdentityPrimaryKey, KeyColumns: []string{"id"}}
	upd, err := BuildStatement(
		port.RowEdit{Object: port.ObjectRef{Name: "assets"}, Kind: "update",
			OldValues: map[string]any{"id": 1}, NewValues: map[string]any{"name": "x"}},
		plan, testCols, pgCaps, DollarPlaceholder)
	if err != nil {
		t.Fatalf("build update: %v", err)
	}
	if upd.ExpectRowsAffected == nil || *upd.ExpectRowsAffected != 1 {
		t.Fatalf("update ExpectRowsAffected = %v, want pointer to 1", upd.ExpectRowsAffected)
	}

	ins, err := BuildStatement(
		port.RowEdit{Object: port.ObjectRef{Name: "assets"}, Kind: "insert",
			NewValues: map[string]any{"id": 1, "name": "x"}},
		plan, testCols, pgCaps, DollarPlaceholder)
	if err != nil {
		t.Fatalf("build insert: %v", err)
	}
	if ins.ExpectRowsAffected != nil {
		t.Fatal("insert must not set ExpectRowsAffected")
	}
}

func TestBuildStatementRejectsUnknownKind(t *testing.T) {
	plan := port.RowIdentityPlan{Level: port.IdentityPrimaryKey, KeyColumns: []string{"id"}}
	_, err := BuildStatement(port.RowEdit{Object: port.ObjectRef{Name: "assets"}, Kind: "upsert"},
		plan, testCols, pgCaps, DollarPlaceholder)
	if err == nil {
		t.Fatal("unknown edit kind accepted, want rejection")
	}
}

// fakeIntrospector is a test double for port.Introspector — dbquery talks to
// no database, so BuildCommitStatements is testable entirely against a canned
// schema.
type fakeIntrospector struct {
	cols  []port.ColumnMeta
	idxs  []port.IndexMeta
	calls int
}

func (f *fakeIntrospector) Tree(context.Context, port.TreePath) ([]port.TreeNode, error) { return nil, nil }
func (f *fakeIntrospector) Columns(context.Context, port.ObjectRef) ([]port.ColumnMeta, error) {
	f.calls++
	return f.cols, nil
}
func (f *fakeIntrospector) Indexes(context.Context, port.ObjectRef) ([]port.IndexMeta, error) {
	return f.idxs, nil
}

func TestBuildCommitStatementsCachesSchemaPerObject(t *testing.T) {
	fi := &fakeIntrospector{cols: []port.ColumnMeta{{Name: "id", IsPrimaryKey: true}, {Name: "name"}}}
	edits := []port.RowEdit{
		{Object: port.ObjectRef{Name: "assets"}, Kind: "update",
			OldValues: map[string]any{"id": 1}, NewValues: map[string]any{"name": "a"}},
		{Object: port.ObjectRef{Name: "assets"}, Kind: "update",
			OldValues: map[string]any{"id": 2}, NewValues: map[string]any{"name": "b"}},
	}
	stmts, err := BuildCommitStatements(context.Background(), fi, edits, pgCaps, DollarPlaceholder)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if len(stmts) != 2 {
		t.Fatalf("stmts = %d, want 2", len(stmts))
	}
	if fi.calls != 1 {
		t.Fatalf("Columns called %d times, want 1 (cached across both edits on the same object)", fi.calls)
	}
}

func TestBuildCommitStatementsRejectsReadOnlyTable(t *testing.T) {
	fi := &fakeIntrospector{cols: []port.ColumnMeta{{Name: "payload", Comparable: false}}}
	mysqlCaps := port.DBCaps{QuoteChar: "`", RowIdentifier: ""}
	edits := []port.RowEdit{
		{Object: port.ObjectRef{Name: "logs"}, Kind: "update",
			OldValues: map[string]any{"payload": "{}"}, NewValues: map[string]any{"payload": "{}"}},
	}
	_, err := BuildCommitStatements(context.Background(), fi, edits, mysqlCaps, QuestionPlaceholder)
	if err == nil {
		t.Fatal("read-only table accepted, want rejection")
	}
	if !errors.Is(err, err) { // sanity: err must be non-nil and comparable
		t.Fatal("unreachable")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/dbquery/ -run 'TestCompileInsert|TestCompileUpdate|TestCompileDelete|TestBuildStatement|TestBuildCommitStatements' -v`
Expected: FAIL — the functions do not exist yet.

- [ ] **Step 3: Implement the compiler**

Create `backend/internal/dbquery/write.go`:

```go
package dbquery

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"devdeck/backend/internal/port"
)

// sortedKeys returns m's keys in a deterministic order, so generated SQL and
// placeholder numbering do not depend on Go's randomized map iteration.
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// buildIdentityPredicate renders the WHERE clause that addresses exactly one
// row, per plan.Level. At IdentityRowPointer the row pointer is compared
// first, then every column in plan.KeyColumns (every loaded column — see
// ResolveRowIdentity): the pointer narrows the scan, the value comparison is
// what actually proves identity, since ctid/rowid can move between read and
// commit. At every other level, plan.KeyColumns alone is the predicate.
func buildIdentityPredicate(plan port.RowIdentityPlan, oldValues map[string]any, rowPointer any, caps port.DBCaps, ph Placeholder, argOffset int) (string, []any, error) {
	var parts []string
	var args []any
	n := argOffset

	if plan.Level == port.IdentityRowPointer {
		q, err := QuoteIdent(plan.RowPointerColumn, caps.QuoteChar)
		if err != nil {
			return "", nil, err
		}
		n++
		parts = append(parts, q+" = "+ph(n))
		args = append(args, rowPointer)
	}
	for _, name := range plan.KeyColumns {
		v, ok := oldValues[name]
		if !ok {
			return "", nil, fmt.Errorf("missing old value for identity column %q", name)
		}
		q, err := QuoteIdent(name, caps.QuoteChar)
		if err != nil {
			return "", nil, err
		}
		n++
		parts = append(parts, q+" = "+ph(n))
		args = append(args, v)
	}
	if len(parts) == 0 {
		return "", nil, fmt.Errorf("no identity predicate could be built")
	}
	return strings.Join(parts, " AND "), args, nil
}

// CompileInsert renders a parameterized INSERT. Column names are validated
// against cols and rejected if absent — the same discipline CompileFilters
// applies, since identifiers can never be bound as parameters.
func CompileInsert(obj port.ObjectRef, values map[string]any, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (string, []any, error) {
	if len(values) == 0 {
		return "", nil, fmt.Errorf("insert requires at least one column")
	}
	target, err := QuoteObject(obj, caps)
	if err != nil {
		return "", nil, err
	}
	names := sortedKeys(values)
	var quotedCols []string
	var placeholders []string
	var args []any
	n := 0
	for _, name := range names {
		if _, ok := columnByName(cols, name); !ok {
			return "", nil, fmt.Errorf("unknown column %q", name)
		}
		q, err := QuoteIdent(name, caps.QuoteChar)
		if err != nil {
			return "", nil, err
		}
		quotedCols = append(quotedCols, q)
		n++
		placeholders = append(placeholders, ph(n))
		args = append(args, values[name])
	}
	sql := "INSERT INTO " + target + " (" + strings.Join(quotedCols, ", ") + ") VALUES (" + strings.Join(placeholders, ", ") + ")"
	return sql, args, nil
}

// CompileUpdate renders a parameterized UPDATE ... SET ... WHERE <identity>.
// plan.ReadOnly tables are rejected outright — a caller that reaches this
// function with a read-only plan has a bug upstream (BuildCommitStatements
// checks this before calling CompileUpdate), and failing loudly here is
// cheaper than debugging a write that silently touched zero rows.
func CompileUpdate(obj port.ObjectRef, plan port.RowIdentityPlan, oldValues, newValues map[string]any, rowPointer any, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (string, []any, error) {
	if plan.ReadOnly {
		return "", nil, fmt.Errorf("table is read-only: %s", plan.Reason)
	}
	if len(newValues) == 0 {
		return "", nil, fmt.Errorf("update requires at least one changed column")
	}
	target, err := QuoteObject(obj, caps)
	if err != nil {
		return "", nil, err
	}
	names := sortedKeys(newValues)
	var sets []string
	var args []any
	n := 0
	for _, name := range names {
		if _, ok := columnByName(cols, name); !ok {
			return "", nil, fmt.Errorf("unknown column %q", name)
		}
		q, err := QuoteIdent(name, caps.QuoteChar)
		if err != nil {
			return "", nil, err
		}
		n++
		sets = append(sets, q+" = "+ph(n))
		args = append(args, newValues[name])
	}
	where, whereArgs, err := buildIdentityPredicate(plan, oldValues, rowPointer, caps, ph, n)
	if err != nil {
		return "", nil, err
	}
	args = append(args, whereArgs...)
	sql := "UPDATE " + target + " SET " + strings.Join(sets, ", ") + " WHERE " + where
	return sql, args, nil
}

// CompileDelete renders a parameterized DELETE ... WHERE <identity>.
func CompileDelete(obj port.ObjectRef, plan port.RowIdentityPlan, oldValues map[string]any, rowPointer any, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (string, []any, error) {
	if plan.ReadOnly {
		return "", nil, fmt.Errorf("table is read-only: %s", plan.Reason)
	}
	target, err := QuoteObject(obj, caps)
	if err != nil {
		return "", nil, err
	}
	where, args, err := buildIdentityPredicate(plan, oldValues, rowPointer, caps, ph, 0)
	if err != nil {
		return "", nil, err
	}
	sql := "DELETE FROM " + target + " WHERE " + where
	return sql, args, nil
}

// BuildStatement dispatches one RowEdit to the matching Compile* function and
// attaches the rows-affected guard: update/delete both expect to match
// exactly one row, since the identity predicate was built to address exactly
// one; insert has no such expectation.
func BuildStatement(edit port.RowEdit, plan port.RowIdentityPlan, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (port.Statement, error) {
	one := int64(1)
	switch edit.Kind {
	case "insert":
		sql, args, err := CompileInsert(edit.Object, edit.NewValues, cols, caps, ph)
		if err != nil {
			return port.Statement{}, err
		}
		return port.Statement{SQL: sql, Args: args}, nil
	case "update":
		sql, args, err := CompileUpdate(edit.Object, plan, edit.OldValues, edit.NewValues, edit.RowPointer, cols, caps, ph)
		if err != nil {
			return port.Statement{}, err
		}
		return port.Statement{SQL: sql, Args: args, ExpectRowsAffected: &one}, nil
	case "delete":
		sql, args, err := CompileDelete(edit.Object, plan, edit.OldValues, edit.RowPointer, cols, caps, ph)
		if err != nil {
			return port.Statement{}, err
		}
		return port.Statement{SQL: sql, Args: args, ExpectRowsAffected: &one}, nil
	default:
		return port.Statement{}, fmt.Errorf("unsupported edit kind %q", edit.Kind)
	}
}

// BuildCommitStatements resolves each edit's row-identity strategy against
// its object's live schema and compiles it into an executable statement.
// Objects are introspected once and cached, even when a batch edits several
// rows of the same table — a grid commit routinely does exactly that.
//
// introspector is whatever the caller already has open (a driver's own
// *conn, which satisfies port.Introspector) — this function talks to no
// database itself, which is what keeps it unit-testable without one.
func BuildCommitStatements(ctx context.Context, introspector port.Introspector, edits []port.RowEdit, caps port.DBCaps, ph Placeholder) ([]port.Statement, error) {
	type schemaKey struct{ database, schema, name string }
	colCache := map[schemaKey][]port.ColumnMeta{}
	idxCache := map[schemaKey][]port.IndexMeta{}

	stmts := make([]port.Statement, 0, len(edits))
	for _, e := range edits {
		key := schemaKey{e.Object.Database, e.Object.Schema, e.Object.Name}
		cols, ok := colCache[key]
		if !ok {
			var err error
			cols, err = introspector.Columns(ctx, e.Object)
			if err != nil {
				return nil, err
			}
			colCache[key] = cols
		}
		idxs, ok := idxCache[key]
		if !ok {
			var err error
			idxs, err = introspector.Indexes(ctx, e.Object)
			if err != nil {
				return nil, err
			}
			idxCache[key] = idxs
		}

		var plan port.RowIdentityPlan
		if e.Kind != "insert" {
			plan = ResolveRowIdentity(cols, idxs, caps)
			if plan.ReadOnly {
				return nil, fmt.Errorf("table %q is read-only: %s", e.Object.Name, plan.Reason)
			}
		}
		stmt, err := BuildStatement(e, plan, cols, caps, ph)
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, stmt)
	}
	return stmts, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/dbquery/ -v`
Expected: PASS for every test in the package (Phase 2's plus this task's).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/dbquery/write.go backend/internal/dbquery/write_test.go
git commit -m "feat(db): add row-write SQL compiler and commit-statement builder"
```

---

### Task 4: Transactional exec, wired into all three drivers

**Files:**
- Create: `backend/internal/dbdriver/exectx.go`
- Create: `backend/internal/dbdriver/exectx_test.go`
- Modify: `backend/internal/dbdriver/sqlitedrv/driver.go`
- Modify: `backend/internal/dbdriver/pgdrv/driver.go`
- Modify: `backend/internal/dbdriver/mysqldrv/driver.go`

**Interfaces:**
- Consumes: `port.Statement`, `port.CommitResult`, `port.ErrRowsAffectedMismatch` (Task 1), `dbquery.BuildCommitStatements` (Task 3).
- Produces: `dbdriver.ExecTxOnDB(ctx context.Context, db *sql.DB, stmts []port.Statement) (port.CommitResult, error)` — shared by every driver's `CommitEdits` here and every driver's `DDLWriter.Apply` in Task 9.

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/dbdriver/exectx_test.go`:

```go
package dbdriver

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"devdeck/backend/internal/port"

	_ "modernc.org/sqlite"
)

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)"); err != nil {
		t.Fatalf("create table: %v", err)
	}
	if _, err := db.Exec("INSERT INTO t (id, name) VALUES (1, 'a'), (2, 'b')"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	return db
}

func TestExecTxOnDBCommitsAllStatements(t *testing.T) {
	db := openTestDB(t)
	one := int64(1)
	_, err := ExecTxOnDB(context.Background(), db, []port.Statement{
		{SQL: "UPDATE t SET name = ? WHERE id = ?", Args: []any{"aa", 1}, ExpectRowsAffected: &one},
		{SQL: "DELETE FROM t WHERE id = ?", Args: []any{2}, ExpectRowsAffected: &one},
	})
	if err != nil {
		t.Fatalf("ExecTxOnDB: %v", err)
	}
	var name string
	if err := db.QueryRow("SELECT name FROM t WHERE id = 1").Scan(&name); err != nil || name != "aa" {
		t.Fatalf("update did not commit: name=%q err=%v", name, err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM t").Scan(&count); err != nil || count != 1 {
		t.Fatalf("delete did not commit: count=%d err=%v", count, err)
	}
}

func TestExecTxOnDBRollsBackOnRowsAffectedMismatch(t *testing.T) {
	db := openTestDB(t)
	one := int64(1)
	_, err := ExecTxOnDB(context.Background(), db, []port.Statement{
		{SQL: "UPDATE t SET name = ? WHERE id = ?", Args: []any{"aa", 1}, ExpectRowsAffected: &one},
		// id 999 matches nothing: 0 rows affected, expected 1.
		{SQL: "UPDATE t SET name = ? WHERE id = ?", Args: []any{"zz", 999}, ExpectRowsAffected: &one},
	})
	if !errors.Is(err, port.ErrRowsAffectedMismatch) {
		t.Fatalf("err = %v, want ErrRowsAffectedMismatch", err)
	}
	var name string
	if err := db.QueryRow("SELECT name FROM t WHERE id = 1").Scan(&name); err != nil || name != "a" {
		t.Fatalf("first statement was not rolled back: name=%q err=%v", name, err)
	}
}

func TestExecTxOnDBRollsBackOnStatementError(t *testing.T) {
	db := openTestDB(t)
	_, err := ExecTxOnDB(context.Background(), db, []port.Statement{
		{SQL: "UPDATE t SET name = ? WHERE id = ?", Args: []any{"aa", 1}},
		{SQL: "INSERT INTO no_such_table (id) VALUES (1)"},
	})
	if err == nil {
		t.Fatal("expected an error from the invalid statement")
	}
	var name string
	if err := db.QueryRow("SELECT name FROM t WHERE id = 1").Scan(&name); err != nil || name != "a" {
		t.Fatalf("first statement was not rolled back: name=%q err=%v", name, err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/dbdriver/ -run TestExecTxOnDB -v`
Expected: FAIL — `ExecTxOnDB` undefined.

- [ ] **Step 3: Implement the shared transactional helper**

Create `backend/internal/dbdriver/exectx.go`:

```go
package dbdriver

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"devdeck/backend/internal/port"
)

// ExecTxOnDB runs every statement in stmts inside one transaction, in order,
// and rolls back the whole batch on the first failure — including an
// ExpectRowsAffected mismatch, which is not a driver error but a stale-read
// conflict: another session changed or removed the row between when the grid
// loaded it and when this commit ran.
//
// Shared by every SQL driver's RowWriter.CommitEdits (Task 4) and
// DDLWriter.Apply (Task 9), so the rollback-on-mismatch guarantee is
// implemented once rather than once per engine.
func ExecTxOnDB(ctx context.Context, db *sql.DB, stmts []port.Statement) (port.CommitResult, error) {
	start := time.Now()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return port.CommitResult{}, err
	}

	results := make([]port.ExecResult, 0, len(stmts))
	for _, s := range stmts {
		stmtStart := time.Now()
		res, err := tx.ExecContext(ctx, s.SQL, s.Args...)
		if err != nil {
			_ = tx.Rollback()
			return port.CommitResult{}, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			// Some statements report no affected-row count; that alone is not
			// a failure, it just means ExpectRowsAffected cannot be checked.
			n = 0
		}
		if s.ExpectRowsAffected != nil && n != *s.ExpectRowsAffected {
			_ = tx.Rollback()
			return port.CommitResult{}, fmt.Errorf(
				"statement affected %d rows, expected %d: %w", n, *s.ExpectRowsAffected, port.ErrRowsAffectedMismatch)
		}
		results = append(results, port.ExecResult{RowsAffected: n, ElapsedMS: time.Since(stmtStart).Milliseconds()})
	}

	if err := tx.Commit(); err != nil {
		return port.CommitResult{}, err
	}
	return port.CommitResult{Results: results, ElapsedMS: time.Since(start).Milliseconds()}, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/dbdriver/ -run TestExecTxOnDB -v`
Expected: PASS for all 3 tests.

- [ ] **Step 5: Wire `CommitEdits` into the SQLite driver**

In `backend/internal/dbdriver/sqlitedrv/driver.go`, add after the existing `Exec` method:

```go
// CommitEdits resolves each edit's row-identity strategy against its live
// schema and executes the whole batch inside one transaction. All of the
// engine-agnostic work — identity resolution, SQL compilation — lives in
// dbquery.BuildCommitStatements; this method is the thin per-engine wrapper
// dbdriver.ExecTxOnDB expects.
func (c *conn) CommitEdits(ctx context.Context, edits []port.RowEdit) (port.CommitResult, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()
	stmts, err := dbquery.BuildCommitStatements(ctx, c, edits, caps, dbquery.QuestionPlaceholder)
	if err != nil {
		return port.CommitResult{}, err
	}
	return dbdriver.ExecTxOnDB(ctx, c.db, stmts)
}

var _ port.RowWriter = (*conn)(nil)
```

Add a behavioral test to `backend/internal/dbdriver/sqlitedrv/driver_test.go`:

```go
func TestCommitEditsUpdatesThroughPrimaryKeyIdentity(t *testing.T) {
	ctx := context.Background()
	conn := openTestConn(t) // reuse whatever in-memory-DB test helper this file already establishes
	if _, err := conn.Exec(ctx, "CREATE TABLE assets (id INTEGER PRIMARY KEY, name TEXT)", nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := conn.Exec(ctx, "INSERT INTO assets (id, name) VALUES (1, 'alpha')", nil); err != nil {
		t.Fatalf("seed: %v", err)
	}
	res, err := conn.CommitEdits(ctx, []port.RowEdit{
		{Object: port.ObjectRef{Name: "assets"}, Kind: "update",
			OldValues: map[string]any{"id": int64(1), "name": "alpha"},
			NewValues: map[string]any{"name": "beta"}},
	})
	if err != nil {
		t.Fatalf("CommitEdits: %v", err)
	}
	if len(res.Results) != 1 || res.Results[0].RowsAffected != 1 {
		t.Fatalf("res = %+v, want one statement affecting 1 row", res)
	}
	var name string
	if err := conn.db.QueryRowContext(ctx, "SELECT name FROM assets WHERE id = 1").Scan(&name); err != nil || name != "beta" {
		t.Fatalf("commit did not apply: name=%q err=%v", name, err)
	}
}
```

If `driver_test.go` has no existing `openTestConn`-style helper that returns a `*conn` backed by an in-memory database, add one modeled on how `sqliteDriver{}.Open` builds a connection, using `:memory:` as the database path:

```go
func openTestConn(t *testing.T) *conn {
	t.Helper()
	c, err := New().Open(context.Background(), port.DSNDescriptor{Engine: "sqlite", Database: ":memory:"})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c.(*conn)
}
```

- [ ] **Step 6: Run the SQLite driver tests**

Run: `cd backend && go test ./internal/dbdriver/sqlitedrv/ -v`
Expected: PASS, including `TestCommitEditsUpdatesThroughPrimaryKeyIdentity`.

- [ ] **Step 7: Wire `CommitEdits` into the PostgreSQL driver**

In `backend/internal/dbdriver/pgdrv/driver.go`, add after the existing `Exec` method:

```go
func (c *conn) CommitEdits(ctx context.Context, edits []port.RowEdit) (port.CommitResult, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()
	stmts, err := dbquery.BuildCommitStatements(ctx, c, edits, caps, dbquery.DollarPlaceholder)
	if err != nil {
		return port.CommitResult{}, err
	}
	return dbdriver.ExecTxOnDB(ctx, c.db, stmts)
}

var _ port.RowWriter = (*conn)(nil)
```

Add to `backend/internal/dbdriver/pgdrv/driver_test.go`:

```go
func TestCommitEditsUpdatesThroughCtidIdentity(t *testing.T) {
	d := descriptorFromEnv(t)
	ctx := context.Background()
	c, err := New().Open(ctx, d)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer c.Close()
	conn := c.(*conn)

	if _, err := conn.Exec(ctx, "DROP TABLE IF EXISTS phase3_commit_test", nil); err != nil {
		t.Fatalf("drop: %v", err)
	}
	// No primary key on purpose: exercises the ctid rung of the ladder.
	if _, err := conn.Exec(ctx, "CREATE TABLE phase3_commit_test (name text)", nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	defer conn.Exec(ctx, "DROP TABLE phase3_commit_test", nil)
	if _, err := conn.Exec(ctx, "INSERT INTO phase3_commit_test (name) VALUES ('alpha')", nil); err != nil {
		t.Fatalf("seed: %v", err)
	}

	var ctid string
	if err := conn.db.QueryRowContext(ctx, "SELECT ctid::text FROM phase3_commit_test WHERE name = 'alpha'").Scan(&ctid); err != nil {
		t.Fatalf("read ctid: %v", err)
	}

	res, err := conn.CommitEdits(ctx, []port.RowEdit{
		{Object: port.ObjectRef{Name: "phase3_commit_test"}, Kind: "update",
			OldValues: map[string]any{"name": "alpha"}, NewValues: map[string]any{"name": "beta"},
			RowPointer: ctid},
	})
	if err != nil {
		t.Fatalf("CommitEdits: %v", err)
	}
	if len(res.Results) != 1 || res.Results[0].RowsAffected != 1 {
		t.Fatalf("res = %+v, want one statement affecting 1 row", res)
	}
}
```

This follows `descriptorFromEnv(t)` exactly as the existing Phase 2 postgres tests do — it `t.Skip`s unless `DEVDECK_TEST_PG_DSN` is set, so `go test ./...` stays green without a live server.

- [ ] **Step 8: Wire `CommitEdits` into the MySQL driver**

In `backend/internal/dbdriver/mysqldrv/driver.go`, add after the existing `Exec` method:

```go
func (c *conn) CommitEdits(ctx context.Context, edits []port.RowEdit) (port.CommitResult, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()
	stmts, err := dbquery.BuildCommitStatements(ctx, c, edits, caps, dbquery.QuestionPlaceholder)
	if err != nil {
		return port.CommitResult{}, err
	}
	return dbdriver.ExecTxOnDB(ctx, c.db, stmts)
}

var _ port.RowWriter = (*conn)(nil)
```

Add to `backend/internal/dbdriver/mysqldrv/driver_test.go` a test mirroring `TestCommitEditsUpdatesThroughCtidIdentity` above, adapted to MySQL's all-columns fallback (MySQL's `RowIdentifier` is `""`, so a table with no primary key lands at `IdentityAllColumns`, not a row-pointer level):

```go
func TestCommitEditsUpdatesThroughAllColumnsIdentity(t *testing.T) {
	raw := os.Getenv("DEVDECK_TEST_MYSQL_DSN")
	if strings.TrimSpace(raw) == "" {
		t.Skip("set DEVDECK_TEST_MYSQL_DSN to run MySQL integration tests")
	}
	d := descriptorFromEnv(t) // use this file's existing DSN-parsing helper
	ctx := context.Background()
	c, err := New().Open(ctx, d)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer c.Close()
	conn := c.(*conn)

	if _, err := conn.Exec(ctx, "DROP TABLE IF EXISTS phase3_commit_test", nil); err != nil {
		t.Fatalf("drop: %v", err)
	}
	if _, err := conn.Exec(ctx, "CREATE TABLE phase3_commit_test (name VARCHAR(64))", nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	defer conn.Exec(ctx, "DROP TABLE phase3_commit_test", nil)
	if _, err := conn.Exec(ctx, "INSERT INTO phase3_commit_test (name) VALUES ('alpha')", nil); err != nil {
		t.Fatalf("seed: %v", err)
	}

	res, err := conn.CommitEdits(ctx, []port.RowEdit{
		{Object: port.ObjectRef{Name: "phase3_commit_test"}, Kind: "update",
			OldValues: map[string]any{"name": "alpha"}, NewValues: map[string]any{"name": "beta"}},
	})
	if err != nil {
		t.Fatalf("CommitEdits: %v", err)
	}
	if len(res.Results) != 1 || res.Results[0].RowsAffected != 1 {
		t.Fatalf("res = %+v, want one statement affecting 1 row", res)
	}
}
```

If this file's existing DSN-parsing helper is not named `descriptorFromEnv` (Task 6's research found the mysql test file uses `os.Getenv("DEVDECK_TEST_MYSQL_DSN")` directly around line 152 rather than pgdrv's named helper), inline the same descriptor-building logic that file's other integration tests already use immediately after that `t.Skip` check, instead of calling a helper that may not exist.

- [ ] **Step 9: Run the full dbdriver package tree**

Run: `cd backend && go build ./internal/dbdriver/... && go vet ./internal/dbdriver/... && go test ./internal/dbdriver/... -v`
Expected: build and vet clean; sqlite tests pass; postgres/mysql integration tests pass if their DSN env vars are set, otherwise skip cleanly.

- [ ] **Step 10: Commit**

```bash
git add backend/internal/dbdriver/exectx.go backend/internal/dbdriver/exectx_test.go \
  backend/internal/dbdriver/sqlitedrv/driver.go backend/internal/dbdriver/sqlitedrv/driver_test.go \
  backend/internal/dbdriver/pgdrv/driver.go backend/internal/dbdriver/pgdrv/driver_test.go \
  backend/internal/dbdriver/mysqldrv/driver.go backend/internal/dbdriver/mysqldrv/driver_test.go
git commit -m "feat(db): add transactional exec and wire row writes into all three drivers"
```

---

### Task 5: Block link-local and cloud-metadata database hosts

**Files:**
- Modify: `backend/internal/service/dbvalidate.go`
- Modify: `backend/internal/service/dbvalidate_test.go`
- Modify: `backend/internal/handler/db.go`

**Interfaces:**
- Produces: `service.ValidateDBHost(host string) error`

- [ ] **Step 1: Write the failing tests**

Add to `backend/internal/service/dbvalidate_test.go` (existing file):

```go
func TestValidateDBHostRejectsLinkLocalIPv4(t *testing.T) {
	// 169.254.169.254 is the cloud metadata endpoint on AWS, GCP, and Azure
	// alike — the exact address the design's residual-risks section names.
	if err := ValidateDBHost("169.254.169.254"); err == nil {
		t.Fatal("link-local IPv4 host accepted, want rejection")
	}
}

func TestValidateDBHostRejectsLinkLocalIPv6(t *testing.T) {
	if err := ValidateDBHost("fe80::1"); err == nil {
		t.Fatal("link-local IPv6 host accepted, want rejection")
	}
}

func TestValidateDBHostAcceptsOrdinaryHosts(t *testing.T) {
	for _, host := range []string{"10.0.0.5", "db.internal.example.com", "127.0.0.1", ""} {
		if err := ValidateDBHost(host); err != nil {
			t.Errorf("host %q rejected: %v", host, err)
		}
	}
}

func TestValidateDBHostAcceptsUnresolvableHostname(t *testing.T) {
	// A hostname the hub cannot resolve yet is not link-local by definition;
	// connecting will simply fail later with its own, clearer error.
	if err := ValidateDBHost("this-host-does-not-exist.invalid"); err != nil {
		t.Errorf("unresolvable hostname rejected: %v", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/service/ -run TestValidateDBHost -v`
Expected: FAIL — `ValidateDBHost` undefined.

- [ ] **Step 3: Implement the guard**

Add to `backend/internal/service/dbvalidate.go`, after `ValidateSSLMode` (add `"net"` and `"strings"` are already imported by this file):

```go
// ValidateDBHost rejects a database host that resolves to a link-local
// address — 169.254.0.0/16 (IPv4) and fe80::/10 (IPv6) — which is where
// every major cloud's instance-metadata service listens: 169.254.169.254 on
// AWS/GCP/Azure, 100.100.100.100 on Alibaba (that one is inside Tailscale's
// own CGNAT range and is not blocked here — see the design doc's
// residual-risks note).
//
// Unlike ValidateExecutorURL, this does not require TLS or reject public
// hosts outright: pointing a DB client at an arbitrary host:port is the
// entire feature. Only the specific metadata-endpoint shape is blocked, and
// only at connection-save time — this is a footgun guard against a
// deliberate metadata-endpoint host, not a defense against a hostile actor
// racing DNS after validation, matching the design's "IsProduction is not a
// security boundary" framing: the operator holds full credentials either way.
func ValidateDBHost(host string) error {
	h := strings.TrimSpace(host)
	if h == "" {
		return nil // sqlite, or "host required" is validated elsewhere
	}
	if ip := net.ParseIP(h); ip != nil {
		return checkLinkLocal(host, []net.IP{ip})
	}
	ips, err := net.LookupIP(h)
	if err != nil {
		return nil
	}
	return checkLinkLocal(host, ips)
}

func checkLinkLocal(host string, ips []net.IP) error {
	for _, ip := range ips {
		if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			return fmt.Errorf("host %q resolves to a link-local address, which is blocked to prevent reaching a cloud metadata endpoint (e.g. 169.254.169.254)", host)
		}
	}
	return nil
}
```

Add `"fmt"` to `dbvalidate.go`'s imports if not already present (it is not — the current file imports only `fmt`, `net`, `net/url`, `strings`; `fmt` is already there since `ValidateEngine` uses it).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/service/ -run TestValidateDBHost -v`
Expected: PASS for all 4 tests.

- [ ] **Step 5: Wire the guard into the connection handlers**

In `backend/internal/handler/db.go`'s `PostConnection`, add right after the existing `ValidateSSLMode` check:

```go
	if err := service.ValidateDBHost(str(body.Host)); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
```

In `PatchConnection`, the pattern already merges patched fields against the existing row before validating (see how `engine`/`sslMode`/`isProduction` are merged before their checks). Add the same merge for `host`, then validate it. Immediately after the existing `sslMode := existing.SSLMode ...` block, add:

```go
	host := existing.Host
	if body.Host != nil {
		host = *body.Host
	}
```

Then, alongside the existing `if err := service.ValidateSSLMode(...)` check in `PatchConnection`, add:

```go
	if err := service.ValidateDBHost(host); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
```

- [ ] **Step 6: Write a handler-level regression test**

Add to `backend/internal/handler/db_test.go` (existing file) a test asserting `POST /api/db/connections` with `"host":"169.254.169.254"` returns 400. Follow this file's existing pattern exactly — reuse whatever test-server constructor (`newDBTestServer(t)` or similar) the file's other `PostConnection` tests already use, rather than building a new one.

- [ ] **Step 7: Run the full service and handler suites**

Run: `cd backend && go test ./internal/service/... ./internal/handler/... -v`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add backend/internal/service/dbvalidate.go backend/internal/service/dbvalidate_test.go backend/internal/handler/db.go backend/internal/handler/db_test.go
git commit -m "feat(db): block link-local and cloud-metadata database hosts"
```

---

### Task 6: Wire SSH tunnel dialing into the PostgreSQL and MySQL drivers

**Files:**
- Modify: `backend/internal/dbdriver/pgdrv/driver.go`
- Modify: `backend/internal/dbdriver/pgdrv/driver_test.go`
- Modify: `backend/internal/dbdriver/mysqldrv/driver.go`
- Modify: `backend/internal/dbdriver/mysqldrv/driver_test.go`

**Interfaces:**
- Consumes: `dbdriver.OpenTunnel(ctx, t port.TunnelDescriptor, target string) (net.Conn, func() error, error)` — already implemented and unit-tested in `backend/internal/dbdriver/tunnel.go`; this task only calls it.
- Produces: `Open` on both drivers now dials through a tunnel instead of rejecting one.

This task is independent of Tasks 1–5 and can run at any point in this plan.

- [ ] **Step 1: Update the PostgreSQL rejection test into a dial-attempt test**

In `backend/internal/dbdriver/pgdrv/driver_test.go`, add:

```go
func TestOpenAttemptsTunnelDialWhenConfigured(t *testing.T) {
	// No live bastion is reachable in this test, so Open must fail at the
	// tunnel dial stage — proving the descriptor's tunnel was wired in and
	// attempted, rather than silently ignored or rejected outright.
	_, err := New().Open(context.Background(), port.DSNDescriptor{
		Host: "127.0.0.1", Port: 5432, Database: "postgres",
		Tunnel: &port.TunnelDescriptor{
			Host: "127.0.0.1", Port: 1, // nothing listens here
			Username: "u", AuthType: "password", Password: "p",
			HostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		},
	})
	if err == nil {
		t.Fatal("expected a dial failure")
	}
	if !strings.Contains(err.Error(), "tunnel") {
		t.Fatalf("error = %q, want it to mention the tunnel dial attempt", err.Error())
	}
}
```

(`pgdrv` has no existing tunnel-rejection test to remove — Phase 2 only added one to `mysqldrv`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && go test ./internal/dbdriver/pgdrv/ -run TestOpenAttemptsTunnelDialWhenConfigured -v`
Expected: FAIL — `Open` currently returns `"postgres: SSH tunnelled connections are not supported yet"` immediately, without the word "tunnel" appearing in a way tied to an actual dial attempt... actually it does contain "tunnel" already in the rejection message, so this assertion alone would pass even before the fix. Strengthen it: also assert the message does **not** contain "not supported":

```go
	if strings.Contains(err.Error(), "not supported") {
		t.Fatal("tunnel was rejected outright rather than attempted")
	}
```

Re-run: now it correctly FAILs against the current rejection-based `Open`.

- [ ] **Step 3: Wire the tunnel into `pgdrv.Open`**

In `backend/internal/dbdriver/pgdrv/driver.go`, replace:

```go
	if d.Tunnel != nil {
		// Tunnelled dialling lands with dbdriver.OpenTunnel. Until it exists,
		// refuse rather than connect directly: an operator who configured a
		// bastion must not silently get a direct connection to the database.
		return nil, errors.New("postgres: SSH tunnelled connections are not supported yet")
	}
	host := strings.TrimSpace(d.Host)
```

with:

```go
	host := strings.TrimSpace(d.Host)
```

Then, after the existing `cfg.RuntimeParams["statement_timeout"] = ...` line and before `db := stdlib.OpenDB(*cfg)`, add:

```go
	if d.Tunnel != nil {
		target := net.JoinHostPort(host, strconv.Itoa(prt))
		cfg.DialFunc = func(dialCtx context.Context, network, addr string) (net.Conn, error) {
			nc, closeExtra, err := dbdriver.OpenTunnel(dialCtx, *d.Tunnel, target)
			if err != nil {
				return nil, err
			}
			return &tunnelConn{Conn: nc, closeExtra: closeExtra}, nil
		}
	}
```

Then change:

```go
	db := stdlib.OpenDB(*cfg)

	pingCtx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
```

to:

```go
	db := stdlib.OpenDB(*cfg)
	if d.Tunnel != nil {
		// Each dial opens its own SSH channel over a fresh client. Capping
		// the pool at one connection bounds how many concurrent channels a
		// single DevDeck connection opens to the bastion, matching the
		// sqlite driver's own single-connection pool for an analogous
		// serialization reason.
		db.SetMaxOpenConns(1)
	}

	pingCtx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
```

Add the wrapper type near the bottom of the file, in the `--- helpers ---` section:

```go
// tunnelConn wraps the net.Conn OpenTunnel returns so closing it also tears
// down the SSH client and channel beneath it. Closing just the embedded
// net.Conn would close the channel but leak the *ssh.Client's TCP socket to
// the bastion.
type tunnelConn struct {
	net.Conn
	closeExtra func() error
}

func (c *tunnelConn) Close() error {
	err := c.Conn.Close()
	if extraErr := c.closeExtra(); extraErr != nil && err == nil {
		err = extraErr
	}
	return err
}
```

`net` and `context` are already imported by this file. Remove the now-unused `"errors"` import only if nothing else in the file uses it — `errors.New` is still used elsewhere in `Open` for `"postgres: no host configured"` etc., so `errors` stays imported.

- [ ] **Step 4: Run the PostgreSQL driver tests**

Run: `cd backend && go build ./internal/dbdriver/pgdrv/ && go test ./internal/dbdriver/pgdrv/ -v`
Expected: build succeeds; `TestOpenAttemptsTunnelDialWhenConfigured` passes; all other tests unaffected.

- [ ] **Step 5: Replace the MySQL rejection test**

In `backend/internal/dbdriver/mysqldrv/driver_test.go`, replace `TestOpenRejectsTunnelWithoutSupport` with:

```go
func TestOpenAttemptsTunnelDialWhenConfigured(t *testing.T) {
	_, err := New().Open(context.Background(), port.DSNDescriptor{
		Engine: "mysql", Host: "127.0.0.1", Port: 3306,
		Tunnel: &port.TunnelDescriptor{
			Host: "127.0.0.1", Port: 1, // nothing listens here
			Username: "u", AuthType: "password", Password: "p",
			HostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		},
	})
	if err == nil {
		t.Fatal("expected a dial failure")
	}
	if strings.Contains(err.Error(), "not supported") {
		t.Fatal("tunnel was rejected outright rather than attempted")
	}
}
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd backend && go test ./internal/dbdriver/mysqldrv/ -run TestOpenAttemptsTunnelDialWhenConfigured -v`
Expected: FAIL against the current rejection-based `Open`.

- [ ] **Step 7: Wire the tunnel into `mysqldrv.Open`**

In `backend/internal/dbdriver/mysqldrv/driver.go`, replace:

```go
	// Tunnel dialing is a separate unit (dbdriver.OpenTunnel). Until it is wired
	// in here, accepting a tunnel descriptor would open a *direct* connection
	// while the operator believes traffic is going through their bastion.
	if d.Tunnel != nil {
		return nil, errors.New("mysql: SSH tunneled connections are not supported by this driver yet")
	}
	host := strings.TrimSpace(d.Host)
```

with:

```go
	host := strings.TrimSpace(d.Host)
```

Inside `newCfg`, right after `cfg.AllowFallbackToPlaintext = d.SSLMode == "preferred"`, add:

```go
		if d.Tunnel != nil {
			target := cfg.Addr
			cfg.DialFunc = func(dialCtx context.Context, network, addr string) (net.Conn, error) {
				nc, closeExtra, err := dbdriver.OpenTunnel(dialCtx, *d.Tunnel, target)
				if err != nil {
					return nil, err
				}
				return &tunnelConn{Conn: nc, closeExtra: closeExtra}, nil
			}
		}
```

Note `cfg.Addr` is already set two lines above this insertion point (`cfg.Addr = net.JoinHostPort(host, strconv.Itoa(p))`), so `target` captures the real dial target before `DialFunc` is invoked.

After `db, err := openAndPing(ctx, newCfg(true))` / the MariaDB fallback / the `if err != nil { return nil, err }` block, before `c := &conn{db: db, defaultDB: d.Database}`, add:

```go
	if d.Tunnel != nil {
		db.SetMaxOpenConns(1)
	}
```

Add the same `tunnelConn` wrapper type used in `pgdrv` (Go does not share unexported types across packages, so this is a small, deliberate duplication — consistent with `scanRow`/`clampLimit` already being duplicated per driver):

```go
// tunnelConn wraps the net.Conn OpenTunnel returns so closing it also tears
// down the SSH client and channel beneath it.
type tunnelConn struct {
	net.Conn
	closeExtra func() error
}

func (c *tunnelConn) Close() error {
	err := c.Conn.Close()
	if extraErr := c.closeExtra(); extraErr != nil && err == nil {
		err = extraErr
	}
	return err
}
```

`net` and `context` are already imported by this file.

- [ ] **Step 8: Run the MySQL driver tests**

Run: `cd backend && go build ./internal/dbdriver/mysqldrv/ && go test ./internal/dbdriver/mysqldrv/ -v`
Expected: build succeeds; `TestOpenAttemptsTunnelDialWhenConfigured` passes; all other tests unaffected.

- [ ] **Step 9: Commit**

```bash
git add backend/internal/dbdriver/pgdrv/driver.go backend/internal/dbdriver/pgdrv/driver_test.go \
  backend/internal/dbdriver/mysqldrv/driver.go backend/internal/dbdriver/mysqldrv/driver_test.go
git commit -m "feat(db): wire SSH tunnel dialing into postgres and mysql drivers"
```

---

### Task 7: Index introspection endpoint

**Files:**
- Modify: `backend/internal/handler/dbexec.go`
- Create: `backend/internal/handler/dbwrite.go`
- Modify: `backend/internal/handler/dbexec_test.go`

**Interfaces:**
- Consumes: `port.Introspector.Indexes` (Phase 2, all three drivers).
- Produces: `DBExecHandler.PostIndexes` (route registered in Task 11).

This is the smallest task in the plan and establishes the pattern Tasks 8–10 repeat: a new field on `runtimeDBRequest`, a new case in `runOp`, a new entry in an `allowed` map, and a new handler method in the new `dbwrite.go` file (kept separate from the already-445-line `dbexec.go`, which stops growing here).

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/handler/dbexec_test.go`:

```go
func TestPostIndexesReturnsIndexMetadata(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t) // existing Phase 2 test fixture: the "assets" table
	res := srv.post(t, "/api/db/connections/"+id+"/indexes", `{"object":{"name":"assets","kind":"table"}}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", res.Code, res.Body.String())
	}
	var out []port.IndexMeta
	if err := json.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
}
```

(`srv.createSQLiteConnection` and `srv.post` are the existing Phase 2 test-server helpers from `dbexec_test.go`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/handler/ -run TestPostIndexesReturnsIndexMetadata -v`
Expected: FAIL — 404, `PostIndexes` and the route do not exist yet (route registration lands in Task 11; for now this test proves the handler method compiles and dispatches correctly when invoked directly — see Step 4).

Since the route is not registered until Task 11, this test cannot reach the handler through `srv.post`'s HTTP router yet. Adjust Step 1 to call the handler method directly instead of over HTTP, matching how a unit test would invoke it before wiring:

```go
func TestPostIndexesReturnsIndexMetadata(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	req := httptest.NewRequest(http.MethodPost, "/api/db/connections/"+id+"/indexes",
		strings.NewReader(`{"object":{"name":"assets","kind":"table"}}`))
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	srv.dbExecH.PostIndexes(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out []port.IndexMeta
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
}
```

If `newDBTestServer(t)`'s returned struct does not expose a `dbExecH` field pointing at the `*DBExecHandler` it constructed, add one — check `dbexec_test.go`'s `newDBTestServer` definition first; it almost certainly already builds a `*DBExecHandler` internally to wire into its own router, so this is exposing an existing value rather than constructing a new one.

- [ ] **Step 3: Add the `Object` field is already present**

`runtimeDBRequest` already has an `Object port.ObjectRef` field (used by `columns`/`stats`/`count`) — no new field is needed for this task.

- [ ] **Step 4: Implement the handler and wire the runtime dispatch**

Create `backend/internal/handler/dbwrite.go`:

```go
// Handlers for the database module's write path: row commits and table/index
// DDL. Kept separate from dbexec.go (the read path) so neither file grows
// unwieldy; both define methods on the same *DBExecHandler and share its
// dispatch()/runOp() machinery.
package handler

import (
	"context"
	"net/http"

	"devdeck/backend/internal/port"
)

// PostIndexes lists a table's indexes — needed by the frontend to explain why
// a table is or is not editable (the row-identity ladder's level 2), and by
// the table designer to show existing indexes before altering them.
func (h *DBExecHandler) PostIndexes(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Object port.ObjectRef `json:"object"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	out := []port.IndexMeta{}
	h.dispatch(w, r, runtimeIntrospectPath, runtimeDBRequest{Op: "indexes", Object: body.Object}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) { return c.Indexes(ctx, body.Object) })
}
```

In `backend/internal/handler/dbexec.go`, add a case to `runOp`'s switch, immediately after the existing `case "stats":` case:

```go
	case "indexes":
		return conn.Indexes(ctx, req.Object)
```

Add `"indexes"` to `RuntimeIntrospect`'s allowed set:

```go
func (h *DBExecHandler) RuntimeIntrospect(w http.ResponseWriter, r *http.Request) {
	h.runtimeRun(w, r, map[string]bool{"tree": true, "columns": true, "stats": true, "indexes": true})
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && go build ./... && go test ./internal/handler/ -run TestPostIndexesReturnsIndexMetadata -v`
Expected: build succeeds; test passes.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/handler/dbexec.go backend/internal/handler/dbwrite.go backend/internal/handler/dbexec_test.go
git commit -m "feat(db): add index introspection endpoint"
```

---

### Task 8: Transactional row-commit endpoint with conflict detection

**Files:**
- Modify: `backend/internal/machineclient/dbexec.go`
- Create: `backend/internal/machineclient/dbexec_test.go`
- Modify: `backend/internal/handler/dbexec.go`
- Modify: `backend/internal/handler/dbwrite.go`
- Modify: `backend/internal/handler/dbexec_test.go`

**Interfaces:**
- Consumes: `port.RowWriter.CommitEdits` (Task 4), `port.ErrRowsAffectedMismatch` (Task 1).
- Produces: `machineclient.RemoteError{Status int, Message string}`, `DBExecHandler.PostCommit` (route in Task 11).

This is the task that makes a rows-affected conflict surface as HTTP 409 whether the connection executes on the hub or on a runtime. A Go error's identity (`errors.Is`) does not survive the hub→runtime JSON hop through `{"error":"..."}` — `machineclient.RunDBRequest` currently discards the runtime's HTTP status entirely, collapsing every non-2xx reply into a generic error. This task makes it preserve the status instead, and teaches `dispatch()`/`runtimeRun()` to use it.

- [ ] **Step 1: Write the failing test for `RunDBRequest`'s status propagation**

Create `backend/internal/machineclient/dbexec_test.go`:

```go
package machineclient

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"devdeck/backend/internal/domain"
)

func TestRunDBRequestPreservesUpstreamStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"error":"statement affected 0 rows, expected 1"}`))
	}))
	defer srv.Close()

	err := RunDBRequest(t.Context(), domain.Machine{ID: "m1", URL: srv.URL, Key: "k"}, "/api/db/exec", map[string]any{}, nil)
	var remoteErr *RemoteError
	if !errors.As(err, &remoteErr) {
		t.Fatalf("err = %v, want *RemoteError", err)
	}
	if remoteErr.Status != http.StatusConflict {
		t.Fatalf("Status = %d, want 409", remoteErr.Status)
	}
}

func TestRunDBRequestSucceedsOn200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	var out struct{ OK bool `json:"ok"` }
	if err := RunDBRequest(t.Context(), domain.Machine{ID: "m1", URL: srv.URL, Key: "k"}, "/api/db/test", map[string]any{}, &out); err != nil {
		t.Fatalf("RunDBRequest: %v", err)
	}
	if !out.OK {
		t.Fatal("expected ok=true to decode")
	}
}
```

If `t.Context()` is unavailable (Go < 1.24 test helper), use `context.Background()` with a `"context"` import instead — check `go.mod`'s Go version first; the project targets Go 1.25 per `.claude/rules/go.md`, so `t.Context()` is available.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/machineclient/ -run TestRunDBRequest -v`
Expected: FAIL — `RemoteError` undefined.

- [ ] **Step 3: Make `RunDBRequest` preserve the upstream status**

In `backend/internal/machineclient/dbexec.go`, add above `RunDBRequest`:

```go
// RemoteError carries a runtime's response status alongside its message, so a
// caller can classify the failure — a 409 conflict from a rows-affected
// mismatch is not the same thing as a 500 the runtime itself failed with —
// rather than treating every non-2xx reply as an opaque server error.
type RemoteError struct {
	Status  int
	Message string
}

func (e *RemoteError) Error() string { return e.Message }
```

Replace the existing non-2xx branch:

```go
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var envelope struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&envelope)
		if envelope.Error == "" {
			return fmt.Errorf("machine %s returned status %d", m.ID, resp.StatusCode)
		}
		return fmt.Errorf("machine %s: %s", m.ID, envelope.Error)
	}
```

with:

```go
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var envelope struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&envelope)
		msg := envelope.Error
		if msg == "" {
			msg = fmt.Sprintf("machine %s returned status %d", m.ID, resp.StatusCode)
		} else {
			msg = fmt.Sprintf("machine %s: %s", m.ID, msg)
		}
		return &RemoteError{Status: resp.StatusCode, Message: msg}
	}
```

Every existing caller of `RunDBRequest` (all of Phase 2's `dispatch()`/`PostTest` call sites) only ever calls `.Error()` on the returned error today, so this change is behavior-preserving for them — `*RemoteError` implements `error` identically to what `fmt.Errorf` produced before.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && go test ./internal/machineclient/ -v`
Expected: PASS for all tests in the package, including the two new ones.

- [ ] **Step 5: Add status classification to `dispatch()` and `runtimeRun()`**

In `backend/internal/handler/dbexec.go`, add near `mapDriverErr`:

```go
// statusForDBErr classifies a driver/commit error into its HTTP status.
// Every op defaults to 500; a rows-affected mismatch is a conflict (409) the
// client can retry after re-reading the row, not a server fault.
// errors.As also unwraps a forwarded runtime's *machineclient.RemoteError, so
// a remote commit's conflict is classified identically to a local one — this
// is the mechanism that survives the hub→runtime JSON hop, where a plain
// Go error's type would not.
func statusForDBErr(err error) int {
	if errors.Is(err, port.ErrRowsAffectedMismatch) {
		return http.StatusConflict
	}
	var remoteErr *machineclient.RemoteError
	if errors.As(err, &remoteErr) && remoteErr.Status == http.StatusConflict {
		return http.StatusConflict
	}
	return http.StatusInternalServerError
}
```

In `dispatch()`, replace both `writeErr(w, http.StatusInternalServerError, mapDriverErr(...))` calls that handle an operation failure (not the earlier `handleStoreErr`/`Conn` failure branches, which stay as-is) with `writeErr(w, statusForDBErr(err), mapDriverErr(...))`:

```go
	if remote {
		req.Descriptor = d
		if err := machineclient.RunDBRequest(ctx, machine, runtimePath, req, out); err != nil {
			writeErr(w, statusForDBErr(err), mapDriverErr(req.Op, err, d))
			return
		}
		writeJSON(w, http.StatusOK, out)
		return
	}

	conn, release, err := h.exec.Conn(ctx, connID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, mapDriverErr("connect", err, d))
		return
	}
	defer release()

	res, err := local(ctx, conn)
	if err != nil {
		writeErr(w, statusForDBErr(err), mapDriverErr(req.Op, err, d))
		return
	}
	writeJSON(w, http.StatusOK, res)
```

In `runtimeRun()`, apply the same change to its one failure branch (the runtime is where a local `CommitEdits` mismatch is actually detected, so it must report 409 for `machineclient.RunDBRequest` to have anything real to propagate):

```go
	res, err := runOp(ctx, conn, req)
	if err != nil {
		writeErr(w, statusForDBErr(err), mapDriverErr(req.Op, err, req.Descriptor))
		return
	}
	writeJSON(w, http.StatusOK, res)
```

Add `"devdeck/backend/internal/machineclient"` is already imported by this file; add `"errors"` if not already present (it is — `runOp`'s `default: return nil, errors.New(...)` already imports it).

- [ ] **Step 6: Write the failing handler test for the commit endpoint**

Add to `backend/internal/handler/dbexec_test.go`:

```go
func TestPostCommitAppliesAnUpdate(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t) // "assets" table, seeded with id/name rows per Phase 2's fixture
	req := httptest.NewRequest(http.MethodPost, "/api/db/connections/"+id+"/commit", strings.NewReader(`{
		"edits": [{
			"object": {"name": "assets", "kind": "table"},
			"kind": "update",
			"oldValues": {"id": 1, "name": "alpha"},
			"newValues": {"name": "renamed"}
		}]
	}`))
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	srv.dbExecH.PostCommit(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out port.CommitResult
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Results) != 1 || out.Results[0].RowsAffected != 1 {
		t.Fatalf("out = %+v, want one statement affecting 1 row", out)
	}
}

func TestPostCommitReturnsConflictOnRowsAffectedMismatch(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	req := httptest.NewRequest(http.MethodPost, "/api/db/connections/"+id+"/commit", strings.NewReader(`{
		"edits": [{
			"object": {"name": "assets", "kind": "table"},
			"kind": "update",
			"oldValues": {"id": 999, "name": "does-not-exist"},
			"newValues": {"name": "renamed"}
		}]
	}`))
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	srv.dbExecH.PostCommit(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", rec.Code, rec.Body.String())
	}
}
```

If `createSQLiteConnection`'s `assets` fixture's actual seeded row values differ from `{id: 1, name: "alpha"}` (check the fixture in `dbexec_test.go` — Phase 2's Task 10 plan referenced it as `assets` with two seeded rows but did not pin exact values in what this plan's research captured), adjust `oldValues` to match the fixture's real first row exactly — the commit's identity predicate must match the actual stored values or it legitimately gets a rows-affected mismatch for the wrong reason.

- [ ] **Step 7: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/handler/ -run TestPostCommit -v`
Expected: FAIL — `PostCommit` undefined.

- [ ] **Step 8: Implement `PostCommit`**

Add `Edits []port.RowEdit` to `runtimeDBRequest` in `backend/internal/handler/dbexec.go`:

```go
type runtimeDBRequest struct {
	Descriptor port.DSNDescriptor `json:"descriptor"`
	Op       string           `json:"op"`
	Tree     port.TreePath    `json:"tree"`
	Object   port.ObjectRef   `json:"object"`
	Filters  []port.Filter    `json:"filters"`
	Rows     port.RowsRequest `json:"rows"`
	Column   string           `json:"column"`
	Identity []port.Filter    `json:"identity"`
	SQL      string           `json:"sql"`
	Args     []any            `json:"args"`
	Edits    []port.RowEdit   `json:"edits"`
}
```

Add a case to `runOp`'s switch, after the `case "lob":` case:

```go
	case "commit":
		rw, ok := conn.(port.RowWriter)
		if !ok {
			return nil, errors.New("this engine does not support row writes")
		}
		return rw.CommitEdits(ctx, req.Edits)
```

Add `"commit"` to `RuntimeExec`'s allowed set:

```go
func (h *DBExecHandler) RuntimeExec(w http.ResponseWriter, r *http.Request) {
	h.runtimeRun(w, r, map[string]bool{"rows": true, "query": true, "count": true, "lob": true, "test": true, "commit": true})
}
```

Add to `backend/internal/handler/dbwrite.go`:

```go
// PostCommit applies a batch of pending grid edits as one transaction. Each
// edit's row identity is resolved fresh against the object's live schema —
// never trusted from the request — inside RowWriter.CommitEdits; a
// rows-affected mismatch rolls back the whole batch and this returns 409 via
// dispatch's statusForDBErr, so the client can re-read the row and retry
// rather than silently doing nothing or corrupting an unrelated row.
func (h *DBExecHandler) PostCommit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Edits []port.RowEdit `json:"edits"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if len(body.Edits) == 0 {
		writeErr(w, http.StatusBadRequest, "edits is required")
		return
	}
	var out port.CommitResult
	h.dispatch(w, r, runtimeExecPath, runtimeDBRequest{Op: "commit", Edits: body.Edits}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) {
			rw, ok := c.(port.RowWriter)
			if !ok {
				return nil, errors.New("this engine does not support row writes")
			}
			return rw.CommitEdits(ctx, body.Edits)
		})
}
```

Add `"errors"` to `dbwrite.go`'s imports.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd backend && go build ./... && go test ./internal/handler/... ./internal/machineclient/... -v`
Expected: build succeeds; all pass, including `TestPostCommitAppliesAnUpdate` (200) and `TestPostCommitReturnsConflictOnRowsAffectedMismatch` (409).

- [ ] **Step 10: Commit**

```bash
git add backend/internal/machineclient/dbexec.go backend/internal/machineclient/dbexec_test.go \
  backend/internal/handler/dbexec.go backend/internal/handler/dbwrite.go backend/internal/handler/dbexec_test.go
git commit -m "feat(db): add transactional row-commit endpoint with conflict detection"
```

---

### Task 9: DDL statement compiler, wired into all three drivers

**Files:**
- Create: `backend/internal/dbquery/ddl.go`
- Create: `backend/internal/dbquery/ddl_test.go`
- Modify: `backend/internal/dbdriver/sqlitedrv/driver.go`
- Modify: `backend/internal/dbdriver/pgdrv/driver.go`
- Modify: `backend/internal/dbdriver/mysqldrv/driver.go`
- Modify: `backend/internal/handler/dbexec.go`
- Modify: `backend/internal/handler/dbwrite.go`
- Modify: `backend/internal/handler/dbexec_test.go`

**Interfaces:**
- Consumes: `port.TablePlan`, `port.ColumnPlan`, `port.IndexPlan`, `port.DDLWriter` (Task 1); `dbdriver.ExecTxOnDB` (Task 4).
- Produces:
  - `dbquery.CompileTablePlan(p port.TablePlan, current []port.ColumnMeta, currentIdx []port.IndexMeta, caps port.DBCaps) ([]string, error)`
  - `dbquery.BuildTablePlan(ctx context.Context, introspector port.Introspector, p port.TablePlan, caps port.DBCaps) ([]string, error)`
  - `dbquery.ColumnPlansFromMeta([]port.ColumnMeta) []port.ColumnPlan`, `dbquery.IndexPlansFromMeta([]port.IndexMeta) []port.IndexPlan` — conversion helpers Task 10's PostgreSQL `ShowCreate` reuses.
  - `DDLWriter.Plan`/`Apply` on all three drivers, `DBExecHandler.PostDDLPreview`/`PostDDLApply`.

**Scope, stated explicitly:** "alter" only ever emits `ADD COLUMN`/`DROP COLUMN`/`CREATE INDEX`/`DROP INDEX`. A column present in both current and desired state is left untouched — changing a column's type or nullability is out of scope, since PostgreSQL's `ALTER COLUMN ... TYPE`, MySQL's `MODIFY COLUMN`, and SQLite's total lack of column-alteration syntax diverge too sharply to unify safely. Primary-key changes, foreign keys, check constraints, and view/materialized-view/function DDL are likewise out of scope. This mirrors how Phase 2's own self-review explicitly deferred scope rather than silently dropping it.

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/dbquery/ddl_test.go`:

```go
package dbquery

import (
	"strings"
	"testing"

	"devdeck/backend/internal/port"
)

func TestCompileTablePlanCreateEmitsColumnsAndPrimaryKey(t *testing.T) {
	p := port.TablePlan{
		Object: port.ObjectRef{Name: "widgets"},
		Kind:   "create",
		Columns: []port.ColumnPlan{
			{Name: "id", DataType: "integer", IsPrimaryKey: true},
			{Name: "name", DataType: "text", Nullable: true},
		},
	}
	stmts, err := CompileTablePlan(p, nil, nil, pgCaps)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(stmts) != 1 {
		t.Fatalf("stmts = %v, want exactly the CREATE TABLE", stmts)
	}
	if !strings.Contains(stmts[0], `"id" integer`) || !strings.Contains(stmts[0], "PRIMARY KEY") {
		t.Fatalf("missing column or primary key: %s", stmts[0])
	}
	if strings.Contains(stmts[0], `"name" text NOT NULL`) {
		t.Fatalf("nullable column incorrectly marked NOT NULL: %s", stmts[0])
	}
}

func TestCompileTablePlanCreateEmitsIndexesAfterTheTable(t *testing.T) {
	p := port.TablePlan{
		Object:  port.ObjectRef{Name: "widgets"},
		Kind:    "create",
		Columns: []port.ColumnPlan{{Name: "id", DataType: "integer", IsPrimaryKey: true}},
		Indexes: []port.IndexPlan{{Name: "widgets_name_idx", Columns: []string{"id"}, Unique: true}},
	}
	stmts, err := CompileTablePlan(p, nil, nil, pgCaps)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(stmts) != 2 {
		t.Fatalf("stmts = %v, want CREATE TABLE + CREATE INDEX", stmts)
	}
	if !strings.Contains(stmts[1], "UNIQUE INDEX") {
		t.Fatalf("index statement wrong: %s", stmts[1])
	}
}

func TestCompileTablePlanDropEmitsDropTable(t *testing.T) {
	stmts, err := CompileTablePlan(port.TablePlan{Object: port.ObjectRef{Name: "widgets"}, Kind: "drop"}, nil, nil, pgCaps)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(stmts) != 1 || !strings.HasPrefix(stmts[0], "DROP TABLE") {
		t.Fatalf("stmts = %v, want a single DROP TABLE", stmts)
	}
}

func TestCompileTablePlanAlterAddsAndDropsColumns(t *testing.T) {
	current := []port.ColumnMeta{{Name: "id", IsPrimaryKey: true}, {Name: "old_col"}}
	p := port.TablePlan{
		Object: port.ObjectRef{Name: "widgets"},
		Kind:   "alter",
		Columns: []port.ColumnPlan{
			{Name: "id", DataType: "integer", IsPrimaryKey: true}, // present in both: untouched
			{Name: "new_col", DataType: "text", Nullable: true},   // added
		},
	}
	stmts, err := CompileTablePlan(p, current, nil, pgCaps)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	var addedNew, droppedOld bool
	for _, s := range stmts {
		if strings.Contains(s, "ADD COLUMN") && strings.Contains(s, "new_col") {
			addedNew = true
		}
		if strings.Contains(s, "DROP COLUMN") && strings.Contains(s, "old_col") {
			droppedOld = true
		}
		if strings.Contains(s, `"id"`) {
			t.Fatalf("column present in both current and desired state must be left untouched: %s", s)
		}
	}
	if !addedNew || !droppedOld {
		t.Fatalf("stmts = %v, want an ADD COLUMN for new_col and a DROP COLUMN for old_col", stmts)
	}
}

func TestCompileTablePlanAlterDropsIndexOnMySQLWithOnClause(t *testing.T) {
	// MySQL indexes are namespaced under their table, not the database: DROP
	// INDEX requires ON <table>, unlike PostgreSQL/SQLite. Backtick quoting is
	// unique to MySQL among the three engines here.
	mysqlCaps := port.DBCaps{QuoteChar: "`"}
	current := []port.ColumnMeta{{Name: "id"}}
	currentIdx := []port.IndexMeta{{Name: "old_idx", Columns: []string{"id"}}}
	p := port.TablePlan{Object: port.ObjectRef{Name: "widgets"}, Kind: "alter", Columns: current2Plan(current)}
	stmts, err := CompileTablePlan(p, current, currentIdx, mysqlCaps)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	found := false
	for _, s := range stmts {
		if strings.Contains(s, "DROP INDEX") {
			found = true
			if !strings.Contains(s, "ON") {
				t.Fatalf("MySQL DROP INDEX missing the required ON <table> clause: %s", s)
			}
		}
	}
	if !found {
		t.Fatal("expected a DROP INDEX statement")
	}
}

func TestCompileTablePlanAlterDropsIndexOnPostgresWithoutOnClause(t *testing.T) {
	current := []port.ColumnMeta{{Name: "id"}}
	currentIdx := []port.IndexMeta{{Name: "old_idx", Columns: []string{"id"}}}
	p := port.TablePlan{Object: port.ObjectRef{Name: "widgets"}, Kind: "alter", Columns: current2Plan(current)}
	stmts, err := CompileTablePlan(p, current, currentIdx, pgCaps)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	for _, s := range stmts {
		if strings.Contains(s, "DROP INDEX") && strings.Contains(s, " ON ") {
			t.Fatalf("PostgreSQL DROP INDEX must not carry an ON clause: %s", s)
		}
	}
}

func TestCompileTablePlanAlterLeavesPrimaryKeyIndexAlone(t *testing.T) {
	current := []port.ColumnMeta{{Name: "id", IsPrimaryKey: true}}
	currentIdx := []port.IndexMeta{{Name: "widgets_pkey", Columns: []string{"id"}, Primary: true}}
	p := port.TablePlan{Object: port.ObjectRef{Name: "widgets"}, Kind: "alter", Columns: current2Plan(current)}
	stmts, err := CompileTablePlan(p, current, currentIdx, pgCaps)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	for _, s := range stmts {
		if strings.Contains(s, "widgets_pkey") {
			t.Fatalf("primary-key index must not be dropped by ALTER: %s", s)
		}
	}
}

func TestCompileTablePlanAlterWithNoChangesIsRejected(t *testing.T) {
	current := []port.ColumnMeta{{Name: "id", IsPrimaryKey: true}}
	p := port.TablePlan{Object: port.ObjectRef{Name: "widgets"}, Kind: "alter", Columns: current2Plan(current)}
	if _, err := CompileTablePlan(p, current, nil, pgCaps); err == nil {
		t.Fatal("no-op alter accepted, want rejection")
	}
}

// current2Plan is a small test-only helper mirroring ColumnPlansFromMeta
// without a primary-key filter, since these ALTER tests need the desired
// state to intentionally match the current one for the columns under test.
func current2Plan(cols []port.ColumnMeta) []port.ColumnPlan {
	out := make([]port.ColumnPlan, len(cols))
	for i, c := range cols {
		out[i] = port.ColumnPlan{Name: c.Name, DataType: c.DataType, Nullable: c.Nullable, IsPrimaryKey: c.IsPrimaryKey}
	}
	return out
}

func TestColumnPlansFromMetaRoundTripsFields(t *testing.T) {
	dflt := "0"
	cols := []port.ColumnMeta{{Name: "id", DataType: "integer", IsPrimaryKey: true, Default: &dflt}}
	plans := ColumnPlansFromMeta(cols)
	if len(plans) != 1 || plans[0].Name != "id" || plans[0].Default == nil || *plans[0].Default != "0" {
		t.Fatalf("plans = %+v", plans)
	}
}

func TestIndexPlansFromMetaExcludesPrimaryKeyIndex(t *testing.T) {
	idxs := []port.IndexMeta{
		{Name: "widgets_pkey", Columns: []string{"id"}, Primary: true},
		{Name: "widgets_name_idx", Columns: []string{"name"}, Unique: true},
	}
	plans := IndexPlansFromMeta(idxs)
	if len(plans) != 1 || plans[0].Name != "widgets_name_idx" {
		t.Fatalf("plans = %+v, want only the non-primary index", plans)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/dbquery/ -run 'TestCompileTablePlan|TestColumnPlansFromMeta|TestIndexPlansFromMeta' -v`
Expected: FAIL — the functions do not exist.

- [ ] **Step 3: Implement the DDL compiler**

Create `backend/internal/dbquery/ddl.go`:

```go
package dbquery

import (
	"context"
	"fmt"
	"strings"

	"devdeck/backend/internal/port"
)

// CompileTablePlan renders the SQL statements a TablePlan implies, given the
// object's current column and index state (nil/empty for "create" and
// "drop", which do not need it). It does not execute anything — callers use
// the result for a preview, then for execution via ExecTxOnDB.
//
// "alter" diffs desired Columns/Indexes against current: a column or index
// present in one but absent from the other is added or dropped. Present in
// both means untouched — see the package-level scope note in this plan's
// Task 9 for why column type/nullability changes are deliberately excluded.
func CompileTablePlan(p port.TablePlan, current []port.ColumnMeta, currentIdx []port.IndexMeta, caps port.DBCaps) ([]string, error) {
	switch p.Kind {
	case "create":
		return compileCreateTable(p, caps)
	case "drop":
		return compileDropTable(p, caps)
	case "alter":
		return compileAlterTable(p, current, currentIdx, caps)
	default:
		return nil, fmt.Errorf("unsupported DDL plan kind %q", p.Kind)
	}
}

// BuildTablePlan is the entry point drivers call: it introspects the object's
// current state when the plan is an "alter" (create/drop need none) and
// delegates to CompileTablePlan. introspector is whatever the caller already
// has open — a driver's own *conn, which satisfies port.Introspector.
func BuildTablePlan(ctx context.Context, introspector port.Introspector, p port.TablePlan, caps port.DBCaps) ([]string, error) {
	var current []port.ColumnMeta
	var currentIdx []port.IndexMeta
	if p.Kind == "alter" {
		var err error
		current, err = introspector.Columns(ctx, p.Object)
		if err != nil {
			return nil, err
		}
		currentIdx, err = introspector.Indexes(ctx, p.Object)
		if err != nil {
			return nil, err
		}
	}
	return CompileTablePlan(p, current, currentIdx, caps)
}

func compileCreateTable(p port.TablePlan, caps port.DBCaps) ([]string, error) {
	if len(p.Columns) == 0 {
		return nil, fmt.Errorf("create table %s: no columns", p.Object.Name)
	}
	target, err := QuoteObject(p.Object, caps)
	if err != nil {
		return nil, err
	}
	var defs []string
	var pkCols []string
	for _, c := range p.Columns {
		def, err := compileColumnDef(c, caps)
		if err != nil {
			return nil, err
		}
		defs = append(defs, def)
		if c.IsPrimaryKey {
			pkCols = append(pkCols, c.Name)
		}
	}
	if len(pkCols) > 0 {
		quoted := make([]string, len(pkCols))
		for i, name := range pkCols {
			q, err := QuoteIdent(name, caps.QuoteChar)
			if err != nil {
				return nil, err
			}
			quoted[i] = q
		}
		defs = append(defs, "PRIMARY KEY ("+strings.Join(quoted, ", ")+")")
	}
	stmts := []string{"CREATE TABLE " + target + " (" + strings.Join(defs, ", ") + ")"}
	idxStmts, err := compileCreateIndexes(p.Object, p.Indexes, caps)
	if err != nil {
		return nil, err
	}
	return append(stmts, idxStmts...), nil
}

func compileColumnDef(c port.ColumnPlan, caps port.DBCaps) (string, error) {
	if strings.TrimSpace(c.DataType) == "" {
		return "", fmt.Errorf("column %q has no data type", c.Name)
	}
	q, err := QuoteIdent(c.Name, caps.QuoteChar)
	if err != nil {
		return "", err
	}
	def := q + " " + c.DataType
	if !c.Nullable {
		def += " NOT NULL"
	}
	if c.Default != nil {
		def += " DEFAULT " + *c.Default
	}
	return def, nil
}

func compileDropTable(p port.TablePlan, caps port.DBCaps) ([]string, error) {
	target, err := QuoteObject(p.Object, caps)
	if err != nil {
		return nil, err
	}
	return []string{"DROP TABLE " + target}, nil
}

func compileCreateIndexes(obj port.ObjectRef, idxs []port.IndexPlan, caps port.DBCaps) ([]string, error) {
	var stmts []string
	for _, idx := range idxs {
		stmt, err := compileCreateIndex(obj, idx, caps)
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, stmt)
	}
	return stmts, nil
}

func compileCreateIndex(obj port.ObjectRef, idx port.IndexPlan, caps port.DBCaps) (string, error) {
	if len(idx.Columns) == 0 {
		return "", fmt.Errorf("index %q has no columns", idx.Name)
	}
	idxName, err := QuoteIdent(idx.Name, caps.QuoteChar)
	if err != nil {
		return "", err
	}
	target, err := QuoteObject(obj, caps)
	if err != nil {
		return "", err
	}
	cols := make([]string, len(idx.Columns))
	for i, c := range idx.Columns {
		q, err := QuoteIdent(c, caps.QuoteChar)
		if err != nil {
			return "", err
		}
		cols[i] = q
	}
	kw := "INDEX"
	if idx.Unique {
		kw = "UNIQUE INDEX"
	}
	return fmt.Sprintf("CREATE %s %s ON %s (%s)", kw, idxName, target, strings.Join(cols, ", ")), nil
}

func compileAlterTable(p port.TablePlan, current []port.ColumnMeta, currentIdx []port.IndexMeta, caps port.DBCaps) ([]string, error) {
	target, err := QuoteObject(p.Object, caps)
	if err != nil {
		return nil, err
	}
	var stmts []string

	currentCols := map[string]bool{}
	for _, c := range current {
		currentCols[c.Name] = true
	}
	desiredCols := map[string]bool{}
	for _, c := range p.Columns {
		desiredCols[c.Name] = true
	}
	for _, c := range p.Columns {
		if currentCols[c.Name] {
			continue // present in both: type/nullability changes are out of scope
		}
		def, err := compileColumnDef(c, caps)
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, "ALTER TABLE "+target+" ADD COLUMN "+def)
	}
	for _, c := range current {
		if desiredCols[c.Name] {
			continue
		}
		q, err := QuoteIdent(c.Name, caps.QuoteChar)
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, "ALTER TABLE "+target+" DROP COLUMN "+q)
	}

	currentIdxNames := map[string]bool{}
	for _, idx := range currentIdx {
		currentIdxNames[idx.Name] = true
	}
	desiredIdxNames := map[string]bool{}
	for _, idx := range p.Indexes {
		desiredIdxNames[idx.Name] = true
		if currentIdxNames[idx.Name] {
			continue
		}
		stmt, err := compileCreateIndex(p.Object, idx, caps)
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, stmt)
	}
	for _, idx := range currentIdx {
		if desiredIdxNames[idx.Name] || idx.Primary {
			continue // a primary-key index is dropped only by dropping the column/table
		}
		q, err := QuoteIdent(idx.Name, caps.QuoteChar)
		if err != nil {
			return nil, err
		}
		if caps.QuoteChar == "`" {
			// MySQL indexes are namespaced under their table, not the
			// database, so DROP INDEX requires ON <table>. Backtick quoting
			// is unique to MySQL among the three engines here; a fourth
			// engine must not add a second overloaded check on QuoteChar —
			// see dbquery.supportsILIKE's identical caution in filter.go.
			stmts = append(stmts, "DROP INDEX "+q+" ON "+target)
		} else {
			stmts = append(stmts, "DROP INDEX "+q)
		}
	}
	if len(stmts) == 0 {
		return nil, fmt.Errorf("alter table %s: no changes between current and desired state", p.Object.Name)
	}
	return stmts, nil
}

// ColumnPlansFromMeta converts introspected columns into a TablePlan's column
// list. Used by ShowCreate on engines with no native CREATE-statement query
// (PostgreSQL), reconstructing one from live metadata via CompileTablePlan
// instead of duplicating column-def rendering.
func ColumnPlansFromMeta(cols []port.ColumnMeta) []port.ColumnPlan {
	out := make([]port.ColumnPlan, len(cols))
	for i, c := range cols {
		out[i] = port.ColumnPlan{
			Name: c.Name, DataType: c.DataType, Nullable: c.Nullable,
			Default: c.Default, IsPrimaryKey: c.IsPrimaryKey,
		}
	}
	return out
}

// IndexPlansFromMeta converts introspected indexes, excluding the primary-key
// index — compileCreateTable already renders the primary key inline from
// each column's IsPrimaryKey flag, so including it again here would emit it
// twice.
func IndexPlansFromMeta(idxs []port.IndexMeta) []port.IndexPlan {
	var out []port.IndexPlan
	for _, idx := range idxs {
		if idx.Primary {
			continue
		}
		out = append(out, port.IndexPlan{Name: idx.Name, Columns: idx.Columns, Unique: idx.Unique})
	}
	return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/dbquery/ -v`
Expected: PASS for every test in the package.

- [ ] **Step 5: Wire `DDLWriter` into all three drivers**

In each of `backend/internal/dbdriver/sqlitedrv/driver.go`, `pgdrv/driver.go`, `mysqldrv/driver.go`, add (identical in all three, since the logic is entirely in `dbquery` and `dbdriver`):

```go
func (c *conn) Plan(ctx context.Context, p port.TablePlan) ([]string, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()
	return dbquery.BuildTablePlan(ctx, c, p, caps)
}

func (c *conn) Apply(ctx context.Context, p port.TablePlan) (port.CommitResult, error) {
	stmts, err := c.Plan(ctx, p)
	if err != nil {
		return port.CommitResult{}, err
	}
	txStmts := make([]port.Statement, len(stmts))
	for i, s := range stmts {
		txStmts[i] = port.Statement{SQL: s}
	}
	return dbdriver.ExecTxOnDB(ctx, c.db, txStmts)
}

var _ port.DDLWriter = (*conn)(nil)
```

Add one integration-style test per driver confirming a create→verify→drop round trip. For SQLite (in-memory, always runs):

```go
func TestApplyCreatesAndDropsATable(t *testing.T) {
	ctx := context.Background()
	conn := openTestConn(t) // from Task 4's helper
	_, err := conn.Apply(ctx, port.TablePlan{
		Object: port.ObjectRef{Name: "widgets"}, Kind: "create",
		Columns: []port.ColumnPlan{{Name: "id", DataType: "INTEGER", IsPrimaryKey: true}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	cols, err := conn.Columns(ctx, port.ObjectRef{Name: "widgets"})
	if err != nil || len(cols) != 1 {
		t.Fatalf("cols = %v, err = %v", cols, err)
	}
	if _, err := conn.Apply(ctx, port.TablePlan{Object: port.ObjectRef{Name: "widgets"}, Kind: "drop"}); err != nil {
		t.Fatalf("drop: %v", err)
	}
	if cols, _ := conn.Columns(ctx, port.ObjectRef{Name: "widgets"}); len(cols) != 0 {
		t.Fatalf("table still has columns after drop: %v", cols)
	}
}
```

For `pgdrv` and `mysqldrv`, add the analogous test gated behind `descriptorFromEnv(t)` / the `DEVDECK_TEST_MYSQL_DSN` skip pattern already established in Task 4's Steps 7–8, using each engine's native integer type (`INTEGER` for postgres, `INT` for MySQL) in place of SQLite's `INTEGER`.

- [ ] **Step 6: Run the driver test suites**

Run: `cd backend && go build ./internal/dbdriver/... && go test ./internal/dbdriver/... -v`
Expected: build clean; sqlite tests pass; postgres/mysql pass if configured, skip otherwise.

- [ ] **Step 7: Wire the DDL endpoints**

Add `TablePlan port.TablePlan` to `runtimeDBRequest` in `backend/internal/handler/dbexec.go`, alongside the `Edits` field added in Task 8:

```go
	Edits      []port.RowEdit   `json:"edits"`
	TablePlan  port.TablePlan   `json:"tablePlan"`
```

Add two cases to `runOp`'s switch, after the `case "commit":` case added in Task 8:

```go
	case "ddlPreview":
		dw, ok := conn.(port.DDLWriter)
		if !ok {
			return nil, errors.New("this engine does not support DDL")
		}
		stmts, err := dw.Plan(ctx, req.TablePlan)
		return ddlPreviewResponse{Statements: stmts}, err
	case "ddlApply":
		dw, ok := conn.(port.DDLWriter)
		if !ok {
			return nil, errors.New("this engine does not support DDL")
		}
		return dw.Apply(ctx, req.TablePlan)
```

Add `"ddlPreview"` to `RuntimeIntrospect`'s allowed set (it renders SQL text without executing anything, so it is side-effect-free like the other introspection ops) and `"ddlApply"` to `RuntimeExec`'s allowed set (it mutates the target database):

```go
func (h *DBExecHandler) RuntimeIntrospect(w http.ResponseWriter, r *http.Request) {
	h.runtimeRun(w, r, map[string]bool{"tree": true, "columns": true, "stats": true, "indexes": true, "ddlPreview": true})
}

func (h *DBExecHandler) RuntimeExec(w http.ResponseWriter, r *http.Request) {
	h.runtimeRun(w, r, map[string]bool{"rows": true, "query": true, "count": true, "lob": true, "test": true, "commit": true, "ddlApply": true})
}
```

Add to `backend/internal/handler/dbwrite.go`:

```go
type ddlPreviewResponse struct {
	Statements []string `json:"statements"`
}

// PostDDLPreview renders the exact statements a TablePlan implies without
// executing them — the "preview before apply" step the design calls for.
func (h *DBExecHandler) PostDDLPreview(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Plan port.TablePlan `json:"plan"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	var out ddlPreviewResponse
	h.dispatch(w, r, runtimeIntrospectPath, runtimeDBRequest{Op: "ddlPreview", TablePlan: body.Plan}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) {
			dw, ok := c.(port.DDLWriter)
			if !ok {
				return nil, errors.New("this engine does not support DDL")
			}
			stmts, err := dw.Plan(ctx, body.Plan)
			return ddlPreviewResponse{Statements: stmts}, err
		})
}

// PostDDLApply executes a TablePlan's statements inside one transaction.
func (h *DBExecHandler) PostDDLApply(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Plan port.TablePlan `json:"plan"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	var out port.CommitResult
	h.dispatch(w, r, runtimeExecPath, runtimeDBRequest{Op: "ddlApply", TablePlan: body.Plan}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) {
			dw, ok := c.(port.DDLWriter)
			if !ok {
				return nil, errors.New("this engine does not support DDL")
			}
			return dw.Apply(ctx, body.Plan)
		})
}
```

- [ ] **Step 8: Add handler tests and run the full suite**

Add to `backend/internal/handler/dbexec_test.go` a `TestPostDDLApplyCreatesATable` following the same direct-invocation pattern as Task 7's `TestPostIndexesReturnsIndexMetadata` (call `srv.dbExecH.PostDDLApply` directly with an `httptest.NewRecorder()`, since routing lands in Task 11), asserting a `201`-or-`200` response and that a follow-up `PostColumns` call sees the new table.

Run: `cd backend && go build ./... && go vet ./... && go test ./internal/dbquery/... ./internal/dbdriver/... ./internal/handler/... -v`
Expected: build and vet clean; all tests pass.

- [ ] **Step 9: Commit**

```bash
git add backend/internal/dbquery/ddl.go backend/internal/dbquery/ddl_test.go \
  backend/internal/dbdriver/sqlitedrv/driver.go backend/internal/dbdriver/sqlitedrv/driver_test.go \
  backend/internal/dbdriver/pgdrv/driver.go backend/internal/dbdriver/pgdrv/driver_test.go \
  backend/internal/dbdriver/mysqldrv/driver.go backend/internal/dbdriver/mysqldrv/driver_test.go \
  backend/internal/handler/dbexec.go backend/internal/handler/dbwrite.go backend/internal/handler/dbexec_test.go
git commit -m "feat(db): add DDL statement compiler and wire table/index writes into all three drivers"
```

---

### Task 10: `ShowCreate` for all three drivers

**Files:**
- Modify: `backend/internal/dbdriver/sqlitedrv/driver.go`
- Modify: `backend/internal/dbdriver/sqlitedrv/driver_test.go`
- Modify: `backend/internal/dbdriver/pgdrv/driver.go`
- Modify: `backend/internal/dbdriver/pgdrv/driver_test.go`
- Modify: `backend/internal/dbdriver/mysqldrv/driver.go`
- Modify: `backend/internal/dbdriver/mysqldrv/driver_test.go`
- Modify: `backend/internal/handler/dbexec.go`
- Modify: `backend/internal/handler/dbwrite.go`
- Modify: `backend/internal/handler/dbexec_test.go`

**Interfaces:**
- Consumes: `port.DDLReader` (Task 1); `dbquery.CompileTablePlan`, `ColumnPlansFromMeta`, `IndexPlansFromMeta` (Task 9, PostgreSQL only).
- Produces: `DDLReader.ShowCreate` on all three drivers, `DBExecHandler.PostShowCreate`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/internal/dbdriver/sqlitedrv/driver_test.go`:

```go
func TestShowCreateReturnsTheStoredDDLVerbatim(t *testing.T) {
	ctx := context.Background()
	conn := openTestConn(t)
	if _, err := conn.Exec(ctx, "CREATE TABLE widgets (id INTEGER PRIMARY KEY)", nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	ddl, err := conn.ShowCreate(ctx, port.ObjectRef{Name: "widgets", Kind: "table"})
	if err != nil {
		t.Fatalf("ShowCreate: %v", err)
	}
	if !strings.Contains(ddl, "CREATE TABLE") || !strings.Contains(ddl, "widgets") {
		t.Fatalf("ddl = %q", ddl)
	}
}

func TestShowCreateRejectsUnknownObject(t *testing.T) {
	conn := openTestConn(t)
	if _, err := conn.ShowCreate(context.Background(), port.ObjectRef{Name: "does_not_exist", Kind: "table"}); err == nil {
		t.Fatal("unknown table accepted, want rejection")
	}
}
```

Add to `backend/internal/dbdriver/pgdrv/driver_test.go`:

```go
func TestShowCreateReconstructsColumnsAndPrimaryKey(t *testing.T) {
	d := descriptorFromEnv(t)
	ctx := context.Background()
	c, err := New().Open(ctx, d)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer c.Close()
	conn := c.(*conn)

	conn.Exec(ctx, "DROP TABLE IF EXISTS phase3_showcreate_test", nil)
	if _, err := conn.Exec(ctx, "CREATE TABLE phase3_showcreate_test (id integer PRIMARY KEY, name text)", nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	defer conn.Exec(ctx, "DROP TABLE phase3_showcreate_test", nil)

	ddl, err := conn.ShowCreate(ctx, port.ObjectRef{Name: "phase3_showcreate_test", Kind: "table"})
	if err != nil {
		t.Fatalf("ShowCreate: %v", err)
	}
	if !strings.Contains(ddl, "CREATE TABLE") || !strings.Contains(ddl, "PRIMARY KEY") {
		t.Fatalf("ddl = %q", ddl)
	}
}
```

Add to `backend/internal/dbdriver/mysqldrv/driver_test.go` an analogous `TestShowCreateReturnsNativeDDL` gated behind the file's existing `DEVDECK_TEST_MYSQL_DSN` skip, asserting the native `SHOW CREATE TABLE` output contains `"CREATE TABLE"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/dbdriver/... -run TestShowCreate -v`
Expected: FAIL — `ShowCreate` undefined on all three.

- [ ] **Step 3: Implement `ShowCreate` for SQLite**

In `backend/internal/dbdriver/sqlitedrv/driver.go`, add:

```go
// ShowCreate returns SQLite's own stored DDL text verbatim — sqlite_master
// records exactly what CREATE TABLE/VIEW statement produced each object, so
// there is nothing to reconstruct.
func (c *conn) ShowCreate(ctx context.Context, obj port.ObjectRef) (string, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()
	var ddl sql.NullString
	err := c.db.QueryRowContext(ctx,
		`SELECT sql FROM sqlite_master WHERE type IN ('table','view') AND name = ?`, obj.Name).Scan(&ddl)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !ddl.Valid) {
		return "", fmt.Errorf("sqlite: no such table or view %q", obj.Name)
	}
	if err != nil {
		return "", err
	}
	return ddl.String, nil
}

var _ port.DDLReader = (*conn)(nil)
```

- [ ] **Step 4: Implement `ShowCreate` for MySQL**

In `backend/internal/dbdriver/mysqldrv/driver.go`, add:

```go
// ShowCreate uses MySQL's native SHOW CREATE, which answers tables and views
// with a different column shape each.
func (c *conn) ShowCreate(ctx context.Context, obj port.ObjectRef) (string, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()
	target, err := c.qualify(obj)
	if err != nil {
		return "", err
	}
	if obj.Kind == "view" {
		var name, ddl, clientCS, collation string
		if err := c.db.QueryRowContext(ctx, "SHOW CREATE VIEW "+target).
			Scan(&name, &ddl, &clientCS, &collation); err != nil {
			return "", err
		}
		return ddl, nil
	}
	var name, ddl string
	if err := c.db.QueryRowContext(ctx, "SHOW CREATE TABLE "+target).Scan(&name, &ddl); err != nil {
		return "", err
	}
	return ddl, nil
}

var _ port.DDLReader = (*conn)(nil)
```

- [ ] **Step 5: Implement `ShowCreate` for PostgreSQL**

PostgreSQL has no native `SHOW CREATE`. Tables are reconstructed by feeding introspected metadata back through `dbquery.CompileTablePlan`'s `"create"` path — reusing Task 9's compiler rather than duplicating column-def rendering; views and materialized views use the built-in `pg_get_viewdef`.

In `backend/internal/dbdriver/pgdrv/driver.go`, add:

```go
// ShowCreate has no native equivalent in PostgreSQL. For a table it
// reconstructs a CREATE TABLE from introspected columns and indexes via
// dbquery.CompileTablePlan — the same compiler Task 9's Plan/Apply use — so
// this is not a byte-perfect pg_dump: check constraints, foreign keys, and
// comments are not carried by ColumnMeta/IndexMeta and do not appear. Views
// and materialized views use the server's own pg_get_viewdef instead, which
// is exact.
func (c *conn) ShowCreate(ctx context.Context, obj port.ObjectRef) (string, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	target, err := dbquery.QuoteObject(qualified(obj), caps)
	if err != nil {
		return "", err
	}
	if obj.Kind == "view" || obj.Kind == "matview" {
		var def string
		if err := c.db.QueryRowContext(ctx, "SELECT pg_get_viewdef($1::regclass, true)", target).Scan(&def); err != nil {
			return "", err
		}
		kw := "VIEW"
		if obj.Kind == "matview" {
			kw = "MATERIALIZED VIEW"
		}
		return "CREATE " + kw + " " + target + " AS\n" + def, nil
	}

	cols, _, err := c.columnInfo(ctx, qualified(obj))
	if err != nil {
		return "", err
	}
	if len(cols) == 0 {
		return "", fmt.Errorf("postgres: no such relation %q", obj.Name)
	}
	idxs, err := c.Indexes(ctx, obj)
	if err != nil {
		return "", err
	}
	plan := port.TablePlan{
		Object:  qualified(obj),
		Kind:    "create",
		Columns: dbquery.ColumnPlansFromMeta(cols),
		Indexes: dbquery.IndexPlansFromMeta(idxs),
	}
	stmts, err := dbquery.CompileTablePlan(plan, nil, nil, caps)
	if err != nil {
		return "", err
	}
	return strings.Join(stmts, ";\n") + ";", nil
}

var _ port.DDLReader = (*conn)(nil)
```

- [ ] **Step 6: Run the driver tests**

Run: `cd backend && go build ./internal/dbdriver/... && go test ./internal/dbdriver/... -v`
Expected: build clean; sqlite `ShowCreate` tests pass; postgres/mysql pass if configured, skip otherwise.

- [ ] **Step 7: Wire the endpoint**

Add a case to `runOp`'s switch in `backend/internal/handler/dbexec.go`, after `case "indexes":`:

```go
	case "showCreate":
		dr, ok := conn.(port.DDLReader)
		if !ok {
			return nil, errors.New("this engine does not support DDL introspection")
		}
		ddl, err := dr.ShowCreate(ctx, req.Object)
		return showCreateResponse{DDL: ddl}, err
```

Add `"showCreate"` to `RuntimeIntrospect`'s allowed set:

```go
func (h *DBExecHandler) RuntimeIntrospect(w http.ResponseWriter, r *http.Request) {
	h.runtimeRun(w, r, map[string]bool{
		"tree": true, "columns": true, "stats": true, "indexes": true, "ddlPreview": true, "showCreate": true,
	})
}
```

Add to `backend/internal/handler/dbwrite.go`:

```go
type showCreateResponse struct {
	DDL string `json:"ddl"`
}

// PostShowCreate renders an object's CREATE statement — a read-only-tab
// convenience in Navicat-style tools, and the "generated DDL" tab the design
// calls for.
func (h *DBExecHandler) PostShowCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Object port.ObjectRef `json:"object"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	var out showCreateResponse
	h.dispatch(w, r, runtimeIntrospectPath, runtimeDBRequest{Op: "showCreate", Object: body.Object}, &out,
		func(ctx context.Context, c port.DBConn) (any, error) {
			dr, ok := c.(port.DDLReader)
			if !ok {
				return nil, errors.New("this engine does not support DDL introspection")
			}
			ddl, err := dr.ShowCreate(ctx, body.Object)
			return showCreateResponse{DDL: ddl}, err
		})
}
```

- [ ] **Step 8: Add a handler test and run the full suite**

Add to `backend/internal/handler/dbexec_test.go` a `TestPostShowCreateReturnsDDL` following Task 7's direct-invocation pattern (`srv.dbExecH.PostShowCreate` with `httptest.NewRecorder()`), asserting the response's `ddl` field contains `"CREATE TABLE"` for the `assets` fixture.

Run: `cd backend && go build ./... && go vet ./... && go test ./... -v 2>&1 | tail -60`
Expected: build and vet clean; every package passes (postgres/mysql-gated tests skip cleanly without their env vars).

- [ ] **Step 9: Commit**

```bash
git add backend/internal/dbdriver/sqlitedrv/driver.go backend/internal/dbdriver/sqlitedrv/driver_test.go \
  backend/internal/dbdriver/pgdrv/driver.go backend/internal/dbdriver/pgdrv/driver_test.go \
  backend/internal/dbdriver/mysqldrv/driver.go backend/internal/dbdriver/mysqldrv/driver_test.go \
  backend/internal/handler/dbexec.go backend/internal/handler/dbwrite.go backend/internal/handler/dbexec_test.go
git commit -m "feat(db): add ShowCreate DDL read endpoint"
```

---

### Task 11: Wire the new routes, verify the full suite, confirm audit coverage

**Files:**
- Modify: `backend/cmd/server/main.go`
- Modify: `backend/internal/handler/dbexec_test.go` (or `audit_test.go`, whichever already exercises `AccessLog`)

**Interfaces:**
- Consumes: `DBExecHandler.PostIndexes` (Task 7), `PostCommit` (Task 8), `PostDDLPreview`/`PostDDLApply` (Task 9), `PostShowCreate` (Task 10).

- [ ] **Step 1: Register the new hub routes**

In `backend/cmd/server/main.go`, inside the existing `if !isRuntime { ... }` block that registers the Phase 2 read-path routes, immediately after `mux.HandleFunc("POST /api/db/connections/{id}/query", dbExecH.PostQuery)`, add:

```go
		mux.HandleFunc("POST /api/db/connections/{id}/indexes", dbExecH.PostIndexes)
		mux.HandleFunc("POST /api/db/connections/{id}/commit", dbExecH.PostCommit)
		mux.HandleFunc("POST /api/db/connections/{id}/ddl/preview", dbExecH.PostDDLPreview)
		mux.HandleFunc("POST /api/db/connections/{id}/ddl/apply", dbExecH.PostDDLApply)
		mux.HandleFunc("POST /api/db/connections/{id}/show-create", dbExecH.PostShowCreate)
```

No runtime-side route changes are needed: `POST /api/db/introspect` and `POST /api/db/exec` already carry every op via the `allowed` maps Tasks 7–10 extended.

- [ ] **Step 2: Verify the full backend build**

Run: `cd backend && go build ./... && go vet ./... && go test ./... -v 2>&1 | tail -100`
Expected: build succeeds, `go vet` reports nothing, every test passes (postgres/mysql-gated tests skip without `DEVDECK_TEST_PG_DSN`/`DEVDECK_TEST_MYSQL_DSN`).

- [ ] **Step 3: Smoke-test the commit path against a real SQLite file**

```bash
sqlite3 /tmp/devdeck-phase3-demo.db "CREATE TABLE assets(id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO assets VALUES (1,'alpha'),(2,'beta');"
curl -s -X POST localhost:8989/api/db/connections -H 'Content-Type: application/json' \
  -d '{"name":"demo","engine":"sqlite","database":"/tmp/devdeck-phase3-demo.db","sslMode":""}'
# take the returned id
curl -s -X POST localhost:8989/api/db/connections/<id>/commit -H 'Content-Type: application/json' -d '{
  "edits": [{"object":{"name":"assets","kind":"table"},"kind":"update",
    "oldValues":{"id":1,"name":"alpha"},"newValues":{"name":"renamed"}}]
}'
curl -s -X POST localhost:8989/api/db/connections/<id>/rows \
  -d '{"object":{"name":"assets","kind":"table"},"sort":[{"column":"id"}],"limit":10}'
curl -s -X POST localhost:8989/api/db/connections/<id>/ddl/preview -H 'Content-Type: application/json' -d '{
  "plan": {"object":{"name":"widgets"},"kind":"create",
    "columns":[{"name":"id","dataType":"INTEGER","isPrimaryKey":true}]}
}'
curl -s -X POST localhost:8989/api/db/connections/<id>/show-create -d '{"object":{"name":"assets","kind":"table"}}'
```

Expected: the commit call returns `{"results":[{"rowsAffected":1,...}],...}`; the follow-up rows call shows `"renamed"` for id 1; the DDL preview returns `{"statements":["CREATE TABLE \"widgets\" (\"id\" INTEGER NOT NULL, PRIMARY KEY (\"id\"))"]}` (SQLite's `QuoteChar` is `"`); the show-create call returns the literal `CREATE TABLE assets (...)` text.

- [ ] **Step 4: Confirm the commit path is actually audited**

The design spec says to reuse `handler/audit.go`'s existing access-log middleware rather than build new audit plumbing — this step verifies that claim rather than taking it on faith. Add a test (in `backend/internal/handler/dbexec_test.go`, or alongside `audit_test.go`'s existing `AccessLog` tests if that file already has a harness for capturing formatted log output):

```go
func TestCommitRequestAndResponseAreAudited(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	// Wrap the handler chain the same way AccessLog does in main.go, capturing
	// its formatted output instead of writing to the real logger.
	var logged strings.Builder
	// ... construct AccessLog(handler, &logged) or equivalent per this
	// project's existing audit_test.go harness — see that file for the exact
	// constructor signature, since it is Phase-0 infrastructure this plan does
	// not modify.
	req := httptest.NewRequest(http.MethodPost, "/api/db/connections/"+id+"/commit", strings.NewReader(`{
		"edits": [{"object":{"name":"assets","kind":"table"},"kind":"update",
			"oldValues":{"id":1,"name":"alpha"},"newValues":{"name":"renamed"}}]
	}`))
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	srv.dbExecH.PostCommit(rec, req)

	out := logged.String()
	if !strings.Contains(out, "renamed") {
		t.Fatalf("commit's new value did not reach the audit log: %s", out)
	}
	if !strings.Contains(out, "rowsAffected") {
		t.Fatalf("commit's rowsAffected did not reach the audit log: %s", out)
	}
}
```

If this test finds that `redactJSON`'s pattern (`(?i)("[a-z0-9_]*(?:password|secret|token|otp|code)[a-z0-9_-]*"\s*:\s*)...`) accidentally strips a legitimate commit value — for example a table that happens to have a column literally named `password` — that is the existing, deliberate "over-matching is the safe direction" behavior documented in `audit.go`, not a bug this plan should fix. Confirm the test passes with the `assets`/`renamed` fixture, which does not trigger that pattern, and leave a comment noting the known interaction rather than changing `audit.go`.

- [ ] **Step 5: Final full-suite run and commit**

Run: `cd backend && go build ./... && go vet ./... && go test ./... -v 2>&1 | tail -100`
Expected: clean.

```bash
git add backend/cmd/server/main.go backend/internal/handler/dbexec_test.go
git commit -m "feat(db): wire row-write and DDL routes into the hub"
```

---

## Phase 3 Self-Review

Checked against `docs/superpowers/specs/2026-07-19-database-management-design.md` and Phase 2's own "Deferred to Phase 3" list.

**Spec/deferred-list coverage.** Row-identity ladder with the `ctid`-instability caveat → Tasks 1, 2, 3 (`buildIdentityPredicate`'s row-pointer-plus-all-old-values predicate). `rowsAffected` guard, rollback on mismatch → Task 4 (`ExecTxOnDB`), surfaced as HTTP 409 → Task 8. Pending-change commit as one transaction → Task 4 + Task 8. Audit ("reuse handler/audit.go") → confirmed rather than assumed, Task 11 Step 4. `ShowCreate` → Task 10. DDL plans (create/alter/drop table, indexes) → Task 9. Metadata-endpoint SSRF blocking (residual risk #3, and Phase 2's explicitly-deferred item) → Task 5. SSH tunnel dialing (declared complete in the design's "Execution & routing" section but found, on inspection, to be unwired in both network drivers) → Task 6.

**Two things this plan found that Phase 2 did not know about, now fixed rather than inherited silently.** First, `pgdrv`/`mysqldrv` reject any tunneled `DSNDescriptor` outright — `dbdriver.OpenTunnel` exists and is unit-tested, but nothing calls it. A connection configured with a tunnel would have failed at dial time on both network engines, forever, with no path forward until this plan's Task 6. Second, `Introspector.Indexes` was implemented by all three Phase 2 drivers but never exposed over HTTP — the row-identity ladder's level 2 (non-null unique index) would have had no data to resolve against without Task 7.

**Scope cuts, stated explicitly rather than silently dropped** (matching the project's own convention from Phase 2's self-review):
- ALTER only adds/drops columns and indexes; column type/nullability changes, primary-key changes, foreign keys, and check constraints are out of scope — the ALTER syntax for a type change diverges too sharply across three engines to unify safely in one compiler, and SQLite has none at all short of a full table rebuild.
- View, materialized-view, and function DDL writes are out of scope; `ShowCreate` reads them (via `pg_get_viewdef` on PostgreSQL, native `SHOW CREATE VIEW` on MySQL, `sqlite_master` on SQLite) but nothing in this plan creates or alters one.
- SQLite's `DROP COLUMN` has engine-side restrictions this plan does not pre-check (a column that is part of a `PRIMARY KEY`, is indexed, or carries a `CHECK`/`UNIQUE` constraint cannot be dropped) — an attempt hits a real SQLite error, mapped through `mapDriverErr` like any other driver error, rather than being silently allowed or pre-validated against every such case.
- `ValidateDBHost` checks at connection-save time only, matching `ValidateExecutorURL`'s save-time check but *not* its execution-time re-check — a save-time-only guard cannot stop a DNS-rebinding host that resolves to a public IP at save time and to a link-local one at connect time. This is consistent with the design's own "IsProduction is not a security boundary" framing (the operator holds full credentials either way) but is worth naming rather than presenting as complete SSRF protection.

**Known weakness carried forward, not fixed.** `dbquery.compileAlterTable`'s MySQL `DROP INDEX ... ON <table>` branch is a second place (after Task 2's Phase 2 `supportsILIKE`) where MySQL is identified by `caps.QuoteChar == "`"` alone. This works only because backtick quoting happens to be unique to MySQL among today's three engines — the same fragility Phase 2's self-review already flagged for the ILIKE downgrade, now duplicated rather than centralized. A fourth SQL engine must replace both call sites with a real `DBCaps.Dialect` field, not add a third overloaded check.

**Type consistency.** `port.RowEdit`, `Statement`, `CommitResult`, `RowIdentityPlan`, `TablePlan`, `ColumnPlan`, `IndexPlan` (Task 1) match their use in Tasks 2–10 exactly — `RowWriter.CommitEdits` and `DDLWriter.Plan`/`Apply` signatures are defined once in Task 1 and never redeclared. `dbquery.BuildCommitStatements`/`BuildTablePlan` both take `port.Introspector` (not a concrete driver type), which is what makes them unit-testable with the `fakeIntrospector` test double in Task 3 rather than requiring a live database — the same principle Phase 2 established by keeping `dbquery` free of any `*sql.DB` dependency.

**Convergence-file discipline.** Only Task 11 touches `backend/cmd/server/main.go`, as a single integration step, exactly mirroring how Phase 2 deferred all of its route wiring to its own final task. `backend/internal/handler/dbexec.go` is touched by Tasks 7, 8, 9, and 10 (each adding a `runtimeDBRequest` field and a `runOp` case) — the Global Constraints section calls this out explicitly for serialization if this plan is executed with `superpowers:subagent-driven-development`, since two agents editing the same switch statement concurrently would conflict. `domain/models.go`, `port/store.go`, and `go.mod` are untouched by every task in this plan.

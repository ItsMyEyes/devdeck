# Database Management — Phase 2: Drivers, Introspection & Read Execution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the registry from Phase 1 actually connect — capability-split driver interfaces, PostgreSQL/MySQL/SQLite drivers, object-tree introspection, table statistics, server-side filtering, keyset pagination, statement timeouts, and the hub→runtime execution hop. Everything needed to *read* a database; no writes.

**Architecture:** Drivers implement narrow interfaces (`Introspector`, `QueryRunner`, `StatsReader`) rather than one wide interface, so Mongo/Redis can attach later without inheriting inapplicable methods. Query shaping (filter compilation, keyset paging) is engine-agnostic code with per-engine identifier quoting, unit-tested without a live database. Execution routes through the hub, which decrypts credentials and either dials directly or forwards a descriptor to a runtime.

**Tech Stack:** Go 1.25, `jackc/pgx/v5` (new), `go-sql-driver/mysql` (new), `modernc.org/sqlite` (existing), `golang.org/x/crypto/ssh` (existing, for tunnels).

**Spec:** `docs/superpowers/specs/2026-07-19-database-management-design.md`
**Depends on:** Phase 1 (`docs/superpowers/plans/2026-07-19-database-management-phase1-foundation.md`) — all six tasks complete.

## Global Constraints

- All API responses use the `{"error":"message"}` envelope. (`CONTRACTS.md`)
- Go handlers use `handleStoreErr()`; raw driver errors never reach the client verbatim — map them, log the original server-side.
- All persistence goes through `port.Store`. The new `dbdriver` packages talk to *external* databases and are exempt from that rule; they must never touch DevDeck's own store.
- Store methods return `(domain.X, error)`. Partial updates use pointer fields.
- `domain/models.go` and `frontend/src/store/types.ts` stay in sync.
- Runtime routes are key-auth only; the `?key=` query param is accepted only on WebSocket upgrades. (`CONTRACTS.md`)
- Verify with `go vet ./...` and `go test ./...` in `backend/`.
- **Row cap:** 500 default, 5000 hard maximum. **Statement timeout:** 30s default.
- **No `COUNT(*)` on any read path.** Exact counts are an explicit user action only.

**Convergence files — do not edit these from parallel agents:** `backend/internal/port/store.go`, `backend/internal/domain/models.go`, `backend/cmd/server/main.go`, `backend/go.mod`. Tasks 1, 10, 11, and 13 touch them; serialize those.

---

### Task 1: Driver interfaces and capability model

**Files:**
- Create: `backend/internal/port/dbdriver.go`
- Create: `backend/internal/port/dbdriver_test.go`

**Interfaces:**
- Produces: everything below. Every later task in Phases 2 and 3 consumes these names, so they must not drift.

- [ ] **Step 1: Define the types**

Create `backend/internal/port/dbdriver.go`:

```go
package port

import "context"

// DBCaps describes what an engine can do. It is served to the frontend so the
// UI renders tree nodes and toolbar actions from capabilities rather than
// branching on engine name.
type DBCaps struct {
	// Schemas is true when the engine has a schema layer between database and
	// table (PostgreSQL). MySQL and SQLite address tables directly.
	Schemas bool `json:"schemas"`
	// MatViews is true when the engine has materialized views (PostgreSQL).
	MatViews bool `json:"matViews"`
	// Functions is true when stored functions/procedures are browsable.
	Functions bool `json:"functions"`
	// MultiDatabase is true when one connection can list and switch between
	// sibling databases (PostgreSQL, MySQL). SQLite is a single file.
	MultiDatabase bool `json:"multiDatabase"`
	// RowIdentifier names the engine's internal physical row address —
	// "ctid" (PostgreSQL), "rowid" (SQLite), or "" (MySQL exposes none).
	// Used as level 3 of the row-identity ladder in Phase 3.
	RowIdentifier string `json:"rowIdentifier"`
	// SizeStats is true when per-table byte sizes are available.
	SizeStats bool `json:"sizeStats"`
	// QuoteChar is the identifier quote character: '"' or '`'.
	QuoteChar string `json:"quoteChar"`
}

// ObjectRef addresses one database object. Schema is empty on engines
// without a schema layer.
type ObjectRef struct {
	Database string `json:"database"`
	Schema   string `json:"schema"`
	Name     string `json:"name"`
	Kind     string `json:"kind"` // "table" | "view" | "matview" | "function"
}

// TreePath addresses a level of the object tree for lazy expansion. An empty
// Database means the connection root.
type TreePath struct {
	Database string `json:"database"`
	Schema   string `json:"schema"`
	// Kind selects which child collection to list: "" (root), "databases",
	// "schemas", "tables", "views", "matviews", "functions".
	Kind string `json:"kind"`
}

// TreeNode is one entry in the object tree.
type TreeNode struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	HasChildren bool   `json:"hasChildren"`
}

// ColumnMeta describes one column.
type ColumnMeta struct {
	Name            string  `json:"name"`
	DataType        string  `json:"dataType"`
	Nullable        bool    `json:"nullable"`
	Default         *string `json:"default"`
	IsPrimaryKey    bool    `json:"isPrimaryKey"`
	OrdinalPosition int     `json:"ordinalPosition"`
	// IsLOB marks large-object columns (bytea, blob, large text). The grid
	// requests a size and placeholder for these instead of the value, so one
	// page of a table with binary columns cannot pull hundreds of megabytes.
	IsLOB bool `json:"isLob"`
	// Comparable is false for types whose equality comparison is unreliable or
	// invalid — float (rounding), json (MySQL errors on `WHERE json_col = ?`),
	// and blob. Phase 3's all-column fallback predicate refuses to use them.
	Comparable bool `json:"comparable"`
}

// IndexMeta describes one index.
type IndexMeta struct {
	Name     string   `json:"name"`
	Columns  []string `json:"columns"`
	Unique   bool     `json:"unique"`
	Primary  bool     `json:"primary"`
	Nullable bool     `json:"nullable"` // true if any indexed column is nullable
}

// TableStats carries estimated size information. Every field is an estimate;
// exact counting is a separate explicit action.
type TableStats struct {
	// EstRows is nil when unknown — PostgreSQL reports reltuples = -1 for a
	// never-analyzed table, and legacy versions report an ambiguous 0.
	// Rendering an unknown count as 0 would be a fabricated number.
	EstRows    *int64 `json:"estRows"`
	TotalBytes *int64 `json:"totalBytes"`
	IndexBytes *int64 `json:"indexBytes"`
	// Analyzed is false when the engine has no statistics for this table yet.
	Analyzed bool `json:"analyzed"`
}

// Filter is one predicate in a compiled WHERE clause.
type Filter struct {
	Column string `json:"column"`
	// Op is one of: eq ne lt gt le ge between in isnull isnotnull like ilike
	Op     string `json:"op"`
	Values []any  `json:"values"`
}

// SortKey is one ORDER BY term.
type SortKey struct {
	Column string `json:"column"`
	Desc   bool   `json:"desc"`
}

// RowsRequest asks for one page of a table.
type RowsRequest struct {
	Object  ObjectRef `json:"object"`
	Filters []Filter  `json:"filters"`
	Sort    []SortKey `json:"sort"`
	// Cursor is the previous page's last ordering tuple for keyset paging.
	// Nil requests the first page.
	Cursor []any `json:"cursor"`
	// Offset is used only when keyset paging is unavailable.
	Offset int `json:"offset"`
	Limit  int `json:"limit"`
	// GlobalSearch matches a substring against every non-LOB column cast to
	// text. This cannot use an index and is a sequential scan by construction.
	GlobalSearch string `json:"globalSearch"`
}

// ResultSet is one page of rows.
type ResultSet struct {
	Columns []ColumnMeta `json:"columns"`
	Rows    [][]any      `json:"rows"`
	// Truncated is true when the row cap was hit, so the UI can say "showing
	// first N rows" rather than implying the result is complete.
	Truncated bool `json:"truncated"`
	// NextCursor is the last row's ordering tuple, or nil when keyset paging
	// is not in use for this request.
	NextCursor []any `json:"nextCursor"`
	// UsedOffsetPaging reports that keyset paging was unavailable, so the UI
	// can explain why deep pages are slow.
	UsedOffsetPaging bool `json:"usedOffsetPaging"`
	ElapsedMS        int64 `json:"elapsedMs"`
}

// ExecResult is the outcome of a non-query statement.
type ExecResult struct {
	RowsAffected int64 `json:"rowsAffected"`
	ElapsedMS    int64 `json:"elapsedMs"`
}

// TunnelDescriptor carries resolved SSH credentials for a tunneled connection.
// HostKeyFingerprint is mandatory verification data, never optional: an
// unverified tunnel creates the man-in-the-middle exposure it exists to prevent.
type TunnelDescriptor struct {
	Host               string `json:"host"`
	Port               int    `json:"port"`
	Username           string `json:"username"`
	AuthType           string `json:"authType"`
	Password           string `json:"password,omitempty"`
	PrivateKey         string `json:"privateKey,omitempty"`
	Passphrase         string `json:"passphrase,omitempty"`
	HostKeyFingerprint string `json:"hostKeyFingerprint"`
}

// DSNDescriptor is everything needed to dial one database, including
// decrypted credentials. It is assembled on the hub and, for runtime-executed
// connections, forwarded to the runtime over an authenticated tailnet/TLS hop.
// It must never be logged and never serialized toward a browser.
type DSNDescriptor struct {
	ConnectionID string `json:"connectionId"`
	Engine       string `json:"engine"`
	Host         string `json:"host"`
	Port         int    `json:"port"`
	Username     string `json:"username"`
	Password     string `json:"password,omitempty"`
	Database     string `json:"database"`
	SSLMode      string `json:"sslMode"`

	CACert     string `json:"caCert,omitempty"`
	ClientCert string `json:"clientCert,omitempty"`
	ClientKey  string `json:"clientKey,omitempty"`
	// ServerCertFingerprint, when set, pins the server certificate (TOFU).
	ServerCertFingerprint string `json:"serverCertFingerprint,omitempty"`

	Tunnel *TunnelDescriptor `json:"tunnel,omitempty"`
}

// DBConn is one open connection to an external database.
type DBConn interface {
	Introspector
	QueryRunner
	StatsReader
	Close() error
}

type DBDriver interface {
	Open(ctx context.Context, d DSNDescriptor) (DBConn, error)
	Capabilities() DBCaps
}

type Introspector interface {
	Tree(ctx context.Context, p TreePath) ([]TreeNode, error)
	Columns(ctx context.Context, obj ObjectRef) ([]ColumnMeta, error)
	Indexes(ctx context.Context, obj ObjectRef) ([]IndexMeta, error)
}

type QueryRunner interface {
	// Rows returns one page of a table, applying filters, sort, and paging.
	Rows(ctx context.Context, r RowsRequest) (ResultSet, error)
	// Query runs arbitrary read SQL from the SQL editor.
	Query(ctx context.Context, sqlText string, args []any) (ResultSet, error)
	// Exec runs a non-query statement.
	Exec(ctx context.Context, sqlText string, args []any) (ExecResult, error)
	// CountExact runs COUNT(*) — an explicit user action only, never on a
	// read path.
	CountExact(ctx context.Context, obj ObjectRef, filters []Filter) (int64, error)
	// LOBValue fetches one large-object cell deferred by Rows.
	LOBValue(ctx context.Context, obj ObjectRef, column string, identity []Filter) ([]byte, error)
}

type StatsReader interface {
	Stats(ctx context.Context, obj ObjectRef) (TableStats, error)
}
```

- [ ] **Step 2: Write the capability registry test**

Create `backend/internal/port/dbdriver_test.go`:

```go
package port

import "testing"

// These assertions pin the per-engine facts the query builders rely on.
// Changing them silently would break paging and the Phase 3 identity ladder.
func TestCapsMatrixIsStable(t *testing.T) {
	cases := []struct {
		engine string
		caps   DBCaps
	}{
		{"postgres", DBCaps{Schemas: true, MatViews: true, Functions: true, MultiDatabase: true, RowIdentifier: "ctid", SizeStats: true, QuoteChar: `"`}},
		{"mysql", DBCaps{Schemas: false, MatViews: false, Functions: true, MultiDatabase: true, RowIdentifier: "", SizeStats: true, QuoteChar: "`"}},
		{"sqlite", DBCaps{Schemas: false, MatViews: false, Functions: false, MultiDatabase: false, RowIdentifier: "rowid", SizeStats: false, QuoteChar: `"`}},
	}
	for _, c := range cases {
		if c.caps.QuoteChar == "" {
			t.Errorf("%s: QuoteChar must not be empty", c.engine)
		}
	}
}
```

This is a placeholder assertion until the drivers exist; Tasks 4, 7, and 8 replace its body with real `Capabilities()` calls against each driver.

- [ ] **Step 3: Verify it compiles**

Run: `cd backend && go build ./internal/port/ && go test ./internal/port/ -v`
Expected: build succeeds, test passes.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/port/dbdriver.go backend/internal/port/dbdriver_test.go
git commit -m "feat(db): add capability-split driver interfaces and shared types"
```

---

### Task 2: Identifier quoting and filter compilation

**Files:**
- Create: `backend/internal/dbquery/ident.go`
- Create: `backend/internal/dbquery/filter.go`
- Create: `backend/internal/dbquery/filter_test.go`

This is the security-critical unit. Column names cannot be bound as parameters, so they are validated against the introspected column list and quoted — never interpolated from raw input.

**Interfaces:**
- Consumes: `port.Filter`, `port.ColumnMeta`, `port.DBCaps` (Task 1).
- Produces:
  - `dbquery.QuoteIdent(name, quoteChar string) (string, error)`
  - `dbquery.QuoteObject(obj port.ObjectRef, caps port.DBCaps) (string, error)`
  - `dbquery.CompileFilters(filters []port.Filter, cols []port.ColumnMeta, caps port.DBCaps, placeholder Placeholder) (string, []any, error)`
  - `dbquery.CompileGlobalSearch(term string, cols []port.ColumnMeta, caps port.DBCaps, placeholder Placeholder) (string, []any, error)`
  - `dbquery.Placeholder` — `func(n int) string`; `dbquery.DollarPlaceholder` (PostgreSQL `$1`), `dbquery.QuestionPlaceholder` (MySQL/SQLite `?`)

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/dbquery/filter_test.go`:

```go
package dbquery

import (
	"strings"
	"testing"

	"devdeck/backend/internal/port"
)

var testCols = []port.ColumnMeta{
	{Name: "id", DataType: "integer", IsPrimaryKey: true, Comparable: true},
	{Name: "name", DataType: "text", Comparable: true, Nullable: true},
	{Name: "score", DataType: "double precision", Comparable: false},
	{Name: "payload", DataType: "jsonb", Comparable: false},
	{Name: "blob_col", DataType: "bytea", Comparable: false, IsLOB: true},
}

var pgCaps = port.DBCaps{QuoteChar: `"`, Schemas: true}

func TestCompileFiltersBindsValuesAsParameters(t *testing.T) {
	f := []port.Filter{{Column: "name", Op: "eq", Values: []any{"o'brien"}}}
	sql, args, err := CompileFilters(f, testCols, pgCaps, DollarPlaceholder)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if strings.Contains(sql, "o'brien") {
		t.Fatalf("value interpolated into SQL instead of bound: %s", sql)
	}
	if len(args) != 1 || args[0] != "o'brien" {
		t.Fatalf("args = %v, want the value bound", args)
	}
	if !strings.Contains(sql, `"name"`) {
		t.Fatalf("column not quoted: %s", sql)
	}
}

func TestCompileFiltersRejectsUnknownColumn(t *testing.T) {
	// A column not in the introspected list must be rejected outright rather
	// than quoted through — this is the injection boundary.
	f := []port.Filter{{Column: "id; DROP TABLE users", Op: "eq", Values: []any{1}}}
	if _, _, err := CompileFilters(f, testCols, pgCaps, DollarPlaceholder); err == nil {
		t.Fatal("unknown column accepted, want rejection")
	}
}

func TestCompileFiltersRejectsUnknownOperator(t *testing.T) {
	f := []port.Filter{{Column: "id", Op: "; DELETE FROM", Values: []any{1}}}
	if _, _, err := CompileFilters(f, testCols, pgCaps, DollarPlaceholder); err == nil {
		t.Fatal("unknown operator accepted, want rejection")
	}
}

func TestCompileFiltersNumbersPlaceholdersSequentially(t *testing.T) {
	f := []port.Filter{
		{Column: "id", Op: "gt", Values: []any{10}},
		{Column: "name", Op: "like", Values: []any{"%a%"}},
	}
	sql, args, err := CompileFilters(f, testCols, pgCaps, DollarPlaceholder)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.Contains(sql, "$1") || !strings.Contains(sql, "$2") {
		t.Fatalf("placeholders not numbered sequentially: %s", sql)
	}
	if len(args) != 2 {
		t.Fatalf("args = %v, want 2", args)
	}
}

func TestCompileFiltersBetweenTakesTwoValues(t *testing.T) {
	ok := []port.Filter{{Column: "id", Op: "between", Values: []any{1, 9}}}
	if _, args, err := CompileFilters(ok, testCols, pgCaps, DollarPlaceholder); err != nil || len(args) != 2 {
		t.Fatalf("between: args=%v err=%v", args, err)
	}
	bad := []port.Filter{{Column: "id", Op: "between", Values: []any{1}}}
	if _, _, err := CompileFilters(bad, testCols, pgCaps, DollarPlaceholder); err == nil {
		t.Fatal("between with one value accepted, want rejection")
	}
}

func TestCompileFiltersInExpandsPlaceholders(t *testing.T) {
	f := []port.Filter{{Column: "id", Op: "in", Values: []any{1, 2, 3}}}
	sql, args, err := CompileFilters(f, testCols, pgCaps, DollarPlaceholder)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(args) != 3 {
		t.Fatalf("args = %v, want 3", args)
	}
	if strings.Count(sql, "$") != 3 {
		t.Fatalf("expected 3 placeholders: %s", sql)
	}
	if !strings.Contains(strings.ToUpper(sql), "IN") {
		t.Fatalf("no IN clause: %s", sql)
	}
}

func TestCompileFiltersInRejectsEmptyList(t *testing.T) {
	// `IN ()` is a syntax error on every engine. Reject with a clear message
	// rather than emitting broken SQL.
	f := []port.Filter{{Column: "id", Op: "in", Values: []any{}}}
	if _, _, err := CompileFilters(f, testCols, pgCaps, DollarPlaceholder); err == nil {
		t.Fatal("empty IN list accepted, want rejection")
	}
}

func TestCompileFiltersNullOpsTakeNoValues(t *testing.T) {
	f := []port.Filter{{Column: "name", Op: "isnull"}}
	sql, args, err := CompileFilters(f, testCols, pgCaps, DollarPlaceholder)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(args) != 0 {
		t.Fatalf("args = %v, want none", args)
	}
	if !strings.Contains(strings.ToUpper(sql), "IS NULL") {
		t.Fatalf("expected IS NULL: %s", sql)
	}
}

func TestCompileFiltersEmptyReturnsEmptyClause(t *testing.T) {
	sql, args, err := CompileFilters(nil, testCols, pgCaps, DollarPlaceholder)
	if err != nil || sql != "" || len(args) != 0 {
		t.Fatalf("empty filters: sql=%q args=%v err=%v", sql, args, err)
	}
}

func TestCompileGlobalSearchSkipsLOBColumns(t *testing.T) {
	sql, args, err := CompileGlobalSearch("abc", testCols, pgCaps, DollarPlaceholder)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if strings.Contains(sql, "blob_col") {
		t.Fatalf("LOB column included in global search: %s", sql)
	}
	if len(args) == 0 {
		t.Fatal("expected the search term to be bound")
	}
	for _, a := range args {
		if s, ok := a.(string); ok && !strings.Contains(s, "abc") {
			t.Fatalf("unexpected bound value %q", s)
		}
	}
}

func TestCompileFiltersDowngradesILIKEOnSQLite(t *testing.T) {
	// SQLite quotes with a double quote just like PostgreSQL but has no ILIKE
	// operator. A downgrade guarded only on QuoteChar would leave ILIKE in
	// place here and fail at runtime.
	sqliteCaps := port.DBCaps{QuoteChar: `"`, Schemas: false}
	f := []port.Filter{{Column: "name", Op: "ilike", Values: []any{"%a%"}}}
	sql, _, err := CompileFilters(f, testCols, sqliteCaps, QuestionPlaceholder)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if strings.Contains(strings.ToUpper(sql), "ILIKE") {
		t.Fatalf("ILIKE not downgraded for SQLite: %s", sql)
	}
	if !strings.Contains(strings.ToUpper(sql), "LIKE") {
		t.Fatalf("expected LIKE: %s", sql)
	}
}

func TestCompileFiltersKeepsILIKEOnPostgres(t *testing.T) {
	f := []port.Filter{{Column: "name", Op: "ilike", Values: []any{"%a%"}}}
	sql, _, err := CompileFilters(f, testCols, pgCaps, DollarPlaceholder)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.Contains(strings.ToUpper(sql), "ILIKE") {
		t.Fatalf("ILIKE lost on PostgreSQL: %s", sql)
	}
}

func TestCompileGlobalSearchMatchesFilterDialectChoice(t *testing.T) {
	// Both call sites must agree on whether the engine has ILIKE; they drifted
	// apart once already.
	sqliteCaps := port.DBCaps{QuoteChar: `"`, Schemas: false}
	sql, _, err := CompileGlobalSearch("abc", testCols, sqliteCaps, QuestionPlaceholder)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if strings.Contains(strings.ToUpper(sql), "ILIKE") {
		t.Fatalf("global search used ILIKE on SQLite: %s", sql)
	}
}

func TestQuoteIdentRejectsEmbeddedQuote(t *testing.T) {
	// Defense in depth: even though callers validate against the column list,
	// quoting must not be fooled by an embedded quote character.
	if _, err := QuoteIdent(`na"me`, `"`); err == nil {
		t.Fatal("identifier with embedded quote accepted, want rejection")
	}
}

func TestQuoteIdentRejectsEmpty(t *testing.T) {
	if _, err := QuoteIdent("", `"`); err == nil {
		t.Fatal("empty identifier accepted, want rejection")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/dbquery/ -v`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Implement identifier quoting**

Create `backend/internal/dbquery/ident.go`:

```go
// Package dbquery builds SQL fragments for the database module. It is
// engine-agnostic: per-engine differences arrive as port.DBCaps and a
// Placeholder function. Nothing here talks to a database.
package dbquery

import (
	"fmt"
	"strings"

	"devdeck/backend/internal/port"
)

// Placeholder renders the nth bind placeholder (1-based).
type Placeholder func(n int) string

// DollarPlaceholder renders PostgreSQL's $1, $2, … numbering.
func DollarPlaceholder(n int) string { return fmt.Sprintf("$%d", n) }

// QuestionPlaceholder renders the positional ? used by MySQL and SQLite.
func QuestionPlaceholder(int) string { return "?" }

// QuoteIdent wraps an identifier in the engine's quote character.
//
// Identifiers can never be bound as parameters, so this is the last line of
// defense. Callers must already have validated the name against an
// introspected list; an embedded quote character here means either a bug in
// that validation or a genuinely hostile name, and both are rejected rather
// than escaped.
func QuoteIdent(name, quoteChar string) (string, error) {
	if name == "" {
		return "", fmt.Errorf("empty identifier")
	}
	if quoteChar == "" {
		return "", fmt.Errorf("no quote character configured for engine")
	}
	if strings.Contains(name, quoteChar) {
		return "", fmt.Errorf("identifier %q contains the quote character", name)
	}
	if strings.ContainsRune(name, 0) {
		return "", fmt.Errorf("identifier contains a null byte")
	}
	return quoteChar + name + quoteChar, nil
}

// QuoteObject renders a fully qualified object name, including the schema on
// engines that have one.
func QuoteObject(obj port.ObjectRef, caps port.DBCaps) (string, error) {
	name, err := QuoteIdent(obj.Name, caps.QuoteChar)
	if err != nil {
		return "", err
	}
	if caps.Schemas && obj.Schema != "" {
		schema, err := QuoteIdent(obj.Schema, caps.QuoteChar)
		if err != nil {
			return "", err
		}
		return schema + "." + name, nil
	}
	return name, nil
}
```

- [ ] **Step 4: Implement filter compilation**

Create `backend/internal/dbquery/filter.go`:

```go
package dbquery

import (
	"fmt"
	"strings"

	"devdeck/backend/internal/port"
)

// filterOps maps an operator token to its SQL form and expected value count.
// arity -1 means variadic (IN). Anything not in this map is rejected: the
// operator is never taken from user input verbatim.
var filterOps = map[string]struct {
	sql   string
	arity int
}{
	"eq":        {"=", 1},
	"ne":        {"<>", 1},
	"lt":        {"<", 1},
	"gt":        {">", 1},
	"le":        {"<=", 1},
	"ge":        {">=", 1},
	"like":      {"LIKE", 1},
	"ilike":     {"ILIKE", 1},
	"between":   {"BETWEEN", 2},
	"in":        {"IN", -1},
	"isnull":    {"IS NULL", 0},
	"isnotnull": {"IS NOT NULL", 0},
}

func columnByName(cols []port.ColumnMeta, name string) (port.ColumnMeta, bool) {
	for _, c := range cols {
		if c.Name == name {
			return c, true
		}
	}
	return port.ColumnMeta{}, false
}

// CompileFilters turns filters into a WHERE fragment (without the WHERE
// keyword) plus bound arguments. An empty filter list yields an empty string.
//
// Column names are matched against cols — the introspected column list — and
// rejected if absent. Values are always bound, never rendered into the SQL.
func CompileFilters(filters []port.Filter, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (string, []any, error) {
	if len(filters) == 0 {
		return "", nil, nil
	}
	var parts []string
	var args []any
	for _, f := range filters {
		col, ok := columnByName(cols, f.Column)
		if !ok {
			return "", nil, fmt.Errorf("unknown column %q", f.Column)
		}
		op, ok := filterOps[f.Op]
		if !ok {
			return "", nil, fmt.Errorf("unsupported operator %q", f.Op)
		}
		quoted, err := QuoteIdent(col.Name, caps.QuoteChar)
		if err != nil {
			return "", nil, err
		}

		switch f.Op {
		case "isnull", "isnotnull":
			if len(f.Values) != 0 {
				return "", nil, fmt.Errorf("operator %q takes no values", f.Op)
			}
			parts = append(parts, quoted+" "+op.sql)

		case "between":
			if len(f.Values) != 2 {
				return "", nil, fmt.Errorf("operator between requires exactly 2 values, got %d", len(f.Values))
			}
			p1 := ph(len(args) + 1)
			p2 := ph(len(args) + 2)
			args = append(args, f.Values[0], f.Values[1])
			parts = append(parts, fmt.Sprintf("%s BETWEEN %s AND %s", quoted, p1, p2))

		case "in":
			if len(f.Values) == 0 {
				return "", nil, fmt.Errorf("operator in requires at least one value")
			}
			ps := make([]string, len(f.Values))
			for i, v := range f.Values {
				ps[i] = ph(len(args) + 1)
				args = append(args, v)
			}
			parts = append(parts, fmt.Sprintf("%s IN (%s)", quoted, strings.Join(ps, ", ")))

		default:
			if len(f.Values) != 1 {
				return "", nil, fmt.Errorf("operator %q requires exactly 1 value, got %d", f.Op, len(f.Values))
			}
			sqlOp := op.sql
			// ILIKE is PostgreSQL-only. MySQL's LIKE is already
			// case-insensitive under its default collations, and SQLite's
			// LIKE is case-insensitive for ASCII.
			if sqlOp == "ILIKE" && !supportsILIKE(caps) {
				sqlOp = "LIKE"
			}
			p := ph(len(args) + 1)
			args = append(args, f.Values[0])
			parts = append(parts, fmt.Sprintf("%s %s %s", quoted, sqlOp, p))
		}
	}
	return strings.Join(parts, " AND "), args, nil
}

// CompileGlobalSearch builds an OR of substring matches across every
// non-LOB column, cast to text.
//
// This cannot use an index and is a sequential scan by construction. The UI
// labels it as slow; it is not offered as ordinary search.
func CompileGlobalSearch(term string, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (string, []any, error) {
	if term == "" {
		return "", nil, nil
	}
	var parts []string
	var args []any
	for _, c := range cols {
		if c.IsLOB {
			continue // binary data has no useful text form
		}
		quoted, err := QuoteIdent(c.Name, caps.QuoteChar)
		if err != nil {
			return "", nil, err
		}
		op := "LIKE"
		if supportsILIKE(caps) {
			op = "ILIKE"
		}
		p := ph(len(args) + 1)
		args = append(args, "%"+term+"%")
		parts = append(parts, fmt.Sprintf("CAST(%s AS %s) %s %s", quoted, textType(caps), op, p))
	}
	if len(parts) == 0 {
		return "", nil, fmt.Errorf("no searchable columns")
	}
	return "(" + strings.Join(parts, " OR ") + ")", args, nil
}

// supportsILIKE reports whether the engine has the ILIKE operator.
//
// PostgreSQL is the only Piece-A engine that does. Both PostgreSQL and SQLite
// quote with a double quote, so QuoteChar ALONE cannot tell them apart —
// checking only the quote character would emit `ILIKE` against SQLite, which
// has no such operator and fails at runtime. Schemas is what distinguishes
// them today.
//
// This is a two-signal heuristic standing in for a real dialect tag. Both
// call sites must use this one function; duplicating the condition inline is
// how the two branches drifted apart in the first place.
func supportsILIKE(caps port.DBCaps) bool {
	return caps.QuoteChar == `"` && caps.Schemas
}

// textType is the engine's cast-to-text type name.
func textType(caps port.DBCaps) string {
	if caps.QuoteChar == "`" {
		return "CHAR" // MySQL: CAST(x AS TEXT) is invalid
	}
	return "TEXT"
}
```

The `supportsILIKE` / `textType` heuristics infer the dialect from capability
flags rather than naming it. That is already fragile for the three Piece-A
engines — PostgreSQL and SQLite share a quote character, so quote character
alone is not a dialect. Adding a fourth engine must replace both with an
explicit `DBCaps.Dialect` field instead of adding a third signal.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/dbquery/ -v`
Expected: PASS for all 12 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/dbquery/
git commit -m "feat(db): add identifier quoting and parameterized filter compilation"
```

---

### Task 3: Keyset pagination builder

**Files:**
- Create: `backend/internal/dbquery/paging.go`
- Create: `backend/internal/dbquery/paging_test.go`

**Interfaces:**
- Consumes: `port.SortKey`, `port.ColumnMeta`, `port.DBCaps`, `dbquery.Placeholder`.
- Produces:
  - `dbquery.PagePlan` struct: `{OrderBy string, Where string, Args []any, UseOffset bool, Reason string, KeyColumns []string}`
  - `dbquery.BuildPagePlan(sort []port.SortKey, identity []string, cols []port.ColumnMeta, cursor []any, caps port.DBCaps, ph Placeholder, argOffset int) (PagePlan, error)`

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/dbquery/paging_test.go`:

```go
package dbquery

import (
	"strings"
	"testing"

	"devdeck/backend/internal/port"
)

var pageCols = []port.ColumnMeta{
	{Name: "id", DataType: "integer", IsPrimaryKey: true, Nullable: false},
	{Name: "created_at", DataType: "timestamp", Nullable: false},
	{Name: "nickname", DataType: "text", Nullable: true},
}

func TestPagePlanAppendsIdentityAsTiebreaker(t *testing.T) {
	// Without a deterministic total order, keyset paging silently repeats and
	// skips rows whenever the sort column has duplicate values.
	plan, err := BuildPagePlan(
		[]port.SortKey{{Column: "created_at"}},
		[]string{"id"}, pageCols, nil, pgCaps, DollarPlaceholder, 0,
	)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.Contains(plan.OrderBy, `"id"`) {
		t.Fatalf("identity column missing from ORDER BY: %s", plan.OrderBy)
	}
	if plan.UseOffset {
		t.Fatal("expected keyset paging with a non-null sort column")
	}
}

func TestPagePlanFirstPageHasNoCursorPredicate(t *testing.T) {
	plan, _ := BuildPagePlan(
		[]port.SortKey{{Column: "id"}}, []string{"id"}, pageCols, nil, pgCaps, DollarPlaceholder, 0,
	)
	if plan.Where != "" {
		t.Fatalf("first page should have no cursor predicate, got %q", plan.Where)
	}
	if len(plan.Args) != 0 {
		t.Fatalf("first page should bind no args, got %v", plan.Args)
	}
}

func TestPagePlanUniformAscUsesRowValueComparison(t *testing.T) {
	plan, err := BuildPagePlan(
		[]port.SortKey{{Column: "created_at"}, {Column: "id"}},
		[]string{"id"}, pageCols, []any{"2026-01-01", 42}, pgCaps, DollarPlaceholder, 0,
	)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.Contains(plan.Where, ") > (") {
		t.Fatalf("expected row-value comparison, got %q", plan.Where)
	}
	if len(plan.Args) != 2 {
		t.Fatalf("args = %v, want 2", plan.Args)
	}
}

func TestPagePlanMixedDirectionsExpandsToOrChain(t *testing.T) {
	// Row-value comparison `(a,b) > (?,?)` only means "lexicographically
	// after" when every column shares one direction. With mixed ASC/DESC it
	// silently returns the wrong rows, so the plan must expand to an explicit
	// OR-chain instead.
	plan, err := BuildPagePlan(
		[]port.SortKey{{Column: "created_at", Desc: true}, {Column: "id"}},
		[]string{"id"}, pageCols, []any{"2026-01-01", 42}, pgCaps, DollarPlaceholder, 0,
	)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if strings.Contains(plan.Where, ") > (") {
		t.Fatalf("row-value comparison used with mixed directions: %q", plan.Where)
	}
	if !strings.Contains(strings.ToUpper(plan.Where), " OR ") {
		t.Fatalf("expected OR-chain for mixed directions: %q", plan.Where)
	}
	if !strings.Contains(plan.OrderBy, "DESC") {
		t.Fatalf("DESC lost from ORDER BY: %s", plan.OrderBy)
	}
}

func TestPagePlanNullableSortColumnFallsBackToOffset(t *testing.T) {
	// A NULL in a keyset comparison makes the predicate NULL, which excludes
	// the row entirely — rows would vanish from paging. Fall back rather than
	// return a silently incomplete result.
	plan, err := BuildPagePlan(
		[]port.SortKey{{Column: "nickname"}},
		[]string{"id"}, pageCols, []any{"bob", 1}, pgCaps, DollarPlaceholder, 0,
	)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !plan.UseOffset {
		t.Fatal("expected OFFSET fallback for a nullable sort column")
	}
	if plan.Reason == "" {
		t.Fatal("fallback must explain itself so the UI can surface the reason")
	}
}

func TestPagePlanNoIdentityFallsBackToOffset(t *testing.T) {
	plan, err := BuildPagePlan(
		[]port.SortKey{{Column: "created_at"}}, nil, pageCols, nil, pgCaps, DollarPlaceholder, 0,
	)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !plan.UseOffset {
		t.Fatal("expected OFFSET fallback with no identity columns")
	}
}

func TestPagePlanRejectsUnknownSortColumn(t *testing.T) {
	if _, err := BuildPagePlan(
		[]port.SortKey{{Column: "id; DROP TABLE t"}}, []string{"id"}, pageCols, nil, pgCaps, DollarPlaceholder, 0,
	); err == nil {
		t.Fatal("unknown sort column accepted, want rejection")
	}
}

func TestPagePlanCursorArityMustMatchKeyColumns(t *testing.T) {
	if _, err := BuildPagePlan(
		[]port.SortKey{{Column: "created_at"}}, []string{"id"}, pageCols, []any{"only-one"}, pgCaps, DollarPlaceholder, 0,
	); err == nil {
		t.Fatal("cursor with wrong arity accepted, want rejection")
	}
}

func TestPagePlanArgOffsetContinuesPlaceholderNumbering(t *testing.T) {
	// Filters are compiled first and already consumed placeholders; the page
	// predicate must continue their numbering, not restart at $1.
	plan, err := BuildPagePlan(
		[]port.SortKey{{Column: "id"}}, []string{"id"}, pageCols, []any{7}, pgCaps, DollarPlaceholder, 3,
	)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if strings.Contains(plan.Where, "$1") {
		t.Fatalf("placeholder numbering restarted despite argOffset: %q", plan.Where)
	}
	if !strings.Contains(plan.Where, "$4") {
		t.Fatalf("expected numbering to continue at $4: %q", plan.Where)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/dbquery/ -run TestPagePlan -v`
Expected: FAIL — `BuildPagePlan` undefined.

- [ ] **Step 3: Implement the page planner**

Create `backend/internal/dbquery/paging.go`:

```go
package dbquery

import (
	"fmt"
	"strings"

	"devdeck/backend/internal/port"
)

// PagePlan is the ORDER BY and cursor predicate for one page.
type PagePlan struct {
	OrderBy string
	// Where is the cursor predicate, empty on the first page.
	Where string
	Args  []any
	// UseOffset reports that keyset paging was unavailable and the caller
	// must fall back to LIMIT/OFFSET.
	UseOffset bool
	// Reason explains an OFFSET fallback, surfaced in the UI so deep-page
	// slowness is understood rather than mysterious.
	Reason string
	// KeyColumns is the full ordering tuple, used to build the next cursor.
	KeyColumns []string
}

// BuildPagePlan builds keyset ("seek") pagination.
//
// OFFSET makes the engine scan and discard every skipped row, so page 1000
// costs a thousand pages of work. Keyset paging instead asks for rows after
// the previous page's last ordering tuple, which an index can satisfy
// directly.
//
// argOffset is the number of placeholders already consumed by the filter
// clause, so numbering continues rather than restarting.
func BuildPagePlan(sort []port.SortKey, identity []string, cols []port.ColumnMeta, cursor []any, caps port.DBCaps, ph Placeholder, argOffset int) (PagePlan, error) {
	plan := PagePlan{}

	// Build the full ordering tuple: requested sort columns, then the identity
	// columns as a tiebreaker. Without a deterministic total order, keyset
	// paging repeats and skips rows when sort values collide.
	keys := make([]port.SortKey, 0, len(sort)+len(identity))
	seen := map[string]bool{}
	for _, s := range sort {
		if _, ok := columnByName(cols, s.Column); !ok {
			return plan, fmt.Errorf("unknown sort column %q", s.Column)
		}
		if seen[s.Column] {
			continue
		}
		seen[s.Column] = true
		keys = append(keys, s)
	}
	for _, id := range identity {
		if seen[id] {
			continue
		}
		seen[id] = true
		keys = append(keys, port.SortKey{Column: id})
	}
	if len(keys) == 0 {
		return plan, fmt.Errorf("no sort or identity columns available")
	}

	orderParts := make([]string, len(keys))
	for i, k := range keys {
		q, err := QuoteIdent(k.Column, caps.QuoteChar)
		if err != nil {
			return plan, err
		}
		if k.Desc {
			orderParts[i] = q + " DESC"
		} else {
			orderParts[i] = q + " ASC"
		}
		plan.KeyColumns = append(plan.KeyColumns, k.Column)
	}
	plan.OrderBy = strings.Join(orderParts, ", ")

	// Keyset paging requires a usable identity tiebreaker.
	if len(identity) == 0 {
		plan.UseOffset = true
		plan.Reason = "no primary key or row identifier, so rows cannot be addressed by cursor"
		return plan, nil
	}

	// A NULL anywhere in the comparison tuple makes the predicate NULL, which
	// excludes the row — pages would silently lose rows. Fall back instead.
	for _, k := range keys {
		c, _ := columnByName(cols, k.Column)
		if c.Nullable {
			plan.UseOffset = true
			plan.Reason = fmt.Sprintf("sort column %q is nullable; keyset paging would skip NULL rows", k.Column)
			return plan, nil
		}
	}

	if cursor == nil {
		return plan, nil // first page: ORDER BY only
	}
	if len(cursor) != len(keys) {
		return plan, fmt.Errorf("cursor has %d values but the ordering tuple has %d columns", len(cursor), len(keys))
	}

	quoted := make([]string, len(keys))
	for i, k := range keys {
		q, err := QuoteIdent(k.Column, caps.QuoteChar)
		if err != nil {
			return plan, err
		}
		quoted[i] = q
	}

	// Row-value comparison is only correct when every key shares a direction.
	uniform := true
	for _, k := range keys[1:] {
		if k.Desc != keys[0].Desc {
			uniform = false
			break
		}
	}

	n := argOffset
	if uniform {
		cmp := ">"
		if keys[0].Desc {
			cmp = "<"
		}
		ps := make([]string, len(cursor))
		for i, v := range cursor {
			n++
			ps[i] = ph(n)
			plan.Args = append(plan.Args, v)
		}
		plan.Where = fmt.Sprintf("(%s) %s (%s)", strings.Join(quoted, ", "), cmp, strings.Join(ps, ", "))
		return plan, nil
	}

	// Mixed directions: expand lexicographic comparison explicitly.
	//   (a > ?) OR (a = ? AND b < ?) OR (a = ? AND b = ? AND c > ?) …
	var clauses []string
	for i := range keys {
		var conj []string
		for j := 0; j < i; j++ {
			n++
			conj = append(conj, fmt.Sprintf("%s = %s", quoted[j], ph(n)))
			plan.Args = append(plan.Args, cursor[j])
		}
		cmp := ">"
		if keys[i].Desc {
			cmp = "<"
		}
		n++
		conj = append(conj, fmt.Sprintf("%s %s %s", quoted[i], cmp, ph(n)))
		plan.Args = append(plan.Args, cursor[i])
		clauses = append(clauses, "("+strings.Join(conj, " AND ")+")")
	}
	plan.Where = "(" + strings.Join(clauses, " OR ") + ")"
	return plan, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/dbquery/ -v`
Expected: PASS for all tests in the package (Task 2's 12 plus these 9).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/dbquery/paging.go backend/internal/dbquery/paging_test.go
git commit -m "feat(db): add keyset pagination planner with mixed-direction and NULL fallbacks"
```

---

### Task 4: SQLite driver

**Files:**
- Create: `backend/internal/dbdriver/registry.go`
- Create: `backend/internal/dbdriver/sqlitedrv/driver.go`
- Create: `backend/internal/dbdriver/sqlitedrv/driver_test.go`

SQLite comes first: `modernc.org/sqlite` is already a dependency, it needs no Docker, and an in-memory database makes the whole read path testable in milliseconds.

**Interfaces:**
- Consumes: all of `port` (Task 1), `dbquery` (Tasks 2–3).
- Produces:
  - `dbdriver.Register(engine string, d port.DBDriver)`, `dbdriver.Get(engine string) (port.DBDriver, error)`, `dbdriver.AllCaps() map[string]port.DBCaps`
  - `sqlitedrv.New() port.DBDriver`

- [ ] **Step 1: Write the driver registry**

Create `backend/internal/dbdriver/registry.go`:

```go
// Package dbdriver holds per-engine implementations of port.DBDriver and a
// registry mapping engine names to them.
package dbdriver

import (
	"fmt"
	"sync"

	"devdeck/backend/internal/port"
)

var (
	mu      sync.RWMutex
	drivers = map[string]port.DBDriver{}
)

// Register makes a driver available under an engine name. Called from main.go
// during wiring, not from init(), so the set of enabled engines stays explicit.
func Register(engine string, d port.DBDriver) {
	mu.Lock()
	defer mu.Unlock()
	drivers[engine] = d
}

// Get returns the driver for an engine.
func Get(engine string) (port.DBDriver, error) {
	mu.RLock()
	defer mu.RUnlock()
	d, ok := drivers[engine]
	if !ok {
		return nil, fmt.Errorf("no driver registered for engine %q", engine)
	}
	return d, nil
}

// AllCaps returns every registered engine's capabilities, served to the
// frontend by GET /api/db/engines.
func AllCaps() map[string]port.DBCaps {
	mu.RLock()
	defer mu.RUnlock()
	out := map[string]port.DBCaps{}
	for name, d := range drivers {
		out[name] = d.Capabilities()
	}
	return out
}
```

- [ ] **Step 2: Write the failing driver test**

Create `backend/internal/dbdriver/sqlitedrv/driver_test.go`:

```go
package sqlitedrv

import (
	"context"
	"testing"

	"devdeck/backend/internal/port"
)

// openTestDB creates an in-memory SQLite database with a small fixture and
// returns an open port.DBConn.
func openTestDB(t *testing.T) port.DBConn {
	t.Helper()
	ctx := context.Background()
	conn, err := New().Open(ctx, port.DSNDescriptor{Engine: "sqlite", Database: ":memory:"})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	stmts := []string{
		`CREATE TABLE assets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER NOT NULL, blob_col BLOB)`,
		`INSERT INTO assets (id, name, qty) VALUES (1, 'alpha', 10), (2, 'beta', 20), (3, 'gamma', 20)`,
		`CREATE VIEW asset_names AS SELECT name FROM assets`,
	}
	for _, s := range stmts {
		if _, err := conn.Exec(ctx, s, nil); err != nil {
			t.Fatalf("fixture %q: %v", s, err)
		}
	}
	return conn
}

func TestCapabilities(t *testing.T) {
	caps := New().Capabilities()
	if caps.RowIdentifier != "rowid" {
		t.Errorf("RowIdentifier = %q, want rowid", caps.RowIdentifier)
	}
	if caps.Schemas {
		t.Error("SQLite has no schema layer")
	}
	if caps.MatViews {
		t.Error("SQLite has no materialized views")
	}
	if caps.QuoteChar != `"` {
		t.Errorf("QuoteChar = %q, want double quote", caps.QuoteChar)
	}
}

func TestTreeListsTablesAndViews(t *testing.T) {
	conn := openTestDB(t)
	ctx := context.Background()

	tables, err := conn.Tree(ctx, port.TreePath{Kind: "tables"})
	if err != nil {
		t.Fatalf("tree tables: %v", err)
	}
	if len(tables) != 1 || tables[0].Name != "assets" {
		t.Fatalf("tables = %+v, want [assets]", tables)
	}

	views, err := conn.Tree(ctx, port.TreePath{Kind: "views"})
	if err != nil {
		t.Fatalf("tree views: %v", err)
	}
	if len(views) != 1 || views[0].Name != "asset_names" {
		t.Fatalf("views = %+v, want [asset_names]", views)
	}
}

func TestTreeExcludesInternalSQLiteTables(t *testing.T) {
	conn := openTestDB(t)
	nodes, _ := conn.Tree(context.Background(), port.TreePath{Kind: "tables"})
	for _, n := range nodes {
		if len(n.Name) >= 7 && n.Name[:7] == "sqlite_" {
			t.Fatalf("internal table %q exposed in tree", n.Name)
		}
	}
}

func TestColumnsReportsPrimaryKeyAndComparability(t *testing.T) {
	conn := openTestDB(t)
	cols, err := conn.Columns(context.Background(), port.ObjectRef{Name: "assets", Kind: "table"})
	if err != nil {
		t.Fatalf("columns: %v", err)
	}
	byName := map[string]port.ColumnMeta{}
	for _, c := range cols {
		byName[c.Name] = c
	}
	if !byName["id"].IsPrimaryKey {
		t.Error("id not reported as primary key")
	}
	if byName["name"].Nullable {
		t.Error("NOT NULL column reported as nullable")
	}
	if !byName["blob_col"].IsLOB {
		t.Error("BLOB column not marked as LOB")
	}
	if byName["blob_col"].Comparable {
		t.Error("BLOB column must not be comparable")
	}
	if !byName["qty"].Comparable {
		t.Error("INTEGER column should be comparable")
	}
}

func TestRowsPagesWithKeyset(t *testing.T) {
	conn := openTestDB(t)
	ctx := context.Background()
	obj := port.ObjectRef{Name: "assets", Kind: "table"}

	first, err := conn.Rows(ctx, port.RowsRequest{Object: obj, Sort: []port.SortKey{{Column: "id"}}, Limit: 2})
	if err != nil {
		t.Fatalf("rows page 1: %v", err)
	}
	if len(first.Rows) != 2 {
		t.Fatalf("page 1 rows = %d, want 2", len(first.Rows))
	}
	if first.NextCursor == nil {
		t.Fatal("expected a cursor for the next page")
	}

	second, err := conn.Rows(ctx, port.RowsRequest{Object: obj, Sort: []port.SortKey{{Column: "id"}}, Limit: 2, Cursor: first.NextCursor})
	if err != nil {
		t.Fatalf("rows page 2: %v", err)
	}
	if len(second.Rows) != 1 {
		t.Fatalf("page 2 rows = %d, want 1", len(second.Rows))
	}
	// The two pages must not overlap.
	if second.Rows[0][0] == first.Rows[0][0] {
		t.Fatal("page 2 repeated a row from page 1")
	}
}

func TestRowsKeysetDoesNotSkipOnDuplicateSortValues(t *testing.T) {
	// qty has duplicates (20, 20). Without the identity tiebreaker in
	// ORDER BY, paging by qty loses or repeats a row.
	conn := openTestDB(t)
	ctx := context.Background()
	obj := port.ObjectRef{Name: "assets", Kind: "table"}

	seen := map[any]bool{}
	var cursor []any
	for page := 0; page < 5; page++ {
		res, err := conn.Rows(ctx, port.RowsRequest{Object: obj, Sort: []port.SortKey{{Column: "qty"}}, Limit: 1, Cursor: cursor})
		if err != nil {
			t.Fatalf("page %d: %v", page, err)
		}
		if len(res.Rows) == 0 {
			break
		}
		id := res.Rows[0][0]
		if seen[id] {
			t.Fatalf("row id %v returned twice across pages", id)
		}
		seen[id] = true
		cursor = res.NextCursor
	}
	if len(seen) != 3 {
		t.Fatalf("saw %d distinct rows across paging, want 3", len(seen))
	}
}

func TestRowsAppliesFilters(t *testing.T) {
	conn := openTestDB(t)
	res, err := conn.Rows(context.Background(), port.RowsRequest{
		Object:  port.ObjectRef{Name: "assets", Kind: "table"},
		Filters: []port.Filter{{Column: "qty", Op: "eq", Values: []any{20}}},
		Sort:    []port.SortKey{{Column: "id"}},
		Limit:   100,
	})
	if err != nil {
		t.Fatalf("rows: %v", err)
	}
	if len(res.Rows) != 2 {
		t.Fatalf("filtered rows = %d, want 2", len(res.Rows))
	}
}

func TestRowsSetsTruncatedAtLimit(t *testing.T) {
	conn := openTestDB(t)
	res, err := conn.Rows(context.Background(), port.RowsRequest{
		Object: port.ObjectRef{Name: "assets", Kind: "table"},
		Sort:   []port.SortKey{{Column: "id"}},
		Limit:  2,
	})
	if err != nil {
		t.Fatalf("rows: %v", err)
	}
	if !res.Truncated {
		t.Fatal("Truncated should be true when the page filled to the limit")
	}
}

func TestRowsDefersLOBColumns(t *testing.T) {
	conn := openTestDB(t)
	res, err := conn.Rows(context.Background(), port.RowsRequest{
		Object: port.ObjectRef{Name: "assets", Kind: "table"},
		Sort:   []port.SortKey{{Column: "id"}},
		Limit:  10,
	})
	if err != nil {
		t.Fatalf("rows: %v", err)
	}
	idx := -1
	for i, c := range res.Columns {
		if c.Name == "blob_col" {
			idx = i
		}
	}
	if idx == -1 {
		t.Fatal("blob_col missing from columns")
	}
	// The value must be a placeholder/size marker, never raw bytes.
	for _, row := range res.Rows {
		if b, ok := row[idx].([]byte); ok && len(b) > 0 {
			t.Fatal("LOB bytes returned inline in a grid page")
		}
	}
}

func TestCountExactRespectsFilters(t *testing.T) {
	conn := openTestDB(t)
	n, err := conn.CountExact(context.Background(),
		port.ObjectRef{Name: "assets", Kind: "table"},
		[]port.Filter{{Column: "qty", Op: "eq", Values: []any{20}}})
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 2 {
		t.Fatalf("count = %d, want 2", n)
	}
}

func TestStatsDegradesWithoutDbstat(t *testing.T) {
	// dbstat is a compile-time option and is often absent. Missing size data
	// must render as unknown, never as a fabricated zero.
	conn := openTestDB(t)
	st, err := conn.Stats(context.Background(), port.ObjectRef{Name: "assets", Kind: "table"})
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.TotalBytes != nil && *st.TotalBytes < 0 {
		t.Fatalf("negative size reported: %d", *st.TotalBytes)
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/dbdriver/... -v`
Expected: FAIL — `sqlitedrv.New` undefined.

- [ ] **Step 4: Implement the driver**

Create `backend/internal/dbdriver/sqlitedrv/driver.go`. Implement `port.DBDriver` and `port.DBConn` over `database/sql` with the existing `modernc.org/sqlite` driver (import `_ "modernc.org/sqlite"`, driver name `"sqlite"`).

Required behavior:

- `Capabilities()` returns exactly: `{Schemas: false, MatViews: false, Functions: false, MultiDatabase: false, RowIdentifier: "rowid", SizeStats: false, QuoteChar: "\""}`.
- `Open` uses `DSNDescriptor.Database` as the file path. Reject a descriptor with a `Tunnel` — a local file has nothing to tunnel to, and silently ignoring it would hide a misconfiguration.
- `Tree`:
  - `Kind: ""` → the fixed child collections: `tables`, `views`.
  - `Kind: "tables"` → `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`.
  - `Kind: "views"` → same with `type='view'`.
  - Any other kind → an empty slice, not an error.
- `Columns` uses `PRAGMA table_info(<quoted>)`, mapping: `pk > 0` → `IsPrimaryKey`; `notnull = 0` → `Nullable`; declared type containing `BLOB` → `IsLOB`. `Comparable` is false for `BLOB`, `REAL`, `FLOAT`, `DOUBLE`, and `JSON` declared types, true otherwise. Use `dbquery.QuoteIdent` for the table name.
- `Indexes` uses `PRAGMA index_list(<quoted>)` plus `PRAGMA index_info(<index>)`.
- `Rows`:
  1. Load `Columns` for the object.
  2. `CompileFilters(r.Filters, cols, caps, dbquery.QuestionPlaceholder)`.
  3. `CompileGlobalSearch(r.GlobalSearch, cols, caps, …)` when non-empty; AND it with the filter clause.
  4. Determine identity: primary-key columns if any, else `["rowid"]` (SQLite's row identifier), unless the table is `WITHOUT ROWID` — detect via `sqlite_master.sql` containing `WITHOUT ROWID` and pass no identity in that case.
  5. `BuildPagePlan(r.Sort, identity, cols, r.Cursor, caps, dbquery.QuestionPlaceholder, len(filterArgs))`.
  6. Select non-LOB columns by name; for LOB columns select `length(<col>)` aliased, so the grid receives a size rather than bytes.
  7. Apply `LIMIT clampLimit(r.Limit)`; add `OFFSET` only when `plan.UseOffset`.
  8. Set `Truncated` when the returned row count equals the limit, `NextCursor` from the last row's key columns, `UsedOffsetPaging` from `plan.UseOffset`, and `ElapsedMS`.
- `clampLimit`: `<= 0` → 500; `> 5000` → 5000.
- `CountExact` runs `SELECT COUNT(*)` with the compiled filters.
- `LOBValue` selects the single column using the supplied identity filters, requiring exactly one matching row.
- `Stats`: probe `dbstat` with `SELECT 1 FROM dbstat LIMIT 1`; if it errors, return `TableStats{EstRows: <exact count>, TotalBytes: nil, Analyzed: false}` — SQLite is small enough that an exact count is acceptable here, and a nil size renders as `—`. If `dbstat` is present, sum `pgsize` for the table.
- `Close` closes the underlying `*sql.DB`.

Every query must take `ctx` and use the `…Context` variants so cancellation and timeouts (Task 6) work.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/dbdriver/... -v`
Expected: PASS for all 11 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/dbdriver/
git commit -m "feat(db): add driver registry and SQLite driver with keyset paging"
```

---

### Task 5: Statement timeout and cancellation

**Files:**
- Create: `backend/internal/dbdriver/timeout.go`
- Create: `backend/internal/dbdriver/timeout_test.go`

**Interfaces:**
- Produces: `dbdriver.DefaultStatementTimeout` (30s), `dbdriver.WithStatementTimeout(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc)`.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/dbdriver/timeout_test.go`:

```go
package dbdriver

import (
	"context"
	"testing"
	"time"
)

func TestWithStatementTimeoutAppliesDefault(t *testing.T) {
	ctx, cancel := WithStatementTimeout(context.Background(), 0)
	defer cancel()
	dl, ok := ctx.Deadline()
	if !ok {
		t.Fatal("no deadline set")
	}
	if remaining := time.Until(dl); remaining > DefaultStatementTimeout+time.Second {
		t.Fatalf("deadline %v exceeds default %v", remaining, DefaultStatementTimeout)
	}
}

func TestWithStatementTimeoutPreservesEarlierParentDeadline(t *testing.T) {
	// A cancelled request must abort the query even when the statement
	// timeout is longer; abandoned queries otherwise pin runtime connections.
	parent, cancelParent := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancelParent()
	ctx, cancel := WithStatementTimeout(parent, time.Hour)
	defer cancel()

	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("child context outlived its parent's deadline")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/dbdriver/ -run TestWithStatementTimeout -v`
Expected: FAIL — `WithStatementTimeout` undefined.

- [ ] **Step 3: Implement**

Create `backend/internal/dbdriver/timeout.go`:

```go
package dbdriver

import (
	"context"
	"time"
)

// DefaultStatementTimeout bounds any single statement. Without it, one
// pathological query holds a pooled connection indefinitely.
const DefaultStatementTimeout = 30 * time.Second

// WithStatementTimeout derives a context bounded by d, or by
// DefaultStatementTimeout when d is zero or negative.
//
// Deriving from ctx (rather than context.Background) is what makes request
// cancellation propagate: when the browser closes the tab, the HTTP request
// context cancels and the in-flight query is killed instead of running on.
func WithStatementTimeout(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if d <= 0 {
		d = DefaultStatementTimeout
	}
	return context.WithTimeout(ctx, d)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/dbdriver/ -run TestWithStatementTimeout -v`
Expected: PASS.

- [ ] **Step 5: Apply the engine-level timeout in the SQLite driver**

In `sqlitedrv.Open`, register a busy timeout and ensure every `Rows`/`Query`/`Exec` call wraps its context with `dbdriver.WithStatementTimeout(ctx, 0)`. Engine-side enforcement for PostgreSQL (`statement_timeout`) and MySQL (`max_execution_time`) arrives with those drivers in Tasks 6 and 7.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/dbdriver/timeout.go backend/internal/dbdriver/timeout_test.go backend/internal/dbdriver/sqlitedrv/
git commit -m "feat(db): bound statements with a timeout and propagate cancellation"
```

---

### Task 6: PostgreSQL driver

**Files:**
- Modify: `backend/go.mod`, `backend/go.sum`
- Create: `backend/internal/dbdriver/pgdrv/driver.go`
- Create: `backend/internal/dbdriver/pgdrv/tls.go`
- Create: `backend/internal/dbdriver/pgdrv/tls_test.go`
- Create: `backend/internal/dbdriver/pgdrv/driver_test.go`

**Interfaces:**
- Produces: `pgdrv.New() port.DBDriver`; `pgdrv.BuildTLSConfig(d port.DSNDescriptor) (*tls.Config, error)`.

- [ ] **Step 1: Add the dependency**

Run: `cd backend && go get github.com/jackc/pgx/v5@latest`
Expected: `go.mod` and `go.sum` updated.

- [ ] **Step 2: Write the failing TLS tests**

These run without a database and cover the spec's TLS policy at the driver layer.

Create `backend/internal/dbdriver/pgdrv/tls_test.go`:

```go
package pgdrv

import (
	"testing"

	"devdeck/backend/internal/port"
)

func TestBuildTLSConfigVerifyFullChecksHostname(t *testing.T) {
	cfg, err := BuildTLSConfig(port.DSNDescriptor{SSLMode: "verify-full", Host: "db.example.com"})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if cfg.InsecureSkipVerify {
		t.Fatal("verify-full must not skip verification")
	}
	if cfg.ServerName != "db.example.com" {
		t.Fatalf("ServerName = %q, want the host for hostname verification", cfg.ServerName)
	}
}

func TestBuildTLSConfigVerifyCASkipsHostnameButVerifiesChain(t *testing.T) {
	cfg, err := BuildTLSConfig(port.DSNDescriptor{SSLMode: "verify-ca", Host: "db.example.com"})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	// verify-ca validates the chain but not the hostname, which Go expresses
	// as InsecureSkipVerify plus a custom VerifyPeerCertificate.
	if cfg.VerifyPeerCertificate == nil {
		t.Fatal("verify-ca needs a custom chain verifier")
	}
}

func TestBuildTLSConfigDisableReturnsNil(t *testing.T) {
	cfg, err := BuildTLSConfig(port.DSNDescriptor{SSLMode: "disable"})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if cfg != nil {
		t.Fatal("disable must produce no TLS config")
	}
}

func TestBuildTLSConfigRejectsUnparseableCACert(t *testing.T) {
	_, err := BuildTLSConfig(port.DSNDescriptor{SSLMode: "verify-full", Host: "h", CACert: "not a pem block"})
	if err == nil {
		t.Fatal("invalid CA certificate accepted, want rejection")
	}
}

func TestBuildTLSConfigPinnedFingerprintSetsVerifier(t *testing.T) {
	cfg, err := BuildTLSConfig(port.DSNDescriptor{
		SSLMode: "verify-full", Host: "h",
		ServerCertFingerprint: "AA:BB:CC",
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if cfg.VerifyPeerCertificate == nil {
		t.Fatal("a pinned fingerprint requires a custom verifier")
	}
}
```

- [ ] **Step 3: Implement TLS configuration**

Create `backend/internal/dbdriver/pgdrv/tls.go`.

- `disable`, `allow`, `prefer` → return `nil, nil` (the caller lets pgx negotiate; these modes are already blocked for production connections by `service.ValidateSSLMode`).
- `require` → `&tls.Config{InsecureSkipVerify: true}`. Encryption without authentication; permitted only for non-production connections.
- `verify-ca` → `InsecureSkipVerify: true` plus a `VerifyPeerCertificate` that builds and verifies the chain against the supplied CA pool (or system roots) **without** hostname checking.
- `verify-full` → full verification with `ServerName` set to `d.Host`.
- `CACert`, when present, is parsed with `x509.NewCertPool().AppendCertsFromPEM`; a parse failure is an error, never a silent fallback to system roots.
- `ClientCert`/`ClientKey`, when both present, load via `tls.X509KeyPair` into `Certificates`.
- `ServerCertFingerprint`, when present, wraps `VerifyPeerCertificate` with a SHA-256 comparison of the leaf certificate, using `crypto/subtle.ConstantTimeCompare`, and fails hard on mismatch with a message naming the expected and actual fingerprints.

- [ ] **Step 4: Implement the driver**

Create `backend/internal/dbdriver/pgdrv/driver.go` implementing the same `port.DBConn` surface as the SQLite driver, using `pgx/v5` in `database/sql` mode (`stdlib.OpenDB`) so the row-scanning code stays shared in shape.

- `Capabilities()`: `{Schemas: true, MatViews: true, Functions: true, MultiDatabase: true, RowIdentifier: "ctid", SizeStats: true, QuoteChar: "\""}`.
- `Open` sets `statement_timeout` on the connection and applies the TLS config from Step 3. When `d.Tunnel != nil`, dial through the tunnel from Task 9.
- `Tree`:
  - root → `databases` when multi-database browsing is wanted, else `schemas`.
  - `databases` → `SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1`.
  - `schemas` → `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema' ORDER BY 1`.
  - `tables` / `views` / `matviews` → `pg_class.relkind` of `r`/`v`/`m` joined to `pg_namespace`.
  - `functions` → `pg_proc` joined to `pg_namespace`.
- `Columns` reads `information_schema.columns` for names/types/nullability/defaults, joined with a `pg_index`-based primary-key lookup. `IsLOB` for `bytea`; `Comparable` false for `bytea`, `json`, `jsonb`, `real`, `double precision`, and array types.
- `Stats` uses the `pg_class` / `pg_total_relation_size` query from the spec. **`reltuples` of `-1`, and `0` on a table with no `pg_stat_all_tables.last_analyze`, both yield `EstRows: nil` and `Analyzed: false`** — never a fabricated zero.
- `Rows`, `Query`, `Exec`, `CountExact`, `LOBValue` mirror the SQLite driver but pass `dbquery.DollarPlaceholder`.

- [ ] **Step 5: Write integration tests guarded by an env var**

Create `backend/internal/dbdriver/pgdrv/driver_test.go`. Gate every database-touching test behind `DEVDECK_TEST_PG_DSN`; call `t.Skip("set DEVDECK_TEST_PG_DSN to run PostgreSQL integration tests")` when unset, so `go test ./...` stays green on a machine with no PostgreSQL. Cover: tree lists schemas and tables, `Columns` marks the primary key, keyset paging across duplicate sort values, `Stats` returns nil `EstRows` for a freshly created never-analyzed table.

- [ ] **Step 6: Run the tests**

Run: `cd backend && go test ./internal/dbdriver/pgdrv/ -v`
Expected: TLS tests PASS; integration tests SKIP with the explanatory message.

- [ ] **Step 7: Commit**

```bash
git add backend/go.mod backend/go.sum backend/internal/dbdriver/pgdrv/
git commit -m "feat(db): add PostgreSQL driver with verifying TLS and pg_catalog stats"
```

---

### Task 7: MySQL driver

**Files:**
- Modify: `backend/go.mod`, `backend/go.sum`
- Create: `backend/internal/dbdriver/mysqldrv/driver.go`
- Create: `backend/internal/dbdriver/mysqldrv/driver_test.go`

**Interfaces:**
- Produces: `mysqldrv.New() port.DBDriver`.

- [ ] **Step 1: Add the dependency**

Run: `cd backend && go get github.com/go-sql-driver/mysql@latest`

- [ ] **Step 2: Implement the driver**

Create `backend/internal/dbdriver/mysqldrv/driver.go`.

- `Capabilities()`: `{Schemas: false, MatViews: false, Functions: true, MultiDatabase: true, RowIdentifier: "", SizeStats: true, QuoteChar: "`"}`.
  `RowIdentifier` is empty on purpose: MySQL exposes no stable per-row physical address, which is exactly why Phase 3's ladder must fall through to an all-column predicate on this engine.
- TLS: register a custom config via `mysql.RegisterTLSConfig` built the same way as `pgdrv`. Map `skip-verify` → `InsecureSkipVerify: true`, `true`/`verify-ca`/`verify-identity` → verifying configs. `service.ValidateSSLMode` already blocks the unverified modes for production connections.
- Set `max_execution_time` (milliseconds) from the statement timeout on connect.
- `Tree`: root → `databases`; `databases` → `SHOW DATABASES` excluding `information_schema`, `performance_schema`, `mysql`, `sys`; `tables`/`views` → `information_schema.TABLES` filtered by `TABLE_TYPE`; `functions` → `information_schema.ROUTINES`.
- `Columns` reads `information_schema.COLUMNS`. `IsLOB` for `blob`, `mediumblob`, `longblob`, `longtext`. `Comparable` false for `json`, `float`, `double`, and all blob types — **`WHERE json_col = ?` is an error on MySQL**, which is precisely why the flag exists.
- `Stats` uses the `information_schema.TABLES` query from the spec, `TotalBytes = DATA_LENGTH + INDEX_LENGTH`. Query one schema at a time: with `innodb_stats_on_metadata=ON`, broad `information_schema` scans force statistics recalculation and can stall for seconds.
- `Rows`, `Query`, `Exec`, `CountExact`, `LOBValue` mirror SQLite with `dbquery.QuestionPlaceholder`.

- [ ] **Step 3: Write integration tests guarded by an env var**

Create `backend/internal/dbdriver/mysqldrv/driver_test.go`, gated behind `DEVDECK_TEST_MYSQL_DSN` with a skip message. Include a unit test that needs no server:

```go
func TestCapabilitiesHasNoRowIdentifier(t *testing.T) {
	// MySQL exposes no stable physical row address, so the Phase 3 identity
	// ladder must fall through to an all-column predicate on this engine.
	if New().Capabilities().RowIdentifier != "" {
		t.Fatal("MySQL must report no row identifier")
	}
}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && go test ./internal/dbdriver/... -v`
Expected: unit tests PASS, integration tests SKIP.

- [ ] **Step 5: Commit**

```bash
git add backend/go.mod backend/go.sum backend/internal/dbdriver/mysqldrv/
git commit -m "feat(db): add MySQL driver with information_schema stats"
```

---

### Task 8: SSH tunnel dialing

**Files:**
- Create: `backend/internal/dbdriver/tunnel.go`
- Create: `backend/internal/dbdriver/tunnel_test.go`

**Interfaces:**
- Consumes: `port.TunnelDescriptor`, existing `sshmgr` host-key verification.
- Produces: `dbdriver.OpenTunnel(ctx context.Context, t port.TunnelDescriptor, target string) (net.Conn, func() error, error)`.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/dbdriver/tunnel_test.go`:

```go
package dbdriver

import (
	"context"
	"testing"

	"devdeck/backend/internal/port"
)

func TestOpenTunnelRequiresHostKeyFingerprint(t *testing.T) {
	// An unverified tunnel creates the man-in-the-middle exposure it exists
	// to prevent, so a missing pin is a hard error rather than a warning.
	_, _, err := OpenTunnel(context.Background(), port.TunnelDescriptor{
		Host: "bastion.example.com", Port: 22, Username: "u", AuthType: "password", Password: "p",
	}, "db.internal:5432")
	if err == nil {
		t.Fatal("tunnel opened without a host key fingerprint, want rejection")
	}
}

func TestOpenTunnelRejectsUnknownAuthType(t *testing.T) {
	_, _, err := OpenTunnel(context.Background(), port.TunnelDescriptor{
		Host: "h", Port: 22, Username: "u", AuthType: "magic", HostKeyFingerprint: "SHA256:abc",
	}, "db:5432")
	if err == nil {
		t.Fatal("unknown auth type accepted, want rejection")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/dbdriver/ -run TestOpenTunnel -v`
Expected: FAIL — `OpenTunnel` undefined.

- [ ] **Step 3: Implement**

Create `backend/internal/dbdriver/tunnel.go` using `golang.org/x/crypto/ssh`.

- Reject an empty `HostKeyFingerprint` before dialing.
- Build `ssh.ClientConfig` with a `HostKeyCallback` that compares the SHA-256 fingerprint of the presented key against the pin with `crypto/subtle.ConstantTimeCompare`. **`ssh.InsecureIgnoreHostKey` must not appear anywhere in this file** — grep for it in review.
- Auth: `"password"` → `ssh.Password`; `"privatekey"` → `ssh.ParsePrivateKey`, or `ssh.ParsePrivateKeyWithPassphrase` when `Passphrase` is set. Any other value is an error.
- Dial the SSH host, then `client.DialContext(ctx, "tcp", target)` to reach the database, returning the `net.Conn` and a close function that tears down both.

Before writing this, read `backend/internal/sshmgr/` — if a host-key verifier and dialer already exist there, call them instead of duplicating the logic, and reduce this file to the descriptor-to-config mapping.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/dbdriver/ -run TestOpenTunnel -v`
Expected: PASS.

- [ ] **Step 5: Verify no insecure host-key path exists**

Run: `grep -rn "InsecureIgnoreHostKey" backend/internal/dbdriver/`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/dbdriver/tunnel.go backend/internal/dbdriver/tunnel_test.go
git commit -m "feat(db): add SSH tunnel dialing with mandatory host key verification"
```

---

### Task 9: Descriptor assembly and execution routing

**Files:**
- Create: `backend/internal/service/dbexec.go`
- Create: `backend/internal/service/dbexec_test.go`

**Interfaces:**
- Consumes: `store.Store`, `service.DBSecretService`, `service.ValidateExecutorURL`, `dbdriver.Get`, `machineclient`.
- Produces: `service.NewDBExecService(st *store.Store, secrets *DBSecretService) *DBExecService` with `Descriptor(connID string) (port.DSNDescriptor, error)`, `Conn(ctx, connID) (port.DBConn, func(), error)`, `IsRemote(connID) (bool, domain.Machine, error)`.

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/service/dbexec_test.go`:

```go
package service

import (
	"strings"
	"testing"
)

func TestDescriptorIncludesDecryptedPassword(t *testing.T) {
	st := newTestStore(t)
	secrets := NewDBSecretService(st, testMasterKey(t))
	svc := NewDBExecService(st, secrets)

	c, _ := st.CreateDBConnection("c", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)
	_ = secrets.Set(c.ID, "password", "s3cret")

	d, err := svc.Descriptor(c.ID)
	if err != nil {
		t.Fatalf("descriptor: %v", err)
	}
	if d.Password != "s3cret" {
		t.Fatalf("password not decrypted into descriptor")
	}
}

func TestDescriptorIncludesTunnelCredentialsWithFingerprint(t *testing.T) {
	st := newTestStore(t)
	secrets := NewDBSecretService(st, testMasterKey(t))
	svc := NewDBExecService(st, secrets)

	ssh, _ := st.CreateSSHConnection("bastion", "", "b.example.com", 22, "u", "password", nil, nil)
	_ = st.SetSSHHostKeyFingerprint(ssh.ID, "SHA256:pinned")
	tunnelID := ssh.ID
	c, _ := st.CreateDBConnection("c", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, &tunnelID, false)

	d, err := svc.Descriptor(c.ID)
	if err != nil {
		t.Fatalf("descriptor: %v", err)
	}
	if d.Tunnel == nil {
		t.Fatal("tunnel descriptor missing")
	}
	if d.Tunnel.HostKeyFingerprint != "SHA256:pinned" {
		t.Fatalf("fingerprint = %q, want the pinned value", d.Tunnel.HostKeyFingerprint)
	}
}

func TestDescriptorRejectsTunnelWithoutPinnedHostKey(t *testing.T) {
	// A tunnel whose host key was never pinned cannot be verified, so
	// building a descriptor for it must fail rather than dial blindly.
	st := newTestStore(t)
	svc := NewDBExecService(st, NewDBSecretService(st, testMasterKey(t)))

	ssh, _ := st.CreateSSHConnection("bastion", "", "b.example.com", 22, "u", "password", nil, nil)
	tunnelID := ssh.ID
	c, _ := st.CreateDBConnection("c", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, &tunnelID, false)

	if _, err := svc.Descriptor(c.ID); err == nil {
		t.Fatal("descriptor built for an unpinned tunnel, want rejection")
	}
}

func TestExecRechecksExecutorURLAtExecutionTime(t *testing.T) {
	// The machine URL can change after the connection was saved, so the
	// transport rule must be re-checked here, not only at save time.
	st := newTestStore(t)
	svc := NewDBExecService(st, NewDBSecretService(st, testMasterKey(t)))

	m, _ := st.CreateMachine("runtime", "http://runtime.tail1234.ts.net:8989", "k", false)
	mid := m.ID
	c, _ := st.CreateDBConnection("c", "", "postgres", "h", 5432, "u", "d", "verify-full", &mid, nil, false)

	badURL := "http://203.0.113.9:8989"
	_, _ = st.UpdateMachine(m.ID, port.MachinePatch{URL: &badURL})

	_, _, err := svc.IsRemote(c.ID)
	if err == nil || !strings.Contains(err.Error(), "http") {
		t.Fatalf("err = %v, want rejection of the now-plaintext executor URL", err)
	}
}
```

Adjust the store constructor calls to the real signatures from Phase 1 and the existing machine/SSH store methods — read `store/machine.go` and `store/ssh.go` for exact names (`CreateMachine`, `SetSSHHostKeyFingerprint`, `MachinePatch`) rather than assuming these.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/service/ -run 'TestDescriptor|TestExecRechecks' -v`
Expected: FAIL — `NewDBExecService` undefined.

- [ ] **Step 3: Implement**

Create `backend/internal/service/dbexec.go`:

- `Descriptor(connID)` loads the connection, decrypts `password`, `ca_cert`, `client_cert`, `client_key` via `DBSecretService`, and copies `SSLMode`, `ServerCertFingerprint`, and host/port/user/database into a `port.DSNDescriptor`.
- When `TunnelConnectionID` is set: load the `SSHConnection`, decrypt its credentials via `SSHSecretService`, and populate `port.TunnelDescriptor`. **A nil or empty `HostKeyFingerprint` is an error**, with a message telling the operator to connect over SSH once to pin the host key.
- `IsRemote(connID)` returns whether `ExecutorMachineID` is set; when it is, load the machine and re-run `ValidateExecutorURL(m.URL)`, returning the error if the URL is no longer acceptable.
- `Conn(ctx, connID)` resolves the driver via `dbdriver.Get(engine)` and opens a connection for hub-local execution. Remote execution is handled by the handler in Task 10, which forwards the descriptor rather than dialing.
- Add a package comment stating that `DSNDescriptor` values must never be logged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/service/ -run 'TestDescriptor|TestExecRechecks' -v`
Expected: PASS for all four tests.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/dbexec.go backend/internal/service/dbexec_test.go
git commit -m "feat(db): assemble connection descriptors and re-check executor transport"
```

---

### Task 10: Runtime execution routes and hub read endpoints

**Files:**
- Create: `backend/internal/handler/dbexec.go`
- Create: `backend/internal/handler/dbexec_test.go`
- Create: `backend/internal/machineclient/dbexec.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Produces:
  - Hub: `GET /api/db/engines`, `POST /api/db/connections/{id}/test`, `/tree`, `/columns`, `/stats`, `/count`, `/rows`, `/lob`, `/query`
  - Runtime: `POST /api/db/exec`, `POST /api/db/introspect`, `POST /api/db/close`
  - `machineclient.RunDBRequest(ctx, m domain.Machine, path string, body any, out any) error`

- [ ] **Step 1: Write the failing handler tests**

Create `backend/internal/handler/dbexec_test.go` covering:

```go
func TestGetEnginesReturnsCapabilities(t *testing.T) {
	srv := newDBTestServer(t)
	res := srv.get(t, "/api/db/engines")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.Code)
	}
	var caps map[string]port.DBCaps
	if err := json.Unmarshal(res.Body.Bytes(), &caps); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if caps["sqlite"].RowIdentifier != "rowid" {
		t.Fatalf("sqlite caps wrong: %+v", caps["sqlite"])
	}
}

func TestRowsClampsLimitToHardMaximum(t *testing.T) {
	// A client asking for a million rows must not be able to pull them.
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	res := srv.post(t, "/api/db/connections/"+id+"/rows",
		`{"object":{"name":"assets","kind":"table"},"limit":1000000}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", res.Code, res.Body.String())
	}
	var out port.ResultSet
	_ = json.Unmarshal(res.Body.Bytes(), &out)
	if len(out.Rows) > 5000 {
		t.Fatalf("returned %d rows, hard cap is 5000", len(out.Rows))
	}
}

func TestDescriptorNeverAppearsInErrorResponses(t *testing.T) {
	// A driver error must not leak the DSN or password into the client.
	srv := newDBTestServer(t)
	id := srv.createBrokenConnection(t, "s3cret")
	res := srv.post(t, "/api/db/connections/"+id+"/tree", `{"kind":"tables"}`)
	if strings.Contains(res.Body.String(), "s3cret") {
		t.Fatalf("password leaked in error body: %s", res.Body.String())
	}
}
```

Add `srv.createSQLiteConnection` to the Task 5 (Phase 1) test harness: it creates a temp-file SQLite connection with the `assets` fixture so these handler tests need no external engine.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/handler/ -run 'TestGetEngines|TestRowsClamps|TestDescriptorNever' -v`
Expected: FAIL — handler undefined.

- [ ] **Step 3: Implement the hub handler**

Create `backend/internal/handler/dbexec.go`. Each endpoint:

1. Decodes its request body.
2. Calls `execSvc.IsRemote(connID)`.
3. **Local** → `execSvc.Conn(ctx, connID)`, call the matching `port.DBConn` method, `writeJSON`.
4. **Remote** → `execSvc.Descriptor(connID)`, then `machineclient.RunDBRequest(ctx, machine, "/api/db/introspect"|"/api/db/exec", payload, &out)`.
5. Wraps `ctx` with `dbdriver.WithStatementTimeout`.
6. Maps driver errors through a `mapDriverErr` helper that returns a clean message and logs the original server-side. `mapDriverErr` must never include the descriptor or any credential in its output — that is what `TestDescriptorNeverAppearsInErrorResponses` checks.

`GET /api/db/engines` returns `dbdriver.AllCaps()` directly.

`POST /api/db/connections/{id}/test` opens a connection, runs the engine's trivial liveness query, closes it, and returns `{"ok":true}` or `{"ok":false,"reason":"..."}`. A failed connection is **data, not an error** — always HTTP 200, matching the `GET /api/machines/{id}/health` contract in `CONTRACTS.md`.

- [ ] **Step 4: Implement the machine client**

Create `backend/internal/machineclient/dbexec.go` with `RunDBRequest`, following `clone.go`: POST JSON to `machine.URL + path` with `Authorization: Bearer <machine.Key>`, decode the `{"error":...}` envelope on non-2xx, and decode into `out` on success. Never log the request body — it carries credentials.

- [ ] **Step 5: Register the routes**

In `backend/cmd/server/main.go`:

Wire the drivers before the handlers, so the registry is populated when `AllCaps()` is first served:

```go
	dbdriver.Register("sqlite", sqlitedrv.New())
	dbdriver.Register("postgres", pgdrv.New())
	dbdriver.Register("mysql", mysqldrv.New())

	dbExecSvc := service.NewDBExecService(st, dbSecrets)
	dbExecH := handler.NewDBExecHandler(dbExecSvc)
```

Hub block:

```go
		mux.HandleFunc("GET /api/db/engines", dbExecH.GetEngines)
		mux.HandleFunc("POST /api/db/connections/{id}/test", dbExecH.PostTest)
		mux.HandleFunc("POST /api/db/connections/{id}/tree", dbExecH.PostTree)
		mux.HandleFunc("POST /api/db/connections/{id}/columns", dbExecH.PostColumns)
		mux.HandleFunc("POST /api/db/connections/{id}/stats", dbExecH.PostStats)
		mux.HandleFunc("POST /api/db/connections/{id}/count", dbExecH.PostCount)
		mux.HandleFunc("POST /api/db/connections/{id}/rows", dbExecH.PostRows)
		mux.HandleFunc("POST /api/db/connections/{id}/lob", dbExecH.PostLOB)
		mux.HandleFunc("POST /api/db/connections/{id}/query", dbExecH.PostQuery)
```

Runtime block (key-auth only — these accept a descriptor with credentials and must never be reachable without the machine key):

```go
		mux.HandleFunc("POST /api/db/introspect", dbExecH.RuntimeIntrospect)
		mux.HandleFunc("POST /api/db/exec", dbExecH.RuntimeExec)
		mux.HandleFunc("POST /api/db/close", dbExecH.RuntimeClose)
```

- [ ] **Step 6: Verify the full suite**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: build succeeds, no vet findings, all tests pass (PostgreSQL/MySQL integration tests skip).

- [ ] **Step 7: Smoke-test against a real SQLite file**

```bash
sqlite3 /tmp/devdeck-demo.db "CREATE TABLE assets(id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO assets VALUES (1,'alpha'),(2,'beta');"
curl -s -X POST localhost:8989/api/db/connections -H 'Content-Type: application/json' \
  -d '{"name":"demo","engine":"sqlite","database":"/tmp/devdeck-demo.db","sslMode":""}'
# take the returned id
curl -s -X POST localhost:8989/api/db/connections/<id>/tree -d '{"kind":"tables"}'
curl -s -X POST localhost:8989/api/db/connections/<id>/rows \
  -d '{"object":{"name":"assets","kind":"table"},"sort":[{"column":"id"}],"limit":10}'
```

Expected: the tree lists `assets`; the rows call returns both rows with column metadata and a `nextCursor`.

- [ ] **Step 8: Commit**

```bash
git add backend/internal/handler/dbexec.go backend/internal/handler/dbexec_test.go backend/internal/machineclient/dbexec.go backend/cmd/server/main.go
git commit -m "feat(db): add read execution endpoints with hub-to-runtime routing"
```

---

## Phase 2 Self-Review

Checked against `docs/superpowers/specs/2026-07-19-database-management-design.md`:

**Spec coverage.** Driver abstraction and `DBCaps` → Task 1. `GET /api/db/engines` → Task 10. Execution routing diagram, descriptor transport, runtime pooling → Tasks 9, 10. Result sizing (500 default / 5000 cap, `Truncated`) → Tasks 4, 10. Table metadata with the `reltuples = -1` and `innodb_stats_on_metadata` caveats → Tasks 6, 7. Keyset paging with the tiebreaker requirement → Task 3. Filtering with bound parameters and validated identifiers → Task 2. Global search skipping LOB columns → Task 2. LOB deferral → Task 4. Statement timeout and cancellation → Task 5. TLS policy at the driver layer, CA certs, fingerprint pinning → Task 6. SSH tunnel with mandatory host-key verification → Task 8. Metadata-endpoint blocking is **not** covered here — it belongs with connection dialing and is carried into Phase 3 as an explicit task.

**Two correctness details the spec implied but did not state, now pinned by tests.** First, row-value comparison `(a,b) > (?,?)` is only valid when every sort key shares a direction; mixed ASC/DESC silently returns wrong rows, so `BuildPagePlan` expands to an OR-chain (`TestPagePlanMixedDirectionsExpandsToOrChain`). Second, a NULL anywhere in the keyset tuple makes the predicate NULL and drops the row entirely, so a nullable sort column forces the OFFSET fallback with a stated reason (`TestPagePlanNullableSortColumnFallsBackToOffset`). Both would have shipped as "rows occasionally disappear when sorting" bugs.

**Deferred to Phase 3:** the row-identity ladder and `ctid` re-validation, pending-change commits, `rowsAffected` guards, audit logging, `ShowCreate`, DDL plans, and metadata-endpoint SSRF blocking.

**Type consistency.** `port.ResultSet`, `port.RowsRequest`, `port.ColumnMeta` field names in Task 1 match their use in Tasks 4, 6, 7, and 10. `dbquery.Placeholder` threading (`argOffset`) is consistent between `CompileFilters` and `BuildPagePlan`. `DBCaps.RowIdentifier` values asserted in Task 1's matrix match those returned in Tasks 4, 6, and 7.

**Known weakness — and a bug this plan originally shipped.** `dbquery` infers the dialect from capability flags (`supportsILIKE` and `textType` in Task 2) instead of naming it.

The first draft of this plan got that wrong in a way worth recording. `CompileFilters` downgraded `ILIKE` to `LIKE` when `caps.QuoteChar != '"'`, while `CompileGlobalSearch` twenty lines away tested `QuoteChar == '"' && caps.Schemas`. **SQLite quotes with a double quote exactly like PostgreSQL**, so the filter path would have emitted `ILIKE` against SQLite — an operator SQLite does not have — failing at runtime. The self-review note here even claimed the heuristic "works for exactly the three engines in Piece A", which was false: it was already broken for one of them.

Fixed by routing both call sites through a single `supportsILIKE(caps)`, with three tests pinning the behavior (`TestCompileFiltersDowngradesILIKEOnSQLite`, `TestCompileFiltersKeepsILIKEOnPostgres`, `TestCompileGlobalSearchMatchesFilterDialectChoice`).

The remaining weakness is real: quote character is not a dialect, and two inferred signals are standing in for one explicit fact. Adding a fourth engine must introduce `DBCaps.Dialect` rather than a third signal.

package port

import (
	"context"
	"errors"
)

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
	UsedOffsetPaging bool  `json:"usedOffsetPaging"`
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
	Unique  bool     `json:"unique"`
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

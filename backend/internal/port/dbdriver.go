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

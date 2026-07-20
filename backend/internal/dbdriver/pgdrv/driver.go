// Package pgdrv implements port.DBDriver for PostgreSQL.
//
// It mirrors the shape of sqlitedrv — same projection, paging and LOB-deferral
// rules — and differs only where the engine does: a schema layer, sibling
// databases, dollar placeholders, pg_catalog introspection, and real TLS.
package pgdrv

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"devdeck/backend/internal/dbdriver"
	"devdeck/backend/internal/dbquery"
	"devdeck/backend/internal/port"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

const (
	// defaultRowLimit and maxRowLimit bound every page, matching the other
	// drivers. A grid never needs more, and an unbounded page can pull an
	// entire table into memory.
	defaultRowLimit = 500
	maxRowLimit     = 5000

	defaultPort = 5432

	// defaultSchema is used when a request names no schema. PostgreSQL's own
	// default search_path starts with "public".
	defaultSchema = "public"
)

// caps is the fixed capability set for PostgreSQL.
var caps = port.DBCaps{
	Schemas:       true,
	MatViews:      true,
	Functions:     true,
	MultiDatabase: true,
	RowIdentifier: "ctid",
	SizeStats:     true,
	QuoteChar:     `"`,
}

type pgDriver struct{}

// New returns the PostgreSQL driver.
func New() port.DBDriver { return pgDriver{} }

func (pgDriver) Capabilities() port.DBCaps { return caps }

// Open dials the server described by d.
func (pgDriver) Open(ctx context.Context, d port.DSNDescriptor) (port.DBConn, error) {
	host := strings.TrimSpace(d.Host)
	if host == "" {
		return nil, errors.New("postgres: no host configured")
	}
	database := strings.TrimSpace(d.Database)
	if database == "" {
		return nil, errors.New("postgres: no database configured")
	}
	prt := d.Port
	if prt <= 0 {
		prt = defaultPort
	}

	tlsCfg, err := BuildTLSConfig(d)
	if err != nil {
		return nil, err
	}

	cfg, err := pgx.ParseConfig(dsnURL(host, prt, database, d))
	if err != nil {
		return nil, fmt.Errorf("postgres: %w", err)
	}
	if tlsCfg != nil {
		cfg.TLSConfig = tlsCfg
		// ParseConfig may have prepared a plaintext fallback for the weaker
		// sslmodes. Once we have installed a verifying config, a fallback would
		// let a server that refuses TLS silently downgrade the connection.
		cfg.Fallbacks = nil
	}
	if cfg.RuntimeParams == nil {
		cfg.RuntimeParams = map[string]string{}
	}
	// Engine-side enforcement: the context deadline aborts the client's wait,
	// but only statement_timeout stops the server still executing the query.
	cfg.RuntimeParams["statement_timeout"] = strconv.FormatInt(
		int64(dbdriver.DefaultStatementTimeout/time.Millisecond), 10)

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
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &conn{db: db}, nil
}

// dsnURL renders the connection URL handed to pgx.ParseConfig. Every component
// is escaped by net/url, so a password containing ':' or '@' cannot break out
// of its field.
func dsnURL(host string, prt int, database string, d port.DSNDescriptor) string {
	u := url.URL{
		Scheme: "postgres",
		Host:   net.JoinHostPort(host, strconv.Itoa(prt)),
		Path:   "/" + database,
	}
	if d.Username != "" {
		if d.Password != "" {
			u.User = url.UserPassword(d.Username, d.Password)
		} else {
			u.User = url.User(d.Username)
		}
	}
	q := url.Values{}
	if mode := strings.TrimSpace(d.SSLMode); mode != "" {
		q.Set("sslmode", mode)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// conn is one open PostgreSQL connection pool.
type conn struct {
	db *sql.DB
}

func (c *conn) Close() error { return c.db.Close() }

// --- introspection ---------------------------------------------------------

func (c *conn) Tree(ctx context.Context, p port.TreePath) ([]port.TreeNode, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	switch p.Kind {
	case "":
		// A connection is bound to one database, so the sibling databases are
		// listed for navigation while the schemas below belong to this one.
		return []port.TreeNode{
			{Name: "databases", Kind: "databases", HasChildren: true},
			{Name: "schemas", Kind: "schemas", HasChildren: true},
		}, nil
	case "databases":
		return c.names(ctx, "database",
			`SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY 1`)
	case "schemas":
		return c.names(ctx, "schema",
			`SELECT nspname FROM pg_namespace
			 WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
			 ORDER BY 1`)
	case "tables":
		// 'p' is a partitioned table: a table to every user-facing purpose,
		// invisible if only 'r' were listed.
		return c.relNames(ctx, p.Schema, "table", "r", "p")
	case "views":
		return c.relNames(ctx, p.Schema, "view", "v")
	case "matviews":
		return c.relNames(ctx, p.Schema, "matview", "m")
	case "functions":
		return c.names(ctx, "function",
			`SELECT p.proname FROM pg_proc p
			 JOIN pg_namespace n ON n.oid = p.pronamespace
			 WHERE n.nspname = $1
			 ORDER BY 1`, schemaOr(p.Schema))
	default:
		// Unsupported collections are empty rather than an error: the caller
		// asks generically across engines.
		return []port.TreeNode{}, nil
	}
}

// relNames lists pg_class entries of the given relkinds in one schema.
func (c *conn) relNames(ctx context.Context, schema, kind string, relkinds ...string) ([]port.TreeNode, error) {
	return c.names(ctx, kind,
		`SELECT c.relname FROM pg_class c
		 JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = $1 AND c.relkind::text = ANY($2::text[])
		 ORDER BY 1`, schemaOr(schema), pgTextArray(relkinds))
}

func (c *conn) names(ctx context.Context, kind, query string, args ...any) ([]port.TreeNode, error) {
	rows, err := c.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []port.TreeNode{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, port.TreeNode{Name: name, Kind: kind, HasChildren: true})
	}
	return out, rows.Err()
}

// pgTextArray renders a literal text[] for a bound parameter. The values are
// fixed relkind letters chosen in this file, never user input.
func pgTextArray(vals []string) string {
	return "{" + strings.Join(vals, ",") + "}"
}

func schemaOr(schema string) string {
	if s := strings.TrimSpace(schema); s != "" {
		return s
	}
	return defaultSchema
}

func (c *conn) Columns(ctx context.Context, obj port.ObjectRef) ([]port.ColumnMeta, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()
	cols, _, err := c.columnInfo(ctx, obj)
	return cols, err
}

// columnInfo returns the column metadata plus the primary-key column names in
// key order.
func (c *conn) columnInfo(ctx context.Context, obj port.ObjectRef) ([]port.ColumnMeta, []string, error) {
	rows, err := c.db.QueryContext(ctx, `
		SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
		       c.ordinal_position, COALESCE(pk.key_pos, 0)
		FROM information_schema.columns c
		LEFT JOIN (
			SELECT a.attname, k.ord AS key_pos
			FROM pg_index i
			JOIN pg_class t ON t.oid = i.indrelid
			JOIN pg_namespace n ON n.oid = t.relnamespace
			JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ON true
			JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
			WHERE i.indisprimary AND t.relname = $1 AND n.nspname = $2
		) pk ON pk.attname = c.column_name
		WHERE c.table_name = $1 AND c.table_schema = $2
		ORDER BY c.ordinal_position`, obj.Name, schemaOr(obj.Schema))
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	var cols []port.ColumnMeta
	type pkEntry struct {
		name string
		pos  int
	}
	var pks []pkEntry

	for rows.Next() {
		var (
			name     string
			dataType string
			isNull   string
			dflt     sql.NullString
			ordinal  int
			keyPos   int
		)
		if err := rows.Scan(&name, &dataType, &isNull, &dflt, &ordinal, &keyPos); err != nil {
			return nil, nil, err
		}
		col := port.ColumnMeta{
			Name:            name,
			DataType:        dataType,
			Nullable:        strings.EqualFold(isNull, "YES"),
			IsPrimaryKey:    keyPos > 0,
			OrdinalPosition: ordinal,
			IsLOB:           isLOB(dataType),
			Comparable:      isComparable(dataType),
		}
		if dflt.Valid {
			v := dflt.String
			col.Default = &v
		}
		cols = append(cols, col)
		if keyPos > 0 {
			pks = append(pks, pkEntry{name: name, pos: keyPos})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	// A composite key must be ordered by its position within the index, not by
	// column order — the cursor tuple has to line up with ORDER BY.
	pkNames := make([]string, 0, len(pks))
	for pos := 1; pos <= len(pks); pos++ {
		for _, e := range pks {
			if e.pos == pos {
				pkNames = append(pkNames, e.name)
			}
		}
	}
	if len(pkNames) != len(pks) {
		pkNames = pkNames[:0]
		for _, e := range pks {
			pkNames = append(pkNames, e.name)
		}
	}
	return cols, pkNames, nil
}

// lobTypes are the types whose values are deferred out of a grid page.
var lobTypes = map[string]bool{"bytea": true}

// uncomparableTypes are the types for which `col = value` is unreliable or
// invalid: floats round, json has no equality operator, and bytea comparison is
// a full-blob memcmp that says nothing useful about row identity.
var uncomparableTypes = map[string]bool{
	"bytea":            true,
	"json":             true,
	"jsonb":            true,
	"real":             true,
	"double precision": true,
	"float4":           true,
	"float8":           true,
	"array":            true,
	"user-defined":     true,
}

// normalizeType folds the two spellings we see: information_schema's
// "double precision" and the driver's "FLOAT8" from ColumnTypes().
func normalizeType(dataType string) string {
	return strings.ToLower(strings.TrimSpace(dataType))
}

func isLOB(dataType string) bool { return lobTypes[normalizeType(dataType)] }

func isComparable(dataType string) bool {
	t := normalizeType(dataType)
	if uncomparableTypes[t] {
		return false
	}
	// information_schema reports every array type as the single value "ARRAY";
	// the driver reports "_int4" and friends.
	return !strings.HasPrefix(t, "_")
}

func (c *conn) Indexes(ctx context.Context, obj port.ObjectRef) ([]port.IndexMeta, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	rows, err := c.db.QueryContext(ctx, `
		SELECT i.relname, ix.indisunique, ix.indisprimary, a.attname, a.attnotnull
		FROM pg_index ix
		JOIN pg_class t ON t.oid = ix.indrelid
		JOIN pg_class i ON i.oid = ix.indexrelid
		JOIN pg_namespace n ON n.oid = t.relnamespace
		JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ON true
		LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
		WHERE t.relname = $1 AND n.nspname = $2
		ORDER BY i.relname, k.ord`, obj.Name, schemaOr(obj.Schema))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []port.IndexMeta{}
	byName := map[string]int{}
	for rows.Next() {
		var (
			idxName string
			unique  bool
			primary bool
			colName sql.NullString
			notNull sql.NullBool
		)
		if err := rows.Scan(&idxName, &unique, &primary, &colName, &notNull); err != nil {
			return nil, err
		}
		pos, ok := byName[idxName]
		if !ok {
			out = append(out, port.IndexMeta{
				Name: idxName, Unique: unique, Primary: primary, Columns: []string{},
			})
			pos = len(out) - 1
			byName[idxName] = pos
		}
		// attname is NULL for an expression index member: there is no column to
		// name, and no nullability to report.
		if !colName.Valid {
			continue
		}
		out[pos].Columns = append(out[pos].Columns, colName.String)
		if notNull.Valid && !notNull.Bool {
			out[pos].Nullable = true
		}
	}
	return out, rows.Err()
}

// --- reads -----------------------------------------------------------------

func (c *conn) Rows(ctx context.Context, r port.RowsRequest) (port.ResultSet, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	start := time.Now()
	res := port.ResultSet{Rows: [][]any{}}

	cols, pk, err := c.columnInfo(ctx, r.Object)
	if err != nil {
		return res, err
	}
	if len(cols) == 0 {
		return res, fmt.Errorf("postgres: %q has no columns", r.Object.Name)
	}
	target, err := dbquery.QuoteObject(qualified(r.Object), caps)
	if err != nil {
		return res, err
	}

	where, args, err := dbquery.CompileFilters(r.Filters, cols, caps, dbquery.DollarPlaceholder)
	if err != nil {
		return res, err
	}
	if r.GlobalSearch != "" {
		gs, gargs, err := dbquery.CompileGlobalSearch(r.GlobalSearch, cols, caps, dbquery.DollarPlaceholder)
		if err != nil {
			return res, err
		}
		if gs != "" {
			if where == "" {
				where = gs
			} else {
				where += " AND " + gs
			}
			args = append(args, gargs...)
		}
	}

	plan, err := dbquery.BuildPagePlan(r.Sort, pk, cols, r.Cursor, caps, dbquery.DollarPlaceholder, len(args))
	if err != nil {
		return res, err
	}
	args = append(args, plan.Args...)

	// Displayed projection: bytea columns become a byte count, so one page of a
	// table with binary columns cannot pull hundreds of megabytes.
	selects := make([]string, 0, len(cols)+len(plan.KeyColumns))
	for _, col := range cols {
		q, err := dbquery.QuoteIdent(col.Name, caps.QuoteChar)
		if err != nil {
			return res, err
		}
		if col.IsLOB {
			selects = append(selects, "octet_length("+q+")")
		} else {
			selects = append(selects, q)
		}
	}
	// The ordering tuple is appended after the projection so the next cursor
	// can be read even when a key column was replaced by a length placeholder.
	keyOffset := len(selects)
	for _, k := range plan.KeyColumns {
		q, err := dbquery.QuoteIdent(k, caps.QuoteChar)
		if err != nil {
			return res, err
		}
		selects = append(selects, q)
	}

	limit := clampLimit(r.Limit)

	var b strings.Builder
	b.WriteString("SELECT ")
	b.WriteString(strings.Join(selects, ", "))
	b.WriteString(" FROM ")
	b.WriteString(target)
	var conds []string
	if where != "" {
		conds = append(conds, where)
	}
	if plan.Where != "" {
		conds = append(conds, plan.Where)
	}
	if len(conds) > 0 {
		b.WriteString(" WHERE ")
		b.WriteString(strings.Join(conds, " AND "))
	}
	if plan.OrderBy != "" {
		b.WriteString(" ORDER BY ")
		b.WriteString(plan.OrderBy)
	}
	// limit and offset are integers, never operator or identifier text.
	b.WriteString(" LIMIT " + strconv.Itoa(limit))
	if plan.UseOffset && r.Offset > 0 {
		b.WriteString(" OFFSET " + strconv.Itoa(r.Offset))
	}

	rows, err := c.db.QueryContext(ctx, b.String(), args...)
	if err != nil {
		return res, err
	}
	defer rows.Close()

	var lastKey []any
	for rows.Next() {
		vals, err := scanRow(rows, len(selects))
		if err != nil {
			return res, err
		}
		res.Rows = append(res.Rows, vals[:keyOffset])
		lastKey = vals[keyOffset:]
	}
	if err := rows.Err(); err != nil {
		return res, err
	}

	res.Columns = cols
	res.Truncated = len(res.Rows) == limit
	res.UsedOffsetPaging = plan.UseOffset
	if !plan.UseOffset && len(lastKey) > 0 {
		res.NextCursor = lastKey
	}
	res.ElapsedMS = time.Since(start).Milliseconds()
	return res, nil
}

// qualified fills in the default schema so QuoteObject always emits a
// schema-qualified name. Relying on search_path instead would resolve the same
// request to different tables for different roles.
func qualified(obj port.ObjectRef) port.ObjectRef {
	obj.Schema = schemaOr(obj.Schema)
	return obj
}

func (c *conn) Query(ctx context.Context, sqlText string, args []any) (port.ResultSet, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	start := time.Now()
	res := port.ResultSet{Rows: [][]any{}}

	rows, err := c.db.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return res, err
	}
	defer rows.Close()

	names, err := rows.Columns()
	if err != nil {
		return res, err
	}
	types, err := rows.ColumnTypes()
	if err != nil {
		return res, err
	}
	res.Columns = make([]port.ColumnMeta, len(names))
	for i, n := range names {
		dt := ""
		nullable := true
		if i < len(types) {
			dt = types[i].DatabaseTypeName()
			if ok, known := types[i].Nullable(); known {
				nullable = ok
			}
		}
		res.Columns[i] = port.ColumnMeta{
			Name:            n,
			DataType:        dt,
			Nullable:        nullable,
			OrdinalPosition: i + 1,
			IsLOB:           isLOB(dt),
			Comparable:      isComparable(dt),
		}
	}

	limit := clampLimit(0)
	for rows.Next() {
		if len(res.Rows) == limit {
			res.Truncated = true
			break
		}
		vals, err := scanRow(rows, len(names))
		if err != nil {
			return res, err
		}
		res.Rows = append(res.Rows, vals)
	}
	if !res.Truncated {
		if err := rows.Err(); err != nil {
			return res, err
		}
	}
	res.ElapsedMS = time.Since(start).Milliseconds()
	return res, nil
}

func (c *conn) Exec(ctx context.Context, sqlText string, args []any) (port.ExecResult, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	start := time.Now()
	r, err := c.db.ExecContext(ctx, sqlText, args...)
	if err != nil {
		return port.ExecResult{}, err
	}
	n, err := r.RowsAffected()
	if err != nil {
		// Some statements report no affected-row count; that is not a failure.
		n = 0
	}
	return port.ExecResult{RowsAffected: n, ElapsedMS: time.Since(start).Milliseconds()}, nil
}

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

func (c *conn) CountExact(ctx context.Context, obj port.ObjectRef, filters []port.Filter) (int64, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	cols, _, err := c.columnInfo(ctx, obj)
	if err != nil {
		return 0, err
	}
	target, err := dbquery.QuoteObject(qualified(obj), caps)
	if err != nil {
		return 0, err
	}
	where, args, err := dbquery.CompileFilters(filters, cols, caps, dbquery.DollarPlaceholder)
	if err != nil {
		return 0, err
	}
	q := "SELECT COUNT(*) FROM " + target
	if where != "" {
		q += " WHERE " + where
	}
	var n int64
	if err := c.db.QueryRowContext(ctx, q, args...).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

func (c *conn) LOBValue(ctx context.Context, obj port.ObjectRef, column string, identity []port.Filter) ([]byte, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	cols, _, err := c.columnInfo(ctx, obj)
	if err != nil {
		return nil, err
	}
	var found bool
	for _, col := range cols {
		if col.Name == column {
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("unknown column %q", column)
	}
	quotedCol, err := dbquery.QuoteIdent(column, caps.QuoteChar)
	if err != nil {
		return nil, err
	}
	target, err := dbquery.QuoteObject(qualified(obj), caps)
	if err != nil {
		return nil, err
	}
	where, args, err := dbquery.CompileFilters(identity, cols, caps, dbquery.DollarPlaceholder)
	if err != nil {
		return nil, err
	}
	// Without an identity predicate this would return an arbitrary row's blob.
	if where == "" {
		return nil, errors.New("a row identity predicate is required to fetch a large object")
	}

	// LIMIT 2 so an ambiguous identity is detected rather than silently
	// returning whichever row the engine happened to visit first.
	rows, err := c.db.QueryContext(ctx,
		"SELECT "+quotedCol+" FROM "+target+" WHERE "+where+" LIMIT 2", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out [][]byte
	for rows.Next() {
		var v []byte
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	switch len(out) {
	case 0:
		return nil, errors.New("no row matches the supplied identity")
	case 1:
		return out[0], nil
	default:
		return nil, errors.New("the supplied identity matches more than one row")
	}
}

func (c *conn) Stats(ctx context.Context, obj port.ObjectRef) (port.TableStats, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	var st port.TableStats
	var (
		reltuples float64
		total     sql.NullInt64
		indexes   sql.NullInt64
		analyzed  bool
	)
	err := c.db.QueryRowContext(ctx, `
		SELECT c.reltuples,
		       pg_total_relation_size(c.oid),
		       pg_indexes_size(c.oid),
		       (s.last_analyze IS NOT NULL OR s.last_autoanalyze IS NOT NULL)
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
		WHERE c.relname = $1 AND n.nspname = $2`,
		obj.Name, schemaOr(obj.Schema)).Scan(&reltuples, &total, &indexes, &analyzed)
	if errors.Is(err, sql.ErrNoRows) {
		return st, fmt.Errorf("postgres: no such relation %q", obj.Name)
	}
	if err != nil {
		return st, err
	}

	st.Analyzed = analyzed
	if total.Valid {
		v := total.Int64
		st.TotalBytes = &v
	}
	if indexes.Valid {
		v := indexes.Int64
		st.IndexBytes = &v
	}

	// PostgreSQL reports reltuples = -1 for a table that has never been
	// analyzed, and legacy versions report an ambiguous 0. Either way the row
	// count is unknown, and rendering unknown as 0 would be a fabricated
	// number an operator could act on.
	switch {
	case reltuples < 0:
	case reltuples == 0 && !analyzed:
	default:
		v := int64(reltuples)
		st.EstRows = &v
	}
	return st, nil
}

// --- helpers ---------------------------------------------------------------

// clampLimit bounds a requested page size.
func clampLimit(n int) int {
	if n <= 0 {
		return defaultRowLimit
	}
	if n > maxRowLimit {
		return maxRowLimit
	}
	return n
}

// scanRow reads one row into a slice of driver-native values.
func scanRow(rows *sql.Rows, n int) ([]any, error) {
	vals := make([]any, n)
	ptrs := make([]any, n)
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		return nil, err
	}
	return vals, nil
}

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

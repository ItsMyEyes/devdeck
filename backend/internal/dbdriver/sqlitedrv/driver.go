// Package sqlitedrv implements port.DBDriver for SQLite database files.
//
// SQLite is the simplest engine in the set: one file, no schema layer, no
// sibling databases. It is also the only one that needs no server, which makes
// it the reference implementation the other drivers mirror.
package sqlitedrv

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"devdeck/backend/internal/dbdriver"
	"devdeck/backend/internal/dbquery"
	"devdeck/backend/internal/port"

	_ "modernc.org/sqlite"
)

const (
	// busyTimeoutMS matches the rest of the project: a writer that finds the
	// database locked waits rather than failing immediately.
	busyTimeoutMS = 5000

	// defaultRowLimit and maxRowLimit bound every page. A grid never needs
	// more, and an unbounded page can pull an entire table into memory.
	defaultRowLimit = 500
	maxRowLimit     = 5000
)

// caps is the fixed capability set for SQLite.
var caps = port.DBCaps{
	Schemas:       false,
	MatViews:      false,
	Functions:     false,
	MultiDatabase: false,
	RowIdentifier: "rowid",
	SizeStats:     false,
	QuoteChar:     `"`,
}

type sqliteDriver struct{}

// New returns the SQLite driver.
func New() port.DBDriver { return sqliteDriver{} }

func (sqliteDriver) Capabilities() port.DBCaps { return caps }

// Open opens the database file named by d.Database.
func (sqliteDriver) Open(ctx context.Context, d port.DSNDescriptor) (port.DBConn, error) {
	// A local file has nothing to tunnel to. Ignoring the tunnel silently would
	// hide a misconfiguration that the operator believes is protecting them.
	if d.Tunnel != nil {
		return nil, errors.New("sqlite: a local database file cannot be reached through an SSH tunnel")
	}
	path := strings.TrimSpace(d.Database)
	if path == "" {
		return nil, errors.New("sqlite: no database file configured")
	}

	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	dsn := path + sep + "_pragma=busy_timeout(" + strconv.Itoa(busyTimeoutMS) + ")"

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite serializes writers anyway, and an in-memory database is scoped to
	// a single connection — a second pooled connection would open a separate,
	// empty database.
	db.SetMaxOpenConns(1)

	pingCtx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &conn{db: db}, nil
}

// conn is one open SQLite database.
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
		// SQLite has no databases or schemas to expand, so the root is the
		// fixed pair of child collections.
		return []port.TreeNode{
			{Name: "tables", Kind: "tables", HasChildren: true},
			{Name: "views", Kind: "views", HasChildren: true},
		}, nil
	case "tables":
		return c.masterNames(ctx, "table")
	case "views":
		return c.masterNames(ctx, "view")
	default:
		// Unsupported collections (schemas, matviews, functions) are empty
		// rather than an error: the caller asks generically across engines.
		return []port.TreeNode{}, nil
	}
}

// masterNames lists sqlite_master entries of one type, excluding SQLite's own
// bookkeeping tables (sqlite_sequence, sqlite_stat1, …).
func (c *conn) masterNames(ctx context.Context, typ string) ([]port.TreeNode, error) {
	rows, err := c.db.QueryContext(ctx,
		`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`, typ)
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
		out = append(out, port.TreeNode{Name: name, Kind: typ, HasChildren: true})
	}
	return out, rows.Err()
}

func (c *conn) Columns(ctx context.Context, obj port.ObjectRef) ([]port.ColumnMeta, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()
	cols, _, _, err := c.tableInfo(ctx, obj)
	return cols, err
}

// tableInfo reads PRAGMA table_info and returns the column metadata, the
// primary-key column names in key order, and whether the object has a rowid.
func (c *conn) tableInfo(ctx context.Context, obj port.ObjectRef) ([]port.ColumnMeta, []string, bool, error) {
	quoted, err := dbquery.QuoteIdent(obj.Name, caps.QuoteChar)
	if err != nil {
		return nil, nil, false, err
	}
	// A PRAGMA cannot take a bind parameter, so the name is quoted instead —
	// QuoteIdent rejects anything containing the quote character.
	rows, err := c.db.QueryContext(ctx, "PRAGMA table_info("+quoted+")")
	if err != nil {
		return nil, nil, false, err
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
			cid      int
			name     string
			declType sql.NullString
			notNull  int
			dflt     sql.NullString
			pk       int
		)
		if err := rows.Scan(&cid, &name, &declType, &notNull, &dflt, &pk); err != nil {
			return nil, nil, false, err
		}
		col := port.ColumnMeta{
			Name:            name,
			DataType:        declType.String,
			Nullable:        notNull == 0,
			IsPrimaryKey:    pk > 0,
			OrdinalPosition: cid + 1,
			IsLOB:           isLOB(declType.String),
			Comparable:      isComparable(declType.String),
		}
		if dflt.Valid {
			v := dflt.String
			col.Default = &v
		}
		cols = append(cols, col)
		if pk > 0 {
			pks = append(pks, pkEntry{name: name, pos: pk})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, false, err
	}

	// The rowid lookup must come after the PRAGMA cursor is drained: the pool
	// is capped at one connection, so a nested query would deadlock.
	noRowid, err := c.isWithoutRowid(ctx, obj)
	if err != nil {
		return nil, nil, false, err
	}

	// SQLite reports notnull = 0 for columns that can nonetheless never hold
	// NULL. On a rowid table a lone INTEGER PRIMARY KEY is an alias for the
	// rowid and is always assigned a value; on a WITHOUT ROWID table every
	// primary-key column is implicitly NOT NULL. Taking notnull at face value
	// here would mark the most common table shape there is as nullable and
	// push keyset paging into its OFFSET fallback for every such table.
	for i := range cols {
		if !cols[i].IsPrimaryKey {
			continue
		}
		isRowidAlias := len(pks) == 1 && strings.EqualFold(strings.TrimSpace(cols[i].DataType), "INTEGER")
		if noRowid || isRowidAlias {
			cols[i].Nullable = false
		}
	}

	// PRAGMA table_info reports pk as the 1-based position within the key, so
	// a composite key must be ordered by it rather than by column order.
	var pkNames []string
	for pos := 1; pos <= len(pks); pos++ {
		for _, e := range pks {
			if e.pos == pos {
				pkNames = append(pkNames, e.name)
			}
		}
	}
	if len(pkNames) != len(pks) {
		// Defensive: unexpected pk numbering, fall back to declaration order.
		pkNames = pkNames[:0]
		for _, e := range pks {
			pkNames = append(pkNames, e.name)
		}
	}
	return cols, pkNames, !noRowid, nil
}

// isLOB reports whether a declared type holds large binary data. The grid
// receives a size for these instead of the bytes.
func isLOB(declType string) bool {
	return strings.Contains(strings.ToUpper(declType), "BLOB")
}

// isComparable reports whether `col = ?` is a meaningful predicate for the
// declared type. Floats compare unreliably, and blobs and JSON documents have
// no useful equality for row identity.
func isComparable(declType string) bool {
	up := strings.ToUpper(declType)
	for _, bad := range []string{"BLOB", "REAL", "FLOAT", "DOUBLE", "JSON"} {
		if strings.Contains(up, bad) {
			return false
		}
	}
	return true
}

func (c *conn) Indexes(ctx context.Context, obj port.ObjectRef) ([]port.IndexMeta, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	cols, _, _, err := c.tableInfo(ctx, obj)
	if err != nil {
		return nil, err
	}
	nullable := map[string]bool{}
	for _, col := range cols {
		nullable[col.Name] = col.Nullable
	}

	names, err := c.indexNames(ctx, obj)
	if err != nil {
		return nil, err
	}

	out := []port.IndexMeta{}
	for _, entry := range names {
		quoted, err := dbquery.QuoteIdent(entry.name, caps.QuoteChar)
		if err != nil {
			return nil, err
		}
		rows, err := c.db.QueryContext(ctx, "PRAGMA index_info("+quoted+")")
		if err != nil {
			return nil, err
		}
		idx := port.IndexMeta{
			Name:    entry.name,
			Unique:  entry.unique,
			Primary: entry.origin == "pk",
			Columns: []string{},
		}
		for rows.Next() {
			var (
				seqno, cid int
				colName    sql.NullString
			)
			if err := rows.Scan(&seqno, &cid, &colName); err != nil {
				rows.Close()
				return nil, err
			}
			// colName is NULL for an expression index; there is no column to
			// name, and no nullability to report.
			if !colName.Valid {
				continue
			}
			idx.Columns = append(idx.Columns, colName.String)
			if nullable[colName.String] {
				idx.Nullable = true
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
		out = append(out, idx)
	}
	return out, nil
}

type indexEntry struct {
	name   string
	unique bool
	origin string
}

func (c *conn) indexNames(ctx context.Context, obj port.ObjectRef) ([]indexEntry, error) {
	quoted, err := dbquery.QuoteIdent(obj.Name, caps.QuoteChar)
	if err != nil {
		return nil, err
	}
	rows, err := c.db.QueryContext(ctx, "PRAGMA index_list("+quoted+")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []indexEntry
	for rows.Next() {
		var (
			seq     int
			name    string
			unique  int
			origin  sql.NullString
			partial int
		)
		if err := rows.Scan(&seq, &name, &unique, &origin, &partial); err != nil {
			return nil, err
		}
		out = append(out, indexEntry{name: name, unique: unique == 1, origin: origin.String})
	}
	return out, rows.Err()
}

// --- reads -----------------------------------------------------------------

func (c *conn) Rows(ctx context.Context, r port.RowsRequest) (port.ResultSet, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	start := time.Now()
	res := port.ResultSet{Rows: [][]any{}}

	cols, pk, hasRowid, err := c.tableInfo(ctx, r.Object)
	if err != nil {
		return res, err
	}
	if len(cols) == 0 {
		return res, fmt.Errorf("sqlite: %q has no columns", r.Object.Name)
	}
	target, err := dbquery.QuoteObject(r.Object, caps)
	if err != nil {
		return res, err
	}

	where, args, err := dbquery.CompileFilters(r.Filters, cols, caps, dbquery.QuestionPlaceholder)
	if err != nil {
		return res, err
	}
	if r.GlobalSearch != "" {
		gs, gargs, err := dbquery.CompileGlobalSearch(r.GlobalSearch, cols, caps, dbquery.QuestionPlaceholder)
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

	identity := identityColumns(pk, hasRowid)
	plan, err := dbquery.BuildPagePlan(r.Sort, identity, cols, r.Cursor, caps, dbquery.QuestionPlaceholder, len(args))
	if err != nil {
		return res, err
	}
	args = append(args, plan.Args...)

	// Displayed projection: LOB columns become a byte count, so one page of a
	// table with binary columns cannot pull hundreds of megabytes.
	selects := make([]string, 0, len(cols)+len(plan.KeyColumns))
	for _, col := range cols {
		q, err := dbquery.QuoteIdent(col.Name, caps.QuoteChar)
		if err != nil {
			return res, err
		}
		if col.IsLOB {
			selects = append(selects, "length("+q+")")
		} else {
			selects = append(selects, q)
		}
	}
	// The ordering tuple is appended after the projection so the next cursor
	// can be read even when a key column is not displayed (rowid) or was
	// replaced by a length() placeholder.
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

// identityColumns returns the columns that address a row uniquely: the primary
// key when there is one, otherwise SQLite's rowid. A view, or a WITHOUT ROWID
// table with no usable primary key, has neither — keyset paging then falls
// back to OFFSET rather than paging on an ambiguous key.
func identityColumns(pk []string, hasRowid bool) []string {
	if len(pk) > 0 {
		return pk
	}
	if !hasRowid {
		return nil
	}
	return []string{caps.RowIdentifier}
}

// isWithoutRowid reports whether the object lacks a rowid. Views are not in
// sqlite_master as tables and have no rowid either, so a missing row counts.
func (c *conn) isWithoutRowid(ctx context.Context, obj port.ObjectRef) (bool, error) {
	var ddl sql.NullString
	err := c.db.QueryRowContext(ctx,
		`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, obj.Name).Scan(&ddl)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return strings.Contains(strings.ToUpper(ddl.String), "WITHOUT ROWID"), nil
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

func (c *conn) CountExact(ctx context.Context, obj port.ObjectRef, filters []port.Filter) (int64, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	cols, _, _, err := c.tableInfo(ctx, obj)
	if err != nil {
		return 0, err
	}
	target, err := dbquery.QuoteObject(obj, caps)
	if err != nil {
		return 0, err
	}
	where, args, err := dbquery.CompileFilters(filters, cols, caps, dbquery.QuestionPlaceholder)
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

	cols, _, _, err := c.tableInfo(ctx, obj)
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
	target, err := dbquery.QuoteObject(obj, caps)
	if err != nil {
		return nil, err
	}
	where, args, err := dbquery.CompileFilters(identity, cols, caps, dbquery.QuestionPlaceholder)
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
	target, err := dbquery.QuoteObject(obj, caps)
	if err != nil {
		return st, err
	}

	// SQLite keeps no estimated row count. Databases here are small enough that
	// an exact count is affordable, and it beats reporting nothing.
	var n int64
	if err := c.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+target).Scan(&n); err != nil {
		return st, err
	}
	st.EstRows = &n

	// dbstat is a compile-time option and is often absent. Without it the size
	// is genuinely unknown, and nil renders as "—" rather than a fabricated 0.
	if !c.hasDbstat(ctx) {
		return st, nil
	}

	idxs, err := c.indexNames(ctx, obj)
	if err != nil {
		return st, err
	}
	idxNames := make([]string, 0, len(idxs))
	for _, e := range idxs {
		idxNames = append(idxNames, e.name)
	}

	total, err := c.sumPgsize(ctx, append([]string{obj.Name}, idxNames...))
	if err != nil {
		return st, err
	}
	st.TotalBytes = &total

	if len(idxNames) > 0 {
		idxBytes, err := c.sumPgsize(ctx, idxNames)
		if err != nil {
			return st, err
		}
		st.IndexBytes = &idxBytes
	}
	st.Analyzed = true
	return st, nil
}

// hasDbstat probes for the dbstat virtual table. An empty database yields no
// rows, which is availability rather than absence.
func (c *conn) hasDbstat(ctx context.Context) bool {
	var one int
	err := c.db.QueryRowContext(ctx, "SELECT 1 FROM dbstat LIMIT 1").Scan(&one)
	return err == nil || errors.Is(err, sql.ErrNoRows)
}

// sumPgsize totals the on-disk page bytes of the named btrees.
func (c *conn) sumPgsize(ctx context.Context, names []string) (int64, error) {
	if len(names) == 0 {
		return 0, nil
	}
	ph := make([]string, len(names))
	args := make([]any, len(names))
	for i, n := range names {
		ph[i] = "?"
		args[i] = n
	}
	var total int64
	err := c.db.QueryRowContext(ctx,
		"SELECT COALESCE(SUM(pgsize), 0) FROM dbstat WHERE name IN ("+strings.Join(ph, ", ")+")",
		args...).Scan(&total)
	if err != nil {
		return 0, err
	}
	return total, nil
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

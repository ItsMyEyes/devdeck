// Package mysqldrv implements port.DBDriver for MySQL and MariaDB.
//
// It mirrors the SQLite reference driver in shape. The two engine-specific
// facts that shape everything here are that MySQL has no schema layer (a
// "database" is the only container, so ObjectRef.Database is what qualifies a
// table) and that it exposes no stable physical row address — Capabilities
// reports an empty RowIdentifier, which is why Phase 3's identity ladder has to
// fall through to an all-column predicate on this engine.
package mysqldrv

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"devdeck/backend/internal/dbdriver"
	"devdeck/backend/internal/dbquery"
	"devdeck/backend/internal/port"

	"github.com/go-sql-driver/mysql"
)

const (
	// defaultRowLimit and maxRowLimit bound every page. A grid never needs more,
	// and an unbounded page can pull an entire table into memory.
	defaultRowLimit = 500
	maxRowLimit     = 5000

	// defaultPort is used when a descriptor carries no port.
	defaultPort = 3306

	// erUnknownSystemVariable is MySQL's error for an unknown system variable.
	// MariaDB has no max_execution_time, so setting it must degrade rather than
	// make the connection unusable.
	erUnknownSystemVariable = 1193
)

// systemSchemas are MySQL's own bookkeeping databases. They are hidden from the
// tree the same way sqlite_% tables are.
var systemSchemas = map[string]bool{
	"information_schema": true,
	"performance_schema": true,
	"mysql":              true,
	"sys":                true,
}

// caps is the fixed capability set for MySQL.
var caps = port.DBCaps{
	Schemas:       false,
	MatViews:      false,
	Functions:     true,
	MultiDatabase: true,
	// Empty on purpose: MySQL exposes no stable per-row physical address.
	RowIdentifier: "",
	SizeStats:     true,
	QuoteChar:     "`",
}

type mysqlDriver struct{}

// New returns the MySQL driver.
func New() port.DBDriver { return mysqlDriver{} }

func (mysqlDriver) Capabilities() port.DBCaps { return caps }

// Open dials the server described by d.
func (mysqlDriver) Open(ctx context.Context, d port.DSNDescriptor) (port.DBConn, error) {
	// Tunnel dialing is a separate unit (dbdriver.OpenTunnel). Until it is wired
	// in here, accepting a tunnel descriptor would open a *direct* connection
	// while the operator believes traffic is going through their bastion.
	if d.Tunnel != nil {
		return nil, errors.New("mysql: SSH tunneled connections are not supported by this driver yet")
	}
	host := strings.TrimSpace(d.Host)
	if host == "" {
		return nil, errors.New("mysql: no host configured")
	}
	p := d.Port
	if p <= 0 {
		p = defaultPort
	}

	tlsCfg, err := buildTLSConfig(d)
	if err != nil {
		return nil, err
	}

	newCfg := func(withTimeout bool) *mysql.Config {
		cfg := mysql.NewConfig()
		cfg.Net = "tcp"
		cfg.Addr = net.JoinHostPort(host, strconv.Itoa(p))
		cfg.User = d.Username
		cfg.Passwd = d.Password
		cfg.DBName = d.Database
		cfg.TLS = tlsCfg
		// "preferred" is the only mode that may silently continue without TLS;
		// every other mode requires the handshake to succeed.
		cfg.AllowFallbackToPlaintext = d.SSLMode == "preferred"
		if withTimeout {
			// Engine-side enforcement of the statement timeout. Params are
			// applied as `SET <name> = <value>` on every new pooled connection,
			// so it survives the pool rather than binding to one session.
			cfg.Params = map[string]string{
				"max_execution_time": strconv.FormatInt(dbdriver.DefaultStatementTimeout.Milliseconds(), 10),
			}
		}
		return cfg
	}

	db, err := openAndPing(ctx, newCfg(true))
	if err != nil && isUnknownSystemVariable(err) {
		// MariaDB (and MySQL < 5.7.8) has no max_execution_time. Drop the
		// engine-side bound rather than refusing to connect; the context
		// deadline from WithStatementTimeout still cancels every statement.
		db, err = openAndPing(ctx, newCfg(false))
	}
	if err != nil {
		return nil, err
	}

	c := &conn{db: db, defaultDB: d.Database}
	if c.defaultDB == "" {
		// Without a default database, information_schema lookups have nothing to
		// scope to. Ask the server what it selected, if anything.
		var cur sql.NullString
		pingCtx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
		defer cancel()
		if err := db.QueryRowContext(pingCtx, "SELECT DATABASE()").Scan(&cur); err == nil && cur.Valid {
			c.defaultDB = cur.String
		}
	}
	return c, nil
}

func openAndPing(ctx context.Context, cfg *mysql.Config) (*sql.DB, error) {
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, err
	}
	db := sql.OpenDB(connector)
	pingCtx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func isUnknownSystemVariable(err error) bool {
	var me *mysql.MySQLError
	return errors.As(err, &me) && me.Number == erUnknownSystemVariable
}

// --- TLS -------------------------------------------------------------------

// buildTLSConfig translates a descriptor's sslMode into a *tls.Config, using
// MySQL's mode vocabulary (service.ValidateSSLMode already rejects unverified
// modes for connections marked production).
//
// A nil config means "no TLS". The unverified modes are deliberately explicit:
// encryption without authentication does not stop an attacker in the path, so
// each one is named rather than reached by falling through a default.
func buildTLSConfig(d port.DSNDescriptor) (*tls.Config, error) {
	switch d.SSLMode {
	case "", "false":
		return nil, nil
	case "skip-verify", "preferred", "true", "verify-ca", "verify-identity":
	default:
		return nil, fmt.Errorf("mysql: unknown sslMode %q", d.SSLMode)
	}

	cfg := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: d.Host}

	var roots *x509.CertPool
	if d.CACert != "" {
		roots = x509.NewCertPool()
		if !roots.AppendCertsFromPEM([]byte(d.CACert)) {
			// Falling back to the system roots here would quietly verify against
			// a completely different trust anchor than the operator configured.
			return nil, errors.New("mysql: the supplied CA certificate is not a valid PEM bundle")
		}
		cfg.RootCAs = roots
	}
	if d.ClientCert != "" && d.ClientKey != "" {
		pair, err := tls.X509KeyPair([]byte(d.ClientCert), []byte(d.ClientKey))
		if err != nil {
			return nil, fmt.Errorf("mysql: client certificate: %w", err)
		}
		cfg.Certificates = []tls.Certificate{pair}
	}

	switch d.SSLMode {
	case "skip-verify", "preferred":
		// Encrypted but unauthenticated; permitted only for non-production.
		cfg.InsecureSkipVerify = true
	case "verify-ca":
		// verify-ca validates the chain but not the hostname. Go has no built-in
		// switch for that, so the standard verification is turned off and the
		// chain is rebuilt by hand with no DNSName.
		cfg.InsecureSkipVerify = true
		cfg.VerifyPeerCertificate = chainVerifier(roots)
	case "true", "verify-identity":
		// Full verification, including the hostname, via cfg.ServerName.
	}

	if d.ServerCertFingerprint != "" {
		cfg.VerifyPeerCertificate = pinVerifier(d.ServerCertFingerprint, cfg.VerifyPeerCertificate)
	}
	return cfg, nil
}

// chainVerifier rebuilds and verifies the presented chain against roots (or the
// system pool when roots is nil) without checking the hostname.
func chainVerifier(roots *x509.CertPool) func([][]byte, [][]*x509.Certificate) error {
	return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if len(rawCerts) == 0 {
			return errors.New("mysql: server presented no certificate")
		}
		certs := make([]*x509.Certificate, 0, len(rawCerts))
		for _, raw := range rawCerts {
			cert, err := x509.ParseCertificate(raw)
			if err != nil {
				return fmt.Errorf("mysql: parsing server certificate: %w", err)
			}
			certs = append(certs, cert)
		}
		opts := x509.VerifyOptions{Roots: roots, Intermediates: x509.NewCertPool()}
		for _, cert := range certs[1:] {
			opts.Intermediates.AddCert(cert)
		}
		if _, err := certs[0].Verify(opts); err != nil {
			return fmt.Errorf("mysql: server certificate chain is not trusted: %w", err)
		}
		return nil
	}
}

// pinVerifier compares the SHA-256 fingerprint of the leaf certificate against
// a pin, then delegates to next (if any). A mismatch is fatal: a pin that only
// warns is not a pin.
func pinVerifier(want string, next func([][]byte, [][]*x509.Certificate) error) func([][]byte, [][]*x509.Certificate) error {
	expected := normalizeFingerprint(want)
	return func(rawCerts [][]byte, chains [][]*x509.Certificate) error {
		if len(rawCerts) == 0 {
			return errors.New("mysql: server presented no certificate to match the pinned fingerprint")
		}
		sum := sha256.Sum256(rawCerts[0])
		actual := hex.EncodeToString(sum[:])
		if subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) != 1 {
			return fmt.Errorf("mysql: server certificate fingerprint mismatch: expected %s, got %s", expected, actual)
		}
		if next != nil {
			return next(rawCerts, chains)
		}
		return nil
	}
}

// normalizeFingerprint strips the punctuation people paste along with a
// fingerprint (colons, spaces) and lowercases it, so "AA:BB" and "aabb" match.
func normalizeFingerprint(s string) string {
	r := strings.NewReplacer(":", "", " ", "", "-", "")
	return strings.ToLower(r.Replace(strings.TrimSpace(s)))
}

// --- connection ------------------------------------------------------------

// conn is one open MySQL connection pool.
type conn struct {
	db *sql.DB
	// defaultDB scopes information_schema lookups when an ObjectRef or TreePath
	// carries no database of its own.
	defaultDB string
}

func (c *conn) Close() error { return c.db.Close() }

// schemaFor resolves which database an object lives in.
func (c *conn) schemaFor(database string) (string, error) {
	if database != "" {
		return database, nil
	}
	if c.defaultDB == "" {
		return "", errors.New("mysql: no database selected; qualify the object with a database name")
	}
	return c.defaultDB, nil
}

// qualify renders `db`.`table`. dbquery.QuoteObject cannot do this: MySQL
// reports Schemas: false, so it would emit the bare table name and silently
// resolve against whichever database the session happens to have selected.
func (c *conn) qualify(obj port.ObjectRef) (string, error) {
	name, err := dbquery.QuoteIdent(obj.Name, caps.QuoteChar)
	if err != nil {
		return "", err
	}
	schema, err := c.schemaFor(obj.Database)
	if err != nil {
		return "", err
	}
	qs, err := dbquery.QuoteIdent(schema, caps.QuoteChar)
	if err != nil {
		return "", err
	}
	return qs + "." + name, nil
}

// --- introspection ---------------------------------------------------------

func (c *conn) Tree(ctx context.Context, p port.TreePath) ([]port.TreeNode, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	switch p.Kind {
	case "":
		// MySQL has no schema layer, so the root is the database list.
		return []port.TreeNode{{Name: "databases", Kind: "databases", HasChildren: true}}, nil
	case "databases":
		return c.databases(ctx)
	case "tables":
		return c.tablesOfType(ctx, p.Database, "BASE TABLE", "table")
	case "views":
		return c.tablesOfType(ctx, p.Database, "VIEW", "view")
	case "functions":
		return c.routines(ctx, p.Database)
	default:
		// Unsupported collections (schemas, matviews) are empty rather than an
		// error: the caller asks generically across engines.
		return []port.TreeNode{}, nil
	}
}

func (c *conn) databases(ctx context.Context) ([]port.TreeNode, error) {
	rows, err := c.db.QueryContext(ctx, "SHOW DATABASES")
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
		if systemSchemas[strings.ToLower(name)] {
			continue
		}
		out = append(out, port.TreeNode{Name: name, Kind: "database", HasChildren: true})
	}
	return out, rows.Err()
}

func (c *conn) tablesOfType(ctx context.Context, database, tableType, kind string) ([]port.TreeNode, error) {
	schema, err := c.schemaFor(database)
	if err != nil {
		return nil, err
	}
	// Scoped to one schema on purpose: with innodb_stats_on_metadata=ON, broad
	// information_schema scans force statistics recalculation and can stall for
	// seconds on servers with many tables.
	rows, err := c.db.QueryContext(ctx,
		`SELECT TABLE_NAME FROM information_schema.TABLES
		 WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ? ORDER BY TABLE_NAME`, schema, tableType)
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

func (c *conn) routines(ctx context.Context, database string) ([]port.TreeNode, error) {
	schema, err := c.schemaFor(database)
	if err != nil {
		return nil, err
	}
	rows, err := c.db.QueryContext(ctx,
		`SELECT ROUTINE_NAME FROM information_schema.ROUTINES
		 WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`, schema)
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
		out = append(out, port.TreeNode{Name: name, Kind: "function", HasChildren: false})
	}
	return out, rows.Err()
}

func (c *conn) Columns(ctx context.Context, obj port.ObjectRef) ([]port.ColumnMeta, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()
	cols, _, err := c.tableInfo(ctx, obj)
	return cols, err
}

// tableInfo reads the column metadata and the primary-key column names in key
// order.
func (c *conn) tableInfo(ctx context.Context, obj port.ObjectRef) ([]port.ColumnMeta, []string, error) {
	schema, err := c.schemaFor(obj.Database)
	if err != nil {
		return nil, nil, err
	}
	rows, err := c.db.QueryContext(ctx,
		`SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, ORDINAL_POSITION
		 FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
		 ORDER BY ORDINAL_POSITION`, schema, obj.Name)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	var cols []port.ColumnMeta
	for rows.Next() {
		var (
			name     string
			dataType string
			nullable string
			dflt     sql.NullString
			key      sql.NullString
			ordinal  int
		)
		if err := rows.Scan(&name, &dataType, &nullable, &dflt, &key, &ordinal); err != nil {
			return nil, nil, err
		}
		col := port.ColumnMeta{
			Name:            name,
			DataType:        dataType,
			Nullable:        strings.EqualFold(nullable, "YES"),
			IsPrimaryKey:    key.String == "PRI",
			OrdinalPosition: ordinal,
			IsLOB:           isLOB(dataType),
			Comparable:      isComparable(dataType),
		}
		if dflt.Valid {
			v := dflt.String
			col.Default = &v
		}
		cols = append(cols, col)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	pk, err := c.primaryKey(ctx, schema, obj.Name)
	if err != nil {
		return nil, nil, err
	}
	return cols, pk, nil
}

// primaryKey returns the primary-key columns in key order. SEQ_IN_INDEX is the
// key position, which is not the same as the column's ordinal position — a
// composite key ordered by the wrong one produces a cursor that does not match
// the ORDER BY.
func (c *conn) primaryKey(ctx context.Context, schema, table string) ([]string, error) {
	rows, err := c.db.QueryContext(ctx,
		`SELECT COLUMN_NAME FROM information_schema.STATISTICS
		 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
		 ORDER BY SEQ_IN_INDEX`, schema, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// isLOB reports whether a column holds large data that must not be sent inline
// in a grid page.
func isLOB(dataType string) bool {
	switch strings.ToLower(dataType) {
	case "tinyblob", "blob", "mediumblob", "longblob", "longtext":
		return true
	}
	return false
}

// isComparable reports whether `col = ?` is a meaningful predicate. Floats
// compare unreliably, and MySQL raises an error outright for `WHERE json_col =
// ?` — which is precisely why this flag exists.
func isComparable(dataType string) bool {
	switch strings.ToLower(dataType) {
	case "json", "float", "double", "tinyblob", "blob", "mediumblob", "longblob":
		return false
	}
	return true
}

func (c *conn) Indexes(ctx context.Context, obj port.ObjectRef) ([]port.IndexMeta, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	schema, err := c.schemaFor(obj.Database)
	if err != nil {
		return nil, err
	}
	rows, err := c.db.QueryContext(ctx,
		`SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, NULLABLE
		 FROM information_schema.STATISTICS
		 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
		 ORDER BY INDEX_NAME, SEQ_IN_INDEX`, schema, obj.Name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []port.IndexMeta{}
	pos := map[string]int{}
	for rows.Next() {
		var (
			idxName   string
			nonUnique int
			seq       int
			colName   sql.NullString
			nullable  sql.NullString
		)
		if err := rows.Scan(&idxName, &nonUnique, &seq, &colName, &nullable); err != nil {
			return nil, err
		}
		i, ok := pos[idxName]
		if !ok {
			out = append(out, port.IndexMeta{
				Name:    idxName,
				Unique:  nonUnique == 0,
				Primary: idxName == "PRIMARY",
				Columns: []string{},
			})
			i = len(out) - 1
			pos[idxName] = i
		}
		// COLUMN_NAME is NULL for a functional index: there is no column to name
		// and no nullability to report.
		if !colName.Valid {
			continue
		}
		out[i].Columns = append(out[i].Columns, colName.String)
		if strings.EqualFold(nullable.String, "YES") {
			out[i].Nullable = true
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

	cols, pk, err := c.tableInfo(ctx, r.Object)
	if err != nil {
		return res, err
	}
	if len(cols) == 0 {
		return res, fmt.Errorf("mysql: %q has no columns", r.Object.Name)
	}
	target, err := c.qualify(r.Object)
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

	// MySQL has no rowid equivalent, so a table without a primary key has no
	// identity at all and BuildPagePlan falls back to OFFSET.
	plan, err := dbquery.BuildPagePlan(r.Sort, pk, cols, r.Cursor, caps, dbquery.QuestionPlaceholder, len(args))
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
			selects = append(selects, "LENGTH("+q+")")
		} else {
			selects = append(selects, q)
		}
	}
	// The ordering tuple is appended after the projection so the next cursor can
	// be read even when a key column was replaced by a LENGTH() placeholder.
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
		// MySQL hands back []byte for text columns; left alone they would reach
		// the browser base64-encoded. LOB columns are already a LENGTH(), so
		// nothing binary is being stringified here.
		for i := range vals {
			vals[i] = textify(vals[i])
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
		for i := range vals {
			// Binary columns keep their bytes; everything else becomes text so
			// the editor's result grid shows values rather than base64.
			if i < len(res.Columns) && res.Columns[i].IsLOB {
				continue
			}
			vals[i] = textify(vals[i])
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

func (c *conn) CountExact(ctx context.Context, obj port.ObjectRef, filters []port.Filter) (int64, error) {
	ctx, cancel := dbdriver.WithStatementTimeout(ctx, 0)
	defer cancel()

	cols, _, err := c.tableInfo(ctx, obj)
	if err != nil {
		return 0, err
	}
	target, err := c.qualify(obj)
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

	cols, _, err := c.tableInfo(ctx, obj)
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
	target, err := c.qualify(obj)
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
	schema, err := c.schemaFor(obj.Database)
	if err != nil {
		return st, err
	}

	// One schema and one table at a time, never a broad scan: with
	// innodb_stats_on_metadata=ON, wide information_schema.TABLES queries force
	// statistics recalculation and can stall for seconds.
	var (
		tableRows   sql.NullInt64
		dataLength  sql.NullInt64
		indexLength sql.NullInt64
	)
	err = c.db.QueryRowContext(ctx,
		`SELECT TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH FROM information_schema.TABLES
		 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, schema, obj.Name).
		Scan(&tableRows, &dataLength, &indexLength)
	if errors.Is(err, sql.ErrNoRows) {
		return st, fmt.Errorf("mysql: no such table %s.%s", schema, obj.Name)
	}
	if err != nil {
		return st, err
	}

	// TABLE_ROWS is NULL for views and for engines that keep no estimate.
	// Rendering that as 0 would be a fabricated number, so it stays nil and the
	// UI shows an em dash.
	if tableRows.Valid {
		n := tableRows.Int64
		st.EstRows = &n
		st.Analyzed = true
	}
	if dataLength.Valid || indexLength.Valid {
		total := dataLength.Int64 + indexLength.Int64
		st.TotalBytes = &total
	}
	if indexLength.Valid {
		idx := indexLength.Int64
		st.IndexBytes = &idx
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

// textify converts the []byte the MySQL driver returns for text columns into a
// string. Left as bytes, encoding/json would emit base64 for every VARCHAR.
func textify(v any) any {
	if b, ok := v.([]byte); ok {
		return string(b)
	}
	return v
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

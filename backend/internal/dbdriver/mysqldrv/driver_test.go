package mysqldrv

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"devdeck/backend/internal/dbdriver"
	"devdeck/backend/internal/port"

	"github.com/go-sql-driver/mysql"
)

// --- unit tests (no server required) ---------------------------------------

func TestCapabilitiesHasNoRowIdentifier(t *testing.T) {
	// MySQL exposes no stable physical row address, so the Phase 3 identity
	// ladder must fall through to an all-column predicate on this engine.
	if New().Capabilities().RowIdentifier != "" {
		t.Fatal("MySQL must report no row identifier")
	}
}

func TestCapabilitiesUsesBacktickQuoting(t *testing.T) {
	caps := New().Capabilities()
	if caps.QuoteChar != "`" {
		t.Errorf("QuoteChar = %q, want a backtick", caps.QuoteChar)
	}
	if caps.Schemas {
		t.Error("MySQL addresses tables directly; it has no schema layer between database and table")
	}
	if caps.MatViews {
		t.Error("MySQL has no materialized views")
	}
	if !caps.MultiDatabase {
		t.Error("one MySQL connection can list and switch between sibling databases")
	}
	if !caps.SizeStats {
		t.Error("information_schema.TABLES exposes per-table byte sizes")
	}
}

func TestOpenRejectsTunnelWithoutSupport(t *testing.T) {
	// A tunnel descriptor that is silently ignored would hide a
	// misconfiguration the operator believes is protecting them.
	_, err := New().Open(context.Background(), port.DSNDescriptor{
		Engine: "mysql", Host: "db.example.com", Port: 3306,
		Tunnel: &port.TunnelDescriptor{Host: "bastion", Port: 22},
	})
	if err == nil {
		t.Fatal("tunneled descriptor accepted, want rejection until tunnel dialing lands")
	}
}

func TestOpenRejectsEmptyHost(t *testing.T) {
	if _, err := New().Open(context.Background(), port.DSNDescriptor{Engine: "mysql"}); err == nil {
		t.Fatal("descriptor with no host accepted, want rejection")
	}
}

func TestBuildTLSConfigDisabledReturnsNil(t *testing.T) {
	for _, mode := range []string{"", "false"} {
		cfg, err := buildTLSConfig(port.DSNDescriptor{SSLMode: mode, Host: "h"})
		if err != nil {
			t.Fatalf("mode %q: %v", mode, err)
		}
		if cfg != nil {
			t.Fatalf("mode %q must produce no TLS config", mode)
		}
	}
}

func TestBuildTLSConfigVerifyIdentityChecksHostname(t *testing.T) {
	for _, mode := range []string{"true", "verify-identity"} {
		cfg, err := buildTLSConfig(port.DSNDescriptor{SSLMode: mode, Host: "db.example.com"})
		if err != nil {
			t.Fatalf("mode %q: %v", mode, err)
		}
		if cfg.InsecureSkipVerify {
			t.Fatalf("mode %q must not skip verification", mode)
		}
		if cfg.ServerName != "db.example.com" {
			t.Fatalf("mode %q: ServerName = %q, want the host for hostname verification", mode, cfg.ServerName)
		}
	}
}

func TestBuildTLSConfigVerifyCASkipsHostnameButVerifiesChain(t *testing.T) {
	cfg, err := buildTLSConfig(port.DSNDescriptor{SSLMode: "verify-ca", Host: "db.example.com"})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	// verify-ca validates the chain but not the hostname, which Go expresses as
	// InsecureSkipVerify plus a custom VerifyPeerCertificate.
	if !cfg.InsecureSkipVerify {
		t.Fatal("verify-ca skips hostname checking, so Go's built-in verification must be off")
	}
	if cfg.VerifyPeerCertificate == nil {
		t.Fatal("verify-ca needs a custom chain verifier")
	}
}

func TestBuildTLSConfigSkipVerifyDoesNotVerify(t *testing.T) {
	for _, mode := range []string{"skip-verify", "preferred"} {
		cfg, err := buildTLSConfig(port.DSNDescriptor{SSLMode: mode, Host: "h"})
		if err != nil {
			t.Fatalf("mode %q: %v", mode, err)
		}
		if cfg == nil || !cfg.InsecureSkipVerify {
			t.Fatalf("mode %q encrypts without authenticating; InsecureSkipVerify must be set", mode)
		}
	}
}

func TestBuildTLSConfigRejectsUnparseableCACert(t *testing.T) {
	_, err := buildTLSConfig(port.DSNDescriptor{SSLMode: "true", Host: "h", CACert: "not a pem block"})
	if err == nil {
		t.Fatal("invalid CA certificate accepted, want rejection")
	}
}

func TestBuildTLSConfigPinnedFingerprintSetsVerifier(t *testing.T) {
	cfg, err := buildTLSConfig(port.DSNDescriptor{
		SSLMode: "true", Host: "h",
		ServerCertFingerprint: "AA:BB:CC",
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if cfg.VerifyPeerCertificate == nil {
		t.Fatal("a pinned fingerprint requires a custom verifier")
	}
}

func TestBuildTLSConfigRejectsUnknownMode(t *testing.T) {
	if _, err := buildTLSConfig(port.DSNDescriptor{SSLMode: "banana", Host: "h"}); err == nil {
		t.Fatal("unknown sslMode accepted, want rejection")
	}
}

// --- integration tests (require a live MySQL) ------------------------------

// openTestDB connects to the server named by DEVDECK_TEST_MYSQL_DSN, creates a
// small fixture table, and returns an open port.DBConn. Every database-touching
// test skips when the variable is unset so `go test ./...` stays green on a
// machine with no MySQL.
func openTestDB(t *testing.T) (port.DBConn, string, string) {
	t.Helper()

	raw := os.Getenv("DEVDECK_TEST_MYSQL_DSN")
	if raw == "" {
		t.Skip("set DEVDECK_TEST_MYSQL_DSN to run MySQL integration tests")
	}
	cfg, err := mysql.ParseDSN(raw)
	if err != nil {
		t.Fatalf("parse DEVDECK_TEST_MYSQL_DSN: %v", err)
	}
	host, port_ := splitHostPort(t, cfg.Addr)

	ctx := context.Background()
	conn, err := New().Open(ctx, port.DSNDescriptor{
		Engine: "mysql", Host: host, Port: port_,
		Username: cfg.User, Password: cfg.Passwd, Database: cfg.DBName,
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	table := fmt.Sprintf("devdeck_assets_%d", os.Getpid())
	if _, err := conn.Exec(ctx, "DROP TABLE IF EXISTS `"+table+"`", nil); err != nil {
		t.Fatalf("drop fixture: %v", err)
	}
	stmts := []string{
		"CREATE TABLE `" + table + "` (id INT NOT NULL PRIMARY KEY, name VARCHAR(64) NOT NULL, qty INT NOT NULL, blob_col BLOB)",
		"INSERT INTO `" + table + "` (id, name, qty, blob_col) VALUES (1,'alpha',10,NULL),(2,'beta',20,NULL),(3,'gamma',20,NULL)",
	}
	for _, s := range stmts {
		if _, err := conn.Exec(ctx, s, nil); err != nil {
			t.Fatalf("fixture %q: %v", s, err)
		}
	}
	t.Cleanup(func() { _, _ = conn.Exec(context.Background(), "DROP TABLE IF EXISTS `"+table+"`", nil) })
	return conn, cfg.DBName, table
}

func splitHostPort(t *testing.T, addr string) (string, int) {
	t.Helper()
	host, portStr, found := strings.Cut(addr, ":")
	if !found {
		return addr, 3306
	}
	var n int
	if _, err := fmt.Sscanf(portStr, "%d", &n); err != nil {
		t.Fatalf("bad port in DSN address %q: %v", addr, err)
	}
	return host, n
}

func TestTreeListsDatabasesAndTables(t *testing.T) {
	conn, db, table := openTestDB(t)
	ctx := context.Background()

	root, err := conn.Tree(ctx, port.TreePath{})
	if err != nil {
		t.Fatalf("tree root: %v", err)
	}
	if len(root) == 0 || root[0].Kind != "databases" {
		t.Fatalf("root = %+v, want a databases collection", root)
	}

	dbs, err := conn.Tree(ctx, port.TreePath{Kind: "databases"})
	if err != nil {
		t.Fatalf("tree databases: %v", err)
	}
	for _, n := range dbs {
		switch n.Name {
		case "information_schema", "performance_schema", "mysql", "sys":
			t.Fatalf("system schema %q exposed in tree", n.Name)
		}
	}

	tables, err := conn.Tree(ctx, port.TreePath{Database: db, Kind: "tables"})
	if err != nil {
		t.Fatalf("tree tables: %v", err)
	}
	var found bool
	for _, n := range tables {
		if n.Name == table {
			found = true
		}
	}
	if !found {
		t.Fatalf("fixture table %q missing from %+v", table, tables)
	}
}

func TestOpenAppliesEngineStatementTimeout(t *testing.T) {
	// The context deadline only stops the client waiting; without an engine-side
	// bound the server keeps grinding on an abandoned query. MariaDB has no
	// max_execution_time and Open degrades to 0 there, which is why this asserts
	// "the default, or disabled" rather than a bare equality.
	conn, _, _ := openTestDB(t)
	res, err := conn.Query(context.Background(), "SELECT @@SESSION.max_execution_time", nil)
	if err != nil {
		t.Skipf("server has no max_execution_time: %v", err)
	}
	if len(res.Rows) != 1 || len(res.Rows[0]) != 1 {
		t.Fatalf("unexpected result shape %+v", res.Rows)
	}
	got := fmt.Sprint(res.Rows[0][0])
	want := fmt.Sprint(dbdriver.DefaultStatementTimeout.Milliseconds())
	if got != want && got != "0" {
		t.Fatalf("max_execution_time = %s, want %s (or 0 when unsupported)", got, want)
	}
	if got == "0" {
		t.Logf("server ignored max_execution_time; relying on context cancellation only")
	}
}

func TestColumnsReportsPrimaryKeyAndComparability(t *testing.T) {
	conn, db, table := openTestDB(t)
	cols, err := conn.Columns(context.Background(), port.ObjectRef{Database: db, Name: table, Kind: "table"})
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
		t.Error("INT column should be comparable")
	}
}

func TestRowsKeysetDoesNotSkipOnDuplicateSortValues(t *testing.T) {
	// qty has duplicates (20, 20). Without the identity tiebreaker in ORDER BY,
	// paging by qty loses or repeats a row.
	conn, db, table := openTestDB(t)
	ctx := context.Background()
	obj := port.ObjectRef{Database: db, Name: table, Kind: "table"}

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
		id := fmt.Sprint(res.Rows[0][0])
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

func TestRowsAppliesFiltersAndDefersLOBColumns(t *testing.T) {
	conn, db, table := openTestDB(t)
	res, err := conn.Rows(context.Background(), port.RowsRequest{
		Object:  port.ObjectRef{Database: db, Name: table, Kind: "table"},
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
	idx := -1
	for i, c := range res.Columns {
		if c.Name == "blob_col" {
			idx = i
		}
	}
	if idx == -1 {
		t.Fatal("blob_col missing from columns")
	}
	for _, row := range res.Rows {
		if b, ok := row[idx].([]byte); ok && len(b) > 0 {
			t.Fatal("LOB bytes returned inline in a grid page")
		}
	}
}

func TestCountExactRespectsFilters(t *testing.T) {
	conn, db, table := openTestDB(t)
	n, err := conn.CountExact(context.Background(),
		port.ObjectRef{Database: db, Name: table, Kind: "table"},
		[]port.Filter{{Column: "qty", Op: "eq", Values: []any{20}}})
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 2 {
		t.Fatalf("count = %d, want 2", n)
	}
}

func TestStatsReportsSizeWithoutFabricatingRowCounts(t *testing.T) {
	conn, db, table := openTestDB(t)
	st, err := conn.Stats(context.Background(), port.ObjectRef{Database: db, Name: table, Kind: "table"})
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.TotalBytes != nil && *st.TotalBytes < 0 {
		t.Fatalf("negative size reported: %d", *st.TotalBytes)
	}
	if st.EstRows == nil && st.Analyzed {
		t.Fatal("Analyzed must be false when the engine reports no row estimate")
	}
}

func TestCommitEditsUpdatesThroughAllColumnsIdentity(t *testing.T) {
	raw := os.Getenv("DEVDECK_TEST_MYSQL_DSN")
	if strings.TrimSpace(raw) == "" {
		t.Skip("set DEVDECK_TEST_MYSQL_DSN to run MySQL integration tests")
	}
	cfg, err := mysql.ParseDSN(raw)
	if err != nil {
		t.Fatalf("parse DEVDECK_TEST_MYSQL_DSN: %v", err)
	}
	host, port_ := splitHostPort(t, cfg.Addr)

	ctx := context.Background()
	c, err := New().Open(ctx, port.DSNDescriptor{
		Engine: "mysql", Host: host, Port: port_,
		Username: cfg.User, Password: cfg.Passwd, Database: cfg.DBName,
	})
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

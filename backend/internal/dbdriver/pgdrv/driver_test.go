package pgdrv

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"

	"devdeck/backend/internal/port"
)

// dsnEnv names the environment variable holding a PostgreSQL URL. Without it
// every database-touching test skips, so `go test ./...` stays green on a
// machine with no PostgreSQL.
const dsnEnv = "DEVDECK_TEST_PG_DSN"

func TestCapabilities(t *testing.T) {
	caps := New().Capabilities()
	if !caps.Schemas {
		t.Error("PostgreSQL has a schema layer")
	}
	if !caps.MatViews {
		t.Error("PostgreSQL has materialized views")
	}
	if !caps.MultiDatabase {
		t.Error("PostgreSQL can list sibling databases")
	}
	if caps.RowIdentifier != "ctid" {
		t.Errorf("RowIdentifier = %q, want ctid", caps.RowIdentifier)
	}
	if !caps.SizeStats {
		t.Error("PostgreSQL reports per-table sizes")
	}
	if caps.QuoteChar != `"` {
		t.Errorf("QuoteChar = %q, want double quote", caps.QuoteChar)
	}
}

// descriptorFromEnv parses DEVDECK_TEST_PG_DSN into a DSNDescriptor, skipping
// the test when it is unset.
func descriptorFromEnv(t *testing.T) port.DSNDescriptor {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv(dsnEnv))
	if raw == "" {
		t.Skip("set DEVDECK_TEST_PG_DSN to run PostgreSQL integration tests")
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %s: %v", dsnEnv, err)
	}
	prt := 5432
	if p := u.Port(); p != "" {
		if n, err := strconv.Atoi(p); err == nil {
			prt = n
		}
	}
	d := port.DSNDescriptor{
		Engine:   "postgres",
		Host:     u.Hostname(),
		Port:     prt,
		Database: strings.TrimPrefix(u.Path, "/"),
		SSLMode:  u.Query().Get("sslmode"),
	}
	if u.User != nil {
		d.Username = u.User.Username()
		d.Password, _ = u.User.Password()
	}
	return d
}

// openTestDB connects and creates a uniquely named schema with a small
// fixture, dropped on cleanup so repeated runs do not collide.
func openTestDB(t *testing.T) (port.DBConn, string) {
	t.Helper()
	ctx := context.Background()

	conn, err := New().Open(ctx, descriptorFromEnv(t))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	schema := fmt.Sprintf("devdeck_test_%d", os.Getpid())
	stmts := []string{
		`DROP SCHEMA IF EXISTS ` + schema + ` CASCADE`,
		`CREATE SCHEMA ` + schema,
		`CREATE TABLE ` + schema + `.assets (
			id integer PRIMARY KEY,
			name text NOT NULL,
			qty integer NOT NULL,
			blob_col bytea
		)`,
		`INSERT INTO ` + schema + `.assets (id, name, qty)
		 VALUES (1, 'alpha', 10), (2, 'beta', 20), (3, 'gamma', 20)`,
		`CREATE VIEW ` + schema + `.asset_names AS SELECT name FROM ` + schema + `.assets`,
	}
	for _, s := range stmts {
		if _, err := conn.Exec(ctx, s, nil); err != nil {
			t.Fatalf("fixture %q: %v", s, err)
		}
	}
	t.Cleanup(func() {
		_, _ = conn.Exec(context.Background(), `DROP SCHEMA IF EXISTS `+schema+` CASCADE`, nil)
	})
	return conn, schema
}

func TestTreeListsSchemasAndTables(t *testing.T) {
	conn, schema := openTestDB(t)
	ctx := context.Background()

	schemas, err := conn.Tree(ctx, port.TreePath{Kind: "schemas"})
	if err != nil {
		t.Fatalf("tree schemas: %v", err)
	}
	if !containsNode(schemas, schema) {
		t.Fatalf("schema %q missing from %+v", schema, schemas)
	}
	for _, n := range schemas {
		if strings.HasPrefix(n.Name, "pg_") || n.Name == "information_schema" {
			t.Fatalf("system schema %q exposed in tree", n.Name)
		}
	}

	tables, err := conn.Tree(ctx, port.TreePath{Schema: schema, Kind: "tables"})
	if err != nil {
		t.Fatalf("tree tables: %v", err)
	}
	if len(tables) != 1 || tables[0].Name != "assets" {
		t.Fatalf("tables = %+v, want [assets]", tables)
	}

	views, err := conn.Tree(ctx, port.TreePath{Schema: schema, Kind: "views"})
	if err != nil {
		t.Fatalf("tree views: %v", err)
	}
	if len(views) != 1 || views[0].Name != "asset_names" {
		t.Fatalf("views = %+v, want [asset_names]", views)
	}
}

func containsNode(nodes []port.TreeNode, name string) bool {
	for _, n := range nodes {
		if n.Name == name {
			return true
		}
	}
	return false
}

func TestColumnsMarksPrimaryKeyAndLOB(t *testing.T) {
	conn, schema := openTestDB(t)
	cols, err := conn.Columns(context.Background(),
		port.ObjectRef{Schema: schema, Name: "assets", Kind: "table"})
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
		t.Error("bytea column not marked as LOB")
	}
	if byName["blob_col"].Comparable {
		t.Error("bytea column must not be comparable")
	}
	if !byName["qty"].Comparable {
		t.Error("integer column should be comparable")
	}
}

func TestRowsKeysetDoesNotSkipOnDuplicateSortValues(t *testing.T) {
	// qty has duplicates (20, 20). Without the identity tiebreaker in
	// ORDER BY, paging by qty loses or repeats a row.
	conn, schema := openTestDB(t)
	ctx := context.Background()
	obj := port.ObjectRef{Schema: schema, Name: "assets", Kind: "table"}

	seen := map[any]bool{}
	var cursor []any
	for page := 0; page < 5; page++ {
		res, err := conn.Rows(ctx, port.RowsRequest{
			Object: obj, Sort: []port.SortKey{{Column: "qty"}}, Limit: 1, Cursor: cursor,
		})
		if err != nil {
			t.Fatalf("page %d: %v", page, err)
		}
		if len(res.Rows) == 0 {
			break
		}
		if res.UsedOffsetPaging {
			t.Fatal("expected keyset paging on a table with a primary key")
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

func TestStatsReportsUnknownRowsForNeverAnalyzedTable(t *testing.T) {
	// A freshly created table has no statistics. reltuples is -1 (or an
	// ambiguous 0 on older servers) and must surface as unknown, never as a
	// fabricated zero an operator might read as "the table is empty".
	conn, schema := openTestDB(t)
	st, err := conn.Stats(context.Background(),
		port.ObjectRef{Schema: schema, Name: "assets", Kind: "table"})
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.Analyzed {
		t.Fatal("a never-analyzed table must not report Analyzed")
	}
	if st.EstRows != nil {
		t.Fatalf("EstRows = %d, want nil for a never-analyzed table", *st.EstRows)
	}
	if st.TotalBytes == nil {
		t.Fatal("PostgreSQL always knows the on-disk size")
	}
}

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
	if strings.Contains(err.Error(), "not supported") {
		t.Fatal("tunnel was rejected outright rather than attempted")
	}
}

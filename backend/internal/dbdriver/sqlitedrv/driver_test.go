package sqlitedrv

import (
	"context"
	"strings"
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
	// SQLite's plain EXPLAIN dumps VDBE bytecode, which is not a query plan.
	// EXPLAIN QUERY PLAN is the statement an operator actually wants.
	if caps.ExplainPrefix != "EXPLAIN QUERY PLAN" {
		t.Errorf("ExplainPrefix = %q, want EXPLAIN QUERY PLAN", caps.ExplainPrefix)
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

func openTestConn(t *testing.T) *conn {
	t.Helper()
	c, err := New().Open(context.Background(), port.DSNDescriptor{Engine: "sqlite", Database: ":memory:"})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c.(*conn)
}

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

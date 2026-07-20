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

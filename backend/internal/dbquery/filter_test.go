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

package dbquery

import (
	"strings"
	"testing"

	"devdeck/backend/internal/port"
)

var pageCols = []port.ColumnMeta{
	{Name: "id", DataType: "integer", IsPrimaryKey: true, Nullable: false},
	{Name: "created_at", DataType: "timestamp", Nullable: false},
	{Name: "nickname", DataType: "text", Nullable: true},
}

func TestPagePlanAppendsIdentityAsTiebreaker(t *testing.T) {
	// Without a deterministic total order, keyset paging silently repeats and
	// skips rows whenever the sort column has duplicate values.
	plan, err := BuildPagePlan(
		[]port.SortKey{{Column: "created_at"}},
		[]string{"id"}, pageCols, nil, pgCaps, DollarPlaceholder, 0,
	)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.Contains(plan.OrderBy, `"id"`) {
		t.Fatalf("identity column missing from ORDER BY: %s", plan.OrderBy)
	}
	if plan.UseOffset {
		t.Fatal("expected keyset paging with a non-null sort column")
	}
}

func TestPagePlanFirstPageHasNoCursorPredicate(t *testing.T) {
	plan, _ := BuildPagePlan(
		[]port.SortKey{{Column: "id"}}, []string{"id"}, pageCols, nil, pgCaps, DollarPlaceholder, 0,
	)
	if plan.Where != "" {
		t.Fatalf("first page should have no cursor predicate, got %q", plan.Where)
	}
	if len(plan.Args) != 0 {
		t.Fatalf("first page should bind no args, got %v", plan.Args)
	}
}

func TestPagePlanUniformAscUsesRowValueComparison(t *testing.T) {
	plan, err := BuildPagePlan(
		[]port.SortKey{{Column: "created_at"}, {Column: "id"}},
		[]string{"id"}, pageCols, []any{"2026-01-01", 42}, pgCaps, DollarPlaceholder, 0,
	)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.Contains(plan.Where, ") > (") {
		t.Fatalf("expected row-value comparison, got %q", plan.Where)
	}
	if len(plan.Args) != 2 {
		t.Fatalf("args = %v, want 2", plan.Args)
	}
}

func TestPagePlanMixedDirectionsExpandsToOrChain(t *testing.T) {
	// Row-value comparison `(a,b) > (?,?)` only means "lexicographically
	// after" when every column shares one direction. With mixed ASC/DESC it
	// silently returns the wrong rows, so the plan must expand to an explicit
	// OR-chain instead.
	plan, err := BuildPagePlan(
		[]port.SortKey{{Column: "created_at", Desc: true}, {Column: "id"}},
		[]string{"id"}, pageCols, []any{"2026-01-01", 42}, pgCaps, DollarPlaceholder, 0,
	)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if strings.Contains(plan.Where, ") > (") {
		t.Fatalf("row-value comparison used with mixed directions: %q", plan.Where)
	}
	if !strings.Contains(strings.ToUpper(plan.Where), " OR ") {
		t.Fatalf("expected OR-chain for mixed directions: %q", plan.Where)
	}
	if !strings.Contains(plan.OrderBy, "DESC") {
		t.Fatalf("DESC lost from ORDER BY: %s", plan.OrderBy)
	}
}

func TestPagePlanNullableSortColumnFallsBackToOffset(t *testing.T) {
	// A NULL in a keyset comparison makes the predicate NULL, which excludes
	// the row entirely — rows would vanish from paging. Fall back rather than
	// return a silently incomplete result.
	plan, err := BuildPagePlan(
		[]port.SortKey{{Column: "nickname"}},
		[]string{"id"}, pageCols, []any{"bob", 1}, pgCaps, DollarPlaceholder, 0,
	)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !plan.UseOffset {
		t.Fatal("expected OFFSET fallback for a nullable sort column")
	}
	if plan.Reason == "" {
		t.Fatal("fallback must explain itself so the UI can surface the reason")
	}
}

func TestPagePlanNoIdentityFallsBackToOffset(t *testing.T) {
	plan, err := BuildPagePlan(
		[]port.SortKey{{Column: "created_at"}}, nil, pageCols, nil, pgCaps, DollarPlaceholder, 0,
	)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !plan.UseOffset {
		t.Fatal("expected OFFSET fallback with no identity columns")
	}
}

func TestPagePlanRejectsUnknownSortColumn(t *testing.T) {
	if _, err := BuildPagePlan(
		[]port.SortKey{{Column: "id; DROP TABLE t"}}, []string{"id"}, pageCols, nil, pgCaps, DollarPlaceholder, 0,
	); err == nil {
		t.Fatal("unknown sort column accepted, want rejection")
	}
}

func TestPagePlanCursorArityMustMatchKeyColumns(t *testing.T) {
	if _, err := BuildPagePlan(
		[]port.SortKey{{Column: "created_at"}}, []string{"id"}, pageCols, []any{"only-one"}, pgCaps, DollarPlaceholder, 0,
	); err == nil {
		t.Fatal("cursor with wrong arity accepted, want rejection")
	}
}

func TestPagePlanArgOffsetContinuesPlaceholderNumbering(t *testing.T) {
	// Filters are compiled first and already consumed placeholders; the page
	// predicate must continue their numbering, not restart at $1.
	plan, err := BuildPagePlan(
		[]port.SortKey{{Column: "id"}}, []string{"id"}, pageCols, []any{7}, pgCaps, DollarPlaceholder, 3,
	)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if strings.Contains(plan.Where, "$1") {
		t.Fatalf("placeholder numbering restarted despite argOffset: %q", plan.Where)
	}
	if !strings.Contains(plan.Where, "$4") {
		t.Fatalf("expected numbering to continue at $4: %q", plan.Where)
	}
}

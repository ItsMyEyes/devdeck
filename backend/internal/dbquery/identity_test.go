package dbquery

import (
	"testing"

	"devdeck/backend/internal/port"
)

var pgCapsWithCtid = port.DBCaps{QuoteChar: `"`, Schemas: true, RowIdentifier: "ctid"}

func TestResolveRowIdentityPrefersPrimaryKey(t *testing.T) {
	cols := []port.ColumnMeta{
		{Name: "id", IsPrimaryKey: true},
		{Name: "email"},
	}
	idxs := []port.IndexMeta{{Name: "email_uq", Columns: []string{"email"}, Unique: true}}
	plan := ResolveRowIdentity(cols, idxs, pgCapsWithCtid)
	if plan.Level != port.IdentityPrimaryKey {
		t.Fatalf("Level = %q, want primary_key", plan.Level)
	}
	if len(plan.KeyColumns) != 1 || plan.KeyColumns[0] != "id" {
		t.Fatalf("KeyColumns = %v, want [id]", plan.KeyColumns)
	}
}

func TestResolveRowIdentityFallsBackToNonNullUniqueIndex(t *testing.T) {
	cols := []port.ColumnMeta{{Name: "email"}, {Name: "name"}}
	idxs := []port.IndexMeta{{Name: "email_uq", Columns: []string{"email"}, Unique: true, Nullable: false}}
	plan := ResolveRowIdentity(cols, idxs, pgCapsWithCtid)
	if plan.Level != port.IdentityUniqueIndex {
		t.Fatalf("Level = %q, want unique_index", plan.Level)
	}
	if len(plan.KeyColumns) != 1 || plan.KeyColumns[0] != "email" {
		t.Fatalf("KeyColumns = %v, want [email]", plan.KeyColumns)
	}
}

func TestResolveRowIdentitySkipsNullableUniqueIndex(t *testing.T) {
	// A NULL in a unique index does not participate in uniqueness the way SQL
	// treats NULLs, so it cannot address a row on its own.
	cols := []port.ColumnMeta{{Name: "email"}}
	idxs := []port.IndexMeta{{Name: "email_uq", Columns: []string{"email"}, Unique: true, Nullable: true}}
	plan := ResolveRowIdentity(cols, idxs, pgCapsWithCtid)
	if plan.Level == port.IdentityUniqueIndex {
		t.Fatal("nullable unique index accepted as identity, want fall-through")
	}
}

func TestResolveRowIdentityFallsBackToRowPointer(t *testing.T) {
	cols := []port.ColumnMeta{{Name: "name"}, {Name: "score", Comparable: true}}
	plan := ResolveRowIdentity(cols, nil, pgCapsWithCtid)
	if plan.Level != port.IdentityRowPointer {
		t.Fatalf("Level = %q, want row_pointer", plan.Level)
	}
	if plan.RowPointerColumn != "ctid" {
		t.Fatalf("RowPointerColumn = %q, want ctid", plan.RowPointerColumn)
	}
	if len(plan.KeyColumns) != 2 {
		t.Fatalf("KeyColumns = %v, want every loaded column for the old-value comparison", plan.KeyColumns)
	}
}

func TestResolveRowIdentityFallsBackToAllColumnsOnMySQL(t *testing.T) {
	// MySQL's RowIdentifier is "", so it never reaches IdentityRowPointer.
	mysqlCaps := port.DBCaps{QuoteChar: "`", RowIdentifier: ""}
	cols := []port.ColumnMeta{
		{Name: "name", Comparable: true},
		{Name: "payload", Comparable: false}, // json: excluded
	}
	plan := ResolveRowIdentity(cols, nil, mysqlCaps)
	if plan.Level != port.IdentityAllColumns {
		t.Fatalf("Level = %q, want all_columns", plan.Level)
	}
	if len(plan.KeyColumns) != 1 || plan.KeyColumns[0] != "name" {
		t.Fatalf("KeyColumns = %v, want only the comparable column", plan.KeyColumns)
	}
}

func TestResolveRowIdentityReadOnlyWhenNoComparableColumns(t *testing.T) {
	mysqlCaps := port.DBCaps{QuoteChar: "`", RowIdentifier: ""}
	cols := []port.ColumnMeta{{Name: "payload", Comparable: false}}
	plan := ResolveRowIdentity(cols, nil, mysqlCaps)
	if !plan.ReadOnly {
		t.Fatal("expected ReadOnly when no column is comparable and no identifier exists")
	}
	if plan.Reason == "" {
		t.Fatal("ReadOnly must explain itself so the UI can surface the reason")
	}
}

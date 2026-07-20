package dbquery

import (
	"strings"
	"testing"

	"devdeck/backend/internal/port"
)

func TestCompileTablePlanCreateEmitsColumnsAndPrimaryKey(t *testing.T) {
	p := port.TablePlan{
		Object: port.ObjectRef{Name: "widgets"},
		Kind:   "create",
		Columns: []port.ColumnPlan{
			{Name: "id", DataType: "integer", IsPrimaryKey: true},
			{Name: "name", DataType: "text", Nullable: true},
		},
	}
	stmts, err := CompileTablePlan(p, nil, nil, pgCaps)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(stmts) != 1 {
		t.Fatalf("stmts = %v, want exactly the CREATE TABLE", stmts)
	}
	if !strings.Contains(stmts[0], `"id" integer`) || !strings.Contains(stmts[0], "PRIMARY KEY") {
		t.Fatalf("missing column or primary key: %s", stmts[0])
	}
	if strings.Contains(stmts[0], `"name" text NOT NULL`) {
		t.Fatalf("nullable column incorrectly marked NOT NULL: %s", stmts[0])
	}
}

func TestCompileTablePlanCreateEmitsIndexesAfterTheTable(t *testing.T) {
	p := port.TablePlan{
		Object:  port.ObjectRef{Name: "widgets"},
		Kind:    "create",
		Columns: []port.ColumnPlan{{Name: "id", DataType: "integer", IsPrimaryKey: true}},
		Indexes: []port.IndexPlan{{Name: "widgets_name_idx", Columns: []string{"id"}, Unique: true}},
	}
	stmts, err := CompileTablePlan(p, nil, nil, pgCaps)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(stmts) != 2 {
		t.Fatalf("stmts = %v, want CREATE TABLE + CREATE INDEX", stmts)
	}
	if !strings.Contains(stmts[1], "UNIQUE INDEX") {
		t.Fatalf("index statement wrong: %s", stmts[1])
	}
}

func TestCompileTablePlanDropEmitsDropTable(t *testing.T) {
	stmts, err := CompileTablePlan(port.TablePlan{Object: port.ObjectRef{Name: "widgets"}, Kind: "drop"}, nil, nil, pgCaps)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(stmts) != 1 || !strings.HasPrefix(stmts[0], "DROP TABLE") {
		t.Fatalf("stmts = %v, want a single DROP TABLE", stmts)
	}
}

func TestCompileTablePlanAlterAddsAndDropsColumns(t *testing.T) {
	current := []port.ColumnMeta{{Name: "id", IsPrimaryKey: true}, {Name: "old_col"}}
	p := port.TablePlan{
		Object: port.ObjectRef{Name: "widgets"},
		Kind:   "alter",
		Columns: []port.ColumnPlan{
			{Name: "id", DataType: "integer", IsPrimaryKey: true}, // present in both: untouched
			{Name: "new_col", DataType: "text", Nullable: true},   // added
		},
	}
	stmts, err := CompileTablePlan(p, current, nil, pgCaps)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	var addedNew, droppedOld bool
	for _, s := range stmts {
		if strings.Contains(s, "ADD COLUMN") && strings.Contains(s, "new_col") {
			addedNew = true
		}
		if strings.Contains(s, "DROP COLUMN") && strings.Contains(s, "old_col") {
			droppedOld = true
		}
		if strings.Contains(s, `"id"`) {
			t.Fatalf("column present in both current and desired state must be left untouched: %s", s)
		}
	}
	if !addedNew || !droppedOld {
		t.Fatalf("stmts = %v, want an ADD COLUMN for new_col and a DROP COLUMN for old_col", stmts)
	}
}

func TestCompileTablePlanAlterDropsIndexOnMySQLWithOnClause(t *testing.T) {
	// MySQL indexes are namespaced under their table, not the database: DROP
	// INDEX requires ON <table>, unlike PostgreSQL/SQLite. Backtick quoting is
	// unique to MySQL among the three engines here.
	mysqlCaps := port.DBCaps{QuoteChar: "`"}
	current := []port.ColumnMeta{{Name: "id"}}
	currentIdx := []port.IndexMeta{{Name: "old_idx", Columns: []string{"id"}}}
	p := port.TablePlan{Object: port.ObjectRef{Name: "widgets"}, Kind: "alter", Columns: current2Plan(current)}
	stmts, err := CompileTablePlan(p, current, currentIdx, mysqlCaps)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	found := false
	for _, s := range stmts {
		if strings.Contains(s, "DROP INDEX") {
			found = true
			if !strings.Contains(s, "ON") {
				t.Fatalf("MySQL DROP INDEX missing the required ON <table> clause: %s", s)
			}
		}
	}
	if !found {
		t.Fatal("expected a DROP INDEX statement")
	}
}

func TestCompileTablePlanAlterDropsIndexOnPostgresWithoutOnClause(t *testing.T) {
	current := []port.ColumnMeta{{Name: "id"}}
	currentIdx := []port.IndexMeta{{Name: "old_idx", Columns: []string{"id"}}}
	p := port.TablePlan{Object: port.ObjectRef{Name: "widgets"}, Kind: "alter", Columns: current2Plan(current)}
	stmts, err := CompileTablePlan(p, current, currentIdx, pgCaps)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	for _, s := range stmts {
		if strings.Contains(s, "DROP INDEX") && strings.Contains(s, " ON ") {
			t.Fatalf("PostgreSQL DROP INDEX must not carry an ON clause: %s", s)
		}
	}
}

func TestCompileTablePlanAlterLeavesPrimaryKeyIndexAlone(t *testing.T) {
	// old_col is current-only (dropped by the alter) so this exercises a real
	// change rather than a no-op — a plan whose desired state exactly matches
	// current, with its only index excluded as primary, would otherwise be
	// legitimately rejected by the "no changes" guard covered by
	// TestCompileTablePlanAlterWithNoChangesIsRejected.
	current := []port.ColumnMeta{{Name: "id", IsPrimaryKey: true}, {Name: "old_col"}}
	currentIdx := []port.IndexMeta{{Name: "widgets_pkey", Columns: []string{"id"}, Primary: true}}
	p := port.TablePlan{Object: port.ObjectRef{Name: "widgets"}, Kind: "alter", Columns: current2Plan(current[:1])}
	stmts, err := CompileTablePlan(p, current, currentIdx, pgCaps)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	for _, s := range stmts {
		if strings.Contains(s, "widgets_pkey") {
			t.Fatalf("primary-key index must not be dropped by ALTER: %s", s)
		}
	}
}

func TestCompileTablePlanAlterWithNoChangesIsRejected(t *testing.T) {
	current := []port.ColumnMeta{{Name: "id", IsPrimaryKey: true}}
	p := port.TablePlan{Object: port.ObjectRef{Name: "widgets"}, Kind: "alter", Columns: current2Plan(current)}
	if _, err := CompileTablePlan(p, current, nil, pgCaps); err == nil {
		t.Fatal("no-op alter accepted, want rejection")
	}
}

// current2Plan is a small test-only helper mirroring ColumnPlansFromMeta
// without a primary-key filter, since these ALTER tests need the desired
// state to intentionally match the current one for the columns under test.
func current2Plan(cols []port.ColumnMeta) []port.ColumnPlan {
	out := make([]port.ColumnPlan, len(cols))
	for i, c := range cols {
		out[i] = port.ColumnPlan{Name: c.Name, DataType: c.DataType, Nullable: c.Nullable, IsPrimaryKey: c.IsPrimaryKey}
	}
	return out
}

func TestColumnPlansFromMetaRoundTripsFields(t *testing.T) {
	dflt := "0"
	cols := []port.ColumnMeta{{Name: "id", DataType: "integer", IsPrimaryKey: true, Default: &dflt}}
	plans := ColumnPlansFromMeta(cols)
	if len(plans) != 1 || plans[0].Name != "id" || plans[0].Default == nil || *plans[0].Default != "0" {
		t.Fatalf("plans = %+v", plans)
	}
}

func TestIndexPlansFromMetaExcludesPrimaryKeyIndex(t *testing.T) {
	idxs := []port.IndexMeta{
		{Name: "widgets_pkey", Columns: []string{"id"}, Primary: true},
		{Name: "widgets_name_idx", Columns: []string{"name"}, Unique: true},
	}
	plans := IndexPlansFromMeta(idxs)
	if len(plans) != 1 || plans[0].Name != "widgets_name_idx" {
		t.Fatalf("plans = %+v, want only the non-primary index", plans)
	}
}

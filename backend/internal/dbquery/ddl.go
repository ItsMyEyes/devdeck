package dbquery

import (
	"context"
	"fmt"
	"strings"

	"devdeck/backend/internal/port"
)

// CompileTablePlan renders the SQL statements a TablePlan implies, given the
// object's current column and index state (nil/empty for "create" and
// "drop", which do not need it). It does not execute anything — callers use
// the result for a preview, then for execution via ExecTxOnDB.
//
// "alter" diffs desired Columns/Indexes against current: a column or index
// present in one but absent from the other is added or dropped. Present in
// both means untouched — see the package-level scope note in this plan's
// Task 9 for why column type/nullability changes are deliberately excluded.
func CompileTablePlan(p port.TablePlan, current []port.ColumnMeta, currentIdx []port.IndexMeta, caps port.DBCaps) ([]string, error) {
	switch p.Kind {
	case "create":
		return compileCreateTable(p, caps)
	case "drop":
		return compileDropTable(p, caps)
	case "alter":
		return compileAlterTable(p, current, currentIdx, caps)
	default:
		return nil, fmt.Errorf("unsupported DDL plan kind %q", p.Kind)
	}
}

// BuildTablePlan is the entry point drivers call: it introspects the object's
// current state when the plan is an "alter" (create/drop need none) and
// delegates to CompileTablePlan. introspector is whatever the caller already
// has open — a driver's own *conn, which satisfies port.Introspector.
func BuildTablePlan(ctx context.Context, introspector port.Introspector, p port.TablePlan, caps port.DBCaps) ([]string, error) {
	var current []port.ColumnMeta
	var currentIdx []port.IndexMeta
	if p.Kind == "alter" {
		var err error
		current, err = introspector.Columns(ctx, p.Object)
		if err != nil {
			return nil, err
		}
		currentIdx, err = introspector.Indexes(ctx, p.Object)
		if err != nil {
			return nil, err
		}
	}
	return CompileTablePlan(p, current, currentIdx, caps)
}

func compileCreateTable(p port.TablePlan, caps port.DBCaps) ([]string, error) {
	if len(p.Columns) == 0 {
		return nil, fmt.Errorf("create table %s: no columns", p.Object.Name)
	}
	target, err := QuoteObject(p.Object, caps)
	if err != nil {
		return nil, err
	}
	var defs []string
	var pkCols []string
	for _, c := range p.Columns {
		def, err := compileColumnDef(c, caps)
		if err != nil {
			return nil, err
		}
		defs = append(defs, def)
		if c.IsPrimaryKey {
			pkCols = append(pkCols, c.Name)
		}
	}
	if len(pkCols) > 0 {
		quoted := make([]string, len(pkCols))
		for i, name := range pkCols {
			q, err := QuoteIdent(name, caps.QuoteChar)
			if err != nil {
				return nil, err
			}
			quoted[i] = q
		}
		defs = append(defs, "PRIMARY KEY ("+strings.Join(quoted, ", ")+")")
	}
	stmts := []string{"CREATE TABLE " + target + " (" + strings.Join(defs, ", ") + ")"}
	idxStmts, err := compileCreateIndexes(p.Object, p.Indexes, caps)
	if err != nil {
		return nil, err
	}
	return append(stmts, idxStmts...), nil
}

func compileColumnDef(c port.ColumnPlan, caps port.DBCaps) (string, error) {
	if strings.TrimSpace(c.DataType) == "" {
		return "", fmt.Errorf("column %q has no data type", c.Name)
	}
	q, err := QuoteIdent(c.Name, caps.QuoteChar)
	if err != nil {
		return "", err
	}
	def := q + " " + c.DataType
	if !c.Nullable {
		def += " NOT NULL"
	}
	if c.Default != nil {
		def += " DEFAULT " + *c.Default
	}
	return def, nil
}

func compileDropTable(p port.TablePlan, caps port.DBCaps) ([]string, error) {
	target, err := QuoteObject(p.Object, caps)
	if err != nil {
		return nil, err
	}
	return []string{"DROP TABLE " + target}, nil
}

func compileCreateIndexes(obj port.ObjectRef, idxs []port.IndexPlan, caps port.DBCaps) ([]string, error) {
	var stmts []string
	for _, idx := range idxs {
		stmt, err := compileCreateIndex(obj, idx, caps)
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, stmt)
	}
	return stmts, nil
}

func compileCreateIndex(obj port.ObjectRef, idx port.IndexPlan, caps port.DBCaps) (string, error) {
	if len(idx.Columns) == 0 {
		return "", fmt.Errorf("index %q has no columns", idx.Name)
	}
	idxName, err := QuoteIdent(idx.Name, caps.QuoteChar)
	if err != nil {
		return "", err
	}
	target, err := QuoteObject(obj, caps)
	if err != nil {
		return "", err
	}
	cols := make([]string, len(idx.Columns))
	for i, c := range idx.Columns {
		q, err := QuoteIdent(c, caps.QuoteChar)
		if err != nil {
			return "", err
		}
		cols[i] = q
	}
	kw := "INDEX"
	if idx.Unique {
		kw = "UNIQUE INDEX"
	}
	return fmt.Sprintf("CREATE %s %s ON %s (%s)", kw, idxName, target, strings.Join(cols, ", ")), nil
}

func compileAlterTable(p port.TablePlan, current []port.ColumnMeta, currentIdx []port.IndexMeta, caps port.DBCaps) ([]string, error) {
	target, err := QuoteObject(p.Object, caps)
	if err != nil {
		return nil, err
	}
	var stmts []string

	currentCols := map[string]bool{}
	for _, c := range current {
		currentCols[c.Name] = true
	}
	desiredCols := map[string]bool{}
	for _, c := range p.Columns {
		desiredCols[c.Name] = true
	}
	for _, c := range p.Columns {
		if currentCols[c.Name] {
			continue // present in both: type/nullability changes are out of scope
		}
		def, err := compileColumnDef(c, caps)
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, "ALTER TABLE "+target+" ADD COLUMN "+def)
	}
	for _, c := range current {
		if desiredCols[c.Name] {
			continue
		}
		q, err := QuoteIdent(c.Name, caps.QuoteChar)
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, "ALTER TABLE "+target+" DROP COLUMN "+q)
	}

	currentIdxNames := map[string]bool{}
	for _, idx := range currentIdx {
		currentIdxNames[idx.Name] = true
	}
	desiredIdxNames := map[string]bool{}
	for _, idx := range p.Indexes {
		desiredIdxNames[idx.Name] = true
		if currentIdxNames[idx.Name] {
			continue
		}
		stmt, err := compileCreateIndex(p.Object, idx, caps)
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, stmt)
	}
	for _, idx := range currentIdx {
		if desiredIdxNames[idx.Name] || idx.Primary {
			continue // a primary-key index is dropped only by dropping the column/table
		}
		q, err := QuoteIdent(idx.Name, caps.QuoteChar)
		if err != nil {
			return nil, err
		}
		if caps.QuoteChar == "`" {
			// MySQL indexes are namespaced under their table, not the
			// database, so DROP INDEX requires ON <table>. Backtick quoting
			// is unique to MySQL among the three engines here; a fourth
			// engine must not add a second overloaded check on QuoteChar —
			// see dbquery.supportsILIKE's identical caution in filter.go.
			stmts = append(stmts, "DROP INDEX "+q+" ON "+target)
		} else {
			stmts = append(stmts, "DROP INDEX "+q)
		}
	}
	if len(stmts) == 0 {
		return nil, fmt.Errorf("alter table %s: no changes between current and desired state", p.Object.Name)
	}
	return stmts, nil
}

// ColumnPlansFromMeta converts introspected columns into a TablePlan's column
// list. Used by ShowCreate on engines with no native CREATE-statement query
// (PostgreSQL), reconstructing one from live metadata via CompileTablePlan
// instead of duplicating column-def rendering.
func ColumnPlansFromMeta(cols []port.ColumnMeta) []port.ColumnPlan {
	out := make([]port.ColumnPlan, len(cols))
	for i, c := range cols {
		out[i] = port.ColumnPlan{
			Name: c.Name, DataType: c.DataType, Nullable: c.Nullable,
			Default: c.Default, IsPrimaryKey: c.IsPrimaryKey,
		}
	}
	return out
}

// IndexPlansFromMeta converts introspected indexes, excluding the primary-key
// index — compileCreateTable already renders the primary key inline from
// each column's IsPrimaryKey flag, so including it again here would emit it
// twice.
func IndexPlansFromMeta(idxs []port.IndexMeta) []port.IndexPlan {
	var out []port.IndexPlan
	for _, idx := range idxs {
		if idx.Primary {
			continue
		}
		out = append(out, port.IndexPlan{Name: idx.Name, Columns: idx.Columns, Unique: idx.Unique})
	}
	return out
}

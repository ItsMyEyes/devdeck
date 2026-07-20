package dbquery

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"devdeck/backend/internal/port"
)

// sortedKeys returns m's keys in a deterministic order, so generated SQL and
// placeholder numbering do not depend on Go's randomized map iteration.
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// buildIdentityPredicate renders the WHERE clause that addresses exactly one
// row, per plan.Level. At IdentityRowPointer the row pointer is compared
// first, then every column in plan.KeyColumns (every loaded column — see
// ResolveRowIdentity): the pointer narrows the scan, the value comparison is
// what actually proves identity, since ctid/rowid can move between read and
// commit. At every other level, plan.KeyColumns alone is the predicate.
func buildIdentityPredicate(plan port.RowIdentityPlan, oldValues map[string]any, rowPointer any, caps port.DBCaps, ph Placeholder, argOffset int) (string, []any, error) {
	var parts []string
	var args []any
	n := argOffset

	if plan.Level == port.IdentityRowPointer {
		q, err := QuoteIdent(plan.RowPointerColumn, caps.QuoteChar)
		if err != nil {
			return "", nil, err
		}
		n++
		parts = append(parts, q+" = "+ph(n))
		args = append(args, rowPointer)
	}
	for _, name := range plan.KeyColumns {
		v, ok := oldValues[name]
		if !ok {
			return "", nil, fmt.Errorf("missing old value for identity column %q", name)
		}
		q, err := QuoteIdent(name, caps.QuoteChar)
		if err != nil {
			return "", nil, err
		}
		n++
		parts = append(parts, q+" = "+ph(n))
		args = append(args, v)
	}
	if len(parts) == 0 {
		return "", nil, fmt.Errorf("no identity predicate could be built")
	}
	return strings.Join(parts, " AND "), args, nil
}

// CompileInsert renders a parameterized INSERT. Column names are validated
// against cols and rejected if absent — the same discipline CompileFilters
// applies, since identifiers can never be bound as parameters.
func CompileInsert(obj port.ObjectRef, values map[string]any, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (string, []any, error) {
	if len(values) == 0 {
		return "", nil, fmt.Errorf("insert requires at least one column")
	}
	target, err := QuoteObject(obj, caps)
	if err != nil {
		return "", nil, err
	}
	names := sortedKeys(values)
	var quotedCols []string
	var placeholders []string
	var args []any
	n := 0
	for _, name := range names {
		if _, ok := columnByName(cols, name); !ok {
			return "", nil, fmt.Errorf("unknown column %q", name)
		}
		q, err := QuoteIdent(name, caps.QuoteChar)
		if err != nil {
			return "", nil, err
		}
		quotedCols = append(quotedCols, q)
		n++
		placeholders = append(placeholders, ph(n))
		args = append(args, values[name])
	}
	sql := "INSERT INTO " + target + " (" + strings.Join(quotedCols, ", ") + ") VALUES (" + strings.Join(placeholders, ", ") + ")"
	return sql, args, nil
}

// CompileUpdate renders a parameterized UPDATE ... SET ... WHERE <identity>.
// plan.ReadOnly tables are rejected outright — a caller that reaches this
// function with a read-only plan has a bug upstream (BuildCommitStatements
// checks this before calling CompileUpdate), and failing loudly here is
// cheaper than debugging a write that silently touched zero rows.
func CompileUpdate(obj port.ObjectRef, plan port.RowIdentityPlan, oldValues, newValues map[string]any, rowPointer any, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (string, []any, error) {
	if plan.ReadOnly {
		return "", nil, fmt.Errorf("table is read-only: %s", plan.Reason)
	}
	if len(newValues) == 0 {
		return "", nil, fmt.Errorf("update requires at least one changed column")
	}
	target, err := QuoteObject(obj, caps)
	if err != nil {
		return "", nil, err
	}
	names := sortedKeys(newValues)
	var sets []string
	var args []any
	n := 0
	for _, name := range names {
		if _, ok := columnByName(cols, name); !ok {
			return "", nil, fmt.Errorf("unknown column %q", name)
		}
		q, err := QuoteIdent(name, caps.QuoteChar)
		if err != nil {
			return "", nil, err
		}
		n++
		sets = append(sets, q+" = "+ph(n))
		args = append(args, newValues[name])
	}
	where, whereArgs, err := buildIdentityPredicate(plan, oldValues, rowPointer, caps, ph, n)
	if err != nil {
		return "", nil, err
	}
	args = append(args, whereArgs...)
	sql := "UPDATE " + target + " SET " + strings.Join(sets, ", ") + " WHERE " + where
	return sql, args, nil
}

// CompileDelete renders a parameterized DELETE ... WHERE <identity>.
func CompileDelete(obj port.ObjectRef, plan port.RowIdentityPlan, oldValues map[string]any, rowPointer any, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (string, []any, error) {
	if plan.ReadOnly {
		return "", nil, fmt.Errorf("table is read-only: %s", plan.Reason)
	}
	target, err := QuoteObject(obj, caps)
	if err != nil {
		return "", nil, err
	}
	where, args, err := buildIdentityPredicate(plan, oldValues, rowPointer, caps, ph, 0)
	if err != nil {
		return "", nil, err
	}
	sql := "DELETE FROM " + target + " WHERE " + where
	return sql, args, nil
}

// BuildStatement dispatches one RowEdit to the matching Compile* function and
// attaches the rows-affected guard: update/delete both expect to match
// exactly one row, since the identity predicate was built to address exactly
// one; insert has no such expectation.
func BuildStatement(edit port.RowEdit, plan port.RowIdentityPlan, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (port.Statement, error) {
	one := int64(1)
	switch edit.Kind {
	case "insert":
		sql, args, err := CompileInsert(edit.Object, edit.NewValues, cols, caps, ph)
		if err != nil {
			return port.Statement{}, err
		}
		return port.Statement{SQL: sql, Args: args}, nil
	case "update":
		sql, args, err := CompileUpdate(edit.Object, plan, edit.OldValues, edit.NewValues, edit.RowPointer, cols, caps, ph)
		if err != nil {
			return port.Statement{}, err
		}
		return port.Statement{SQL: sql, Args: args, ExpectRowsAffected: &one}, nil
	case "delete":
		sql, args, err := CompileDelete(edit.Object, plan, edit.OldValues, edit.RowPointer, cols, caps, ph)
		if err != nil {
			return port.Statement{}, err
		}
		return port.Statement{SQL: sql, Args: args, ExpectRowsAffected: &one}, nil
	default:
		return port.Statement{}, fmt.Errorf("unsupported edit kind %q", edit.Kind)
	}
}

// BuildCommitStatements resolves each edit's row-identity strategy against
// its object's live schema and compiles it into an executable statement.
// Objects are introspected once and cached, even when a batch edits several
// rows of the same table — a grid commit routinely does exactly that.
//
// introspector is whatever the caller already has open (a driver's own
// *conn, which satisfies port.Introspector) — this function talks to no
// database itself, which is what keeps it unit-testable without one.
func BuildCommitStatements(ctx context.Context, introspector port.Introspector, edits []port.RowEdit, caps port.DBCaps, ph Placeholder) ([]port.Statement, error) {
	type schemaKey struct{ database, schema, name string }
	colCache := map[schemaKey][]port.ColumnMeta{}
	idxCache := map[schemaKey][]port.IndexMeta{}

	stmts := make([]port.Statement, 0, len(edits))
	for _, e := range edits {
		key := schemaKey{e.Object.Database, e.Object.Schema, e.Object.Name}
		cols, ok := colCache[key]
		if !ok {
			var err error
			cols, err = introspector.Columns(ctx, e.Object)
			if err != nil {
				return nil, err
			}
			colCache[key] = cols
		}
		idxs, ok := idxCache[key]
		if !ok {
			var err error
			idxs, err = introspector.Indexes(ctx, e.Object)
			if err != nil {
				return nil, err
			}
			idxCache[key] = idxs
		}

		var plan port.RowIdentityPlan
		if e.Kind != "insert" {
			plan = ResolveRowIdentity(cols, idxs, caps)
			if plan.ReadOnly {
				return nil, fmt.Errorf("table %q is read-only: %s", e.Object.Name, plan.Reason)
			}
		}
		stmt, err := BuildStatement(e, plan, cols, caps, ph)
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, stmt)
	}
	return stmts, nil
}

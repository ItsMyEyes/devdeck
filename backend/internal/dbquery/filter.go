package dbquery

import (
	"fmt"
	"strings"

	"devdeck/backend/internal/port"
)

// filterOps maps an operator token to its SQL form and expected value count.
// arity -1 means variadic (IN). Anything not in this map is rejected: the
// operator is never taken from user input verbatim.
var filterOps = map[string]struct {
	sql   string
	arity int
}{
	"eq":        {"=", 1},
	"ne":        {"<>", 1},
	"lt":        {"<", 1},
	"gt":        {">", 1},
	"le":        {"<=", 1},
	"ge":        {">=", 1},
	"like":      {"LIKE", 1},
	"ilike":     {"ILIKE", 1},
	"between":   {"BETWEEN", 2},
	"in":        {"IN", -1},
	"isnull":    {"IS NULL", 0},
	"isnotnull": {"IS NOT NULL", 0},
}

func columnByName(cols []port.ColumnMeta, name string) (port.ColumnMeta, bool) {
	for _, c := range cols {
		if c.Name == name {
			return c, true
		}
	}
	return port.ColumnMeta{}, false
}

// CompileFilters turns filters into a WHERE fragment (without the WHERE
// keyword) plus bound arguments. An empty filter list yields an empty string.
//
// Column names are matched against cols — the introspected column list — and
// rejected if absent. Values are always bound, never rendered into the SQL.
func CompileFilters(filters []port.Filter, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (string, []any, error) {
	if len(filters) == 0 {
		return "", nil, nil
	}
	var parts []string
	var args []any
	for _, f := range filters {
		col, ok := columnByName(cols, f.Column)
		if !ok {
			return "", nil, fmt.Errorf("unknown column %q", f.Column)
		}
		op, ok := filterOps[f.Op]
		if !ok {
			return "", nil, fmt.Errorf("unsupported operator %q", f.Op)
		}
		quoted, err := QuoteIdent(col.Name, caps.QuoteChar)
		if err != nil {
			return "", nil, err
		}

		switch f.Op {
		case "isnull", "isnotnull":
			if len(f.Values) != 0 {
				return "", nil, fmt.Errorf("operator %q takes no values", f.Op)
			}
			parts = append(parts, quoted+" "+op.sql)

		case "between":
			if len(f.Values) != 2 {
				return "", nil, fmt.Errorf("operator between requires exactly 2 values, got %d", len(f.Values))
			}
			p1 := ph(len(args) + 1)
			p2 := ph(len(args) + 2)
			args = append(args, f.Values[0], f.Values[1])
			parts = append(parts, fmt.Sprintf("%s BETWEEN %s AND %s", quoted, p1, p2))

		case "in":
			if len(f.Values) == 0 {
				return "", nil, fmt.Errorf("operator in requires at least one value")
			}
			ps := make([]string, len(f.Values))
			for i, v := range f.Values {
				ps[i] = ph(len(args) + 1)
				args = append(args, v)
			}
			parts = append(parts, fmt.Sprintf("%s IN (%s)", quoted, strings.Join(ps, ", ")))

		default:
			if len(f.Values) != 1 {
				return "", nil, fmt.Errorf("operator %q requires exactly 1 value, got %d", f.Op, len(f.Values))
			}
			sqlOp := op.sql
			// ILIKE is PostgreSQL-only. MySQL's LIKE is already
			// case-insensitive under its default collations, and SQLite's
			// LIKE is case-insensitive for ASCII.
			if sqlOp == "ILIKE" && !supportsILIKE(caps) {
				sqlOp = "LIKE"
			}
			p := ph(len(args) + 1)
			args = append(args, f.Values[0])
			parts = append(parts, fmt.Sprintf("%s %s %s", quoted, sqlOp, p))
		}
	}
	return strings.Join(parts, " AND "), args, nil
}

// CompileGlobalSearch builds an OR of substring matches across every
// non-LOB column, cast to text.
//
// This cannot use an index and is a sequential scan by construction. The UI
// labels it as slow; it is not offered as ordinary search.
func CompileGlobalSearch(term string, cols []port.ColumnMeta, caps port.DBCaps, ph Placeholder) (string, []any, error) {
	if term == "" {
		return "", nil, nil
	}
	var parts []string
	var args []any
	for _, c := range cols {
		if c.IsLOB {
			continue // binary data has no useful text form
		}
		quoted, err := QuoteIdent(c.Name, caps.QuoteChar)
		if err != nil {
			return "", nil, err
		}
		op := "LIKE"
		if supportsILIKE(caps) {
			op = "ILIKE"
		}
		p := ph(len(args) + 1)
		args = append(args, "%"+term+"%")
		parts = append(parts, fmt.Sprintf("CAST(%s AS %s) %s %s", quoted, textType(caps), op, p))
	}
	if len(parts) == 0 {
		return "", nil, fmt.Errorf("no searchable columns")
	}
	return "(" + strings.Join(parts, " OR ") + ")", args, nil
}

// supportsILIKE reports whether the engine has the ILIKE operator.
//
// PostgreSQL is the only Piece-A engine that does. Both PostgreSQL and SQLite
// quote with a double quote, so QuoteChar ALONE cannot tell them apart —
// checking only the quote character would emit `ILIKE` against SQLite, which
// has no such operator and fails at runtime. Schemas is what distinguishes
// them today.
//
// This is a two-signal heuristic standing in for a real dialect tag. Both
// call sites must use this one function; duplicating the condition inline is
// how the two branches drifted apart in the first place.
func supportsILIKE(caps port.DBCaps) bool {
	return caps.QuoteChar == `"` && caps.Schemas
}

// textType is the engine's cast-to-text type name.
func textType(caps port.DBCaps) string {
	if caps.QuoteChar == "`" {
		return "CHAR" // MySQL: CAST(x AS TEXT) is invalid
	}
	return "TEXT"
}

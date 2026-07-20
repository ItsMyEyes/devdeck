// Package dbquery — row-identity ladder.
package dbquery

import "devdeck/backend/internal/port"

// ResolveRowIdentity picks the row-identity ladder level for a table from its
// live, freshly introspected columns and indexes — never from anything the
// client supplied, the same discipline CompileFilters applies to column
// names. Descend only when the level above is unavailable:
//
//  1. Primary key — always preferred.
//  2. A non-null unique index — a NULL in a unique index does not
//     participate in SQL's uniqueness comparison, so a nullable one cannot
//     reliably address a row.
//  3. The engine's physical row pointer (ctid/rowid). KeyColumns is set to
//     every loaded column here, not just the pointer: ctid is not stable
//     across a VACUUM or a concurrent UPDATE, so the write predicate compares
//     the pointer AND every old value together — the pointer narrows the
//     scan, the value comparison proves identity.
//  4. Every comparable column — float, json, and blob columns are excluded
//     (ColumnMeta.Comparable), since their equality comparison is either
//     unreliable or, for MySQL json, a runtime error.
//
// A table with none of the above is read-only; ReadOnly explains why.
func ResolveRowIdentity(cols []port.ColumnMeta, indexes []port.IndexMeta, caps port.DBCaps) port.RowIdentityPlan {
	var pkCols []string
	for _, c := range cols {
		if c.IsPrimaryKey {
			pkCols = append(pkCols, c.Name)
		}
	}
	if len(pkCols) > 0 {
		return port.RowIdentityPlan{Level: port.IdentityPrimaryKey, KeyColumns: pkCols}
	}

	for _, idx := range indexes {
		if idx.Unique && !idx.Nullable && len(idx.Columns) > 0 {
			return port.RowIdentityPlan{Level: port.IdentityUniqueIndex, KeyColumns: idx.Columns}
		}
	}

	if caps.RowIdentifier != "" {
		names := make([]string, len(cols))
		for i, c := range cols {
			names[i] = c.Name
		}
		return port.RowIdentityPlan{
			Level:            port.IdentityRowPointer,
			RowPointerColumn: caps.RowIdentifier,
			KeyColumns:       names,
		}
	}

	var comparable []string
	for _, c := range cols {
		if c.Comparable {
			comparable = append(comparable, c.Name)
		}
	}
	if len(comparable) == 0 {
		return port.RowIdentityPlan{
			Level:    port.IdentityNone,
			ReadOnly: true,
			Reason:   "no primary key, unique index, or row identifier, and no column is safely comparable for a fallback match",
		}
	}
	return port.RowIdentityPlan{Level: port.IdentityAllColumns, KeyColumns: comparable}
}

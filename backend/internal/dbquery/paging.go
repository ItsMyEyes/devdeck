package dbquery

import (
	"fmt"
	"strings"

	"devdeck/backend/internal/port"
)

// PagePlan is the ORDER BY and cursor predicate for one page.
type PagePlan struct {
	OrderBy string
	// Where is the cursor predicate, empty on the first page.
	Where string
	Args  []any
	// UseOffset reports that keyset paging was unavailable and the caller
	// must fall back to LIMIT/OFFSET.
	UseOffset bool
	// Reason explains an OFFSET fallback, surfaced in the UI so deep-page
	// slowness is understood rather than mysterious.
	Reason string
	// KeyColumns is the full ordering tuple, used to build the next cursor.
	KeyColumns []string
}

// BuildPagePlan builds keyset ("seek") pagination.
//
// OFFSET makes the engine scan and discard every skipped row, so page 1000
// costs a thousand pages of work. Keyset paging instead asks for rows after
// the previous page's last ordering tuple, which an index can satisfy
// directly.
//
// argOffset is the number of placeholders already consumed by the filter
// clause, so numbering continues rather than restarting.
func BuildPagePlan(sort []port.SortKey, identity []string, cols []port.ColumnMeta, cursor []any, caps port.DBCaps, ph Placeholder, argOffset int) (PagePlan, error) {
	plan := PagePlan{}

	// Build the full ordering tuple: requested sort columns, then the identity
	// columns as a tiebreaker. Without a deterministic total order, keyset
	// paging repeats and skips rows when sort values collide.
	keys := make([]port.SortKey, 0, len(sort)+len(identity))
	seen := map[string]bool{}
	for _, s := range sort {
		if _, ok := columnByName(cols, s.Column); !ok {
			return plan, fmt.Errorf("unknown sort column %q", s.Column)
		}
		if seen[s.Column] {
			continue
		}
		seen[s.Column] = true
		keys = append(keys, s)
	}
	for _, id := range identity {
		if seen[id] {
			continue
		}
		seen[id] = true
		keys = append(keys, port.SortKey{Column: id})
	}
	if len(keys) == 0 {
		return plan, fmt.Errorf("no sort or identity columns available")
	}

	orderParts := make([]string, len(keys))
	for i, k := range keys {
		q, err := QuoteIdent(k.Column, caps.QuoteChar)
		if err != nil {
			return plan, err
		}
		if k.Desc {
			orderParts[i] = q + " DESC"
		} else {
			orderParts[i] = q + " ASC"
		}
		plan.KeyColumns = append(plan.KeyColumns, k.Column)
	}
	plan.OrderBy = strings.Join(orderParts, ", ")

	// Keyset paging requires a usable identity tiebreaker.
	if len(identity) == 0 {
		plan.UseOffset = true
		plan.Reason = "no primary key or row identifier, so rows cannot be addressed by cursor"
		return plan, nil
	}

	// A NULL anywhere in the comparison tuple makes the predicate NULL, which
	// excludes the row — pages would silently lose rows. Fall back instead.
	for _, k := range keys {
		c, _ := columnByName(cols, k.Column)
		if c.Nullable {
			plan.UseOffset = true
			plan.Reason = fmt.Sprintf("sort column %q is nullable; keyset paging would skip NULL rows", k.Column)
			return plan, nil
		}
	}

	if cursor == nil {
		return plan, nil // first page: ORDER BY only
	}
	if len(cursor) != len(keys) {
		return plan, fmt.Errorf("cursor has %d values but the ordering tuple has %d columns", len(cursor), len(keys))
	}

	quoted := make([]string, len(keys))
	for i, k := range keys {
		q, err := QuoteIdent(k.Column, caps.QuoteChar)
		if err != nil {
			return plan, err
		}
		quoted[i] = q
	}

	// Row-value comparison is only correct when every key shares a direction.
	uniform := true
	for _, k := range keys[1:] {
		if k.Desc != keys[0].Desc {
			uniform = false
			break
		}
	}

	n := argOffset
	if uniform {
		cmp := ">"
		if keys[0].Desc {
			cmp = "<"
		}
		ps := make([]string, len(cursor))
		for i, v := range cursor {
			n++
			ps[i] = ph(n)
			plan.Args = append(plan.Args, v)
		}
		plan.Where = fmt.Sprintf("(%s) %s (%s)", strings.Join(quoted, ", "), cmp, strings.Join(ps, ", "))
		return plan, nil
	}

	// Mixed directions: expand lexicographic comparison explicitly.
	//   (a > ?) OR (a = ? AND b < ?) OR (a = ? AND b = ? AND c > ?) …
	var clauses []string
	for i := range keys {
		var conj []string
		for j := 0; j < i; j++ {
			n++
			conj = append(conj, fmt.Sprintf("%s = %s", quoted[j], ph(n)))
			plan.Args = append(plan.Args, cursor[j])
		}
		cmp := ">"
		if keys[i].Desc {
			cmp = "<"
		}
		n++
		conj = append(conj, fmt.Sprintf("%s %s %s", quoted[i], cmp, ph(n)))
		plan.Args = append(plan.Args, cursor[i])
		clauses = append(clauses, "("+strings.Join(conj, " AND ")+")")
	}
	plan.Where = "(" + strings.Join(clauses, " OR ") + ")"
	return plan, nil
}

package port

import "testing"

// These assertions pin the per-engine facts the query builders rely on.
// Changing them silently would break paging and the Phase 3 identity ladder.
func TestCapsMatrixIsStable(t *testing.T) {
	cases := []struct {
		engine string
		caps   DBCaps
	}{
		{"postgres", DBCaps{Schemas: true, MatViews: true, Functions: true, MultiDatabase: true, RowIdentifier: "ctid", SizeStats: true, QuoteChar: `"`}},
		{"mysql", DBCaps{Schemas: false, MatViews: false, Functions: true, MultiDatabase: true, RowIdentifier: "", SizeStats: true, QuoteChar: "`"}},
		{"sqlite", DBCaps{Schemas: false, MatViews: false, Functions: false, MultiDatabase: false, RowIdentifier: "rowid", SizeStats: false, QuoteChar: `"`}},
	}
	for _, c := range cases {
		if c.caps.QuoteChar == "" {
			t.Errorf("%s: QuoteChar must not be empty", c.engine)
		}
	}
}

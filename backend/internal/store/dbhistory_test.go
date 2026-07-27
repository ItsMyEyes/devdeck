package store

import (
	"fmt"
	"testing"
)

// addHistory is a small helper: every field but the SQL text and timestamp is
// noise for most of these assertions.
func addHistory(t *testing.T, s *Store, connID, sqlText, executedAt string) {
	t.Helper()
	if _, err := s.AddDBQueryHistory(connID, sqlText, "success", "", 3, 1, executedAt); err != nil {
		t.Fatalf("add history %q: %v", sqlText, err)
	}
}

func TestAddDBQueryHistoryRoundTrip(t *testing.T) {
	s := newTestStore(t)
	c, _ := s.CreateDBConnection("s", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)

	got, err := s.AddDBQueryHistory(c.ID, "SELECT 1", "success", "", 42, 7, "2026-07-27T10:00:00Z")
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if got.ID == "" {
		t.Fatal("no id assigned")
	}
	if got.ConnectionID != c.ID || got.SQL != "SELECT 1" || got.Status != "success" ||
		got.Error != "" || got.ElapsedMS != 42 || got.RowCount != 7 || got.ExecutedAt != "2026-07-27T10:00:00Z" {
		t.Fatalf("unexpected entry: %+v", got)
	}

	list, err := s.DBQueryHistory(c.ID, 50)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 || list[0] != got {
		t.Fatalf("round trip mismatch:\n got %+v\nwant [%+v]", list, got)
	}
}

func TestAddDBQueryHistoryStoresErrorEntries(t *testing.T) {
	s := newTestStore(t)
	c, _ := s.CreateDBConnection("s", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)

	got, err := s.AddDBQueryHistory(c.ID, "SELECT boom", "error", "query: syntax error", 5, 0, "2026-07-27T10:00:00Z")
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if got.Status != "error" || got.Error != "query: syntax error" || got.RowCount != 0 {
		t.Fatalf("unexpected error entry: %+v", got)
	}
}

func TestDBQueryHistoryIsNewestFirst(t *testing.T) {
	s := newTestStore(t)
	c, _ := s.CreateDBConnection("s", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)

	// Identical timestamps on purpose: ordering must not depend on the clock
	// having ticked between two fast executions.
	for _, q := range []string{"first", "second", "third"} {
		addHistory(t, s, c.ID, q, "2026-07-27T10:00:00Z")
	}
	list, err := s.DBQueryHistory(c.ID, 50)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("len = %d, want 3", len(list))
	}
	if list[0].SQL != "third" || list[1].SQL != "second" || list[2].SQL != "first" {
		t.Fatalf("wrong order: %q, %q, %q", list[0].SQL, list[1].SQL, list[2].SQL)
	}
}

func TestDBQueryHistoryHonorsLimit(t *testing.T) {
	s := newTestStore(t)
	c, _ := s.CreateDBConnection("s", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)
	for i := 0; i < 10; i++ {
		addHistory(t, s, c.ID, fmt.Sprintf("q%d", i), "2026-07-27T10:00:00Z")
	}
	list, err := s.DBQueryHistory(c.ID, 3)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("len = %d, want 3", len(list))
	}
	if list[0].SQL != "q9" {
		t.Fatalf("limit did not take the newest rows: %+v", list)
	}
}

func TestDBQueryHistoryIsScopedToOneConnection(t *testing.T) {
	s := newTestStore(t)
	a, _ := s.CreateDBConnection("a", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)
	b, _ := s.CreateDBConnection("b", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)
	addHistory(t, s, a.ID, "from-a", "2026-07-27T10:00:00Z")
	addHistory(t, s, b.ID, "from-b", "2026-07-27T10:00:00Z")

	list, err := s.DBQueryHistory(a.ID, 50)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 || list[0].SQL != "from-a" {
		t.Fatalf("connection scoping broken: %+v", list)
	}
}

func TestAddDBQueryHistoryPrunesToMostRecent200(t *testing.T) {
	s := newTestStore(t)
	c, _ := s.CreateDBConnection("s", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)
	for i := 0; i < 205; i++ {
		addHistory(t, s, c.ID, fmt.Sprintf("q%d", i), "2026-07-27T10:00:00Z")
	}
	// Ask for more than the cap so a failure to prune shows up as a longer list
	// rather than being hidden by the limit.
	list, err := s.DBQueryHistory(c.ID, 1000)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != dbHistoryMaxPerConnection {
		t.Fatalf("len = %d, want %d after pruning", len(list), dbHistoryMaxPerConnection)
	}
	if list[0].SQL != "q204" {
		t.Fatalf("newest entry = %q, want q204", list[0].SQL)
	}
	if oldest := list[len(list)-1].SQL; oldest != "q5" {
		t.Fatalf("oldest surviving entry = %q, want q5", oldest)
	}
}

func TestAddDBQueryHistoryPruningIsPerConnection(t *testing.T) {
	// Pruning connection A's overflow must not evict connection B's entries.
	s := newTestStore(t)
	a, _ := s.CreateDBConnection("a", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)
	b, _ := s.CreateDBConnection("b", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)

	addHistory(t, s, b.ID, "keep-me", "2026-07-27T10:00:00Z")
	for i := 0; i < 250; i++ {
		addHistory(t, s, a.ID, fmt.Sprintf("q%d", i), "2026-07-27T10:00:00Z")
	}

	list, err := s.DBQueryHistory(b.ID, 50)
	if err != nil {
		t.Fatalf("list b: %v", err)
	}
	if len(list) != 1 || list[0].SQL != "keep-me" {
		t.Fatalf("another connection's pruning evicted b's history: %+v", list)
	}
}

func TestClearDBQueryHistory(t *testing.T) {
	s := newTestStore(t)
	c, _ := s.CreateDBConnection("s", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)
	addHistory(t, s, c.ID, "SELECT 1", "2026-07-27T10:00:00Z")

	if err := s.ClearDBQueryHistory(c.ID); err != nil {
		t.Fatalf("clear: %v", err)
	}
	list, err := s.DBQueryHistory(c.ID, 50)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("history survived clear: %+v", list)
	}
	// Clearing an already-empty history is the caller's intent satisfied, not
	// an error — same reasoning as DeleteDBSecret.
	if err := s.ClearDBQueryHistory(c.ID); err != nil {
		t.Fatalf("second clear: %v", err)
	}
}

func TestDBQueryHistoryCascadesOnConnectionDelete(t *testing.T) {
	s := newTestStore(t)
	c, _ := s.CreateDBConnection("s", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)
	addHistory(t, s, c.ID, "SELECT 1", "2026-07-27T10:00:00Z")

	if err := s.DeleteDBConnection(c.ID); err != nil {
		t.Fatalf("delete connection: %v", err)
	}
	list, err := s.DBQueryHistory(c.ID, 50)
	if err != nil {
		t.Fatalf("list after cascade: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("history survived the connection cascade: %+v", list)
	}
}

func TestDBQueryHistoryEmptyForUnknownConnection(t *testing.T) {
	s := newTestStore(t)
	list, err := s.DBQueryHistory("dbc-nope", 50)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("list = %+v, want empty", list)
	}
}

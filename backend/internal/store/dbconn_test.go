package store

import (
	"testing"

	"devdeck/backend/internal/port"
)

func TestCreateAndReadDBConnection(t *testing.T) {
	s := newTestStore(t)
	got, err := s.CreateDBConnection("staging", "Depoharkam", "postgres", "localhost", 5433, "transform_user", "warehouse", "verify-full", nil, nil, true)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if got.Name != "staging" || got.Engine != "postgres" || got.Port != 5433 {
		t.Fatalf("unexpected row: %+v", got)
	}
	if !got.IsProduction {
		t.Fatal("IsProduction not persisted")
	}
	if got.ExecutorMachineID != nil || got.TunnelConnectionID != nil || got.ServerCertFingerprint != nil {
		t.Fatalf("expected nil optionals, got %+v", got)
	}

	back, err := s.DBConnectionByID(got.ID)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if back != got {
		t.Fatalf("round trip mismatch:\n got %+v\nwant %+v", back, got)
	}
}

func TestUpdateDBConnectionPatchesOnlyProvidedFields(t *testing.T) {
	s := newTestStore(t)
	c, _ := s.CreateDBConnection("staging", "", "postgres", "localhost", 5433, "u", "warehouse", "verify-full", nil, nil, false)

	newName := "staging-renamed"
	got, err := s.UpdateDBConnection(c.ID, port.DBConnectionPatch{Name: &newName})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if got.Name != newName {
		t.Fatalf("name = %q, want %q", got.Name, newName)
	}
	if got.Database != "warehouse" || got.Port != 5433 {
		t.Fatalf("unprovided fields changed: %+v", got)
	}
}

func TestDeleteDBConnectionCascadesSecrets(t *testing.T) {
	s := newTestStore(t)
	c, _ := s.CreateDBConnection("s", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)
	if err := s.UpsertDBSecret(c.ID, "password", "cipher"); err != nil {
		t.Fatalf("upsert secret: %v", err)
	}
	if err := s.DeleteDBConnection(c.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.DBSecretRow(c.ID, "password"); err != ErrNotFound {
		t.Fatalf("secret survived cascade: err = %v", err)
	}
}

func TestDBConnectionByIDNotFound(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.DBConnectionByID("nope"); err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestSavedQueryRoundTripAndCascade(t *testing.T) {
	s := newTestStore(t)
	c, _ := s.CreateDBConnection("s", "", "postgres", "h", 5432, "u", "d", "verify-full", nil, nil, false)

	q, err := s.CreateDBSavedQuery(c.ID, "top assets", "SELECT 1", "2026-07-19T00:00:00Z")
	if err != nil {
		t.Fatalf("create query: %v", err)
	}
	list, err := s.DBSavedQueries(c.ID)
	if err != nil || len(list) != 1 || list[0].ID != q.ID {
		t.Fatalf("list = %+v, err = %v", list, err)
	}

	newSQL := "SELECT 2"
	upd, err := s.UpdateDBSavedQuery(q.ID, "2026-07-20T00:00:00Z", port.DBSavedQueryPatch{SQL: &newSQL})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if upd.SQL != newSQL || upd.Name != "top assets" || upd.UpdatedAt != "2026-07-20T00:00:00Z" {
		t.Fatalf("unexpected update result: %+v", upd)
	}

	if err := s.DeleteDBConnection(c.ID); err != nil {
		t.Fatalf("delete conn: %v", err)
	}
	after, err := s.DBSavedQueries(c.ID)
	if err != nil {
		t.Fatalf("list after cascade: %v", err)
	}
	if len(after) != 0 {
		t.Fatalf("saved queries survived cascade: %+v", after)
	}
}

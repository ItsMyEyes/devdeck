package handler

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"devdeck/backend/internal/dbdriver"
	"devdeck/backend/internal/dbdriver/sqlitedrv"
	"devdeck/backend/internal/port"
)

// The registry is populated from main.go during wiring, not from a driver
// init(), so a test binary has to do the same wiring itself before
// GET /api/db/engines can report anything.
func init() {
	dbdriver.Register("sqlite", sqlitedrv.New())
}

// createSQLiteConnection writes a temp-file SQLite database holding the
// `assets` fixture and registers it as a connection, so the read endpoints can
// be exercised without any external engine.
func (s *dbTestServer) createSQLiteConnection(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fixture.db")

	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer db.Close()
	for _, stmt := range []string{
		`CREATE TABLE assets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER NOT NULL)`,
		`INSERT INTO assets (id, name, qty) VALUES (1, 'alpha', 10), (2, 'beta', 20), (3, 'gamma', 20)`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("fixture %q: %v", stmt, err)
		}
	}

	res := s.post(t, "/api/db/connections",
		`{"name":"fixture","engine":"sqlite","database":"`+path+`","sslMode":""}`)
	if res.Code != http.StatusOK {
		t.Fatalf("create connection: %d %s", res.Code, res.Body.String())
	}
	return s.idOf(t, res)
}

// createBrokenConnection registers a connection that cannot be opened (the
// database file's parent directory does not exist) but does carry a stored
// password, so any error path that echoes the descriptor is caught.
func (s *dbTestServer) createBrokenConnection(t *testing.T, password string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "no-such-dir", "missing.db")
	res := s.post(t, "/api/db/connections",
		`{"name":"broken","engine":"sqlite","database":"`+path+`","sslMode":"","password":"`+password+`"}`)
	if res.Code != http.StatusOK {
		t.Fatalf("create connection: %d %s", res.Code, res.Body.String())
	}
	return s.idOf(t, res)
}

func TestGetEnginesReturnsCapabilities(t *testing.T) {
	srv := newDBTestServer(t)
	res := srv.get(t, "/api/db/engines")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.Code)
	}
	var caps map[string]port.DBCaps
	if err := json.Unmarshal(res.Body.Bytes(), &caps); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if caps["sqlite"].RowIdentifier != "rowid" {
		t.Fatalf("sqlite caps wrong: %+v", caps["sqlite"])
	}
}

func TestRowsClampsLimitToHardMaximum(t *testing.T) {
	// A client asking for a million rows must not be able to pull them.
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	res := srv.post(t, "/api/db/connections/"+id+"/rows",
		`{"object":{"name":"assets","kind":"table"},"limit":1000000}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", res.Code, res.Body.String())
	}
	var out port.ResultSet
	_ = json.Unmarshal(res.Body.Bytes(), &out)
	if len(out.Rows) > 5000 {
		t.Fatalf("returned %d rows, hard cap is 5000", len(out.Rows))
	}
}

func TestPostIndexesReturnsIndexMetadata(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	req := httptest.NewRequest(http.MethodPost, "/api/db/connections/"+id+"/indexes",
		strings.NewReader(`{"object":{"name":"assets","kind":"table"}}`))
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	srv.dbExecH.PostIndexes(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out []port.IndexMeta
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
}

func TestPostCommitAppliesAnUpdate(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t) // "assets" table, seeded with id/name rows per Phase 2's fixture
	req := httptest.NewRequest(http.MethodPost, "/api/db/connections/"+id+"/commit", strings.NewReader(`{
		"edits": [{
			"object": {"name": "assets", "kind": "table"},
			"kind": "update",
			"oldValues": {"id": 1, "name": "alpha"},
			"newValues": {"name": "renamed"}
		}]
	}`))
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	srv.dbExecH.PostCommit(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out port.CommitResult
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Results) != 1 || out.Results[0].RowsAffected != 1 {
		t.Fatalf("out = %+v, want one statement affecting 1 row", out)
	}
}

func TestPostCommitReturnsConflictOnRowsAffectedMismatch(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	req := httptest.NewRequest(http.MethodPost, "/api/db/connections/"+id+"/commit", strings.NewReader(`{
		"edits": [{
			"object": {"name": "assets", "kind": "table"},
			"kind": "update",
			"oldValues": {"id": 999, "name": "does-not-exist"},
			"newValues": {"name": "renamed"}
		}]
	}`))
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	srv.dbExecH.PostCommit(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", rec.Code, rec.Body.String())
	}
}

func TestPostDDLApplyCreatesATable(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	req := httptest.NewRequest(http.MethodPost, "/api/db/connections/"+id+"/ddl/apply", strings.NewReader(`{
		"plan": {
			"object": {"name": "widgets", "kind": "table"},
			"kind": "create",
			"columns": [{"name": "id", "dataType": "INTEGER", "isPrimaryKey": true}]
		}
	}`))
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	srv.dbExecH.PostDDLApply(rec, req)
	if rec.Code != http.StatusOK && rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 200 or 201: %s", rec.Code, rec.Body.String())
	}

	colReq := httptest.NewRequest(http.MethodPost, "/api/db/connections/"+id+"/columns",
		strings.NewReader(`{"object":{"name":"widgets","kind":"table"}}`))
	colReq.SetPathValue("id", id)
	colRec := httptest.NewRecorder()
	srv.dbExecH.PostColumns(colRec, colReq)
	if colRec.Code != http.StatusOK {
		t.Fatalf("columns status = %d: %s", colRec.Code, colRec.Body.String())
	}
	var cols []port.ColumnMeta
	if err := json.Unmarshal(colRec.Body.Bytes(), &cols); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(cols) != 1 || cols[0].Name != "id" {
		t.Fatalf("cols = %+v, want the new widgets table's id column", cols)
	}
}

func TestPostShowCreateReturnsDDL(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	req := httptest.NewRequest(http.MethodPost, "/api/db/connections/"+id+"/show-create",
		strings.NewReader(`{"object":{"name":"assets","kind":"table"}}`))
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	srv.dbExecH.PostShowCreate(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		DDL string `json:"ddl"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.Contains(out.DDL, "CREATE TABLE") {
		t.Fatalf("ddl = %q, want it to contain CREATE TABLE", out.DDL)
	}
}

func TestDescriptorNeverAppearsInErrorResponses(t *testing.T) {
	// A driver error must not leak the DSN or password into the client.
	srv := newDBTestServer(t)
	id := srv.createBrokenConnection(t, "s3cret")
	res := srv.post(t, "/api/db/connections/"+id+"/tree", `{"kind":"tables"}`)
	if res.Code == http.StatusOK {
		t.Fatalf("expected the broken connection to fail, got 200: %s", res.Body.String())
	}
	if strings.Contains(res.Body.String(), "s3cret") {
		t.Fatalf("password leaked in error body: %s", res.Body.String())
	}
}

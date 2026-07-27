package handler

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// createExportFixture registers a SQLite connection whose `products` table has
// a stable, fully specified shape — exact-byte assertions need one.
func (s *dbTestServer) createExportFixture(t *testing.T, extraStmts ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "export.db")

	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer db.Close()
	stmts := append([]string{
		`CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL NOT NULL)`,
		`INSERT INTO products (id, name, price) VALUES (1, 'alpha', 1.5), (2, 'it''s "quoted", ok', 2), (3, 'gamma', 3)`,
	}, extraStmts...)
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("fixture %q: %v", stmt, err)
		}
	}

	res := s.post(t, "/api/db/connections",
		`{"name":"export-fixture","engine":"sqlite","database":"`+path+`","sslMode":""}`)
	if res.Code != http.StatusOK {
		t.Fatalf("create connection: %d %s", res.Code, res.Body.String())
	}
	return s.idOf(t, res)
}

func TestExportCSVExactBytes(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createExportFixture(t)

	res := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"products","kind":"table"},"format":"csv","sort":[{"column":"id"}]}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", res.Code, res.Body.String())
	}
	want := "id,name,price\n" +
		"1,alpha,1.5\n" +
		"2,\"it's \"\"quoted\"\", ok\",2\n" +
		"3,gamma,3\n"
	if got := res.Body.String(); got != want {
		t.Fatalf("csv =\n%q\nwant\n%q", got, want)
	}
	if ct := res.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Fatalf("Content-Type = %q, want text/csv", ct)
	}
	cd := res.Header().Get("Content-Disposition")
	if !strings.Contains(cd, "attachment") || !strings.Contains(cd, "products.csv") {
		t.Fatalf("Content-Disposition = %q", cd)
	}
}

func TestExportSQLExactBytes(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createExportFixture(t)

	res := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"products","kind":"table"},"format":"sql","sort":[{"column":"id"}]}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", res.Code, res.Body.String())
	}
	want := `INSERT INTO "products" ("id", "name", "price") VALUES (1, 'alpha', 1.5);` + "\n" +
		`INSERT INTO "products" ("id", "name", "price") VALUES (2, 'it''s "quoted", ok', 2);` + "\n" +
		`INSERT INTO "products" ("id", "name", "price") VALUES (3, 'gamma', 3);` + "\n"
	if got := res.Body.String(); got != want {
		t.Fatalf("sql =\n%s\nwant\n%s", got, want)
	}
	if ct := res.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("Content-Type = %q, want text/plain", ct)
	}
	if cd := res.Header().Get("Content-Disposition"); !strings.Contains(cd, "products.sql") {
		t.Fatalf("Content-Disposition = %q", cd)
	}
}

func TestExportJSONIsAValidArrayOfObjects(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createExportFixture(t)

	res := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"products","kind":"table"},"format":"json","sort":[{"column":"id"}]}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", res.Code, res.Body.String())
	}
	var rows []map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode %s: %v", res.Body.String(), err)
	}
	if len(rows) != 3 {
		t.Fatalf("rows = %+v, want 3", rows)
	}
	if rows[0]["name"] != "alpha" || rows[2]["name"] != "gamma" {
		t.Fatalf("rows = %+v", rows)
	}
	if ct := res.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	if cd := res.Header().Get("Content-Disposition"); !strings.Contains(cd, "products.json") {
		t.Fatalf("Content-Disposition = %q", cd)
	}
}

func TestExportAppliesFilters(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createExportFixture(t)

	res := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"products","kind":"table"},"format":"csv","sort":[{"column":"id"}],
		  "filters":[{"column":"id","op":"eq","values":[3]}]}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", res.Code, res.Body.String())
	}
	if got := res.Body.String(); got != "id,name,price\n3,gamma,3\n" {
		t.Fatalf("csv = %q, want only the filtered row", got)
	}
}

func TestExportHonorsTheRequestedLimit(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createExportFixture(t)

	res := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"products","kind":"table"},"format":"csv","sort":[{"column":"id"}],"limit":2}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", res.Code, res.Body.String())
	}
	if n := strings.Count(res.Body.String(), "\n"); n != 3 {
		t.Fatalf("body has %d lines, want header + 2 rows:\n%s", n, res.Body.String())
	}
}

func TestExportPagesPastOneDriverPage(t *testing.T) {
	// The driver caps a page at 500 rows and the exporter asks for 1000, so a
	// 1200-row table proves the paging loop follows the cursor rather than
	// stopping at the first page.
	srv := newDBTestServer(t)
	id := srv.createExportFixture(t,
		`WITH RECURSIVE seq(n) AS (SELECT 4 UNION ALL SELECT n+1 FROM seq WHERE n < 1200)
		 INSERT INTO products (id, name, price) SELECT n, 'bulk', 1 FROM seq`)

	res := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"products","kind":"table"},"format":"csv","sort":[{"column":"id"}]}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", res.Code, res.Body.String())
	}
	lines := strings.Count(res.Body.String(), "\n")
	if lines != 1201 {
		t.Fatalf("body has %d lines, want header + 1200 rows", lines)
	}
	// A paging bug that re-requests the same page would duplicate ids.
	if strings.Count(res.Body.String(), "\n1200,") != 1 {
		t.Fatalf("last row missing or duplicated")
	}
}

func TestExportLimitStraddlingAPageBoundaryWritesEveryRow(t *testing.T) {
	// The requested limit is not a multiple of the page size: the final fetch
	// asks for the remaining 200 rows rather than a full page. Guards the
	// arithmetic that shrinks each request to the remaining budget — an
	// off-by-one there either truncates the export or overruns the limit.
	srv := newDBTestServer(t)
	id := srv.createExportFixture(t,
		`WITH RECURSIVE seq(n) AS (SELECT 4 UNION ALL SELECT n+1 FROM seq WHERE n < 1500)
		 INSERT INTO products (id, name, price) SELECT n, 'bulk', 1 FROM seq`)

	res := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"products","kind":"table"},"format":"csv","sort":[{"column":"id"}],"limit":1200}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", res.Code, res.Body.String())
	}
	if lines := strings.Count(res.Body.String(), "\n"); lines != 1201 {
		t.Fatalf("body has %d lines, want header + exactly 1200 rows", lines)
	}
}

func TestExportOmitsLOBColumns(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createExportFixture(t,
		`CREATE TABLE files (id INTEGER PRIMARY KEY, label TEXT NOT NULL, payload BLOB)`,
		`INSERT INTO files (id, label, payload) VALUES (1, 'doc', X'deadbeef')`)

	csvRes := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"files","kind":"table"},"format":"csv","sort":[{"column":"id"}]}`)
	if csvRes.Code != http.StatusOK {
		t.Fatalf("csv status = %d: %s", csvRes.Code, csvRes.Body.String())
	}
	if got := csvRes.Body.String(); got != "id,label\n1,doc\n" {
		t.Fatalf("csv = %q, want the payload column omitted with no note", got)
	}

	sqlRes := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"files","kind":"table"},"format":"sql","sort":[{"column":"id"}]}`)
	if sqlRes.Code != http.StatusOK {
		t.Fatalf("sql status = %d: %s", sqlRes.Code, sqlRes.Body.String())
	}
	body := sqlRes.Body.String()
	if strings.Contains(body, "payload") && !strings.Contains(body, "-- omitted large-object columns: payload") {
		t.Fatalf("sql mentions payload outside the omission comment:\n%s", body)
	}
	if !strings.HasSuffix(body, "-- omitted large-object columns: payload\n") {
		t.Fatalf("sql =\n%s\nwant a trailing omission comment", body)
	}

	jsonRes := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"files","kind":"table"},"format":"json","sort":[{"column":"id"}]}`)
	if strings.Contains(jsonRes.Body.String(), "payload") {
		t.Fatalf("json mentions the omitted column: %s", jsonRes.Body.String())
	}
}

func TestExportRejectsAnUnknownFormatBeforeStreaming(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createExportFixture(t)
	res := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"products","kind":"table"},"format":"xlsx"}`)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", res.Code, res.Body.String())
	}
	// Errors before the first byte still use the standard envelope.
	var envelope struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &envelope); err != nil || envelope.Error == "" {
		t.Fatalf("body = %s, want the {\"error\":...} envelope", res.Body.String())
	}
}

func TestExportRejectsAMissingObjectName(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createExportFixture(t)
	res := srv.post(t, "/api/db/connections/"+id+"/export", `{"object":{"kind":"table"},"format":"csv"}`)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", res.Code, res.Body.String())
	}
}

func TestExportReturnsAnEnvelopeWhenTheTableDoesNotExist(t *testing.T) {
	// The failure happens before any byte is written, so the normal envelope
	// still applies and mapDriverErr's redaction is in force.
	srv := newDBTestServer(t)
	id := srv.createExportFixture(t)
	res := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"no_such_table","kind":"table"},"format":"csv"}`)
	if res.Code == http.StatusOK {
		t.Fatalf("expected a failure, got 200: %s", res.Body.String())
	}
	var envelope struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &envelope); err != nil || envelope.Error == "" {
		t.Fatalf("body = %s, want the error envelope", res.Body.String())
	}
}

func TestExportNeverLeaksTheConnectionPassword(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createBrokenConnection(t, "s3cret")
	res := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"assets","kind":"table"},"format":"csv"}`)
	if res.Code == http.StatusOK {
		t.Fatalf("expected the broken connection to fail, got 200")
	}
	if strings.Contains(res.Body.String(), "s3cret") {
		t.Fatalf("password leaked in export error: %s", res.Body.String())
	}
}

func TestExportOfAnEmptyTableWritesHeaderOnly(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createExportFixture(t, `CREATE TABLE empties (id INTEGER PRIMARY KEY, v TEXT)`)
	res := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"empties","kind":"table"},"format":"csv"}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", res.Code, res.Body.String())
	}
	if got := res.Body.String(); got != "id,v\n" {
		t.Fatalf("csv = %q, want the header row alone", got)
	}
	// JSON's empty case must still be a well-formed array.
	jres := srv.post(t, "/api/db/connections/"+id+"/export",
		`{"object":{"name":"empties","kind":"table"},"format":"json"}`)
	if got := strings.TrimSpace(jres.Body.String()); got != "[]" {
		t.Fatalf("json = %q, want []", got)
	}
}

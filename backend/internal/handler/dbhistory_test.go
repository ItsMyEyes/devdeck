package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"devdeck/backend/internal/domain"
)

func decodeHistory(t *testing.T, body []byte) []domain.DBQueryHistoryEntry {
	t.Helper()
	var out []domain.DBQueryHistoryEntry
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode history from %s: %v", string(body), err)
	}
	return out
}

func TestGetHistoryIsEmptyForANewConnection(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	res := srv.get(t, "/api/db/connections/"+id+"/history")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", res.Code, res.Body.String())
	}
	if got := decodeHistory(t, res.Body.Bytes()); len(got) != 0 {
		t.Fatalf("history = %+v, want empty", got)
	}
	// An empty history must serialize as [] rather than null, so the frontend
	// can map over it without a guard.
	if strings.TrimSpace(res.Body.String()) != "[]" {
		t.Fatalf("body = %s, want []", res.Body.String())
	}
}

func TestPostQueryRecordsASuccessfulExecution(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)

	res := srv.post(t, "/api/db/connections/"+id+"/query", `{"sql":"SELECT id, name FROM assets"}`)
	if res.Code != http.StatusOK {
		t.Fatalf("query status = %d: %s", res.Code, res.Body.String())
	}

	hist := decodeHistory(t, srv.get(t, "/api/db/connections/"+id+"/history").Body.Bytes())
	if len(hist) != 1 {
		t.Fatalf("history = %+v, want one entry", hist)
	}
	e := hist[0]
	if e.SQL != "SELECT id, name FROM assets" {
		t.Fatalf("sql = %q", e.SQL)
	}
	if e.Status != "success" {
		t.Fatalf("status = %q, want success", e.Status)
	}
	if e.Error != "" {
		t.Fatalf("error = %q, want empty on success", e.Error)
	}
	if e.RowCount != 3 {
		t.Fatalf("rowCount = %d, want 3 (the assets fixture)", e.RowCount)
	}
	if e.ExecutedAt == "" {
		t.Fatal("executedAt not recorded")
	}
	if e.ConnectionID != id {
		t.Fatalf("connectionId = %q, want %q", e.ConnectionID, id)
	}
}

func TestPostQueryStillReturnsTheResultSetUnchanged(t *testing.T) {
	// Recording must be a side effect: the response body the frontend reads is
	// exactly the ResultSet it was before history existed.
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)

	res := srv.post(t, "/api/db/connections/"+id+"/query", `{"sql":"SELECT id FROM assets ORDER BY id"}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", res.Code, res.Body.String())
	}
	var out struct {
		Rows [][]any `json:"rows"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Rows) != 3 {
		t.Fatalf("rows = %+v, want the 3 fixture rows", out.Rows)
	}
}

func TestPostQueryRecordsAFailedExecutionWithTheRedactedMessage(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)

	res := srv.post(t, "/api/db/connections/"+id+"/query", `{"sql":"SELECT * FROM no_such_table"}`)
	if res.Code == http.StatusOK {
		t.Fatalf("expected the bad query to fail, got 200: %s", res.Body.String())
	}
	var envelope struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}

	hist := decodeHistory(t, srv.get(t, "/api/db/connections/"+id+"/history").Body.Bytes())
	if len(hist) != 1 {
		t.Fatalf("history = %+v, want one entry", hist)
	}
	if hist[0].Status != "error" {
		t.Fatalf("status = %q, want error", hist[0].Status)
	}
	// The stored message must be byte-identical to what the client received —
	// that is what proves it went through mapDriverErr's redaction rather than
	// being the raw driver error.
	if hist[0].Error != envelope.Error {
		t.Fatalf("stored error = %q, client saw %q", hist[0].Error, envelope.Error)
	}
	if hist[0].RowCount != 0 {
		t.Fatalf("rowCount = %d, want 0 on a failure", hist[0].RowCount)
	}
}

func TestFailedQueryHistoryNeverStoresTheConnectionPassword(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createBrokenConnection(t, "s3cret")

	res := srv.post(t, "/api/db/connections/"+id+"/query", `{"sql":"SELECT 1"}`)
	if res.Code == http.StatusOK {
		t.Fatalf("expected the broken connection to fail, got 200: %s", res.Body.String())
	}
	body := srv.get(t, "/api/db/connections/"+id+"/history").Body.String()
	if strings.Contains(body, "s3cret") {
		t.Fatalf("password leaked into history: %s", body)
	}
}

func TestGetHistoryIsNewestFirst(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	for _, q := range []string{"SELECT 1", "SELECT 2", "SELECT 3"} {
		srv.post(t, "/api/db/connections/"+id+"/query", `{"sql":"`+q+`"}`)
	}
	hist := decodeHistory(t, srv.get(t, "/api/db/connections/"+id+"/history").Body.Bytes())
	if len(hist) != 3 {
		t.Fatalf("history = %+v, want 3 entries", hist)
	}
	if hist[0].SQL != "SELECT 3" || hist[2].SQL != "SELECT 1" {
		t.Fatalf("wrong order: %q ... %q", hist[0].SQL, hist[2].SQL)
	}
}

func TestGetHistoryHonorsLimitParam(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	for _, q := range []string{"SELECT 1", "SELECT 2", "SELECT 3"} {
		srv.post(t, "/api/db/connections/"+id+"/query", `{"sql":"`+q+`"}`)
	}
	hist := decodeHistory(t, srv.get(t, "/api/db/connections/"+id+"/history?limit=2").Body.Bytes())
	if len(hist) != 2 {
		t.Fatalf("len = %d, want 2", len(hist))
	}
	if hist[0].SQL != "SELECT 3" {
		t.Fatalf("limit did not take the newest entries: %+v", hist)
	}
}

func TestGetHistoryRejectsAnUnparseableLimit(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	res := srv.get(t, "/api/db/connections/"+id+"/history?limit=abc")
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", res.Code, res.Body.String())
	}
}

func TestGetHistoryClampsLimitToTheMaximum(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	srv.post(t, "/api/db/connections/"+id+"/query", `{"sql":"SELECT 1"}`)
	// A client asking for a million entries gets the cap, not an error.
	res := srv.get(t, "/api/db/connections/"+id+"/history?limit=1000000")
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", res.Code, res.Body.String())
	}
	if got := decodeHistory(t, res.Body.Bytes()); len(got) != 1 {
		t.Fatalf("history = %+v, want the single recorded entry", got)
	}
}

func TestDeleteHistoryReturns204AndEmptiesTheList(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	srv.post(t, "/api/db/connections/"+id+"/query", `{"sql":"SELECT 1"}`)

	res := srv.delete(t, "/api/db/connections/"+id+"/history")
	if res.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204: %s", res.Code, res.Body.String())
	}
	if got := decodeHistory(t, srv.get(t, "/api/db/connections/"+id+"/history").Body.Bytes()); len(got) != 0 {
		t.Fatalf("history = %+v, want empty after delete", got)
	}
}

func TestPostQueryRejectsEmptySQLWithoutRecording(t *testing.T) {
	srv := newDBTestServer(t)
	id := srv.createSQLiteConnection(t)
	res := srv.post(t, "/api/db/connections/"+id+"/query", `{"sql":"   "}`)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.Code)
	}
	if got := decodeHistory(t, srv.get(t, "/api/db/connections/"+id+"/history").Body.Bytes()); len(got) != 0 {
		t.Fatalf("a validation rejection was recorded as history: %+v", got)
	}
}

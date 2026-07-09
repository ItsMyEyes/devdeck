package handler

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"loom/backend/internal/store"
)

func newTestMachineHandler(t *testing.T) *MachineHandler {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return NewMachineHandler(store.New(db))
}

func TestPostMachineValidatesRequiredFields(t *testing.T) {
	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"builder"}`))) // missing url + key
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestPostMachineRejectsNonHTTPURL(t *testing.T) {
	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"b","url":"ftp://x","key":"k"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestMachineCRUDRoundtrip(t *testing.T) {
	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"builder","url":"https://b.ts.net:8989","key":"rt-key"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d, body %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.GetMachines(rec, httptest.NewRequest(http.MethodGet, "/api/machines", nil))
	if !strings.Contains(rec.Body.String(), `"key":"rt-key"`) {
		t.Errorf("GET /api/machines must distribute keys, body = %s", rec.Body.String())
	}
}

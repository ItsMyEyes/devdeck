package handler

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"loom/backend/internal/machineclient"
	"loom/backend/internal/service"
	"loom/backend/internal/store"
)

func newTestMachineHandler(t *testing.T) *MachineHandler {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return NewMachineHandler(store.New(db), service.NewMachineHealthCache())
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

func TestMachineHealthOnline(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)
	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("rt", backend.URL, "k", false)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/machines/{id}/health", h.GetMachineHealth)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/machines/"+m.ID+"/health", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"online"`) {
		t.Errorf("status=%d body=%s, want 200 online", rec.Code, rec.Body.String())
	}
}

func TestMachineHealthOffline(t *testing.T) {
	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("dead", "http://127.0.0.1:1", "k", false)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/machines/{id}/health", h.GetMachineHealth)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/machines/"+m.ID+"/health", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"offline"`) {
		t.Errorf("status=%d body=%s, want 200 offline", rec.Code, rec.Body.String())
	}
}

func TestPostMachineAcceptsIsLocal(t *testing.T) {
	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"desktop","url":"http://127.0.0.1:9001","key":"k","isLocal":true}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"isLocal":true`) {
		t.Errorf("body = %s, want isLocal:true", rec.Body.String())
	}
}

func TestPostMachineDefaultsIsLocalFalse(t *testing.T) {
	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"builder","url":"https://b.ts.net","key":"k"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"isLocal":false`) {
		t.Errorf("body = %s, want isLocal:false", rec.Body.String())
	}
}

func TestMachineHealthServesFromCacheWithoutLiveCheck(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	cache := service.NewMachineHealthCache()
	h := NewMachineHandler(st, cache)

	// Unreachable URL: if the handler ever did a live check here, it would
	// report offline. The cached value must win instead.
	m, err := st.CreateMachine("cached", "http://127.0.0.1:1", "k", false)
	if err != nil {
		t.Fatal(err)
	}
	cache.Set(m.ID, machineclient.HealthStatus{Status: "online", LatencyMs: 42})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/machines/{id}/health", h.GetMachineHealth)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/machines/"+m.ID+"/health", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"online"`) || !strings.Contains(rec.Body.String(), `"latencyMs":42`) {
		t.Errorf("status=%d body=%s, want cached online/42", rec.Code, rec.Body.String())
	}
}

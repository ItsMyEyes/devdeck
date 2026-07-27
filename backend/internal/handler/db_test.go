package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

// dbTestServer wires a DBHandler onto a real mux with the routes from
// backend/cmd/server/main.go's hub route block (Task 6), plus small request
// helpers. Mirrors the store/handler construction in ssh_test.go and
// machine_test.go; those files call handler methods directly or build an
// inline mux per test, but the request bodies this task's tests need make a
// small shared wrapper worth it.
type dbTestServer struct {
	st      *store.Store
	h       *DBHandler
	dbExecH *DBExecHandler
	mux     *http.ServeMux
}

func newDBTestServer(t *testing.T) *dbTestServer {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	secrets := service.NewDBSecretService(st, make([]byte, 32))
	h := NewDBHandler(st, secrets)
	execH := NewDBExecHandler(service.NewDBExecService(st, secrets))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/db/connections", h.GetConnections)
	mux.HandleFunc("POST /api/db/connections", h.PostConnection)
	mux.HandleFunc("PATCH /api/db/connections/{id}", h.PatchConnection)
	mux.HandleFunc("DELETE /api/db/connections/{id}", h.DeleteConnection)
	mux.HandleFunc("POST /api/db/connections/{id}/secret", h.PostSecret)
	mux.HandleFunc("GET /api/db/connections/{id}/queries", h.GetSavedQueries)
	mux.HandleFunc("POST /api/db/connections/{id}/queries", h.PostSavedQuery)
	mux.HandleFunc("PATCH /api/db/queries/{qid}", h.PatchSavedQuery)
	mux.HandleFunc("DELETE /api/db/queries/{qid}", h.DeleteSavedQuery)
	mux.HandleFunc("GET /api/db/connections/{id}/history", h.GetQueryHistory)
	mux.HandleFunc("DELETE /api/db/connections/{id}/history", h.DeleteQueryHistory)

	// Phase 2 read/execution routes, same shapes as main.go's hub block.
	mux.HandleFunc("GET /api/db/engines", execH.GetEngines)
	mux.HandleFunc("POST /api/db/connections/{id}/test", execH.PostTest)
	mux.HandleFunc("POST /api/db/connections/{id}/tree", execH.PostTree)
	mux.HandleFunc("POST /api/db/connections/{id}/columns", execH.PostColumns)
	mux.HandleFunc("POST /api/db/connections/{id}/stats", execH.PostStats)
	mux.HandleFunc("POST /api/db/connections/{id}/count", execH.PostCount)
	mux.HandleFunc("POST /api/db/connections/{id}/rows", execH.PostRows)
	mux.HandleFunc("POST /api/db/connections/{id}/lob", execH.PostLOB)
	mux.HandleFunc("POST /api/db/connections/{id}/query", execH.PostQuery)
	mux.HandleFunc("POST /api/db/connections/{id}/export", execH.PostExport)

	return &dbTestServer{st: st, h: h, dbExecH: execH, mux: mux}
}

func (s *dbTestServer) do(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	return rec
}

func (s *dbTestServer) post(t *testing.T, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	return s.do(t, http.MethodPost, path, body)
}

func (s *dbTestServer) get(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	return s.do(t, http.MethodGet, path, "")
}

func (s *dbTestServer) patch(t *testing.T, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	return s.do(t, http.MethodPatch, path, body)
}

func (s *dbTestServer) delete(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	return s.do(t, http.MethodDelete, path, "")
}

// createMachine registers a runtime directly through the store (bypassing
// MachineHandler.PostMachine's reachability probe, which is irrelevant here).
func (s *dbTestServer) createMachine(t *testing.T, name, url string) domain.Machine {
	t.Helper()
	m, err := s.st.CreateMachine(name, url, "test-key", false)
	if err != nil {
		t.Fatalf("create machine: %v", err)
	}
	return m
}

func (s *dbTestServer) idOf(t *testing.T, res *httptest.ResponseRecorder) string {
	t.Helper()
	var v struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode id from %s: %v", res.Body.String(), err)
	}
	if v.ID == "" {
		t.Fatalf("no id in response body %s", res.Body.String())
	}
	return v.ID
}

func TestPostConnectionRejectsProductionWithUnverifiedTLS(t *testing.T) {
	srv := newDBTestServer(t)
	body := `{"name":"prod","engine":"postgres","host":"db.internal","port":5432,
	          "username":"u","database":"app","sslMode":"require","isProduction":true}`
	res := srv.post(t, "/api/db/connections", body)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.Code)
	}
	if !strings.Contains(res.Body.String(), "verify") {
		t.Fatalf("error should explain certificate verification, got %s", res.Body.String())
	}
}

func TestPostConnectionRejectsLinkLocalHost(t *testing.T) {
	srv := newDBTestServer(t)
	body := `{"name":"c","engine":"postgres","host":"169.254.169.254","port":5432,
	          "username":"u","database":"d","sslMode":"verify-full"}`
	res := srv.post(t, "/api/db/connections", body)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", res.Code, res.Body.String())
	}
}

func TestPostConnectionRejectsUnsupportedEngine(t *testing.T) {
	srv := newDBTestServer(t)
	res := srv.post(t, "/api/db/connections", `{"name":"r","engine":"redis","host":"h","port":6379}`)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.Code)
	}
}

func TestPostConnectionRejectsPlaintextExecutorMachine(t *testing.T) {
	srv := newDBTestServer(t)
	m := srv.createMachine(t, "public-runtime", "http://203.0.113.9:8989")
	body := `{"name":"c","engine":"postgres","host":"h","port":5432,"username":"u",
	          "database":"d","sslMode":"verify-full","executorMachineId":"` + m.ID + `"}`
	res := srv.post(t, "/api/db/connections", body)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", res.Code, res.Body.String())
	}
}

func TestPostConnectionAcceptsTailnetExecutorMachine(t *testing.T) {
	srv := newDBTestServer(t)
	m := srv.createMachine(t, "tailnet-runtime", "http://runtime.tail1234.ts.net:8989")
	body := `{"name":"c","engine":"postgres","host":"h","port":5432,"username":"u",
	          "database":"d","sslMode":"verify-full","executorMachineId":"` + m.ID + `"}`
	res := srv.post(t, "/api/db/connections", body)
	if res.Code != http.StatusOK && res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 2xx; body = %s", res.Code, res.Body.String())
	}
}

func TestPostConnectionRejectsUnknownExecutorMachine(t *testing.T) {
	srv := newDBTestServer(t)
	body := `{"name":"c","engine":"postgres","host":"h","port":5432,"username":"u",
	          "database":"d","sslMode":"verify-full","executorMachineId":"m-nope"}`
	res := srv.post(t, "/api/db/connections", body)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.Code)
	}
}

func TestPasswordNeverAppearsInAnyResponse(t *testing.T) {
	srv := newDBTestServer(t)
	body := `{"name":"c","engine":"postgres","host":"h","port":5432,"username":"u",
	          "database":"d","sslMode":"verify-full","password":"s3cret"}`
	created := srv.post(t, "/api/db/connections", body)
	if strings.Contains(created.Body.String(), "s3cret") {
		t.Fatal("password echoed in create response")
	}
	list := srv.get(t, "/api/db/connections")
	if strings.Contains(list.Body.String(), "s3cret") {
		t.Fatal("password echoed in list response")
	}
	if strings.Contains(list.Body.String(), "password") {
		t.Fatalf("list response mentions a password field at all: %s", list.Body.String())
	}
}

func TestDeleteConnectionReturns204(t *testing.T) {
	srv := newDBTestServer(t)
	created := srv.post(t, "/api/db/connections", `{"name":"c","engine":"sqlite","database":"/tmp/x.db","sslMode":""}`)
	id := srv.idOf(t, created)
	res := srv.delete(t, "/api/db/connections/"+id)
	if res.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", res.Code)
	}
}

func TestPatchConnectionRevalidatesTLSPolicy(t *testing.T) {
	srv := newDBTestServer(t)
	created := srv.post(t, "/api/db/connections", `{"name":"c","engine":"postgres","host":"h","port":5432,"username":"u","database":"d","sslMode":"require","isProduction":false}`)
	id := srv.idOf(t, created)
	// Flipping an existing weak-TLS connection to production must be rejected,
	// not silently accepted because the sslMode field was not part of the patch.
	res := srv.patch(t, "/api/db/connections/"+id, `{"isProduction":true}`)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", res.Code, res.Body.String())
	}
}

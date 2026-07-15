package handler

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"loom/backend/internal/service"
	"loom/backend/internal/store"
)

func newTestSSHHandler(t *testing.T) *SSHHandler {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	return NewSSHHandler(st, service.NewSSHSecretService(st, make([]byte, 32)))
}

func TestPostSSHConnectionValidatesRequiredFields(t *testing.T) {
	h := newTestSSHHandler(t)
	rec := httptest.NewRecorder()
	h.PostConnection(rec, httptest.NewRequest(http.MethodPost, "/api/ssh/connections",
		strings.NewReader(`{"name":"web"}`))) // missing host + username
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestPostSSHConnectionRejectsBadAuthType(t *testing.T) {
	h := newTestSSHHandler(t)
	rec := httptest.NewRecorder()
	h.PostConnection(rec, httptest.NewRequest(http.MethodPost, "/api/ssh/connections",
		strings.NewReader(`{"name":"web","host":"h","username":"u","authType":"agent","password":"x"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestPostSSHConnectionRequiresMatchingSecret(t *testing.T) {
	h := newTestSSHHandler(t)
	rec := httptest.NewRecorder()
	h.PostConnection(rec, httptest.NewRequest(http.MethodPost, "/api/ssh/connections",
		strings.NewReader(`{"name":"web","host":"h","username":"u","authType":"password"}`))) // no password
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestPostSSHConnectionRejectsUnknownJumpConnection(t *testing.T) {
	h := newTestSSHHandler(t)
	rec := httptest.NewRecorder()
	h.PostConnection(rec, httptest.NewRequest(http.MethodPost, "/api/ssh/connections",
		strings.NewReader(`{"name":"web","host":"h","username":"u","authType":"password","password":"x","jumpConnectionId":"sc-missing"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestPostSSHConnectionRejectsUnknownExecutorMachine(t *testing.T) {
	h := newTestSSHHandler(t)
	rec := httptest.NewRecorder()
	h.PostConnection(rec, httptest.NewRequest(http.MethodPost, "/api/ssh/connections",
		strings.NewReader(`{"name":"web","host":"h","username":"u","authType":"password","password":"x","executorMachineId":"m-missing"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestPostSSHConnectionAcceptsValidJumpConnection(t *testing.T) {
	h := newTestSSHHandler(t)
	jump, err := h.st.CreateSSHConnection("bastion", "", "b", 22, "root", "password", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.PostConnection(rec, httptest.NewRequest(http.MethodPost, "/api/ssh/connections",
		strings.NewReader(`{"name":"web","host":"h","username":"u","authType":"password","password":"x","jumpConnectionId":"`+jump.ID+`"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"jumpConnectionId":"`+jump.ID+`"`) {
		t.Errorf("body = %s, want jumpConnectionId set", rec.Body.String())
	}
}

func TestPatchSSHConnectionRejectsJumpChainCycle(t *testing.T) {
	h := newTestSSHHandler(t)
	a, _ := h.st.CreateSSHConnection("a", "", "h", 22, "u", "password", nil, nil)
	b, err := h.st.CreateSSHConnection("b", "", "h", 22, "u", "password", &a.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /api/ssh/connections/{id}", h.PatchConnection)
	rec := httptest.NewRecorder()
	// a -> b would close the loop, since b already jumps through a.
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/ssh/connections/"+a.ID,
		strings.NewReader(`{"jumpConnectionId":"`+b.ID+`"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 (cycle)", rec.Code)
	}
}

func TestPatchSSHConnectionCanClearJumpConnection(t *testing.T) {
	h := newTestSSHHandler(t)
	jump, _ := h.st.CreateSSHConnection("bastion", "", "b", 22, "root", "password", nil, nil)
	c, err := h.st.CreateSSHConnection("web", "", "h", 22, "u", "password", &jump.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /api/ssh/connections/{id}", h.PatchConnection)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/ssh/connections/"+c.ID,
		strings.NewReader(`{"jumpConnectionId":null}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	got, _ := h.st.SSHConnectionByID(c.ID)
	if got.JumpConnectionID != nil {
		t.Errorf("JumpConnectionID = %v, want cleared", got.JumpConnectionID)
	}
}

func TestSSHConnectionCRUDRoundtripNeverLeaksSecrets(t *testing.T) {
	h := newTestSSHHandler(t)
	rec := httptest.NewRecorder()
	h.PostConnection(rec, httptest.NewRequest(http.MethodPost, "/api/ssh/connections",
		strings.NewReader(`{"name":"web","host":"web.example.com","port":2222,"username":"deploy","authType":"password","password":"hunter2"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d, body %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "hunter2") {
		t.Fatalf("create response leaked the password: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.GetConnections(rec, httptest.NewRequest(http.MethodGet, "/api/ssh/connections", nil))
	body := rec.Body.String()
	if !strings.Contains(body, `"host":"web.example.com"`) || !strings.Contains(body, `"port":2222`) {
		t.Errorf("list body = %s, want the created connection", body)
	}
	if strings.Contains(body, "hunter2") {
		t.Errorf("list body leaked secret material: %s", body)
	}
}

func TestPatchSSHConnectionUpdatesFieldsAndSecrets(t *testing.T) {
	h := newTestSSHHandler(t)
	conn, err := h.st.CreateSSHConnection("web", "", "h", 22, "u", "password", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /api/ssh/connections/{id}", h.PatchConnection)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/ssh/connections/"+conn.ID,
		strings.NewReader(`{"name":"web-2","password":"new-secret"}`)))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"name":"web-2"`) {
		t.Fatalf("patch status=%d body=%s", rec.Code, rec.Body.String())
	}
	got, ok, err := h.secrets.Get(conn.ID, "password")
	if err != nil || !ok || got != "new-secret" {
		t.Errorf("stored password = (%q, %v, %v), want new-secret", got, ok, err)
	}
}

func TestPostAcceptHostKeyClearsPin(t *testing.T) {
	h := newTestSSHHandler(t)
	conn, _ := h.st.CreateSSHConnection("web", "", "h", 22, "u", "password", nil, nil)
	fp := "SHA256:abc"
	if err := h.st.SetSSHHostKey(conn.ID, &fp); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/ssh/connections/{id}/accept-hostkey", h.PostAcceptHostKey)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/ssh/connections/"+conn.ID+"/accept-hostkey", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	got, _ := h.st.SSHConnectionByID(conn.ID)
	if got.HostKeyFingerprint != nil {
		t.Errorf("fingerprint = %q, want cleared", *got.HostKeyFingerprint)
	}
}

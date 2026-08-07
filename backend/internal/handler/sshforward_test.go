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
	"devdeck/backend/internal/sshmgr"
	"devdeck/backend/internal/store"
)

// newTestSSHForwardHandler mirrors ssh_test.go's newTestSSHHandler, plus a
// real seeded SSH connection — ssh_forwards.connection_id has a foreign
// key, so a literal "c1" (ids actually come from idGen("sc-")) would fail
// every write with a 500, not the validation status these tests expect.
func newTestSSHForwardHandler(t *testing.T) (*SSHForwardHandler, string) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	conn, err := st.CreateSSHConnection("web", "", "example.com", 22, "root", "password", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	secrets := service.NewSSHSecretService(st, make([]byte, 32))
	fwd := sshmgr.NewForwarder(sshmgr.NewDialer(st, secrets))
	return NewSSHForwardHandler(st, fwd), conn.ID
}

func TestPostForwardRejectsUnknownMode(t *testing.T) {
	h, connID := newTestSSHForwardHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/ssh/connections/"+connID+"/forwards",
		strings.NewReader(`{"mode":"sideways","bindHost":"127.0.0.1","bindPort":1080}`))
	req.SetPathValue("id", connID)

	h.Post(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	_ = json.NewDecoder(rec.Body).Decode(&body)
	if body["error"] == "" {
		t.Error("missing the {\"error\":...} envelope")
	}
}

func TestPostForwardRejectsLocalWithoutTarget(t *testing.T) {
	h, connID := newTestSSHForwardHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/ssh/connections/"+connID+"/forwards",
		strings.NewReader(`{"mode":"local","bindHost":"127.0.0.1","bindPort":5432}`))
	req.SetPathValue("id", connID)

	h.Post(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
}

func TestPostForwardRejectsDynamicWithTarget(t *testing.T) {
	h, connID := newTestSSHForwardHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/ssh/connections/"+connID+"/forwards",
		strings.NewReader(`{"mode":"dynamic","bindHost":"127.0.0.1","bindPort":1081,"targetHost":"db","targetPort":5432}`))
	req.SetPathValue("id", connID)

	h.Post(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
}

func TestPostForwardRejectsZeroBindPort(t *testing.T) {
	// The API is stricter than sshmgr.validateForward: 0 is only meaningful
	// for an OS-assigned ephemeral test port, never for a saved rule.
	h, connID := newTestSSHForwardHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/ssh/connections/"+connID+"/forwards",
		strings.NewReader(`{"mode":"local","bindPort":0,"targetHost":"db","targetPort":5432}`))
	req.SetPathValue("id", connID)

	h.Post(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
}

func TestPostForwardDefaultsBindHostToLoopback(t *testing.T) {
	h, connID := newTestSSHForwardHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/ssh/connections/"+connID+"/forwards",
		strings.NewReader(`{"mode":"local","bindPort":5432,"targetHost":"db","targetPort":5432}`))
	req.SetPathValue("id", connID)

	h.Post(rec, req)

	if rec.Code != http.StatusOK && rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body domain.SSHForward
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.BindHost != "127.0.0.1" {
		t.Errorf("BindHost = %q, want the loopback default", body.BindHost)
	}
}

func TestGetForConnectionReturnsEmptyArrayNotNull(t *testing.T) {
	h, connID := newTestSSHForwardHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/ssh/connections/"+connID+"/forwards", nil)
	req.SetPathValue("id", connID)

	h.GetForConnection(rec, req)

	if got := strings.TrimSpace(rec.Body.String()); got != "[]" {
		t.Errorf("body = %s, want [] (a null breaks the frontend's .map)", got)
	}
}

func TestPatchLeavesAnOffRuleOff(t *testing.T) {
	// Patch must not silently start a rule that wasn't running.
	h, connID := newTestSSHForwardHandler(t)
	postRec := httptest.NewRecorder()
	postReq := httptest.NewRequest(http.MethodPost, "/api/ssh/connections/"+connID+"/forwards",
		strings.NewReader(`{"mode":"local","bindPort":5432,"targetHost":"db","targetPort":5432}`))
	postReq.SetPathValue("id", connID)
	h.Post(postRec, postReq)
	var created domain.SSHForward
	if err := json.NewDecoder(postRec.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/api/ssh/forwards/"+created.ID,
		strings.NewReader(`{"label":"renamed"}`))
	req.SetPathValue("id", created.ID)
	h.Patch(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := h.forwarder.StateOf(created.ID).Status; got != "off" {
		t.Errorf("StateOf after patching an off rule = %q, want \"off\" (Patch must not start it)", got)
	}
}

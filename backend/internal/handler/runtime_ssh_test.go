package handler

import (
	"context"
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

// This route is the one place a plaintext SSH credential crosses a process
// boundary, so its authorization check is the thing under test here — far more
// than its happy path.

func newRuntimeSSHFixture(t *testing.T) (*RuntimeSSHHandler, *store.Store, *service.SSHSecretService) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "runtimessh.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	st := store.New(db)
	secrets := service.NewSSHSecretService(st, make([]byte, 32))
	return NewRuntimeSSHHandler(st, secrets), st, secrets
}

// call invokes the handler as machine m would — RequireMachineKey resolves the
// caller and puts it in the context, so the test injects it the same way.
func callSecret(t *testing.T, h *RuntimeSSHHandler, m domain.Machine, connID, kind string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"connectionId": connID, "kind": kind})
	req := httptest.NewRequest(http.MethodPost, "/api/runtime/ssh/secret", strings.NewReader(string(body)))
	req = req.WithContext(context.WithValue(req.Context(), machineCtxKey{}, m))
	rec := httptest.NewRecorder()
	h.PostSecret(rec, req)
	return rec
}

func TestRuntimeSSHSecretReturnsCredentialToItsOwnExecutor(t *testing.T) {
	h, st, secrets := newRuntimeSSHFixture(t)

	m, err := st.CreateMachine("runtime-a", "http://runtime-a:7777", "key-a", false)
	if err != nil {
		t.Fatalf("create machine: %v", err)
	}
	conn, err := st.CreateSSHConnection("prod", "", "10.0.0.5", 22, "clouduser", "password", nil, &m.ID)
	if err != nil {
		t.Fatalf("create connection: %v", err)
	}
	if err := secrets.Set(conn.ID, "password", "hunter2"); err != nil {
		t.Fatalf("set secret: %v", err)
	}

	rec := callSecret(t, h, m, conn.ID, "password")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Found bool   `json:"found"`
		Value string `json:"value"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.Found || out.Value != "hunter2" {
		t.Errorf("got found=%v value=%q, want the decrypted password", out.Found, out.Value)
	}
}

// The check this route exists to enforce. Without it, ANY registered runtime
// could read every SSH credential the operator has stored, just by knowing (or
// guessing) a connection id.
func TestRuntimeSSHSecretRefusesAnotherMachinesConnection(t *testing.T) {
	h, st, secrets := newRuntimeSSHFixture(t)

	owner, err := st.CreateMachine("runtime-a", "http://runtime-a:7777", "key-a", false)
	if err != nil {
		t.Fatalf("create machine: %v", err)
	}
	intruder, err := st.CreateMachine("runtime-b", "http://runtime-b:7777", "key-b", false)
	if err != nil {
		t.Fatalf("create machine: %v", err)
	}
	conn, err := st.CreateSSHConnection("prod", "", "10.0.0.5", 22, "clouduser", "password", nil, &owner.ID)
	if err != nil {
		t.Fatalf("create connection: %v", err)
	}
	if err := secrets.Set(conn.ID, "password", "hunter2"); err != nil {
		t.Fatalf("set secret: %v", err)
	}

	rec := callSecret(t, h, intruder, conn.ID, "password")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 — a machine must not read another's credentials", rec.Code)
	}
	// 404 rather than 403 on purpose: distinguishing the two would turn this
	// route into an oracle for enumerating the operator's SSH inventory.
	if strings.Contains(rec.Body.String(), "hunter2") {
		t.Fatal("the credential leaked into the refusal body")
	}
}

// A connection the hub dials itself has no executor, so no runtime may claim
// it — the nil case must not be readable by whoever asks first.
func TestRuntimeSSHSecretRefusesConnectionWithNoExecutor(t *testing.T) {
	h, st, secrets := newRuntimeSSHFixture(t)

	m, err := st.CreateMachine("runtime-a", "http://runtime-a:7777", "key-a", false)
	if err != nil {
		t.Fatalf("create machine: %v", err)
	}
	conn, err := st.CreateSSHConnection("prod", "", "10.0.0.5", 22, "clouduser", "password", nil, nil)
	if err != nil {
		t.Fatalf("create connection: %v", err)
	}
	if err := secrets.Set(conn.ID, "password", "hunter2"); err != nil {
		t.Fatalf("set secret: %v", err)
	}

	if rec := callSecret(t, h, m, conn.ID, "password"); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for a hub-dialed connection", rec.Code)
	}
}

// A key-authenticated connection legitimately has no password stored. That is
// "found: false", not an error — sshmgr.SecretSource's contract is (value, ok,
// error), and reporting it as a failure would break every dial that falls back
// to another credential kind.
func TestRuntimeSSHSecretReportsMissingCredentialAsNotFound(t *testing.T) {
	h, st, _ := newRuntimeSSHFixture(t)

	m, err := st.CreateMachine("runtime-a", "http://runtime-a:7777", "key-a", false)
	if err != nil {
		t.Fatalf("create machine: %v", err)
	}
	conn, err := st.CreateSSHConnection("prod", "", "10.0.0.5", 22, "clouduser", "privatekey", nil, &m.ID)
	if err != nil {
		t.Fatalf("create connection: %v", err)
	}

	rec := callSecret(t, h, m, conn.ID, "password")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var out struct {
		Found bool `json:"found"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out.Found {
		t.Error("reported a credential that was never stored")
	}
}

func TestRuntimeSSHSecretRequiresAMachine(t *testing.T) {
	h, _, _ := newRuntimeSSHFixture(t)

	body, _ := json.Marshal(map[string]string{"connectionId": "sc-1", "kind": "password"})
	req := httptest.NewRequest(http.MethodPost, "/api/runtime/ssh/secret", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()
	h.PostSecret(rec, req) // no machine in context
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 without a resolved machine", rec.Code)
	}
}

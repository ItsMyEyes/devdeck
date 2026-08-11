package handler

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

// fakeForwardStopper records every forward id Stop was called with, mirroring
// sshmgr.Forwarder.Stop's always-nil, idempotent contract.
type fakeForwardStopper struct {
	stopped []string
}

func (f *fakeForwardStopper) Stop(forwardID string) error {
	f.stopped = append(f.stopped, forwardID)
	return nil
}

// fakePoolEvicter records every connection id Evict was called with.
type fakePoolEvicter struct {
	evicted []string
}

func (f *fakePoolEvicter) Evict(connectionID string) {
	f.evicted = append(f.evicted, connectionID)
}

func newTestSSHHandlerWithFakes(t *testing.T) (*SSHHandler, *fakeForwardStopper, *fakePoolEvicter) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	fwd := &fakeForwardStopper{}
	pool := &fakePoolEvicter{}
	h := NewSSHHandler(st, service.NewSSHSecretService(st, make([]byte, 32)), fwd, pool)
	return h, fwd, pool
}

func deleteConnectionRequest(id string) *http.Request {
	req := httptest.NewRequest(http.MethodDelete, "/api/ssh/connections/"+id, nil)
	req.SetPathValue("id", id)
	return req
}

// TestDeleteSSHConnectionStopsForwardsAndEvictsPool covers BUG 1: deleting a
// connection must stop every one of its live port-forwards and evict the
// pooled SSH+SFTP client before the row (and its cascaded ssh_forwards rows)
// disappear — otherwise the forwarder's supervisor goroutine and its bound
// listener/client would keep running forever with no DB row or UI surface
// left to stop them.
func TestDeleteSSHConnectionStopsForwardsAndEvictsPool(t *testing.T) {
	h, fwd, pool := newTestSSHHandlerWithFakes(t)
	conn, err := h.st.CreateSSHConnection("web", "", "h", 22, "u", "password", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	f1, err := h.st.CreateSSHForward(conn.ID, "local", "127.0.0.1", 8080, "target", 80, "")
	if err != nil {
		t.Fatal(err)
	}
	f2, err := h.st.CreateSSHForward(conn.ID, "local", "127.0.0.1", 8081, "target", 81, "")
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	h.DeleteConnection(rec, deleteConnectionRequest(conn.ID))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204, body %s", rec.Code, rec.Body.String())
	}

	wantStopped := map[string]bool{f1.ID: true, f2.ID: true}
	if len(fwd.stopped) != len(wantStopped) {
		t.Fatalf("forwarder.Stop calls = %v, want exactly %v", fwd.stopped, wantStopped)
	}
	for _, id := range fwd.stopped {
		if !wantStopped[id] {
			t.Errorf("forwarder.Stop called with unexpected id %q", id)
		}
	}

	if len(pool.evicted) != 1 || pool.evicted[0] != conn.ID {
		t.Errorf("pool.Evict calls = %v, want exactly [%q]", pool.evicted, conn.ID)
	}

	if _, err := h.st.SSHConnectionByID(conn.ID); err == nil {
		t.Error("connection row still exists after delete")
	}
}

// TestDeleteSSHConnectionUnknownIDIsHarmless covers the not-found case
// called out in the fix: stopping forwards for an id that turns out not to
// exist must not error or panic. SSHForwards on an unknown connection id
// returns an empty list (not an error), so the Stop loop is simply a no-op;
// the actual 404 still comes from the store's DeleteSSHConnection.
func TestDeleteSSHConnectionUnknownIDIsHarmless(t *testing.T) {
	h, fwd, pool := newTestSSHHandlerWithFakes(t)

	rec := httptest.NewRecorder()
	h.DeleteConnection(rec, deleteConnectionRequest("sc-missing"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404, body %s", rec.Code, rec.Body.String())
	}
	if len(fwd.stopped) != 0 {
		t.Errorf("forwarder.Stop calls = %v, want none for an unknown connection", fwd.stopped)
	}
	// Evict is unconditional on id (cheap, always safe), so it still fires.
	if len(pool.evicted) != 1 || pool.evicted[0] != "sc-missing" {
		t.Errorf("pool.Evict calls = %v, want exactly [\"sc-missing\"]", pool.evicted)
	}
}

// TestDeleteSSHConnectionNilForwarderAndPoolDoesNotPanic covers the
// nil-tolerance contract: constructions (like the pre-existing test helper)
// that don't care about live forwards or pooled connections can pass nil for
// both without DeleteConnection panicking.
func TestDeleteSSHConnectionNilForwarderAndPoolDoesNotPanic(t *testing.T) {
	h := newTestSSHHandler(t) // forwarder=nil, pool=nil
	conn, err := h.st.CreateSSHConnection("web", "", "h", 22, "u", "password", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.DeleteConnection(rec, deleteConnectionRequest(conn.ID))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204, body %s", rec.Code, rec.Body.String())
	}
}

// TestPatchSSHConnectionEvictsPool covers BUG 2: editing a connection must
// evict the pooled SSH+SFTP client immediately so pooled REST paths (SFTP,
// stats, RunCommand) stop hitting the old host/credentials rather than
// waiting out the pool's 10-minute idle TTL.
func TestPatchSSHConnectionEvictsPool(t *testing.T) {
	h, _, pool := newTestSSHHandlerWithFakes(t)
	conn, err := h.st.CreateSSHConnection("web", "", "h", 22, "u", "password", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /api/ssh/connections/{id}", h.PatchConnection)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/ssh/connections/"+conn.ID,
		strings.NewReader(`{"host":"new-host"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body %s", rec.Code, rec.Body.String())
	}
	if len(pool.evicted) != 1 || pool.evicted[0] != conn.ID {
		t.Errorf("pool.Evict calls = %v, want exactly [%q]", pool.evicted, conn.ID)
	}
}

// TestPostAcceptHostKeyEvictsPool covers the other half of BUG 2: accepting
// a new host key means the identity of the host changed, so any cached
// pooled transport dialed under the old pin must go too.
func TestPostAcceptHostKeyEvictsPool(t *testing.T) {
	h, _, pool := newTestSSHHandlerWithFakes(t)
	conn, err := h.st.CreateSSHConnection("web", "", "h", 22, "u", "password", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	fp := "SHA256:abc"
	if err := h.st.SetSSHHostKey(conn.ID, &fp); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/ssh/connections/{id}/accept-hostkey", h.PostAcceptHostKey)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/ssh/connections/"+conn.ID+"/accept-hostkey", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204, body %s", rec.Code, rec.Body.String())
	}
	if len(pool.evicted) != 1 || pool.evicted[0] != conn.ID {
		t.Errorf("pool.Evict calls = %v, want exactly [%q]", pool.evicted, conn.ID)
	}
}

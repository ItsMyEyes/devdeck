package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/store"
)

func TestWhoamiReportsRoleAndKeepsStatus(t *testing.T) {
	h := NewWhoamiHandler("runtime", "builder", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/whoami", nil))

	var got map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	// status must survive: machineclient.Probe checks only for a 200, but
	// older clients read this field.
	if got["status"] != "ok" {
		t.Errorf("status = %v, want ok", got["status"])
	}
	if got["role"] != "runtime" {
		t.Errorf("role = %v, want runtime", got["role"])
	}
	if got["machineName"] != "builder" {
		t.Errorf("machineName = %v, want builder", got["machineName"])
	}
}

func TestWhoamiReportsNullLastSyncedBeforeFirstSync(t *testing.T) {
	// nil store: the hub's whoami never reports sync state at all.
	h := NewWhoamiHandler("runtime", "builder", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/whoami", nil))

	var got map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["lastSyncedAt"] != nil {
		t.Errorf("lastSyncedAt = %v, want null", got["lastSyncedAt"])
	}
}

func TestWhoamiReportsLastSyncedAtOnceTheReplicaHasSynced(t *testing.T) {
	// non-nil store, but never applied a snapshot: still null.
	st := store.NewTestStore(t)
	h := NewWhoamiHandler("runtime", "builder", st)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/whoami", nil))

	var got map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["lastSyncedAt"] != nil {
		t.Errorf("lastSyncedAt = %v, want null before any snapshot", got["lastSyncedAt"])
	}

	// Once a snapshot lands, whoami must report it in RFC3339.
	syncedAt := time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC)
	if err := st.ApplyCatalogSnapshot(domain.CatalogSnapshot{}, syncedAt); err != nil {
		t.Fatal(err)
	}

	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/api/whoami", nil))
	var got2 map[string]any
	if err := json.NewDecoder(rec2.Body).Decode(&got2); err != nil {
		t.Fatal(err)
	}
	want := syncedAt.Format(time.RFC3339)
	if got2["lastSyncedAt"] != want {
		t.Errorf("lastSyncedAt = %v, want %v", got2["lastSyncedAt"], want)
	}
}

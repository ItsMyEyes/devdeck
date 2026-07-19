package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/store"
)

func TestCatalogIsScopedToThePresentedMachineKey(t *testing.T) {
	st := newCatalogTestStore(t) // helper defined below

	// Machine A asks with its own key and must see only its own project.
	req := httptest.NewRequest(http.MethodGet, "/api/runtime/catalog", nil)
	req.Header.Set("Authorization", "Bearer key-a")
	rec := httptest.NewRecorder()
	catalogRouter(st).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var snap domain.CatalogSnapshot
	if err := json.NewDecoder(rec.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	if len(snap.Projects) != 1 || snap.Projects[0].Name != "a-project" {
		t.Fatalf("projects = %+v, want only a-project", snap.Projects)
	}

	// An unknown key is rejected outright.
	req2 := httptest.NewRequest(http.MethodGet, "/api/runtime/catalog", nil)
	req2.Header.Set("Authorization", "Bearer not-a-machine")
	rec2 := httptest.NewRecorder()
	catalogRouter(st).ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusUnauthorized {
		t.Errorf("unknown key status = %d, want 401", rec2.Code)
	}
}

func catalogRouter(st *store.Store) http.Handler {
	mux := http.NewServeMux()
	h := NewCatalogHandler(st)
	mux.HandleFunc("GET /api/runtime/catalog", h.GetCatalog)
	return RequireMachineKey(st)(mux)
}

func newCatalogTestStore(t *testing.T) *store.Store {
	t.Helper()
	st := store.NewTestStore(t) // see step 3 note
	ma, _ := st.CreateMachine("a", "https://a.ts.net", "key-a", false)
	mb, _ := st.CreateMachine("b", "https://b.ts.net", "key-b", false)
	ws, _ := st.CreateWorkspace("clients")
	st.CreateProject(ws.ID, "a-project", "/srv/a", "", ma.ID)
	st.CreateProject(ws.ID, "b-project", "/srv/b", "", mb.ID)
	return st
}

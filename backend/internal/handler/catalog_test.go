package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/service"
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
	h := NewCatalogHandler(st, service.NewCatalogService(st))
	mux.HandleFunc("GET /api/runtime/catalog", h.GetCatalog)
	return RequireMachineKey(st)(mux)
}

func TestPostProjectReplayScopesToPresentedMachineAndTranslates409(t *testing.T) {
	st := newCatalogTestStore(t)
	ws, _ := st.CreateWorkspace("orphanable")

	catalogSvc := service.NewCatalogService(st)
	h := NewCatalogHandler(st, catalogSvc)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/runtime/projects", h.PostProject)
	router := RequireMachineKey(st)(mux)

	body := `{"id":"p-offline-1","workspaceId":"` + ws.ID + `","name":"api","path":"/srv/api"}`
	req := httptest.NewRequest(http.MethodPost, "/api/runtime/projects", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer key-a")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s, want 200", rec.Code, rec.Body.String())
	}
	var got domain.Project
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.ID != "p-offline-1" {
		t.Errorf("ID = %q, want p-offline-1 (preserved)", got.ID)
	}
	// Machine IDs are random hex (idGen), not the literal key label, so look
	// up the machine "key-a" actually resolves to rather than assuming a
	// literal value.
	wantMachine, err := st.MachineByKey("key-a")
	if err != nil {
		t.Fatal(err)
	}
	if got.MachineID != wantMachine.ID {
		t.Errorf("MachineID = %q, want %q (forced from the presented key, not from the body)", got.MachineID, wantMachine.ID)
	}

	// Replaying against a workspace that doesn't exist must come back 409,
	// not the store's raw 404 — the spec calls this out explicitly so a
	// runtime can tell "retry later" apart from "gone forever".
	badBody := `{"id":"p-orphan","workspaceId":"ws-does-not-exist","name":"x","path":"/srv/x"}`
	req2 := httptest.NewRequest(http.MethodPost, "/api/runtime/projects", strings.NewReader(badBody))
	req2.Header.Set("Authorization", "Bearer key-a")
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409", rec2.Code)
	}
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

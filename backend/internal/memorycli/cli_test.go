package memorycli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"devdeck/backend/internal/port"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

// newTestDB creates a real, throwaway sqlite database and returns its path —
// runRecall/runGraph open one exactly like the running hub's, via --db.
func newTestDB(t *testing.T) string {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "devdeck.db")
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	return dbPath
}

func configureMemory(t *testing.T, dbPath, baseURL string) {
	t.Helper()
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("reopen db: %v", err)
	}
	defer db.Close()
	svc := service.NewMemoryService(store.New(db), filepath.Dir(dbPath))
	enabled := true
	if _, err := svc.UpdateConfig(port.MemoryConfigPatch{
		Enabled: &enabled, BaseURL: &baseURL, HasBaseURL: true,
	}); err != nil {
		t.Fatalf("UpdateConfig: %v", err)
	}
}

// TestRunRecallReturnsRealErrorWhenNotConfigured pins the deliberate
// difference from the automatic per-turn recall path (RecallBlock, which
// degrades silently): an explicit `devdeck memory recall` invocation is an
// agent asking a direct question and deserves a real, visible answer when
// memory isn't reachable, not a quietly empty result it might mistake for
// "nothing relevant was found."
func TestRunRecallReturnsRealErrorWhenNotConfigured(t *testing.T) {
	dbPath := newTestDB(t)
	var stdout, stderr bytes.Buffer
	if err := runRecall([]string{"--db", dbPath, "what do I like?"}, &stdout, &stderr); err == nil {
		t.Fatal("expected an error when memory isn't configured")
	}
}

func TestRunRecallRequiresAQuery(t *testing.T) {
	dbPath := newTestDB(t)
	var stdout, stderr bytes.Buffer
	if err := runRecall([]string{"--db", dbPath}, &stdout, &stderr); err == nil {
		t.Fatal("expected an error when no query is given")
	}
}

func TestRunRecallPrintsRealServerResults(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{{"text": "prefers dark mode", "type": "world"}},
		})
	}))
	defer srv.Close()

	dbPath := newTestDB(t)
	configureMemory(t, dbPath, srv.URL)

	var stdout, stderr bytes.Buffer
	if err := runRecall([]string{"--db", dbPath, "preferences?"}, &stdout, &stderr); err != nil {
		t.Fatalf("runRecall: %v", err)
	}
	var resp struct {
		Results []struct {
			Text string `json:"text"`
		} `json:"results"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &resp); err != nil {
		t.Fatalf("stdout not valid JSON: %v", err)
	}
	if len(resp.Results) != 1 || resp.Results[0].Text != "prefers dark mode" {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestRunGraphPrintsRealNeighbors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"nodes": []map[string]any{
				{"data": map[string]any{"id": "1", "label": "Kubernetes"}},
				{"data": map[string]any{"id": "2", "label": "RKE2"}},
			},
			"edges": []map[string]any{
				{"data": map[string]any{"source": "1", "target": "2", "linkType": "cooccurrence", "weight": 9}},
			},
		})
	}))
	defer srv.Close()

	dbPath := newTestDB(t)
	configureMemory(t, dbPath, srv.URL)

	var stdout, stderr bytes.Buffer
	if err := runGraph([]string{"--db", dbPath, "Kubernetes"}, &stdout, &stderr); err != nil {
		t.Fatalf("runGraph: %v", err)
	}
	var lookup struct {
		Found   bool `json:"found"`
		Results []struct {
			Entity    string `json:"entity"`
			Neighbors []struct {
				Entity string `json:"entity"`
			} `json:"neighbors"`
		} `json:"results"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &lookup); err != nil {
		t.Fatalf("stdout not valid JSON: %v\nstdout: %s", err, stdout.String())
	}
	if !lookup.Found || len(lookup.Results) != 1 || lookup.Results[0].Entity != "Kubernetes" {
		t.Fatalf("lookup = %+v", lookup)
	}
	if len(lookup.Results[0].Neighbors) != 1 || lookup.Results[0].Neighbors[0].Entity != "RKE2" {
		t.Fatalf("neighbors = %+v", lookup.Results[0].Neighbors)
	}
}

func TestRunGraphRequiresAnEntity(t *testing.T) {
	dbPath := newTestDB(t)
	var stdout, stderr bytes.Buffer
	if err := runGraph([]string{"--db", dbPath}, &stdout, &stderr); err == nil {
		t.Fatal("expected an error when no entity is given")
	}
}

func TestRunGraphRejectsInvalidMode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{})
	}))
	defer srv.Close()

	dbPath := newTestDB(t)
	configureMemory(t, dbPath, srv.URL)

	var stdout, stderr bytes.Buffer
	if err := runGraph([]string{"--db", dbPath, "--mode", "bogus", "X"}, &stdout, &stderr); err == nil {
		t.Fatal("expected an error for an invalid --mode")
	}
}

func TestDispatchRoutesRecallAndGraph(t *testing.T) {
	if _, handled := Dispatch([]string{"devdeck", "notmemory"}); handled {
		t.Fatal("Dispatch must only handle argv[1] == \"memory\"")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"results": []map[string]any{}})
	}))
	defer srv.Close()
	dbPath := newTestDB(t)
	configureMemory(t, dbPath, srv.URL)

	code, handled := Dispatch([]string{"devdeck", "memory", "recall", "--db", dbPath, "anything"})
	if !handled || code != 0 {
		t.Fatalf("Dispatch(recall) = code=%d handled=%v, want 0/true", code, handled)
	}
	code, handled = Dispatch([]string{"devdeck", "memory", "bogus-subcommand"})
	if !handled || code == 0 {
		t.Fatalf("Dispatch(bogus) = code=%d handled=%v, want nonzero/true", code, handled)
	}
}

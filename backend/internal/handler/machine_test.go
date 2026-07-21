package handler

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/handovertoken"
	"devdeck/backend/internal/machineclient"
	"devdeck/backend/internal/service"
	"devdeck/backend/internal/store"
)

func newTestMachineHandler(t *testing.T) *MachineHandler {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	_, priv, _ := ed25519.GenerateKey(nil)
	return NewMachineHandler(store.New(db), service.NewMachineHealthCache(), nil, priv)
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
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer rt-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"builder","url":"`+backend.URL+`","key":"rt-key"}`)))
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
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"desktop","url":"`+backend.URL+`","key":"k","isLocal":true}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"isLocal":true`) {
		t.Errorf("body = %s, want isLocal:true", rec.Body.String())
	}
}

func TestPostMachineDefaultsIsLocalFalse(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"builder","url":"`+backend.URL+`","key":"k"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"isLocal":false`) {
		t.Errorf("body = %s, want isLocal:false", rec.Body.String())
	}
}

func TestPostMachineRejectsUnreachableURL(t *testing.T) {
	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"ghost","url":"http://127.0.0.1:1","key":"k"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for an unreachable machine", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "could not connect") {
		t.Errorf("body = %s, want it to mention the connection failure", rec.Body.String())
	}
}

func TestPostMachineRejectsWrongKey(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer correct-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"builder","url":"`+backend.URL+`","key":"wrong-key"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for a rejected key", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "rejected the key") {
		t.Errorf("body = %s, want it to mention the key was rejected", rec.Body.String())
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
	_, priv, _ := ed25519.GenerateKey(nil)
	h := NewMachineHandler(st, cache, nil, priv)

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

func TestGetMachinesIncludesTheHubSigningPublicKey(t *testing.T) {
	st := store.NewTestStore(t)
	st.CreateMachine("builder", "https://a.ts.net", "key-a", false)
	_, priv, _ := ed25519.GenerateKey(nil)

	h := NewMachineHandler(st, service.NewMachineHealthCache(), nil, priv)
	req := httptest.NewRequest(http.MethodGet, "/api/machines", nil)
	rec := httptest.NewRecorder()
	h.GetMachines(rec, req)

	var got []domain.Machine
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].SigningPublicKey == "" {
		t.Fatalf("GetMachines() = %+v, want one machine with a non-empty SigningPublicKey", got)
	}
	wantPub := base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))
	if got[0].SigningPublicKey != wantPub {
		t.Errorf("SigningPublicKey = %q, want %q (base64 of priv.Public())", got[0].SigningPublicKey, wantPub)
	}
}

func TestPostMachineRestartCallsTheMachinesSelfRestart(t *testing.T) {
	var gotPath string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("builder", backend.URL, "k", false)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/machines/{id}/restart", h.PostMachineRestart)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/machines/"+m.ID+"/restart", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/api/self/restart" {
		t.Errorf("backend received path %q, want /api/self/restart", gotPath)
	}
}

func TestPostMachineRestartSurfacesUnreachable(t *testing.T) {
	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("dead", "http://127.0.0.1:1", "k", false)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/machines/{id}/restart", h.PostMachineRestart)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/machines/"+m.ID+"/restart", nil))

	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502 for an unreachable machine", rec.Code)
	}
}

func TestPostMachineStopCallsTheMachinesSelfStop(t *testing.T) {
	var gotPath string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("builder", backend.URL, "k", false)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/machines/{id}/stop", h.PostMachineStop)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/machines/"+m.ID+"/stop", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/api/self/stop" {
		t.Errorf("backend received path %q, want /api/self/stop", gotPath)
	}
}

func TestPostMachineStopRefusesForLocalMachine(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("must not call the local machine's /api/self/stop at all")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("desktop", backend.URL, "k", true)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/machines/{id}/stop", h.PostMachineStop)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/machines/"+m.ID+"/stop", nil))

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for stopping the local machine", rec.Code)
	}
}

func TestPostTokenMintsAHandoverTokenForTheAuthenticatedUser(t *testing.T) {
	st := store.NewTestStore(t)
	m, _ := st.CreateMachine("builder", "https://a.ts.net", "key-a", false)
	_, priv, _ := ed25519.GenerateKey(nil)
	authKey := make([]byte, 32)
	authSvc := service.NewAuthService(st, authKey)

	// KeySession's underlying mechanism creates/reuses the single operator
	// account and issues a real session — reused here purely to get a
	// valid (userID, sessionToken) pair to authenticate the request with,
	// the same way any other authenticated hub handler test would.
	sessionToken, user, err := authSvc.KeySession()
	if err != nil {
		t.Fatal(err)
	}

	h := NewMachineHandler(st, service.NewMachineHealthCache(), authSvc, priv)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/machines/{id}/token", h.PostToken)

	req := httptest.NewRequest(http.MethodPost, "/api/machines/"+m.ID+"/token", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionToken})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s, want 200", rec.Code, rec.Body.String())
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	pub := priv.Public().(ed25519.PublicKey)
	claims, err := handovertoken.Verify(pub, body.Token, m.ID, time.Now())
	if err != nil {
		t.Fatalf("minted token failed to verify: %v", err)
	}
	if claims.Sub != user.ID {
		t.Errorf("claims.Sub = %q, want %q", claims.Sub, user.ID)
	}

	// A request for a machine id that doesn't exist must 404, not silently
	// mint a token for nothing.
	req2 := httptest.NewRequest(http.MethodPost, "/api/machines/m-does-not-exist/token", nil)
	req2.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionToken})
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusNotFound {
		t.Errorf("status for unknown machine = %d, want 404", rec2.Code)
	}
}

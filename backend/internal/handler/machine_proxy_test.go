package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"loom/backend/internal/store"

	"nhooyr.io/websocket"
)

// proxyTestEnv registers a machine pointing at a fake runtime and returns a
// mux with the proxy route mounted the same way main.go mounts it.
func proxyTestEnv(t *testing.T, runtime http.Handler) (*http.ServeMux, *store.Store) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	backend := httptest.NewServer(runtime)
	t.Cleanup(backend.Close)
	if _, err := st.CreateMachine("rt", backend.URL, "rt-key", false); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/api/machines/{id}/proxy/{rest...}", NewMachineProxyHandler(st))
	return mux, st
}

func machineID(t *testing.T, st *store.Store) string {
	t.Helper()
	list, err := st.Machines()
	if err != nil || len(list) == 0 {
		t.Fatal("no machine registered")
	}
	return list[0].ID
}

func TestProxyInjectsRuntimeKeyAndStripsClientCredentials(t *testing.T) {
	var gotAuth, gotCookie string
	mux, st := proxyTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotCookie = r.Header.Get("Cookie")
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/machines/"+machineID(t, st)+"/proxy/api/health", nil)
	req.Header.Set("Authorization", "Bearer hub-key")
	req.Header.Set("Cookie", "loom_session=secret")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if gotAuth != "Bearer rt-key" {
		t.Errorf("runtime saw Authorization = %q, want Bearer rt-key", gotAuth)
	}
	if gotCookie != "" {
		t.Errorf("runtime saw Cookie = %q, want empty", gotCookie)
	}
}

func TestProxyStripsUpstreamCORSHeaders(t *testing.T) {
	mux, st := proxyTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*") // runtime's own CorsMiddleware sets this
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/api/machines/"+machineID(t, st)+"/proxy/api/health", nil))
	if got := rec.Header().Values("Access-Control-Allow-Origin"); len(got) != 0 {
		t.Errorf("proxied ACAO = %v, want stripped (hub CorsMiddleware adds its own)", got)
	}
}

func TestProxyDropsKeyQueryParam(t *testing.T) {
	var gotQuery string
	mux, st := proxyTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
	}))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/api/machines/"+machineID(t, st)+"/proxy/ws/terminal?session=s1&key=hubkey", nil))
	if strings.Contains(gotQuery, "key=") {
		t.Errorf("hub key leaked to runtime: query = %q", gotQuery)
	}
	if !strings.Contains(gotQuery, "session=s1") {
		t.Errorf("legit params must survive: query = %q", gotQuery)
	}
}

func TestProxyUnknownMachineReturns404(t *testing.T) {
	mux, _ := proxyTestEnv(t, http.NotFoundHandler())
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/machines/m-nope/proxy/api/health", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

// TestMachineProxyWebSocketSurvivesFullMiddlewareStack proves a WebSocket
// upgrade makes it through the proxy when wrapped in the SAME middleware
// chain main.go applies to /api/* routes (CorsMiddleware + JSONErrorMiddleware).
// The other proxy tests above call the handler directly with
// httptest.NewRecorder(), which never exercises JSONErrorMiddleware's
// errRecorder wrapping — that gap is why the real server 502'd with
// "machine unreachable" (errRecorder didn't implement http.Hijacker, so
// httputil.ReverseProxy couldn't hijack the connection to relay the
// runtime's 101 Switching Protocols response) even though these unit tests
// were green.
func TestMachineProxyWebSocketSurvivesFullMiddlewareStack(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)

	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		ctx := r.Context()
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if err := conn.Write(ctx, typ, data); err != nil {
			return
		}
		conn.Close(websocket.StatusNormalClosure, "")
	}))
	t.Cleanup(runtime.Close)

	if _, err := st.CreateMachine("rt", runtime.URL, "rt-key", false); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("/api/machines/{id}/proxy/{rest...}", NewMachineProxyHandler(st))
	// Reproduce the exact wrapping main.go puts around /api/* handlers.
	root := CorsMiddleware(JSONErrorMiddleware(mux))
	hub := httptest.NewServer(root)
	t.Cleanup(hub.Close)

	wsURL := "ws" + strings.TrimPrefix(hub.URL, "http") + "/api/machines/" + machineID(t, st) + "/proxy/ws/echo"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial proxied WebSocket through full middleware stack: %v", err)
	}
	defer conn.CloseNow()

	if err := conn.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
		t.Fatalf("write proxied frame: %v", err)
	}
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read proxied echo: %v", err)
	}
	if string(data) != "ping" {
		t.Errorf("echo = %q, want ping", data)
	}
}

func TestProxyUnreachableRuntimeReturns502(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	if _, err := st.CreateMachine("dead", "http://127.0.0.1:1", "k", false); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/api/machines/{id}/proxy/{rest...}", NewMachineProxyHandler(st))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/api/machines/"+machineID(t, st)+"/proxy/api/health", nil))
	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "machine unreachable") {
		t.Errorf("body = %s, want machine unreachable envelope", rec.Body.String())
	}
}

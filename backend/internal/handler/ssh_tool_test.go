package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"devdeck/backend/internal/service"
	"devdeck/backend/internal/sshtool"
)

// fakeToolSvc is a minimal sshToolService fake. Exec records the session
// and command it was called with so tests can assert on them; err, when
// set, is returned by whichever method is exercised. The four file methods
// return zero values — no test here exercises their success path, only
// that the routes exist and are guarded by RequireThreadToken.
type fakeToolSvc struct {
	gotSession sshtool.Session
	gotCommand string
	err        error
}

func (f *fakeToolSvc) Exec(_ context.Context, sess sshtool.Session, command string) (service.ExecResult, error) {
	f.gotSession, f.gotCommand = sess, command
	if f.err != nil {
		return service.ExecResult{}, f.err
	}
	return service.ExecResult{Stdout: "ok", ExitCode: 0}, nil
}

func (f *fakeToolSvc) ReadFile(_ context.Context, sess sshtool.Session, path string) (service.SSHFileContent, error) {
	f.gotSession = sess
	if f.err != nil {
		return service.SSHFileContent{}, f.err
	}
	return service.SSHFileContent{Path: path, Content: "contents"}, nil
}

func (f *fakeToolSvc) ListFiles(_ context.Context, sess sshtool.Session, _ string) ([]service.SSHFileEntry, error) {
	f.gotSession = sess
	if f.err != nil {
		return nil, f.err
	}
	return []service.SSHFileEntry{{Name: "a", Path: "/a", IsDir: false, Size: 3}}, nil
}

func (f *fakeToolSvc) Grep(_ context.Context, sess sshtool.Session, query string) (service.GrepResult, error) {
	f.gotSession, f.gotCommand = sess, query
	if f.err != nil {
		return service.GrepResult{}, f.err
	}
	return service.GrepResult{Engine: "rg", RgAvailable: true}, nil
}

func (f *fakeToolSvc) WriteFile(_ context.Context, sess sshtool.Session, path, _ string) (service.SSHFileContent, error) {
	f.gotSession = sess
	if f.err != nil {
		return service.SSHFileContent{}, f.err
	}
	return service.SSHFileContent{Path: path}, nil
}

func TestExecRequiresToken(t *testing.T) {
	store := sshtool.NewTokenStore()
	mux := newToolMux(store, &fakeToolSvc{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/agent-tools/ssh/exec", strings.NewReader(`{"command":"ls"}`))
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	var body map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["error"] == "" {
		t.Fatal("401 did not use the {\"error\":...} envelope")
	}
}

func TestExecDerivesConnectionFromToken(t *testing.T) {
	store := sshtool.NewTokenStore()
	tok := store.Mint("ssh:c-1", "c-1")
	svc := &fakeToolSvc{}
	mux := newToolMux(store, svc)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/agent-tools/ssh/exec", strings.NewReader(`{"command":"ls -la","connectionId":"c-999"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body)
	}
	// The body's connectionId must be ignored entirely — the token decides.
	if svc.gotSession.ConnectionID != "c-1" {
		t.Fatalf("connection = %q, want c-1 (from token)", svc.gotSession.ConnectionID)
	}
	if svc.gotCommand != "ls -la" {
		t.Fatalf("command = %q", svc.gotCommand)
	}
}

func TestExecDeniedReturns403(t *testing.T) {
	store := sshtool.NewTokenStore()
	tok := store.Mint("ssh:c-1", "c-1")
	mux := newToolMux(store, &fakeToolSvc{err: service.ErrDenied})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/agent-tools/ssh/exec", strings.NewReader(`{"command":"rm -rf /"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	var body map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["error"] != "denied by user" {
		t.Fatalf("error = %q, want %q", body["error"], "denied by user")
	}
}

func TestExecApprovalTimeoutReturns403(t *testing.T) {
	store := sshtool.NewTokenStore()
	tok := store.Mint("ssh:c-1", "c-1")
	mux := newToolMux(store, &fakeToolSvc{err: context.DeadlineExceeded})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/agent-tools/ssh/exec", strings.NewReader(`{"command":"systemctl restart nginx"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	var body map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["error"] != "approval timed out" {
		t.Fatalf("error = %q, want %q", body["error"], "approval timed out")
	}
}

func TestExecTransportErrorReturns502(t *testing.T) {
	store := sshtool.NewTokenStore()
	tok := store.Mint("ssh:c-1", "c-1")
	mux := newToolMux(store, &fakeToolSvc{err: errTransport})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/agent-tools/ssh/exec", strings.NewReader(`{"command":"ls"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	var body map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["error"] != errTransport.Error() {
		t.Fatalf("error = %q, want %q", body["error"], errTransport.Error())
	}
}

var errTransport = errTransportErr{}

type errTransportErr struct{}

func (errTransportErr) Error() string { return "dial tcp: connection refused" }

func TestReadFileRequiresToken(t *testing.T) {
	store := sshtool.NewTokenStore()
	mux := newToolMux(store, &fakeToolSvc{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/agent-tools/ssh/file?path=/etc/hosts", nil)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestListFilesWrapsEntriesUnderKey(t *testing.T) {
	store := sshtool.NewTokenStore()
	tok := store.Mint("ssh:c-1", "c-1")
	mux := newToolMux(store, &fakeToolSvc{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/agent-tools/ssh/files?path=/etc", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body)
	}
	var body struct {
		Entries []service.SSHFileEntry `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(body.Entries) != 1 || body.Entries[0].Name != "a" {
		t.Fatalf("entries = %+v", body.Entries)
	}
}

func TestGrepUsesQueryParamAndToken(t *testing.T) {
	store := sshtool.NewTokenStore()
	tok := store.Mint("ssh:c-1", "c-1")
	svc := &fakeToolSvc{}
	mux := newToolMux(store, svc)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/agent-tools/ssh/grep?q=TODO&path=/srv", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body)
	}
	if svc.gotCommand != "TODO" {
		t.Fatalf("query = %q, want %q", svc.gotCommand, "TODO")
	}
	if svc.gotSession.ConnectionID != "c-1" {
		t.Fatalf("connection = %q, want c-1", svc.gotSession.ConnectionID)
	}
}

func TestWriteFileIgnoresBodyConnectionID(t *testing.T) {
	store := sshtool.NewTokenStore()
	tok := store.Mint("ssh:c-1", "c-1")
	svc := &fakeToolSvc{}
	mux := newToolMux(store, svc)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/agent-tools/ssh/file", strings.NewReader(`{"path":"/tmp/x","content":"hi","connectionId":"c-999"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body)
	}
	if svc.gotSession.ConnectionID != "c-1" {
		t.Fatalf("connection = %q, want c-1 (from token)", svc.gotSession.ConnectionID)
	}
}

func TestExecAcceptsQueryKeyFallback(t *testing.T) {
	store := sshtool.NewTokenStore()
	tok := store.Mint("ssh:c-1", "c-1")
	mux := newToolMux(store, &fakeToolSvc{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/agent-tools/ssh/exec?key="+tok, strings.NewReader(`{"command":"ls"}`))
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body)
	}
}

// newToolMux builds the same route wiring Task 9 registers in main.go: the
// five /api/agent-tools/ssh/* routes wrapped in RequireThreadToken(store).
func newToolMux(store *sshtool.TokenStore, svc sshToolService) http.Handler {
	h := NewSSHToolHandler(svc)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/agent-tools/ssh/exec", h.Exec)
	mux.HandleFunc("GET /api/agent-tools/ssh/file", h.ReadFile)
	mux.HandleFunc("PUT /api/agent-tools/ssh/file", h.WriteFile)
	mux.HandleFunc("GET /api/agent-tools/ssh/files", h.ListFiles)
	mux.HandleFunc("GET /api/agent-tools/ssh/grep", h.Grep)
	return RequireThreadToken(store)(mux)
}

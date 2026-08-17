package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExecSendsBearerTokenAndReturnsExitCode(t *testing.T) {
	var gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		_ = json.NewEncoder(w).Encode(map[string]any{"stdout": "hi\n", "stderr": "", "exitCode": 7})
	}))
	defer srv.Close()

	c := &client{hubURL: srv.URL, token: "tok-1"}
	res, code, err := c.exec("ls -la")
	if err != nil {
		t.Fatalf("exec: %v", err)
	}
	if gotAuth != "Bearer tok-1" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if !strings.Contains(gotBody, `"ls -la"`) {
		t.Fatalf("body = %s", gotBody)
	}
	if code != 2 {
		t.Fatalf("cli exit code = %d, want 2 for a non-zero remote exit", code)
	}
	if res.Stdout != "hi\n" {
		t.Fatalf("stdout = %q", res.Stdout)
	}
}

func TestExecDeniedMapsTo77(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "denied by user"})
	}))
	defer srv.Close()

	_, code, _ := (&client{hubURL: srv.URL, token: "t"}).exec("rm -rf /")
	if code != 77 {
		t.Fatalf("exit code = %d, want 77", code)
	}
}

func TestLoadBindingReadsSessionFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".devdeck"), 0o700); err != nil {
		t.Fatal(err)
	}
	raw := `{"hubUrl":"http://h","threadId":"ssh:c-1","connectionId":"c-1","token":"tok"}`
	if err := os.WriteFile(filepath.Join(dir, ".devdeck/session.json"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	b, err := loadBinding(dir)
	if err != nil {
		t.Fatalf("loadBinding: %v", err)
	}
	if b.Token != "tok" || b.HubURL != "http://h" {
		t.Fatalf("binding = %+v", b)
	}
}

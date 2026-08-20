package sshtoolcli

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

// Dispatch is what makes `devdeck ssh-tool …` a second entry point in the
// server binary. If it ever stopped claiming its own argv, the server would try
// to parse a tool call as flags; if it claimed too much, `devdeck --role hub`
// would never boot.
func TestDispatchClaimsOnlyItsOwnSubcommand(t *testing.T) {
	for _, tc := range []struct {
		name string
		argv []string
		want bool
	}{
		{"subcommand", []string{"devdeck", Subcommand, "exec", "uptime"}, true},
		{"subcommand alone", []string{"devdeck", Subcommand}, true},
		{"server flags", []string{"devdeck", "--role", "hub"}, false},
		{"setup", []string{"devdeck", "setup"}, false},
		{"not first position", []string{"devdeck", "--role", "hub", Subcommand}, false},
		{"bare", []string{"devdeck"}, false},
		// The name the agent types resolves through the workspace shim, never
		// through argv — claiming it here would shadow nothing and confuse the
		// server's own flag parsing.
		{"helper name", []string{"devdeck", HelperName, "exec", "uptime"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// A claimed argv runs the CLI, which needs a session file it will
			// not find here; that failure is fine — only `handled` is asserted.
			t.Setenv(sessionEnvVar, filepath.Join(t.TempDir(), "absent.json"))
			if _, handled := Dispatch(tc.argv); handled != tc.want {
				t.Errorf("Dispatch(%q) handled = %v, want %v", tc.argv, handled, tc.want)
			}
		})
	}
}

// Run rejects an unknown subcommand rather than falling through to a session
// lookup, so a typo reports usage instead of a confusing session error.
func TestRunRejectsUnknownSubcommand(t *testing.T) {
	var stdout, stderr strings.Builder
	if code := Run([]string{"sudo"}, strings.NewReader(""), &stdout, &stderr); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), "unknown command") {
		t.Errorf("stderr = %q, want it to name the unknown command", stderr.String())
	}
}

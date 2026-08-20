package sshthread

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"devdeck/backend/internal/sshtoolcli"
)

// TestSeededShimReachesToolRoutesThroughTheServerBinary is the one test that
// covers the seam this feature lives or dies on: an agent spawned into a seeded
// workspace runs a bare `devdeck-ssh`, and that has to resolve, re-enter the
// DevDeck binary at its ssh-tool subcommand, and come back with the remote
// host's output.
//
// Nothing smaller catches a break here. Seed's unit tests only assert the shim's
// text; sshtoolcli's only assert the HTTP client. The wiring between them —
// PATH, the shim's exec line, the subcommand name main.go dispatches on, and the
// argument and exit-code plumbing through a shell — is only real once an actual
// build of cmd/server is invoked by name from an actual workspace. This is
// exactly the wiring that a rename or a dropped Dispatch call would silently
// undo, and the symptom would be every tool call in production reporting
// "command not found".
func TestSeededShimReachesToolRoutesThroughTheServerBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		// The .cmd shim needs cmd.exe to resolve `devdeck-ssh` through PATHEXT,
		// which exec.Command does not do. Asserted by unit test instead.
		t.Skip("shim resolution on windows goes through cmd.exe PATHEXT")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go toolchain on PATH to build the server binary with")
	}

	// A stand-in hub: the shim's whole job is to turn an argv into this one
	// authenticated call, so this asserts what actually arrived.
	var gotAuth, gotBody string
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent-tools/ssh/exec" {
			t.Errorf("unexpected request path %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		gotAuth = r.Header.Get("Authorization")
		var req struct{ Command string }
		_ = json.NewDecoder(r.Body).Decode(&req)
		gotBody = req.Command
		_ = json.NewEncoder(w).Encode(map[string]any{
			"stdout": "host up 3 days\n", "stderr": "", "exitCode": 0,
		})
	}))
	defer hub.Close()

	exe := filepath.Join(t.TempDir(), "devdeck")
	build := exec.Command("go", "build", "-o", exe, "devdeck/backend/cmd/server")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build cmd/server: %v\n%s", err, out)
	}

	dir, err := Seed(t.TempDir(), Binding{
		HubURL: hub.URL, ThreadID: "ssh:c-1", ConnectionID: "c-1",
		Label: "prod-1", Host: "10.0.0.4", User: "ops", Token: "thread-token",
	}, exe)
	if err != nil {
		t.Fatalf("Seed: %v", err)
	}

	// A quoted multi-word command also proves the shim's "$@" keeps one
	// argument one argument.
	out, code, err := runInWorkspace(t, dir, sshtoolcli.HelperName+` exec "uptime -p"`)
	if err != nil {
		t.Fatalf("run %s: %v", sshtoolcli.HelperName, err)
	}
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; output: %s", code, out)
	}

	if got := out; got != "host up 3 days\n" {
		t.Errorf("stdout = %q, want the hub's response", got)
	}
	if gotAuth != "Bearer thread-token" {
		t.Errorf("Authorization = %q, want the thread token from the seeded binding", gotAuth)
	}
	if gotBody != "uptime -p" {
		t.Errorf("command = %q, want it forwarded as one argument", gotBody)
	}
}

// TestSeededShimPropagatesDeniedExitCode covers the other half of the contract
// the skill file teaches the agent: exit code 77 means the operator declined.
// The shim sits between the hub and the agent, so a wrapper that swallowed the
// code would leave the agent retrying a refused action — the one behaviour
// SKILL.md is most emphatic about never doing.
func TestSeededShimPropagatesDeniedExitCode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shim resolution on windows goes through cmd.exe PATHEXT")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go toolchain on PATH to build the server binary with")
	}

	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "denied by operator"})
	}))
	defer hub.Close()

	exe := filepath.Join(t.TempDir(), "devdeck")
	if out, err := exec.Command("go", "build", "-o", exe, "devdeck/backend/cmd/server").CombinedOutput(); err != nil {
		t.Fatalf("build cmd/server: %v\n%s", err, out)
	}
	dir, err := Seed(t.TempDir(), Binding{
		HubURL: hub.URL, ThreadID: "ssh:c-1", ConnectionID: "c-1", Token: "t",
	}, exe)
	if err != nil {
		t.Fatalf("Seed: %v", err)
	}

	out, code, err := runInWorkspace(t, dir, sshtoolcli.HelperName+" exec reboot")
	if err != nil {
		t.Fatalf("run %s: %v", sshtoolcli.HelperName, err)
	}
	if code != 77 {
		t.Errorf("exit code = %d, want 77 (operator declined)", code)
	}
	if !strings.Contains(out, "denied by user") {
		t.Errorf("output = %q, want it to tell the agent the operator declined", out)
	}
}

// runInWorkspace runs one command line the way an agent CLI does: through a
// shell, with the seeded workspace as the working directory and its bin/ first
// on PATH, exactly as main.go's agentPathEnv builds it. The shell is the point —
// it is what resolves the bare `devdeck-ssh` name against PATH, which is the
// resolution step under test. (exec.Command would look the name up in the test
// process's own PATH instead, and never see the shim at all.)
//
// Returns combined output and the exit code, since the exit code is a documented
// part of the contract with the agent, not an error to be unwrapped away.
func runInWorkspace(t *testing.T, dir, line string) (string, int, error) {
	t.Helper()
	cmd := exec.Command("/bin/sh", "-c", line)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PATH="+BinDir(dir)+string(os.PathListSeparator)+os.Getenv("PATH"))
	out, err := cmd.CombinedOutput()
	if ee, ok := err.(*exec.ExitError); ok {
		return string(out), ee.ExitCode(), nil
	}
	return string(out), 0, err
}

package opencode

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"devdeck/backend/internal/agentcore/provider"
)

// Verified live against the installed opencode CLI (see mcp.go's doc
// comment): `opencode mcp add hindsight --url ... --header
// "Authorization=Bearer X"` produces `{"type":"remote","url":...,
// "headers":{"Authorization":"Bearer X"}}`, and `opencode mcp add devdeck --
// /bin/x a b` (undocumented in --help) produces
// `{"type":"local","command":["/bin/x","a","b"]}`. This test pins the argv
// mcpAddArgs must keep producing to get that shape.
func TestMCPAddArgsHTTPEndpoint(t *testing.T) {
	args := mcpAddArgs(provider.MCPEndpoint{
		Name: "hindsight", URL: "http://127.0.0.1:8888/mcp/devdeck/", Token: "hsk_test",
	})
	want := []string{"mcp", "add", "hindsight", "--url", "http://127.0.0.1:8888/mcp/devdeck/", "--header", "Authorization=Bearer hsk_test"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %v, want %v", args, want)
	}
}

func TestMCPAddArgsStdioEndpoint(t *testing.T) {
	args := mcpAddArgs(provider.MCPEndpoint{
		Name: "devdeck", Command: "/path/to/devdeck", Args: []string{"mcp-server", "--db", "/path/to/devdeck.db"},
	})
	want := []string{"mcp", "add", "devdeck", "--", "/path/to/devdeck", "mcp-server", "--db", "/path/to/devdeck.db"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %v, want %v", args, want)
	}
}

func TestConfigureMCPNoOpWithoutIsolatedHomeDir(t *testing.T) {
	// configureMCP must return before ever building an exec.Cmd when
	// HomeDir is unset — a bogus binary path here would only surface as a
	// logged error if that guard were missing, so this mainly documents the
	// intent; TestConfigureMCPNoOpWithoutIsolatedHomeDir in the codex
	// package covers the same gate with an assertable return value.
	configureMCP("/nonexistent/opencode-binary-for-test", Config{}, []provider.MCPEndpoint{
		{Name: "hindsight", URL: "http://127.0.0.1:8888/mcp/devdeck/", Token: "hsk_test"},
	})
}

// TestConfigureMCPWritesRealConfigFile drives the REAL installed opencode
// binary (skips if absent) against a scratch, throwaway HOME — never the
// operator's own — and reads back what it actually wrote. This is the live
// evaluation for the whole opencode MCP feature: unit tests above pin the
// argv shape, this proves that argv, run through the real CLI, produces an
// opencode.jsonc opencode itself will load two servers from.
func TestConfigureMCPWritesRealConfigFile(t *testing.T) {
	bin, err := exec.LookPath("opencode")
	if err != nil {
		t.Skip("opencode CLI not installed on this machine")
	}
	home := t.TempDir()

	configureMCP(bin, Config{HomeDir: home}, []provider.MCPEndpoint{
		{Name: "hindsight", URL: "http://127.0.0.1:8888/mcp/devdeck/", Token: "hsk_test"},
		{Name: "devdeck", Command: "/path/to/devdeck", Args: []string{"mcp-server", "--db", "/path/to/devdeck.db"}},
	})

	raw, err := os.ReadFile(filepath.Join(home, ".config", "opencode", "opencode.jsonc"))
	if err != nil {
		t.Fatalf("opencode.jsonc was not written: %v", err)
	}
	var cfg struct {
		MCP map[string]struct {
			Type    string            `json:"type"`
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
			Command []string          `json:"command"`
		} `json:"mcp"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("opencode.jsonc is not valid JSON: %v\nraw: %s", err, raw)
	}

	hs, ok := cfg.MCP["hindsight"]
	if !ok || hs.Type != "remote" || hs.URL != "http://127.0.0.1:8888/mcp/devdeck/" || hs.Headers["Authorization"] != "Bearer hsk_test" {
		t.Fatalf("hindsight entry wrong shape: %+v", hs)
	}

	dd, ok := cfg.MCP["devdeck"]
	wantCmd := []string{"/path/to/devdeck", "mcp-server", "--db", "/path/to/devdeck.db"}
	if !ok || dd.Type != "local" || !reflect.DeepEqual(dd.Command, wantCmd) {
		t.Fatalf("devdeck entry wrong shape: %+v, want command=%v", dd, wantCmd)
	}
}

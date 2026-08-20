package codex

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"devdeck/backend/internal/agentcore/provider"
)

// Verified live against the installed codex CLI (see mcp.go's doc comment):
// `codex mcp add hindsight --url ... --bearer-token-env-var VAR` produces
// `[mcp_servers.hindsight] url=... bearer_token_env_var="VAR"` in
// config.toml, and `codex mcp add devdeck -- /bin/x a b` produces
// `[mcp_servers.devdeck] command="/bin/x" args=["a","b"]`. This test pins
// the argv mcpAddArgs must keep producing to get that shape.
func TestMCPAddArgsHTTPEndpoint(t *testing.T) {
	args, tokenEnvVar := mcpAddArgs(provider.MCPEndpoint{
		Name: "hindsight", URL: "http://127.0.0.1:8888/mcp/devdeck/", Token: "hsk_test",
	})
	want := []string{"mcp", "add", "hindsight", "--url", "http://127.0.0.1:8888/mcp/devdeck/", "--bearer-token-env-var", tokenEnvVar}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %v, want %v", args, want)
	}
	if tokenEnvVar == "" {
		t.Fatal("an HTTP endpoint must return a token env var name — codex's config.toml never carries the token itself")
	}
}

func TestMCPAddArgsStdioEndpoint(t *testing.T) {
	args, tokenEnvVar := mcpAddArgs(provider.MCPEndpoint{
		Name: "devdeck", Command: "/path/to/devdeck", Args: []string{"mcp-server", "--db", "/path/to/devdeck.db"},
	})
	want := []string{"mcp", "add", "devdeck", "--", "/path/to/devdeck", "mcp-server", "--db", "/path/to/devdeck.db"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %v, want %v", args, want)
	}
	if tokenEnvVar != "" {
		t.Fatalf("a stdio endpoint has no token to expose; tokenEnvVar = %q, want empty", tokenEnvVar)
	}
}

func TestConfigureMCPNoOpWithoutIsolatedHomeDir(t *testing.T) {
	// A bogus binary path proves this: if configureMCP tried to exec it, the
	// error would be logged (harmless) but the call must not even reach
	// exec.Command — HomeDir empty means "this instance shares the
	// operator's real ~/.codex", which must never be touched automatically.
	tokenEnv := configureMCP("/nonexistent/codex-binary-for-test", Config{}, []provider.MCPEndpoint{
		{Name: "hindsight", URL: "http://127.0.0.1:8888/mcp/devdeck/", Token: "hsk_test"},
	})
	if tokenEnv != nil {
		t.Fatalf("tokenEnv = %v, want nil when HomeDir is unset", tokenEnv)
	}
}

// TestConfigureMCPWritesRealConfigFile drives the REAL installed codex
// binary (skips if absent) against a scratch, throwaway CODEX_HOME — never
// the operator's own — and reads back what it actually wrote. This is the
// live evaluation for the whole codex MCP feature: unit tests above pin the
// argv shape, this proves that argv, run through the real CLI, produces a
// config.toml codex itself will load two servers from.
func TestConfigureMCPWritesRealConfigFile(t *testing.T) {
	bin, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("codex CLI not installed on this machine")
	}
	home := t.TempDir()

	tokenEnv := configureMCP(bin, Config{HomeDir: home}, []provider.MCPEndpoint{
		{Name: "hindsight", URL: "http://127.0.0.1:8888/mcp/devdeck/", Token: "hsk_test"},
		{Name: "devdeck", Command: "/path/to/devdeck", Args: []string{"mcp-server", "--db", "/path/to/devdeck.db"}},
	})

	envVar, ok := tokenEnv["DEVDECK_MCP_HINDSIGHT_TOKEN"]
	if !ok || envVar != "hsk_test" {
		t.Fatalf("tokenEnv = %v, want DEVDECK_MCP_HINDSIGHT_TOKEN=hsk_test", tokenEnv)
	}

	raw, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		t.Fatalf("config.toml was not written: %v", err)
	}
	got := string(raw)
	for _, want := range []string{
		"[mcp_servers.hindsight]",
		`url = "http://127.0.0.1:8888/mcp/devdeck/"`,
		`bearer_token_env_var = "DEVDECK_MCP_HINDSIGHT_TOKEN"`,
		"[mcp_servers.devdeck]",
		`command = "/path/to/devdeck"`,
		`args = ["mcp-server", "--db", "/path/to/devdeck.db"]`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("config.toml missing %q; got:\n%s", want, got)
		}
	}
	if strings.Contains(got, "hsk_test") {
		t.Fatal("the raw token must never land in config.toml — only the env var name should")
	}
}

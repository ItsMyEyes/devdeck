package codex

import (
	"log"
	"os"
	"os/exec"
	"strings"

	"devdeck/backend/internal/agentcore/provider"
)

// mcpTokenEnvVar derives the env var name codex reads an HTTP MCP server's
// bearer token from. Codex's config.toml never stores the token itself —
// only `bearer_token_env_var`, a pointer to an environment variable
// (verified live: `codex mcp add --bearer-token-env-var <VAR>` writes that
// key, not the token). This process must set that var before the app-server
// reads it, so app-server's own env is where the real value lives.
func mcpTokenEnvVar(name string) string {
	return "DEVDECK_MCP_" + strings.ToUpper(name) + "_TOKEN"
}

// mcpAddArgs builds the `codex mcp add` argv for one endpoint, verified live
// against the installed CLI: a stdio endpoint (Command set) becomes
// `mcp add <name> -- <command> <args...>`, matching what produces
// `[mcp_servers.<name>] command=... args=[...]` in config.toml; an HTTP
// endpoint becomes `mcp add <name> --url <url> --bearer-token-env-var
// <VAR>`, matching `url=...` + `bearer_token_env_var=...` — codex's schema
// never stores the token itself in the file. tokenEnvVar is "" for a stdio
// endpoint (nothing to expose).
func mcpAddArgs(ep provider.MCPEndpoint) (args []string, tokenEnvVar string) {
	if ep.Command != "" {
		args = append([]string{"mcp", "add", ep.Name, "--"}, ep.Command)
		args = append(args, ep.Args...)
		return args, ""
	}
	tokenEnvVar = mcpTokenEnvVar(ep.Name)
	return []string{"mcp", "add", ep.Name, "--url", ep.URL, "--bearer-token-env-var", tokenEnvVar}, tokenEnvVar
}

// configureMCP wires endpoints into CODEX_HOME/config.toml via `codex mcp
// add` — the CLI's own command, not hand-rolled TOML editing, so every OTHER
// key an operator has in that file (model providers, project trust levels,
// feature flags, ...) survives untouched. Verified live and idempotent:
// calling it again with the same name overwrites that one entry, it never
// duplicates.
//
// Deliberately a no-op when cfg.HomeDir is empty: that means this instance
// shares the operator's REAL ~/.codex, which they may hand-edit and use
// interactively outside DevDeck — silently adding MCP servers there would
// both surprise them and reach every codex session on the machine, not just
// DevDeck's. Only an operator-isolated HomeDir (set in Settings) opts in.
//
// Returns the env vars an HTTP endpoint's bearer token must be exposed
// under — the caller folds these into the app-server process's own
// environment (see ensureProcess).
func configureMCP(bin string, cfg Config, endpoints []provider.MCPEndpoint) map[string]string {
	if cfg.HomeDir == "" || len(endpoints) == 0 {
		return nil
	}
	tokenEnv := make(map[string]string, len(endpoints))
	for _, ep := range endpoints {
		args, tokenEnvVar := mcpAddArgs(ep)
		if tokenEnvVar != "" {
			tokenEnv[tokenEnvVar] = ep.Token
		}
		cmd := exec.Command(bin, args...)
		cmd.Env = append(os.Environ(), "CODEX_HOME="+cfg.HomeDir)
		if out, err := cmd.CombinedOutput(); err != nil {
			log.Printf("codex: mcp add %s failed: %v: %s", ep.Name, err, strings.TrimSpace(string(out)))
		}
	}
	return tokenEnv
}

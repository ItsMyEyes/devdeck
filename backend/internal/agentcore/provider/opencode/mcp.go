package opencode

import (
	"log"
	"os"
	"os/exec"
	"strings"

	"devdeck/backend/internal/agentcore/provider"
)

// mcpAddArgs builds the `opencode mcp add` argv for one endpoint, verified
// live against the installed CLI: a stdio endpoint (Command set) becomes
// `mcp add <name> -- <command> <args...>` — undocumented in `mcp add
// --help`, but confirmed to produce `{"type":"local","command":[...]}` in
// opencode.jsonc, matching the CLI's own JSON config schema
// (https://opencode.ai/config.json). An HTTP endpoint becomes `mcp add
// <name> --url <url> --header "Authorization=Bearer <token>"` — unlike
// codex, opencode's config carries the token directly in a header rather
// than pointing at an env var, confirmed by the file this actually writes.
func mcpAddArgs(ep provider.MCPEndpoint) []string {
	if ep.Command != "" {
		args := append([]string{"mcp", "add", ep.Name, "--"}, ep.Command)
		return append(args, ep.Args...)
	}
	return []string{"mcp", "add", ep.Name, "--url", ep.URL, "--header", "Authorization=Bearer " + ep.Token}
}

// configureMCP wires endpoints into HomeDir's opencode.jsonc via `opencode
// mcp add` — the CLI's own command, so every other key an operator has in
// that file survives untouched. Verified live and idempotent: repeat calls
// with the same name overwrite that one entry, never duplicate.
//
// Deliberately a no-op when cfg.HomeDir is empty — see codex's configureMCP
// for the reasoning this mirrors: an unset HomeDir means this instance
// shares the operator's REAL opencode config (~/.config/opencode), which
// DevDeck must not silently touch.
func configureMCP(bin string, cfg Config, endpoints []provider.MCPEndpoint) {
	if cfg.HomeDir == "" || len(endpoints) == 0 {
		return
	}
	for _, ep := range endpoints {
		cmd := exec.Command(bin, mcpAddArgs(ep)...)
		cmd.Env = append(os.Environ(), "HOME="+cfg.HomeDir)
		// Stdin left nil (-> /dev/null): `add` only prompts interactively
		// when a required flag/arg is missing, and a closed stdin makes
		// that fail fast instead of hanging this goroutine forever.
		if out, err := cmd.CombinedOutput(); err != nil {
			log.Printf("opencode: mcp add %s failed: %v: %s", ep.Name, err, strings.TrimSpace(string(out)))
		}
	}
}

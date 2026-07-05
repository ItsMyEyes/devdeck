package detect

import (
	"testing"
)

func TestParseCodexMCPServersRedactsValues(t *testing.T) {
	input := []byte(`[
	  {
	    "name": "codegraph",
	    "enabled": true,
	    "disabled_reason": null,
	    "transport": {
	      "type": "stdio",
	      "command": "codegraph",
	      "args": ["serve", "--mcp"],
	      "env": {"API_TOKEN": "never-return-this"},
	      "env_vars": ["HOME"]
	    },
	    "auth_status": "unsupported"
	  },
	  {
	    "name": "remote",
	    "enabled": false,
	    "disabled_reason": "disabled",
	    "transport": {
	      "type": "streamable_http",
	      "url": "https://user:secret@example.com/mcp?token=hidden"
	    },
	    "auth_status": "unsupported"
	  }
	]`)

	servers, err := parseCodexMCPServers(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(servers) != 2 {
		t.Fatalf("server count = %d", len(servers))
	}
	if servers[0].Target != "codegraph" || servers[0].ArgCount != 2 {
		t.Fatalf("stdio server = %#v", servers[0])
	}
	if got := servers[0].EnvKeys; len(got) != 2 || got[0] != "API_TOKEN" || got[1] != "HOME" {
		t.Fatalf("env keys = %#v", got)
	}
	if servers[1].Target != "https://example.com/mcp" {
		t.Fatalf("safe URL = %q", servers[1].Target)
	}
}

func TestParseClaudeMCPServers(t *testing.T) {
	input := []byte("Checking MCP server health…\ncodegraph: codegraph serve --mcp - ✔ Connected\nremote: https://example.com/mcp?secret=yes - ✘ Failed to connect\n")
	servers := parseClaudeMCPServers(input)
	if len(servers) != 2 {
		t.Fatalf("server count = %d: %#v", len(servers), servers)
	}
	if servers[0].Name != "codegraph" || servers[0].Status != "connected" || servers[0].Transport != "stdio" {
		t.Fatalf("codegraph = %#v", servers[0])
	}
	if servers[1].Target != "https://example.com/mcp" || servers[1].Status != "failed" {
		t.Fatalf("remote = %#v", servers[1])
	}
}

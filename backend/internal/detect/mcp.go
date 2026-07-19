package detect

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os/exec"
	"sort"
	"strings"
	"time"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

const mcpCommandTimeout = 20 * time.Second

// ReadMCPServers asks the installed agent CLI for its configured MCP servers.
// Returned records are redacted to executable/URL identity and environment key
// names. Argument and environment values never leave the backend.
func ReadMCPServers(agentID string) ([]domain.MCPServer, error) {
	binary, err := Resolve(agentID)
	if err != nil {
		return nil, fmt.Errorf("%s is not installed: %w", agentID, port.ErrAgentManagementUnsupported)
	}
	switch agentID {
	case "codex":
		return readCodexMCPServers(binary)
	case "claude":
		return readClaudeMCPServers(binary)
	default:
		return nil, fmt.Errorf("%s does not expose managed MCP configuration: %w", agentID, port.ErrAgentManagementUnsupported)
	}
}

// AddMCPServer delegates writes to the agent's own CLI so its native config
// format, permissions, and migrations remain authoritative.
func AddMCPServer(agentID string, input port.MCPServerInput) error {
	binary, err := Resolve(agentID)
	if err != nil {
		return fmt.Errorf("%s is not installed: %w", agentID, port.ErrAgentManagementUnsupported)
	}
	envKeys := make([]string, 0, len(input.Env))
	for key := range input.Env {
		envKeys = append(envKeys, key)
	}
	sort.Strings(envKeys)

	var args []string
	switch agentID {
	case "claude":
		args = []string{"mcp", "add", "--scope", "user", "--transport", input.Transport}
		for _, key := range envKeys {
			args = append(args, "--env", key+"="+input.Env[key])
		}
		args = append(args, input.Name)
		if input.Transport == "stdio" {
			args = append(args, "--", input.Command)
			args = append(args, input.Args...)
		} else {
			args = append(args, input.URL)
		}
	case "codex":
		args = []string{"mcp", "add", input.Name}
		if input.Transport == "stdio" {
			for _, key := range envKeys {
				args = append(args, "--env", key+"="+input.Env[key])
			}
			args = append(args, "--", input.Command)
			args = append(args, input.Args...)
		} else {
			args = append(args, "--url", input.URL)
		}
	default:
		return fmt.Errorf("%s does not expose managed MCP configuration: %w", agentID, port.ErrAgentManagementUnsupported)
	}
	return runMCPCommand(binary, args...)
}

// RemoveMCPServer delegates removal to the native agent CLI.
func RemoveMCPServer(agentID, serverName string) error {
	binary, err := Resolve(agentID)
	if err != nil {
		return fmt.Errorf("%s is not installed: %w", agentID, port.ErrAgentManagementUnsupported)
	}
	var args []string
	switch agentID {
	case "claude":
		args = []string{"mcp", "remove", "--scope", "user", serverName}
	case "codex":
		args = []string{"mcp", "remove", serverName}
	default:
		return fmt.Errorf("%s does not expose managed MCP configuration: %w", agentID, port.ErrAgentManagementUnsupported)
	}
	return runMCPCommand(binary, args...)
}

func readCodexMCPServers(binary string) ([]domain.MCPServer, error) {
	output, err := commandOutput(binary, "mcp", "list", "--json")
	if err != nil {
		return nil, err
	}
	return parseCodexMCPServers(output)
}

func parseCodexMCPServers(output []byte) ([]domain.MCPServer, error) {
	var raw []struct {
		Name           string         `json:"name"`
		Enabled        bool           `json:"enabled"`
		DisabledReason *string        `json:"disabled_reason"`
		Transport      map[string]any `json:"transport"`
		AuthStatus     string         `json:"auth_status"`
	}
	if err := json.Unmarshal(output, &raw); err != nil {
		return nil, fmt.Errorf("parse codex MCP list: %w", err)
	}

	servers := make([]domain.MCPServer, 0, len(raw))
	for _, item := range raw {
		transport := stringValue(item.Transport["type"])
		target := stringValue(item.Transport["command"])
		if target == "" {
			target = safeURL(stringValue(item.Transport["url"]))
		}
		status := "configured"
		if !item.Enabled {
			status = "disabled"
		} else if item.AuthStatus != "" && item.AuthStatus != "unsupported" {
			status = item.AuthStatus
		}
		servers = append(servers, domain.MCPServer{
			Name:      item.Name,
			AgentID:   "codex",
			Transport: normalizeTransport(transport),
			Target:    target,
			ArgCount:  sliceLength(item.Transport["args"]),
			EnvKeys:   codexEnvKeys(item.Transport),
			Enabled:   item.Enabled,
			Status:    status,
		})
	}
	sortMCPServers(servers)
	return servers, nil
}

func readClaudeMCPServers(binary string) ([]domain.MCPServer, error) {
	output, err := commandOutput(binary, "mcp", "list")
	if err != nil {
		return nil, err
	}
	return parseClaudeMCPServers(output), nil
}

func parseClaudeMCPServers(output []byte) []domain.MCPServer {
	lines := strings.Split(string(output), "\n")
	servers := make([]domain.MCPServer, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(stripANSI(line))
		if line == "" || strings.HasPrefix(line, "Checking MCP") || strings.HasPrefix(line, "No MCP") {
			continue
		}
		name, detail, ok := strings.Cut(line, ": ")
		if !ok || name == "" {
			continue
		}
		target, health, ok := splitClaudeHealth(detail)
		if !ok {
			continue
		}
		status := "configured"
		enabled := true
		switch {
		case strings.Contains(health, "Connected"):
			status = "connected"
		case strings.Contains(health, "Pending"):
			status = "pending"
			enabled = false
		case strings.Contains(health, "Failed"):
			status = "failed"
		}
		servers = append(servers, domain.MCPServer{
			Name:      name,
			AgentID:   "claude",
			Transport: inferClaudeTransport(target),
			Target:    safeTarget(target),
			EnvKeys:   []string{},
			Enabled:   enabled,
			Status:    status,
		})
	}
	sortMCPServers(servers)
	return servers
}

func commandOutput(binary string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), mcpCommandTimeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, binary, args...).Output()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("agent MCP command timed out")
	}
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			message := strings.TrimSpace(string(exitErr.Stderr))
			if len(message) > 300 {
				message = message[:300]
			}
			if message != "" {
				return nil, fmt.Errorf("agent MCP command failed: %s", message)
			}
		}
		return nil, fmt.Errorf("agent MCP command failed: %w", err)
	}
	return output, nil
}

func runMCPCommand(binary string, args ...string) error {
	_, err := commandOutput(binary, args...)
	return err
}

func codexEnvKeys(transport map[string]any) []string {
	keys := make(map[string]bool)
	if env, ok := transport["env"].(map[string]any); ok {
		for key := range env {
			keys[key] = true
		}
	}
	if envVars, ok := transport["env_vars"].([]any); ok {
		for _, item := range envVars {
			if key, ok := item.(string); ok && key != "" {
				keys[key] = true
			}
		}
	}
	out := make([]string, 0, len(keys))
	for key := range keys {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func splitClaudeHealth(detail string) (string, string, bool) {
	markers := []string{" - ✔ ", " - ✘ ", " - ⏸ "}
	for _, marker := range markers {
		if index := strings.LastIndex(detail, marker); index >= 0 {
			return strings.TrimSpace(detail[:index]), strings.TrimSpace(detail[index+3:]), true
		}
	}
	return "", "", false
}

func inferClaudeTransport(target string) string {
	fields := strings.Fields(target)
	if len(fields) > 0 {
		if parsed, err := url.Parse(fields[0]); err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") {
			return "http"
		}
	}
	return "stdio"
}

func safeTarget(target string) string {
	fields := strings.Fields(target)
	if len(fields) == 0 {
		return ""
	}
	if safe := safeURL(fields[0]); safe != fields[0] {
		return safe
	}
	return fields[0]
}

func safeURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return raw
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func normalizeTransport(value string) string {
	switch value {
	case "streamable_http", "sse":
		return "http"
	case "":
		return "stdio"
	default:
		return value
	}
}

func stringValue(value any) string {
	result, _ := value.(string)
	return result
}

func sliceLength(value any) int {
	items, _ := value.([]any)
	return len(items)
}

func sortMCPServers(servers []domain.MCPServer) {
	sort.Slice(servers, func(i, j int) bool {
		return strings.ToLower(servers[i].Name) < strings.ToLower(servers[j].Name)
	})
}

func stripANSI(value string) string {
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		if value[index] == 0x1b && index+1 < len(value) && value[index+1] == '[' {
			index += 2
			for index < len(value) && (value[index] < '@' || value[index] > '~') {
				index++
			}
			continue
		}
		builder.WriteByte(value[index])
	}
	return builder.String()
}

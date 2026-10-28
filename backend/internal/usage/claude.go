package usage

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

var claudeLine = regexp.MustCompile(`(?i)^\s*current (session|week)(?:\s*\(all models\))?\s*:\s*([0-9]+(?:\.[0-9]+)?)%\s*(used|left|remaining)(?:\s*·\s*(resets?\s+[a-z0-9:., /_()+-]+))?\s*$`)
var ansiEscape = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

func parseClaudeUsage(output string) []Window {
	output = ansiEscape.ReplaceAllString(output, "")
	windows := []Window{}
	seen := map[string]bool{}
	for _, line := range strings.Split(output, "\n") {
		if strings.Contains(strings.ToLower(line), "what's contributing to your limits usage?") {
			break
		}
		m := claudeLine.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		kind := strings.ToLower(m[1])
		if seen[kind] {
			continue
		}
		percent, err := strconv.ParseFloat(m[2], 64)
		if err != nil || percent < 0 || percent > 100 {
			continue
		}
		if !strings.EqualFold(m[3], "used") {
			percent = 100 - percent
		}
		minutes := 300
		if kind == "week" {
			minutes = 10080
		}
		windows = append(windows, Window{Name: "Claude", UsedPercent: percent, DurationMinutes: &minutes, ResetDescription: strings.TrimSpace(m[4])})
		seen[kind] = true
	}
	return windows
}

func readClaudeUsage(ctx context.Context, binary string) ([]Window, string) {
	empty := []Window{}
	dir, err := os.MkdirTemp("", "devdeck-claude-usage-")
	if err != nil {
		return empty, "error"
	}
	defer os.RemoveAll(dir)
	cmd := exec.CommandContext(ctx, binary, "/usage", "--no-session-persistence", "--settings", `{"remoteControlAtStartup":false,"disableAllHooks":true}`, "--strict-mcp-config", "--allowedTools", "")
	cmd.Dir = dir
	cmd.Env = make([]string, 0, len(os.Environ()))
	for _, env := range os.Environ() {
		if !strings.HasPrefix(env, "CLAUDECODE=") {
			cmd.Env = append(cmd.Env, env)
		}
	}
	output, err := cmd.Output()
	if err != nil {
		return empty, "error"
	}
	windows := parseClaudeUsage(string(output))
	if len(windows) == 0 {
		return empty, "unavailable"
	}
	return windows, "available"
}

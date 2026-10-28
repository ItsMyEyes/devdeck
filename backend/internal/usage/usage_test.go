package usage

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestCodexWindows(t *testing.T) {
	var result codexResponse
	if err := json.Unmarshal([]byte(`{"rateLimitsByLimitId":{"codex":{"limitName":"Codex","primary":{"usedPercent":66,"windowDurationMins":300,"resetsAt":1800000000},"secondary":null},"other":{"primary":{"usedPercent":79,"windowDurationMins":10080}}}}`), &result); err != nil {
		t.Fatal(err)
	}
	windows := codexWindows(result)
	if len(windows) != 2 || windows[0].UsedPercent != 66 || windows[1].DurationMinutes == nil || *windows[1].DurationMinutes != 10080 {
		t.Fatalf("unexpected windows: %+v", windows)
	}
}

func TestCodexLegacyAndMissingWindows(t *testing.T) {
	var result codexResponse
	if err := json.Unmarshal([]byte(`{"rateLimits":{"primary":null,"secondary":{"usedPercent":0,"windowDurationMins":300}}}`), &result); err != nil {
		t.Fatal(err)
	}
	got := codexWindows(result)
	if len(got) != 1 || got[0].UsedPercent != 0 {
		t.Fatalf("unexpected windows: %+v", got)
	}
}

func TestReadCodexProtocol(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "codex")
	script := `#!/bin/sh
read init
printf '%s\n' '{"id":1,"result":{}}'
read initialized
read request
printf '%s\n' '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":23,"windowDurationMins":300}}}}'
`
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	windows, status := readCodex(context.Background(), path)
	if status != "available" || len(windows) != 1 || windows[0].UsedPercent != 23 {
		t.Fatalf("%s: %+v", status, windows)
	}
}

func TestReadCodexAuthFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	path := filepath.Join(t.TempDir(), "codex")
	script := "#!/bin/sh\nread init\nprintf '%s\\n' '{\"id\":1,\"result\":{}}'\nread initialized\nread request\nprintf '%s\\n' '{\"id\":2,\"error\":{\"message\":\"authentication required secret\"}}'\n"
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	windows, status := readCodex(context.Background(), path)
	if status != "not_logged_in" || len(windows) != 0 {
		t.Fatalf("%s: %+v", status, windows)
	}
}

func TestReadClaudeUsage(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	path := filepath.Join(t.TempDir(), "claude")
	script := "#!/bin/sh\nprintf '%s\\n' 'Current session: 66% used · resets Oct 27 at 8:30pm (Asia/Jakarta)' 'Current week (all models): 79% used · resets Nov 1 at 9:00am (Asia/Jakarta)'\n"
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	windows, status := readClaudeUsage(context.Background(), path)
	if status != "available" || len(windows) != 2 || windows[0].UsedPercent != 66 || *windows[1].DurationMinutes != 10080 || windows[0].ResetDescription != "resets Oct 27 at 8:30pm (Asia/Jakarta)" {
		t.Fatalf("%s: %+v", status, windows)
	}
}

func TestClaudeUsageIgnoresInsightsAndMissingWindows(t *testing.T) {
	windows := parseClaudeUsage("Current session: 25% used\nWhat's contributing to your limits usage?\nCurrent week: 80% used\n")
	if len(windows) != 1 || windows[0].UsedPercent != 25 {
		t.Fatalf("unexpected windows: %+v", windows)
	}
	if len(parseClaudeUsage("Current session: loading\nTop tool: 90% used")) != 0 {
		t.Fatal("insights treated as quota")
	}
}

func TestLiveClaudeUsage(t *testing.T) {
	if os.Getenv("DEVDECK_LIVE_CLAUDE_USAGE") != "1" {
		t.Skip("live Claude check is opt-in")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result := Read(ctx, "claude")
	if result.Status != "available" || len(result.Windows) == 0 {
		t.Fatalf("live usage status: %s; windows: %d", result.Status, len(result.Windows))
	}
}

func TestClaudeUsageFindsCLIBeyondGUIPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	home := t.TempDir()
	dir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "claude"), []byte("#!/bin/sh\nprintf '%s\\n' 'Current session: 33% used'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", filepath.Join(home, "missing"))
	result := Read(context.Background(), "claude")
	if result.Status != "available" || len(result.Windows) != 1 {
		t.Fatalf("status = %s", result.Status)
	}
}

func TestAntigravityUsageReport(t *testing.T) {
	data := []byte(`{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"window":"5h","remaining_fraction":0.69,"reset_time":"2026-10-28T13:00:00Z"},{"window":"weekly","remaining_fraction":0.0}]},{"name":"Claude and GPT models","buckets":[{"window":"weekly","remaining_fraction":1.0},{"window":"5h","remaining_fraction":null}]}]}}}`)
	windows, err := parseAntigravityUsage(data)
	if err != nil || len(windows) != 3 {
		t.Fatalf("windows=%+v err=%v", windows, err)
	}
	if windows[0].Name != "Gemini Models" || windows[0].UsedPercent != 31 || *windows[0].DurationMinutes != 300 || windows[0].ResetsAt == nil {
		t.Fatalf("first window: %+v", windows[0])
	}
	if windows[1].UsedPercent != 100 || windows[2].Name != "Claude and GPT models" || windows[2].UsedPercent != 0 {
		t.Fatalf("windows: %+v", windows)
	}
}

func TestAntigravityRejectsUnknownAndMalformedReport(t *testing.T) {
	for _, data := range []string{`{}`, `{"status":"ERROR","command":{"name":"usage"}}`, `{"status":"SUCCESS","command":{"name":"model"}}`, `not-json`} {
		if _, err := parseAntigravityUsage([]byte(data)); err == nil {
			t.Fatalf("accepted invalid report: %s", data)
		}
	}
	windows, err := parseAntigravityUsage([]byte(`{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini","buckets":[{"window":"5h","remaining_fraction":1.5},{"window":"weekly","remaining_fraction":"0.5"},{"window":"weekly","remaining_fraction":0.5}]}]}}}`))
	if err != nil || len(windows) != 1 || windows[0].UsedPercent != 50 {
		t.Fatalf("windows=%+v err=%v", windows, err)
	}
}

func TestAntigravityProbeUsesCLIAndBlocksBrowser(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	path := filepath.Join(t.TempDir(), "agy")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then printf "1.4.8\n"; exit 0; fi
[ "$AGY_CLI_DISABLE_AUTO_UPDATE" = true ] || exit 2
[ "$BROWSER" = "$(command -v open)" ] || exit 3
open https://example.com && exit 4
printf '%s\n' '{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"window":"5h","remaining_fraction":0.25}]}]}}}'
`
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	windows, status := readAntigravityUsage(context.Background(), path)
	if status != "available" || len(windows) != 1 || windows[0].UsedPercent != 75 {
		t.Fatalf("status=%s windows=%+v", status, windows)
	}
}

func TestAntigravityProbeTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	path := filepath.Join(t.TempDir(), "agy")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf \"1.4.8\\n\"; exit 0; fi\nsleep 20\n"), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, status := readAntigravityUsage(ctx, path)
	if status != "error" || time.Since(started) > 4*time.Second {
		t.Fatalf("status=%s duration=%s", status, time.Since(started))
	}
}

func TestLiveAntigravityUsage(t *testing.T) {
	if os.Getenv("DEVDECK_LIVE_AGY_USAGE") != "1" {
		t.Skip("live Antigravity check is opt-in")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	result := Read(ctx, "antigravity")
	if result.Status != "available" || len(result.Windows) == 0 {
		t.Fatalf("live usage status: %s; windows: %d", result.Status, len(result.Windows))
	}
}

func TestAntigravityOldVersionNeverRunsUsage(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "agy")
	marker := filepath.Join(dir, "launched-usage")
	script := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 1.1.10; exit 0; fi\ntouch " + marker + "\n"
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	_, status := readAntigravityUsage(context.Background(), path)
	if status != "unavailable" {
		t.Fatalf("status = %s", status)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("old CLI was allowed to run a prompt")
	}
}

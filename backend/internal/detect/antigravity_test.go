package detect

import (
	"context"
	"devdeck/backend/internal/port"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestAntigravityModelsAreRealAndContextUnknown(t *testing.T) {
	models := parseAntigravityModels("Fetching available models...\n\x1b[32mgemini-real\x1b[0m\tGemini Real\nclaude-real\tClaude Real\ngemini-real\tDuplicate\nnot a model\n")
	if len(models) != 2 || models[0].ID != "gemini-real" || models[0].ContextWindow != 0 {
		t.Fatalf("models: %+v", models)
	}
}

func TestAntigravityModelReaderAndTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	bin := filepath.Join(dir, "agy")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nprintf 'real-model\\tReal Model\\n'\n"), 0755); err != nil {
		t.Fatal(err)
	}
	models, err := readAntigravityModels(context.Background())
	if err != nil || len(models) != 2 || models[0].ID != "" || models[1].ID != "real-model" {
		t.Fatalf("models=%+v err=%v", models, err)
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nwhile :; do :; done\n"), 0755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := readAntigravityModels(ctx); err == nil {
		t.Fatal("catalog must be bounded")
	}
}

func TestAntigravityMCPRedactsCLIAndConfig(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	configDir := filepath.Join(home, ".gemini", "config")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		t.Fatal(err)
	}
	raw := `{"mcpServers":{"local":{"command":"/some path/server","args":["--key","SECRET"],"env":{"API_KEY":"SECRET"}}}}`
	if err := os.WriteFile(filepath.Join(configDir, "mcp_config.json"), []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(home, "agy")
	script := "#!/bin/sh\nprintf '%s\\n' 'NAME TYPE STATUS COMMAND/URL' 'local stdio enabled /some path/server --key SECRET' 'remote http disabled https://user:SECRET@example.com/mcp?key=SECRET'\n"
	if err := os.WriteFile(bin, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	servers, err := readAntigravityMCPServers(bin)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(servers)
	if strings.Contains(string(encoded), "SECRET") {
		t.Fatalf("secret exposed: %s", encoded)
	}
	if len(servers) != 2 || servers[0].Target != "/some path/server" || servers[0].ArgCount != 2 || len(servers[0].EnvKeys) != 1 || servers[1].Enabled {
		t.Fatalf("servers: %+v", servers)
	}
	if _, err := parseAntigravityMCPServers("unexpected format"); err == nil {
		t.Fatal("unknown format must fail clearly")
	}
}

func TestAntigravitySkillsAndSettingsAreSeparateFromGemini(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	locations, err := agentSkillLocations("antigravity")
	if err != nil || locations[0].dir != filepath.Join(home, ".gemini", "antigravity-cli", "skills") {
		t.Fatalf("locations=%+v err=%v", locations, err)
	}
	spec, err := settingsFileSpecFor("antigravity")
	if err != nil || spec.candidates[0] != filepath.Join(home, ".gemini", "antigravity-cli", "settings.json") {
		t.Fatalf("settings=%+v err=%v", spec, err)
	}
	if AgentBinary["antigravity"] != "agy" || AgentBinary["gemini"] != "gemini" {
		t.Fatal("agent identities must remain distinct")
	}
}

func TestAntigravityMCPNativeManagementAndErrorRedaction(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("PATH", dir)
	bin := filepath.Join(dir, "agy")
	log := filepath.Join(dir, "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > '" + log + "'\n"
	if err := os.WriteFile(bin, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	input := port.MCPServerInput{Name: "local-test", Transport: "stdio", Command: "/some path/server", Args: []string{"--option", "value"}, Env: map[string]string{"API_KEY": "SECRET"}}
	if err := AddMCPServer("antigravity", input); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"mcp", "add", "--type", "stdio", "--env", "API_KEY=SECRET", "local-test", "--", "/some path/server", "--option", "value"}
	if got := strings.Split(strings.TrimSpace(string(raw)), "\n"); !reflect.DeepEqual(got, want) {
		t.Fatalf("args=%v", got)
	}
	if err := RemoveMCPServer("antigravity", "local-test"); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(log)
	if string(raw) != "mcp\nremove\nlocal-test\n" {
		t.Fatal(string(raw))
	}
	if err := os.WriteFile(bin, []byte(script+"printf 'SECRET' >&2\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := AddMCPServer("antigravity", input); err == nil || strings.Contains(err.Error(), "SECRET") {
		t.Fatal("secret-bearing diagnostics exposed", err)
	}
}

func TestAntigravityCatalogFailureIsCached(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("PATH", dir)
	ResetModelCache()
	t.Cleanup(ResetModelCache)
	bin := filepath.Join(dir, "agy")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	if ReadModels("antigravity") != nil || !strings.Contains(ModelCatalogDetail("antigravity"), "login and connectivity") {
		t.Fatal("missing catalog failure")
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nprintf 'new-model\\tNew Model\\n'\n"), 0755); err != nil {
		t.Fatal(err)
	}
	if ReadModels("antigravity") != nil {
		t.Fatal("failure not cached")
	}
	ResetModelCache()
	if models := ReadModels("antigravity"); len(models) != 2 || ModelCatalogDetail("antigravity") != "" {
		t.Fatal("cache did not refresh", models)
	}
}

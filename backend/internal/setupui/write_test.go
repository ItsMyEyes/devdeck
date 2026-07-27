package setupui

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"devdeck/backend/internal/config"
)

// The hub's paste dialog accepts exactly three non-empty pipe-separated fields
// whose URL is absolute http(s). This mirrors parseConnectionString in
// frontend/src/features/machines/connectionString.ts — if that parser and this
// test ever disagree, the line the wizard prints is unpasteable.
func parseLikeTheFrontend(t *testing.T, raw string) (name, url, key string) {
	t.Helper()
	parts := strings.Split(strings.TrimSpace(raw), "|")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	if len(parts) != 3 {
		t.Fatalf("connection line %q split into %d fields, want exactly 3", raw, len(parts))
	}
	for i, p := range parts {
		if p == "" {
			t.Fatalf("connection line %q has an empty field at index %d", raw, i)
		}
	}
	if !regexp.MustCompile(`^https?://`).MatchString(parts[1]) {
		t.Fatalf("connection line %q url %q is not absolute http(s)", raw, parts[1])
	}
	return parts[0], parts[1], parts[2]
}

func TestConnectionLineRoundTripsThroughTheFrontendParser(t *testing.T) {
	line, err := ConnectionLine("builder", "https://builder.tail-abc.ts.net", "a1b2c3")
	if err != nil {
		t.Fatalf("ConnectionLine: %v", err)
	}
	name, url, key := parseLikeTheFrontend(t, line)
	if name != "builder" || url != "https://builder.tail-abc.ts.net" || key != "a1b2c3" {
		t.Errorf("round trip = (%q, %q, %q), want (builder, https://builder.tail-abc.ts.net, a1b2c3)", name, url, key)
	}
}

func TestConnectionLineRejectsUnpasteableInput(t *testing.T) {
	tests := []struct {
		name             string
		mName, mURL, key string
	}{
		{name: "empty name", mURL: "https://h", key: "k"},
		{name: "empty url", mName: "n", key: "k"},
		{name: "empty key", mName: "n", mURL: "https://h"},
		{name: "blank name is empty after trim", mName: "   ", mURL: "https://h", key: "k"},
		{name: "relative url", mName: "n", mURL: "h.example", key: "k"},
		{name: "wrong scheme", mName: "n", mURL: "ftp://h", key: "k"},
		{name: "pipe in name would split into four", mName: "a|b", mURL: "https://h", key: "k"},
		{name: "pipe in key would split into four", mName: "n", mURL: "https://h", key: "a|b"},
		{name: "newline in name breaks the one-line format", mName: "a\nb", mURL: "https://h", key: "k"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if line, err := ConnectionLine(tt.mName, tt.mURL, tt.key); err == nil {
				t.Errorf("ConnectionLine(%q, %q, %q) = %q, want an error", tt.mName, tt.mURL, tt.key, line)
			}
		})
	}
}

func TestConnectionLineTrimsSurroundingWhitespace(t *testing.T) {
	line, err := ConnectionLine("  builder  ", " https://h ", " key ")
	if err != nil {
		t.Fatalf("ConnectionLine: %v", err)
	}
	if line != "builder|https://h|key" {
		t.Errorf("line = %q, want %q", line, "builder|https://h|key")
	}
}

func runtimeConfig() *config.Config {
	return &config.Config{
		Role:    "runtime",
		Addr:    "0.0.0.0:9199",
		Key:     "a1b2c3d4",
		Machine: config.MachineConfig{Name: "builder", PublicURL: "https://builder.tail-abc.ts.net"},
		Hub:     config.HubConfig{URL: "https://hq.tail-abc.ts.net", Key: "hubkey"},
	}
}

func TestWriteRuntimeEmitsBothFiles(t *testing.T) {
	dir := t.TempDir()
	res, err := Write(dir, runtimeConfig())
	if err != nil {
		t.Fatalf("Write: %v", err)
	}

	if res.ConfigPath != filepath.Join(dir, config.FileName) {
		t.Errorf("ConfigPath = %q, want %q", res.ConfigPath, filepath.Join(dir, config.FileName))
	}
	if res.CopyThisPath != filepath.Join(dir, CopyThisFileName) {
		t.Errorf("CopyThisPath = %q, want %q", res.CopyThisPath, filepath.Join(dir, CopyThisFileName))
	}

	name, url, key := parseLikeTheFrontend(t, res.ConnectionLine)
	if name != "builder" || url != "https://builder.tail-abc.ts.net" || key != "a1b2c3d4" {
		t.Errorf("connection line = %q", res.ConnectionLine)
	}

	// copy-this.md must contain the exact same line, on a line of its own, so
	// the operator can select and paste it.
	body, err := os.ReadFile(res.CopyThisPath)
	if err != nil {
		t.Fatalf("read copy-this.md: %v", err)
	}
	var found bool
	for _, l := range strings.Split(string(body), "\n") {
		if strings.TrimSpace(l) == res.ConnectionLine {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("copy-this.md does not contain the connection line %q on its own line:\n%s", res.ConnectionLine, body)
	}
}

func TestWriteBothRoleAlsoEmitsCopyThis(t *testing.T) {
	cfg := runtimeConfig()
	cfg.Role = "both"
	res, err := Write(t.TempDir(), cfg)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if res.CopyThisPath == "" || res.ConnectionLine == "" {
		t.Errorf("role both: got CopyThisPath=%q line=%q, want both set", res.CopyThisPath, res.ConnectionLine)
	}
}

// A hub has nothing to paste anywhere: emitting a copy-this.md for it would
// leak the hub's own key into a file whose whole purpose is to be pasted.
func TestWriteHubEmitsNoCopyThis(t *testing.T) {
	dir := t.TempDir()
	cfg := &config.Config{Role: "hub", Addr: "127.0.0.1:8989", Key: "hubkey"}
	res, err := Write(dir, cfg)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if res.CopyThisPath != "" || res.ConnectionLine != "" {
		t.Errorf("role hub: got CopyThisPath=%q line=%q, want both empty", res.CopyThisPath, res.ConnectionLine)
	}
	if _, err := os.Stat(filepath.Join(dir, CopyThisFileName)); !os.IsNotExist(err) {
		t.Errorf("copy-this.md exists for role hub (stat err = %v), want it absent", err)
	}
}

func TestWriteUsesMode0600ForEveryFile(t *testing.T) {
	dir := t.TempDir()
	res, err := Write(dir, runtimeConfig())
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	for _, path := range []string{res.ConfigPath, res.CopyThisPath} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat %s: %v", path, err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("%s mode = %v, want 0600 — both files carry a live API key", path, perm)
		}
	}
}

func TestWrittenConfigParsesBackThroughTheStrictDecoder(t *testing.T) {
	dir := t.TempDir()
	res, err := Write(dir, runtimeConfig())
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	cfg, err := config.Load(res.ConfigPath)
	if err != nil {
		t.Fatalf("the wizard wrote a devdeck.yaml its own strict decoder rejects: %v", err)
	}
	if cfg.Role != "runtime" || cfg.Machine.Name != "builder" || cfg.Key != "a1b2c3d4" {
		t.Errorf("round trip lost values: %+v", cfg)
	}
}

func TestWriteCreatesTheTargetDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "deeper")
	if _, err := Write(dir, runtimeConfig()); err != nil {
		t.Fatalf("Write into a missing directory: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, config.FileName)); err != nil {
		t.Errorf("config not written into the created directory: %v", err)
	}
}

// A runtime with no public URL or no key cannot produce a pasteable line. That
// must surface as an error from Write, not as a malformed line the operator
// discovers only when the hub rejects it.
func TestWriteRuntimeRejectsAnIncompleteIdentity(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*config.Config)
	}{
		{name: "no machine name", mutate: func(c *config.Config) { c.Machine.Name = "" }},
		{name: "no public url", mutate: func(c *config.Config) { c.Machine.PublicURL = "" }},
		{name: "no key", mutate: func(c *config.Config) { c.Key = "" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := runtimeConfig()
			tt.mutate(cfg)
			if _, err := Write(t.TempDir(), cfg); err == nil {
				t.Error("Write succeeded, want an error naming the missing field")
			}
		})
	}
}

func TestSummaryShowsThePathsAndTheLine(t *testing.T) {
	res, err := Write(t.TempDir(), runtimeConfig())
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	summary := res.Summary()
	for _, want := range []string{res.ConfigPath, res.CopyThisPath, res.ConnectionLine} {
		if !strings.Contains(summary, want) {
			t.Errorf("summary missing %q:\n%s", want, summary)
		}
	}
}

func TestSummaryForHubOmitsTheConnectionSection(t *testing.T) {
	res, err := Write(t.TempDir(), &config.Config{Role: "hub", Addr: "127.0.0.1:8989"})
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	summary := res.Summary()
	if strings.Contains(summary, CopyThisFileName) || strings.Contains(summary, "|") {
		t.Errorf("hub summary should not mention copy-this.md or a connection line:\n%s", summary)
	}
	if !strings.Contains(summary, res.ConfigPath) {
		t.Errorf("hub summary missing the config path:\n%s", summary)
	}
}

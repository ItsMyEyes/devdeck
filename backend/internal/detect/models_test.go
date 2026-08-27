package detect

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"devdeck/backend/internal/domain"
)

func ids(models []domain.Model) []string {
	out := make([]string, 0, len(models))
	for _, m := range models {
		out = append(out, m.ID)
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// The id handed back must be the CLI's `value`, never its `resolvedModel`.
// `value` is what --model and the set_model control request accept; the
// resolved id is the CLI's own bookkeeping and moves whenever an alias is
// re-pointed at a newer model. This is also the case the old settings.json
// reader got wrong in the field: the real setting was "opus[1m]", which its
// alias table did not know, so it surfaced as a model literally named
// "opus[1m]" with no display name and no opus 5 in the list at all.
func TestClaudeModelsUseTheValueTheCLIAccepts(t *testing.T) {
	models := claudeModelsFrom([]claudeInitModel{
		{Value: "default", ResolvedModel: "claude-opus-5[1m]", DisplayName: "Default (recommended)"},
		{Value: "opus[1m]", ResolvedModel: "claude-opus-5[1m]", DisplayName: "Opus (1M context)"},
		{Value: "sonnet", ResolvedModel: "claude-sonnet-5", DisplayName: "Sonnet"},
	})

	want := []string{"default", "opus[1m]", "sonnet"}
	if got := ids(models); !equalStrings(got, want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
	if models[1].Name != "Opus (1M context)" {
		t.Fatalf("dropped the CLI's own display name: %q", models[1].Name)
	}
	// The "[1m]" marker is the CLI's own statement about the window; nothing
	// here may invent a number for a model id it does not recognise.
	if models[1].ContextWindow != 1000000 {
		t.Fatalf("1M variant reported ContextWindow=%d", models[1].ContextWindow)
	}
	if models[2].ContextWindow != 200000 {
		t.Fatalf("non-1M variant reported ContextWindow=%d", models[2].ContextWindow)
	}
}

// An entry with no value cannot be selected, and one with no display name
// still has to be nameable — falling back to the value is better than a blank
// row in the picker.
func TestClaudeModelsSkipValuelessEntriesAndNameTheRest(t *testing.T) {
	models := claudeModelsFrom([]claudeInitModel{
		{Value: "", DisplayName: "ghost"},
		{Value: "haiku"},
	})
	if got := ids(models); !equalStrings(got, []string{"haiku"}) {
		t.Fatalf("ids = %v, want [haiku]", got)
	}
	if models[0].Name != "haiku" {
		t.Fatalf("nameless entry rendered as %q", models[0].Name)
	}
	if claudeModelsFrom(nil) != nil {
		t.Fatal("an empty catalog must be nil so the caller falls back, not an empty list")
	}
}

// opencode addresses every model as "provider/model". Anything without a
// slash is a banner, a warning or a blank line — never a model id — and the
// old static fallback offering bare "gpt-5" is exactly the shape that must not
// reach the picker.
func TestOpenCodeModelsKeepOnlyProviderQualifiedIDs(t *testing.T) {
	out := []byte("\nopencode/big-pickle\nanthropic/claude-sonnet-5\n" +
		"warning: something happened\ngpt-5\nopencode/big-pickle\n  \n")

	want := []string{"opencode/big-pickle", "anthropic/claude-sonnet-5"}
	if got := ids(parseOpenCodeModels(out)); !equalStrings(got, want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
	if parseOpenCodeModels([]byte("no models here\n")) != nil {
		t.Fatal("output with no ids must be nil so the caller falls back")
	}
}

// The configured model is what this machine actually runs, and it is routinely
// a custom-provider id that appears in no catalog — so it has to survive the
// scan. A [model_providers.*] table's `name` key must not be mistaken for one.
func TestCodexConfiguredModelsReadTheModelKeyOnly(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	body := `model_reasoning_effort = "xhigh"
model = "ollama/glm-5.2"
model_provider = "9router"

[model_providers.custom]
name = "custom"
base_url = "https://ollama.com/v1"

[profiles.fast]
model = "gpt-5.4-mini"

[tui.model_availability_nux]
"gpt-5.5" = 3
`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	want := []string{"ollama/glm-5.2", "gpt-5.4-mini"}
	if got := ids(codexConfiguredModels(path)); !equalStrings(got, want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
	if codexConfiguredModels(filepath.Join(dir, "absent.toml")) != nil {
		t.Fatal("a missing config must read as nil, not an error the caller cannot see")
	}
}

// Cache hits must not re-spawn the CLI, and the TTL must actually expire —
// a catalog frozen for the life of the process would never notice an agent
// upgrade.
func TestReadModelsCachesPerAgentAndExpires(t *testing.T) {
	ResetModelCache()
	t.Cleanup(ResetModelCache)

	now := time.Now()
	modelNow = func() time.Time { return now }
	t.Cleanup(func() { modelNow = time.Now })

	calls := 0
	// "gemini" has no reader, so nothing here touches a real binary; the call
	// count is observed through the cache map instead.
	seed := func(models []domain.Model) {
		calls++
		modelCacheMu.Lock()
		modelCache["fake"] = modelCacheEntry{models: models, readAt: modelNow()}
		modelCacheMu.Unlock()
	}
	seed([]domain.Model{{ID: "one"}})

	if got := ReadModels("fake"); !equalStrings(ids(got), []string{"one"}) {
		t.Fatalf("cache miss on a fresh entry: %v", ids(got))
	}
	if calls != 1 {
		t.Fatalf("a cached read re-ran the reader (%d calls)", calls)
	}

	now = now.Add(modelCacheTTL + time.Second)
	// Expired: ReadModels now runs the real (nil) reader for an unknown agent
	// and overwrites the entry, which is what proves the TTL is honoured.
	if got := ReadModels("fake"); got != nil {
		t.Fatalf("expired entry was served anyway: %v", ids(got))
	}
}

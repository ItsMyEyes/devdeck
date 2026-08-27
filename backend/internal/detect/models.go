package detect

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"devdeck/backend/internal/domain"
)

// modelReadTimeout bounds every per-agent catalog read below. Two of them
// (claude, opencode) shell out to the agent's own CLI, and this endpoint is on
// the path of opening a model picker — an agent whose binary hangs must cost a
// stale list, never a wedged request.
const modelReadTimeout = 12 * time.Second

// modelCacheTTL is how long one agent's catalog is reused.
//
// It exists because the readers below are no longer all cheap file reads:
// asking claude for its own model list means spawning the CLI (~2s), and
// ListModels is called every time a picker opens. A few minutes is far shorter
// than the interval at which a user installs a new agent version or edits a
// config, and long enough that browsing the UI never spawns a second process.
//
// Failures are cached too, deliberately: an agent that is installed but whose
// catalog cannot be read would otherwise re-spawn a doomed process on every
// single call.
const modelCacheTTL = 5 * time.Minute

type modelCacheEntry struct {
	models []domain.Model
	readAt time.Time
}

var (
	modelCacheMu sync.Mutex
	modelCache   = map[string]modelCacheEntry{}
	// modelNow is the clock, swappable so a test can age the cache without
	// sleeping.
	modelNow = time.Now
)

// ResetModelCache drops every cached catalog. Exported for tests and for the
// settings surfaces that have just rewritten an agent's config and want the
// next read to see it.
func ResetModelCache() {
	modelCacheMu.Lock()
	defer modelCacheMu.Unlock()
	modelCache = map[string]modelCacheEntry{}
}

// ReadModels returns the models an agent ACTUALLY offers, read from that
// agent's own configuration or from the agent's own CLI — never from a table
// maintained in this repository.
//
// That distinction is the whole point of this file. A hardcoded catalog is
// wrong the day a provider ships a model and stays wrong until someone notices:
// the built-in claude list had no claude-opus-5 in it long after opus 5 was the
// default, and the built-in opencode list named two models ("claude-sonnet-5",
// "gpt-5") that are not valid opencode ids in any configuration — opencode
// addresses models as "provider/model". Every entry returned here came from the
// installed agent.
//
// Returns nil when the agent is not detected or its catalog is unreadable, and
// callers fall back to the registry's static data (see registry.LocalRegistry).
func ReadModels(agentID string) []domain.Model {
	modelCacheMu.Lock()
	entry, ok := modelCache[agentID]
	if ok && modelNow().Sub(entry.readAt) < modelCacheTTL {
		modelCacheMu.Unlock()
		return entry.models
	}
	modelCacheMu.Unlock()

	models := readModelsUncached(agentID)

	modelCacheMu.Lock()
	modelCache[agentID] = modelCacheEntry{models: models, readAt: modelNow()}
	modelCacheMu.Unlock()
	return models
}

func readModelsUncached(agentID string) []domain.Model {
	switch agentID {
	case "claude":
		return readClaudeModels()
	case "codex":
		return readCodexModels()
	case "pi":
		return readPiModels()
	case "opencode":
		return readOpenCodeModels()
	default:
		// gemini has no catalog this package knows how to read; the static
		// registry's entry stands until someone adds one.
		return nil
	}
}

// ---- Claude models (the CLI's own `initialize` response) ----

// claudeInitTimeout is shorter than modelReadTimeout on purpose: the
// initialize response comes back before the first turn is ever sent (measured
// at ~2s on a cold start, including SessionStart hooks), so anything slower
// than this is a CLI that is not going to answer at all.
const claudeInitTimeout = 10 * time.Second

// readClaudeModels asks the claude CLI which models it offers.
//
// There is no file to read. ~/.claude/settings.json holds a single `model`
// key — the DEFAULT, not a catalog — and this function used to return exactly
// that one value, mapped through a hardcoded alias table in this repo. Both
// halves were wrong in the field: the real setting was "opus[1m]", which the
// table did not know, so it fell through as a literal model id named
// "opus[1m]" and the picker showed that string alongside a stale built-in list
// that had no opus 5 in it at all.
//
// The CLI's own `initialize` control_response is the catalog, and it is the
// only place it exists (live capture, 2.1.241): each entry carries the `value`
// that --model and the set_model control request accept, plus the
// `displayName` the CLI's own picker shows. No API call and no turn is
// involved — the response arrives from session setup alone.
func readClaudeModels() []domain.Model {
	bin, err := Resolve("claude")
	if err != nil {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), claudeInitTimeout)
	defer cancel()

	// Same flag set the provider adapter spawns sessions with (see
	// agentcore/provider/claude buildArgs), minus everything that only
	// matters once a turn runs. --verbose is not optional: with --print and
	// --output-format stream-json the CLI refuses to start without it.
	cmd := exec.CommandContext(ctx, bin,
		"--print",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--verbose",
	)
	cmd.Env = AugmentedEnv()
	// A directory the CLI cannot enter kills the process before it answers.
	if home, herr := os.UserHomeDir(); herr == nil {
		cmd.Dir = home
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil
	}
	if err := cmd.Start(); err != nil {
		return nil
	}
	// The CLI keeps the session open waiting for a user message that is never
	// coming, so it is always this side that ends the process.
	defer func() {
		_ = stdin.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()

	const requestID = "devdeck-models-1"
	frame, err := json.Marshal(map[string]any{
		"type":       "control_request",
		"request_id": requestID,
		"request":    map[string]any{"subtype": "initialize"},
	})
	if err != nil {
		return nil
	}
	if _, err := stdin.Write(append(frame, '\n')); err != nil {
		return nil
	}

	scanner := bufio.NewScanner(stdout)
	// An init response carries every slash command and skill description the
	// installation has; on a heavily-extended install that is well past the
	// scanner's default 64KB line budget.
	scanner.Buffer(make([]byte, 0, 1<<20), 16<<20)
	for scanner.Scan() {
		var line struct {
			Type     string `json:"type"`
			Response struct {
				Subtype   string `json:"subtype"`
				RequestID string `json:"request_id"`
				Response  struct {
					Models []claudeInitModel `json:"models"`
				} `json:"response"`
			} `json:"response"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			continue
		}
		if line.Type != "control_response" || line.Response.RequestID != requestID {
			continue
		}
		if line.Response.Subtype != "success" {
			return nil
		}
		return claudeModelsFrom(line.Response.Response.Models)
	}
	return nil
}

// claudeInitModel is one entry of the initialize response's `models` array.
type claudeInitModel struct {
	// Value is what --model and the set_model control request accept — an
	// alias ("sonnet", "opus[1m]") as often as a full id. It is the id DevDeck
	// must hand back, never ResolvedModel: resolution is the CLI's job and it
	// changes as models ship.
	Value string `json:"value"`
	// ResolvedModel is what Value currently points at. Used here only to spot
	// a 1M-context variant, since the response states no context window.
	ResolvedModel string `json:"resolvedModel"`
	DisplayName   string `json:"displayName"`
}

func claudeModelsFrom(entries []claudeInitModel) []domain.Model {
	models := make([]domain.Model, 0, len(entries))
	for _, m := range entries {
		if m.Value == "" {
			continue
		}
		name := m.DisplayName
		if name == "" {
			name = m.Value
		}
		models = append(models, domain.Model{
			ID:            m.Value,
			Name:          name,
			ContextWindow: claudeContextWindow(m),
		})
	}
	if len(models) == 0 {
		return nil
	}
	return models
}

// claudeContextWindow reads the window off the "[1m]" marker the CLI puts in
// its own model ids. The initialize response carries no numeric window, and
// inventing one per model id would be exactly the maintained-table problem
// this file exists to remove — the marker is the CLI's own statement.
func claudeContextWindow(m claudeInitModel) int {
	if strings.Contains(m.Value, "[1m]") || strings.Contains(m.ResolvedModel, "[1m]") {
		return 1000000
	}
	return 200000
}

// ---- Codex models (~/.codex/models_cache.json + config.toml) ----

// codexModelsFile is the catalog Codex fetches from its backend and caches on
// disk. Reading it is what makes the list the models Codex will actually
// accept, rather than a guess: the cache on the machine this was written
// against listed gpt-5.5 / gpt-5.4 / gpt-5.4-mini, where the built-in table
// still offered gpt-5, o3 and o4-mini — none of which are in it.
type codexModelsFile struct {
	Models []struct {
		Slug        string `json:"slug"`
		DisplayName string `json:"display_name"`
		// Visibility is "list" for a model Codex's own picker shows; "hide"
		// marks internal ones (codex-auto-review) that must not be offered.
		Visibility string `json:"visibility"`
		// Priority is Codex's own ordering, lowest first.
		Priority int `json:"priority"`
	} `json:"models"`
}

func readCodexModels() []domain.Model {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}

	var models []domain.Model
	// The configured model comes first: whatever the operator set in
	// config.toml is what this machine actually runs, and it is routinely a
	// custom-provider id ("ollama/glm-5.2") that appears in no catalog.
	if configured := codexConfiguredModels(filepath.Join(home, ".codex", "config.toml")); len(configured) > 0 {
		models = append(models, configured...)
	}

	if data, rerr := os.ReadFile(filepath.Join(home, ".codex", "models_cache.json")); rerr == nil {
		var file codexModelsFile
		if json.Unmarshal(data, &file) == nil {
			entries := file.Models
			sort.SliceStable(entries, func(i, j int) bool { return entries[i].Priority < entries[j].Priority })
			for _, m := range entries {
				if m.Slug == "" || m.Visibility == "hide" {
					continue
				}
				if containsModel(models, m.Slug) {
					continue
				}
				name := m.DisplayName
				if name == "" {
					name = m.Slug
				}
				models = append(models, domain.Model{ID: m.Slug, Name: name})
			}
		}
	}

	if len(models) == 0 {
		return nil
	}
	return models
}

// codexConfiguredModels pulls the model ids out of config.toml.
//
// Deliberately a line scan and not a TOML parser: the only keys wanted are
// top-level `model = "..."` and the same key inside a [profiles.*] table, both
// of which are unambiguous on one line, and adding a TOML dependency to read
// two string values is not a trade this package should make. Anything it
// cannot read is simply not returned — the cache above carries the catalog.
func codexConfiguredModels(path string) []domain.Model {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	var models []domain.Model
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		key, value, found := strings.Cut(line, "=")
		if !found || strings.TrimSpace(key) != "model" {
			continue
		}
		id := strings.Trim(strings.TrimSpace(value), `"`)
		if id == "" || containsModel(models, id) {
			continue
		}
		models = append(models, domain.Model{ID: id, Name: id})
	}
	return models
}

// ---- OpenCode models (`opencode models`) ----

// readOpenCodeModels asks opencode for its own catalog.
//
// This path used to return nil on the belief that opencode has "no local
// config directory", and the static fallback then offered "claude-sonnet-5"
// and "gpt-5" — ids opencode cannot resolve, because it addresses every model
// as "provider/model". `opencode models` prints exactly the list the installed
// binary will accept, one per line, and it returns in well under a second.
func readOpenCodeModels() []domain.Model {
	bin, err := Resolve("opencode")
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), modelReadTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, "models")
	cmd.Env = AugmentedEnv()
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	return parseOpenCodeModels(out)
}

func parseOpenCodeModels(out []byte) []domain.Model {
	var models []domain.Model
	for _, line := range strings.Split(string(out), "\n") {
		id := strings.TrimSpace(stripANSI(line))
		// Every real entry is "provider/model". The slash test is what keeps
		// a banner, a warning or a blank line out of the picker.
		if id == "" || !strings.Contains(id, "/") || strings.ContainsAny(id, " \t") {
			continue
		}
		if containsModel(models, id) {
			continue
		}
		models = append(models, domain.Model{ID: id, Name: id})
	}
	if len(models) == 0 {
		return nil
	}
	return models
}

// ---- Pi models (~/.pi/agent/models.json + settings.json) ----

type piModelsFile struct {
	Providers map[string]struct {
		Models []struct {
			ID        string `json:"id"`
			Reasoning bool   `json:"reasoning"`
		} `json:"models"`
	} `json:"providers"`
}

type piSettingsFile struct {
	DefaultProvider string `json:"defaultProvider"`
	DefaultModel    string `json:"defaultModel"`
}

func readPiModels() []domain.Model {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}

	// Read providers/models
	modelsPath := filepath.Join(home, ".pi", "agent", "models.json")
	data, err := os.ReadFile(modelsPath)
	if err != nil {
		return nil
	}
	var mf piModelsFile
	if err := json.Unmarshal(data, &mf); err != nil {
		return nil
	}

	// IDs are prefixed "provider/id" — required, not cosmetic: Pi's own
	// model catalog reuses bare ids across providers (e.g. "deepseek-v4-flash"
	// exists under both the "deepseek" and "opencode-go" providers, at
	// different prices), and the orchestration adapter's mid-session
	// set_model switch (agentcore/provider/pi/adapter.go) only fires for a
	// model string in this exact "provider/id" form — a bare id there is
	// left on whatever model the session already has.
	var models []domain.Model
	for provName, prov := range mf.Providers {
		for _, m := range prov.Models {
			id := provName + "/" + m.ID
			models = append(models, domain.Model{
				ID:            id,
				Name:          id,
				ContextWindow: 0,
			})
		}
	}
	// Map iteration order is random, so without this the picker reshuffles
	// itself on every read.
	sort.Slice(models, func(i, j int) bool { return models[i].ID < models[j].ID })

	// Read default model from settings
	settingsPath := filepath.Join(home, ".pi", "agent", "settings.json")
	data, err = os.ReadFile(settingsPath)
	if err == nil {
		var sf piSettingsFile
		if json.Unmarshal(data, &sf) == nil && sf.DefaultModel != "" && sf.DefaultProvider != "" {
			id := sf.DefaultProvider + "/" + sf.DefaultModel
			// Prepend default model if not already in the list
			if !containsModel(models, id) {
				models = append([]domain.Model{{
					ID:            id,
					Name:          id,
					ContextWindow: 0,
				}}, models...)
			}
		}
	}

	if len(models) == 0 {
		return nil
	}
	return models
}

func containsModel(models []domain.Model, id string) bool {
	for _, m := range models {
		if m.ID == id {
			return true
		}
	}
	return false
}

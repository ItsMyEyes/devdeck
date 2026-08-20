package detect

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"devdeck/backend/internal/domain"
)

// ReadModels reads installed models for the given agent from its local config.
// Returns nil if the agent is not detected or its config is unreadable —
// callers should fall back to the registry's static data.
func ReadModels(agentID string) []domain.Model {
	switch agentID {
	case "claude":
		return readClaudeModels()
	case "codex":
		return readCodexModels()
	case "pi":
		return readPiModels()
	case "opencode", "gemini":
		// No local config directory for these agents; keep static defaults.
		return nil
	default:
		return nil
	}
}

// ---- Codex models (~/.codex/config.toml model key) ----

func readCodexModels() []domain.Model {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	configPath := filepath.Join(home, ".codex", "config.toml")
	f, err := os.Open(configPath)
	if err != nil {
		return nil
	}
	defer f.Close()

	var models []domain.Model
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		// Match top-level "model = \"value\""
		if strings.HasPrefix(line, "model = ") {
			val := strings.TrimPrefix(line, "model = ")
			val = strings.Trim(val, `"`)
			if val != "" {
				models = append(models, domain.Model{
					ID:            val,
					Name:          val,
					ContextWindow: 0, // unknown from config alone
				})
			}
		}
		// Also collect models from [tui.model_availability_nux] entries
		if strings.Count(line, `"`) == 2 && strings.HasPrefix(line, `"`) {
			parts := strings.SplitN(line, `"`, 3)
			if len(parts) >= 2 {
				modelID := parts[1]
				if !containsModel(models, modelID) {
					models = append(models, domain.Model{
						ID:            modelID,
						Name:          modelID,
						ContextWindow: 0,
					})
				}
			}
		}
	}
	if len(models) == 0 {
		return nil
	}
	return models
}

// ---- Claude models (~/.claude/settings.json model field) ----

func readClaudeModels() []domain.Model {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return nil
	}
	var settings struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(data, &settings); err != nil || settings.Model == "" {
		return nil
	}
	// The model field is an alias like "opus", "sonnet", "haiku" —
	// map it to the concrete model ID from the static registry.
	modelID := claudeModelAlias(settings.Model)
	return []domain.Model{{
		ID:            modelID,
		Name:          modelID,
		ContextWindow: 200000,
	}}
}

// claudeModelAlias maps short model names to their concrete IDs.
func claudeModelAlias(alias string) string {
	switch alias {
	case "opus":
		return "claude-opus-4-8"
	case "sonnet":
		return "claude-sonnet-5"
	case "haiku":
		return "claude-haiku-4-5"
	case "fable":
		return "claude-fable-5"
	default:
		return alias // return as-is (might be a direct model ID)
	}
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

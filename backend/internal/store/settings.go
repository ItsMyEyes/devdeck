package store

import (
	"database/sql"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

// Settings returns the singleton settings row.
func (s *Store) Settings() (domain.Settings, error) {
	var set domain.Settings
	var active sql.NullString
	err := s.db.QueryRow(`SELECT active_workspace_id, default_model FROM settings WHERE id = 1`).
		Scan(&active, &set.DefaultModel)
	if err != nil {
		return set, err
	}
	if active.Valid {
		v := active.String
		set.ActiveWorkspaceID = &v
	}
	return set, nil
}

// UpdateSettings applies a partial settings update.
func (s *Store) UpdateSettings(p port.SettingsPatch) (domain.Settings, error) {
	if p.HasActive {
		if _, err := s.db.Exec(`UPDATE settings SET active_workspace_id = ? WHERE id = 1`, p.ActiveWorkspaceID); err != nil {
			return domain.Settings{}, err
		}
	}
	if p.DefaultModel != nil {
		if _, err := s.db.Exec(`UPDATE settings SET default_model = ? WHERE id = 1`, *p.DefaultModel); err != nil {
			return domain.Settings{}, err
		}
	}
	return s.Settings()
}

// SignInPINHash returns the bcrypt hash of the runtime sign-in PIN, or "" when
// none has been set. Deliberately separate from Settings(): the hash must
// never ride along in the JSON the settings endpoint serves.
func (s *Store) SignInPINHash() (string, error) {
	var hash string
	err := s.db.QueryRow(`SELECT signin_pin_hash FROM settings WHERE id = 1`).Scan(&hash)
	return hash, err
}

// SetSignInPINHash replaces the stored runtime sign-in PIN hash.
func (s *Store) SetSignInPINHash(hash string) error {
	_, err := s.db.Exec(`UPDATE settings SET signin_pin_hash = ? WHERE id = 1`, hash)
	return err
}

func (s *Store) setActiveWorkspace(id *string) error {
	_, err := s.db.Exec(`UPDATE settings SET active_workspace_id = ? WHERE id = 1`, id)
	return err
}

// PublishedSOCKS returns this machine's forward-proxy publication state.
// Kept off Settings()/domain.Settings for the same reason SignInPINHash is:
// the key must never ride along in the JSON GET /api/settings serves.
func (s *Store) PublishedSOCKS() (domain.PublishedSOCKSConfig, error) {
	var cfg domain.PublishedSOCKSConfig
	err := s.db.QueryRow(
		`SELECT socks_publish_enabled, socks_publish_port, socks_publish_key FROM settings WHERE id = 1`,
	).Scan(&cfg.Enabled, &cfg.Port, &cfg.Key)
	return cfg, err
}

// SetPublishedSOCKS replaces this machine's forward-proxy publication state.
func (s *Store) SetPublishedSOCKS(cfg domain.PublishedSOCKSConfig) error {
	_, err := s.db.Exec(
		`UPDATE settings SET socks_publish_enabled = ?, socks_publish_port = ?, socks_publish_key = ? WHERE id = 1`,
		cfg.Enabled, cfg.Port, cfg.Key,
	)
	return err
}

// CompletionsConfig returns the BYOK inline-completions configuration.
// Never includes the API key.
func (s *Store) CompletionsConfig() (domain.CompletionsConfig, error) {
	var cfg domain.CompletionsConfig
	var enabled int
	err := s.db.QueryRow(
		`SELECT completions_provider, completions_base_url, completions_model, completions_enabled FROM settings WHERE id = 1`,
	).Scan(&cfg.Provider, &cfg.BaseURL, &cfg.Model, &enabled)
	if err != nil {
		return cfg, err
	}
	cfg.Enabled = enabled != 0
	return cfg, nil
}

// UpdateCompletionsConfig applies a partial update. A nil field is left
// unchanged; APIKey follows the same nil-vs-non-nil convention.
func (s *Store) UpdateCompletionsConfig(p port.CompletionsConfigPatch) (domain.CompletionsConfig, error) {
	if p.Provider != nil {
		if _, err := s.db.Exec(`UPDATE settings SET completions_provider = ? WHERE id = 1`, *p.Provider); err != nil {
			return domain.CompletionsConfig{}, err
		}
	}
	if p.HasBaseURL {
		// completions_base_url is NOT NULL DEFAULT ''; an explicit JSON null
		// means "clear it", so a nil pointer maps to the empty string rather
		// than being dereferenced.
		baseURL := ""
		if p.BaseURL != nil {
			baseURL = *p.BaseURL
		}
		if _, err := s.db.Exec(`UPDATE settings SET completions_base_url = ? WHERE id = 1`, baseURL); err != nil {
			return domain.CompletionsConfig{}, err
		}
	}
	if p.Model != nil {
		if _, err := s.db.Exec(`UPDATE settings SET completions_model = ? WHERE id = 1`, *p.Model); err != nil {
			return domain.CompletionsConfig{}, err
		}
	}
	if p.Enabled != nil {
		if _, err := s.db.Exec(`UPDATE settings SET completions_enabled = ? WHERE id = 1`, *p.Enabled); err != nil {
			return domain.CompletionsConfig{}, err
		}
	}
	if p.APIKey != nil {
		if _, err := s.db.Exec(`UPDATE settings SET completions_api_key = ? WHERE id = 1`, *p.APIKey); err != nil {
			return domain.CompletionsConfig{}, err
		}
	}
	return s.CompletionsConfig()
}

// CompletionsConfigured reports whether a non-empty API key is stored.
func (s *Store) CompletionsConfigured() (bool, error) {
	key, err := s.CompletionsAPIKey()
	if err != nil {
		return false, err
	}
	return key != "", nil
}

// CompletionsAPIKey returns the stored key ("" if unset). Used only by the
// completions service — never surfaced in a handler response.
func (s *Store) CompletionsAPIKey() (string, error) {
	var key string
	err := s.db.QueryRow(`SELECT completions_api_key FROM settings WHERE id = 1`).Scan(&key)
	return key, err
}

// MemoryConfig returns the persistent agent-memory configuration. Never
// includes either API key — see MemoryAPIKey / MemoryLLMAPIKey.
func (s *Store) MemoryConfig() (domain.MemoryConfig, error) {
	var cfg domain.MemoryConfig
	var enabled, autoRecall, autoRetain, localRunning int
	err := s.db.QueryRow(`
		SELECT memory_enabled, memory_base_url, memory_bank_id,
		       memory_hosting, memory_local_port, memory_local_running,
		       memory_llm_provider, memory_llm_model, memory_llm_base_url,
		       memory_auto_recall, memory_auto_retain, memory_recall_budget, memory_max_tokens
		FROM settings WHERE id = 1`).
		Scan(&enabled, &cfg.BaseURL, &cfg.BankID,
			&cfg.Hosting, &cfg.LocalPort, &localRunning,
			&cfg.LLMProvider, &cfg.LLMModel, &cfg.LLMBaseURL,
			&autoRecall, &autoRetain, &cfg.RecallBudget, &cfg.MaxTokens)
	if err != nil {
		return cfg, err
	}
	cfg.Enabled = enabled != 0
	cfg.AutoRecall = autoRecall != 0
	cfg.AutoRetain = autoRetain != 0
	cfg.LocalRunning = localRunning != 0
	return cfg, nil
}

// UpdateMemoryConfig applies a partial update. A nil field is left unchanged;
// APIKey and LLMAPIKey follow the same nil-vs-non-nil convention as
// CompletionsConfigPatch.APIKey.
func (s *Store) UpdateMemoryConfig(p port.MemoryConfigPatch) (domain.MemoryConfig, error) {
	if p.Enabled != nil {
		if _, err := s.db.Exec(`UPDATE settings SET memory_enabled = ? WHERE id = 1`, *p.Enabled); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	if p.HasBaseURL {
		baseURL := ""
		if p.BaseURL != nil {
			baseURL = *p.BaseURL
		}
		if _, err := s.db.Exec(`UPDATE settings SET memory_base_url = ? WHERE id = 1`, baseURL); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	if p.HasBankID {
		bank := ""
		if p.BankID != nil {
			bank = *p.BankID
		}
		if _, err := s.db.Exec(`UPDATE settings SET memory_bank_id = ? WHERE id = 1`, bank); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	if p.Hosting != nil {
		if _, err := s.db.Exec(`UPDATE settings SET memory_hosting = ? WHERE id = 1`, *p.Hosting); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	if p.LocalPort != nil {
		if _, err := s.db.Exec(`UPDATE settings SET memory_local_port = ? WHERE id = 1`, *p.LocalPort); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	if p.LocalRunning != nil {
		if _, err := s.db.Exec(`UPDATE settings SET memory_local_running = ? WHERE id = 1`, *p.LocalRunning); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	if p.LLMProvider != nil {
		if _, err := s.db.Exec(`UPDATE settings SET memory_llm_provider = ? WHERE id = 1`, *p.LLMProvider); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	if p.LLMModel != nil {
		if _, err := s.db.Exec(`UPDATE settings SET memory_llm_model = ? WHERE id = 1`, *p.LLMModel); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	if p.HasLLMBaseURL {
		llmBaseURL := ""
		if p.LLMBaseURL != nil {
			llmBaseURL = *p.LLMBaseURL
		}
		if _, err := s.db.Exec(`UPDATE settings SET memory_llm_base_url = ? WHERE id = 1`, llmBaseURL); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	if p.AutoRecall != nil {
		if _, err := s.db.Exec(`UPDATE settings SET memory_auto_recall = ? WHERE id = 1`, *p.AutoRecall); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	if p.AutoRetain != nil {
		if _, err := s.db.Exec(`UPDATE settings SET memory_auto_retain = ? WHERE id = 1`, *p.AutoRetain); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	if p.RecallBudget != nil {
		if _, err := s.db.Exec(`UPDATE settings SET memory_recall_budget = ? WHERE id = 1`, *p.RecallBudget); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	if p.MaxTokens != nil {
		if _, err := s.db.Exec(`UPDATE settings SET memory_max_tokens = ? WHERE id = 1`, *p.MaxTokens); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	if p.APIKey != nil {
		if _, err := s.db.Exec(`UPDATE settings SET memory_api_key = ? WHERE id = 1`, *p.APIKey); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	if p.LLMAPIKey != nil {
		if _, err := s.db.Exec(`UPDATE settings SET memory_llm_api_key = ? WHERE id = 1`, *p.LLMAPIKey); err != nil {
			return domain.MemoryConfig{}, err
		}
	}
	return s.MemoryConfig()
}

// MemoryConfigured reports whether a base URL has been set. Enabling the
// feature with no server address configured yet is caught earlier, at the
// service layer — this only answers "is there anywhere to call".
func (s *Store) MemoryConfigured() (bool, error) {
	var baseURL string
	err := s.db.QueryRow(`SELECT memory_base_url FROM settings WHERE id = 1`).Scan(&baseURL)
	return baseURL != "", err
}

// MemoryAPIKey returns the stored Hindsight API key ("" if unset). Used only
// by the memory service — never surfaced in a handler response.
func (s *Store) MemoryAPIKey() (string, error) {
	var key string
	err := s.db.QueryRow(`SELECT memory_api_key FROM settings WHERE id = 1`).Scan(&key)
	return key, err
}

// MemoryLLMAPIKey returns the stored LLM provider key ("" if unset) that the
// Hindsight server uses for fact extraction. Used only by the memory service.
func (s *Store) MemoryLLMAPIKey() (string, error) {
	var key string
	err := s.db.QueryRow(`SELECT memory_llm_api_key FROM settings WHERE id = 1`).Scan(&key)
	return key, err
}

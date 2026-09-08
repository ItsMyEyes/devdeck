package detect

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"text/template"
	"time"

	"devdeck/backend/internal/domain"
)

// This file manages Claude Code LLM-provider "environment profiles" — named
// snapshots of the `env` block of ~/.claude/settings.json. Profiles are stored
// as one JSON file per profile under ~/.claude/devdeck-envs/{id}.json; the single
// active profile's id is recorded in ~/.claude/devdeck-envs/.active. Activating a
// profile writes its built env map into ~/.claude/settings.json (other top-level
// keys preserved), so Claude Code picks up the provider on its next launch.

// envProfileIDPattern is the slug allowed for a profile id (and file name).
var envProfileIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// defaultModelSlots maps each Claude model alias slot to the *_MODEL env key it
// controls. The matching *_MODEL_NAME key always carries the same value.
var defaultModelSlots = []struct {
	slot, modelKey string
}{
	{"haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"},
	{"opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"},
	{"sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"},
}

const envProfileDirName = "devdeck-envs"

// envProfilesDir returns ~/.claude/devdeck-envs, creating it (0o700) if missing.
func envProfilesDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".claude", envProfileDirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// agentSettingsPath returns the settings file an env profile is written into.
// Codex uses config.toml; Claude uses settings.json. Only these two implement
// env profiles — the raw settings-file editor covers every agent through
// settingsFileSpecFor in settingsfile.go, which must not be conflated with
// this: writing a profile's env block into an agent that never reads it would
// look like it worked and change nothing.
func agentSettingsPath(agentID string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch agentID {
	case "claude":
		return filepath.Join(home, ".claude", "settings.json"), nil
	case "codex":
		return filepath.Join(home, ".codex", "config.toml"), nil
	default:
		return "", fmt.Errorf("unknown agent %q", agentID)
	}
}

// codexAuthPath returns ~/.codex/auth.json.
func codexAuthPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".codex", "auth.json"), nil
}

func claudeSettingsPath() (string, error) {
	return agentSettingsPath("claude")
}

func activeMarkerPath() (string, error) {
	dir, err := envProfilesDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, ".active"), nil
}

func profilePath(id string) (string, error) {
	if !envProfileIDPattern.MatchString(id) {
		return "", fmt.Errorf("invalid profile id %q", id)
	}
	dir, err := envProfilesDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, id+".json"), nil
}

// ListEnvProfiles returns saved profiles for a given agent (or all if agentID is
// ""), sorted by name then id. The Active flag is populated from the .active marker.
func ListEnvProfiles(agentID string) ([]domain.EnvProfile, error) {
	dir, err := envProfilesDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	activeID, _ := ActiveEnvProfileID()
	var profiles []domain.EnvProfile
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !envProfileIDPattern.MatchString(id) {
			continue
		}
		p, err := readProfileFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue // skip corrupt profiles rather than failing the whole list
		}
		if agentID != "" && p.AgentID != agentID {
			continue
		}
		p.Active = p.ID == activeID
		profiles = append(profiles, p)
	}
	sort.Slice(profiles, func(i, j int) bool {
		if profiles[i].Name != profiles[j].Name {
			return profiles[i].Name < profiles[j].Name
		}
		return profiles[i].ID < profiles[j].ID
	})
	return profiles, nil
}

// ReadEnvProfile returns a single profile by id.
func ReadEnvProfile(id string) (*domain.EnvProfile, error) {
	path, err := profilePath(id)
	if err != nil {
		return nil, err
	}
	p, err := readProfileFile(path)
	if err != nil {
		return nil, err
	}
	activeID, _ := ActiveEnvProfileID()
	p.Active = p.ID == activeID
	return &p, nil
}

func readProfileFile(path string) (domain.EnvProfile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return domain.EnvProfile{}, err
	}
	var p domain.EnvProfile
	if err := json.Unmarshal(raw, &p); err != nil {
		return domain.EnvProfile{}, fmt.Errorf("parse profile %s: %w", filepath.Base(path), err)
	}
	if p.Models == nil {
		p.Models = map[string]string{}
	}
	if p.ExtraEnv == nil {
		p.ExtraEnv = map[string]string{}
	}
	return p, nil
}

// WriteEnvProfile persists a profile to disk, creating it if new. ID must match
// envProfileIDPattern. Timestamps are stamped here (RFC3339).
func WriteEnvProfile(p domain.EnvProfile) error {
	if !envProfileIDPattern.MatchString(p.ID) {
		return fmt.Errorf("invalid profile id %q", p.ID)
	}
	if p.Models == nil {
		p.Models = map[string]string{}
	}
	if p.ExtraEnv == nil {
		p.ExtraEnv = map[string]string{}
	}
	existing, err := readProfileFileOrNil(p.ID)
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	p.UpdatedAt = now
	if existing == nil {
		p.CreatedAt = now
	} else {
		p.CreatedAt = existing.CreatedAt
		if p.CreatedAt == "" {
			p.CreatedAt = now
		}
	}
	path, err := profilePath(p.ID)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return atomicWrite(path, data, 0o600)
}

func readProfileFileOrNil(id string) (*domain.EnvProfile, error) {
	path, err := profilePath(id)
	if err != nil {
		return nil, err
	}
	p, err := readProfileFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	return &p, nil
}

// DeleteEnvProfile removes a profile file. If it was the active profile, the
// active marker is cleared and the agent's settings.json env block is removed.
func DeleteEnvProfile(id string) error {
	path, err := profilePath(id)
	if err != nil {
		return err
	}
	activeID, activeAgent, _ := readActiveMarker()
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	if activeID == id {
		_ = clearActiveAndEnv(activeAgent)
	}
	return nil
}

// ActiveEnvProfileForAgent returns the id of the active profile for a given agent, or "".
func ActiveEnvProfileForAgent(agentID string) (string, error) {
	id, activeAgent, _ := readActiveMarker()
	if id == "" || activeAgent != agentID {
		return "", nil
	}
	return id, nil
}

// ActiveEnvProfileID returns the globally active profile id, regardless of agent.
func ActiveEnvProfileID() (string, error) {
	id, _, _ := readActiveMarker()
	return id, nil
}

// readActiveMarker returns (profileID, agentID) from the .active file.
func readActiveMarker() (profileID, agentID string, err error) {
	path, err := activeMarkerPath()
	if err != nil {
		return "", "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", "", nil
		}
		return "", "", err
	}
	parts := strings.SplitN(strings.TrimSpace(string(data)), "\n", 2)
	if len(parts) >= 1 {
		profileID = strings.TrimSpace(parts[0])
	}
	if len(parts) >= 2 {
		agentID = strings.TrimSpace(parts[1])
	}
	return
}

// codexConfigTmpl is the TOML template for generating a Codex config.
var codexConfigTmpl = template.Must(template.New("codex-config").Parse(
	`profile = "{{.Name}}"

[model_providers.{{.ProviderID}}]
name = "{{.ProviderName}}"
base_url = "{{.BaseURL}}"
wire_api = "{{.WireAPI}}"
env_key = "{{.EnvKey}}"
requires_openai_auth = true
{{- if .ContextWindow}}
model_context_window = {{.ContextWindow}}
{{- end}}
{{- if .MaxTokens}}
model_max_output_tokens = {{.MaxTokens}}
{{- end}}

[profiles.{{.Name}}]
model = "{{.Model}}"
model_provider = "{{.ProviderID}}"
{{- if .ContextWindow}}
model_context_window = {{.ContextWindow}}
{{- end}}
{{- if .MaxTokens}}
model_max_output_tokens = {{.MaxTokens}}
{{- end}}
`,
))

type codexConfigData struct {
	Name, ProviderID, ProviderName, BaseURL, WireAPI, EnvKey, Model string
	ContextWindow, MaxTokens                                         int
}

// ApplyEnvProfile marks the profile active and writes its config into the
// agent's settings file (Claude → settings.json env block, Codex → config.toml + auth.json),
// preserving all other top-level keys/data.
func ApplyEnvProfile(id, agentID string) error {
	p, err := ReadEnvProfile(id)
	if err != nil {
		return err
	}
	if err := writeActiveMarker(id, agentID); err != nil {
		return err
	}
	if agentID == "codex" {
		return applyCodexProfile(*p)
	}
	settingsPath, err := agentSettingsPath(agentID)
	if err != nil {
		return err
	}
	return applyEnvToSettingsForAgent(settingsPath, buildEnvMap(*p))
}

// ClearActiveEnvProfile removes the active marker and deletes the managed config
// from the agent's settings file (Claude → removes env from settings.json,
// Codex → removes managed sections from config.toml + auth.json).
func ClearActiveEnvProfile(agentID string) error {
	activeID, activeAgent, _ := readActiveMarker()
	if activeID == "" || activeAgent != agentID {
		return nil
	}
	return clearActiveAndEnv(agentID)
}

func clearActiveAndEnv(agentID string) error {
	path, err := activeMarkerPath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	if agentID == "codex" {
		return clearCodexConfig()
	}
	settingsPath, err := agentSettingsPath(agentID)
	if err != nil {
		return err
	}
	return removeEnvFromSettingsForAgent(settingsPath)
}

// applyCodexProfile writes the profile into config.toml and auth.json.
func applyCodexProfile(p domain.EnvProfile) error {
	// 1. Write auth.json
	if err := writeCodexAuth(p); err != nil {
		return fmt.Errorf("write auth: %w", err)
	}
	// 2. Write config.toml
	if err := writeCodexConfig(p); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}

// writeCodexAuth merges the profile's env_key + authToken into auth.json.
func writeCodexAuth(p domain.EnvProfile) error {
	path, err := codexAuthPath()
	if err != nil {
		return err
	}
	envKey := codexEnvKey(p.CodexEnvKey)
	doc := map[string]string{}
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &doc) // preserve existing keys
	}
	if p.AuthToken != "" {
		doc[envKey] = p.AuthToken
	} else {
		delete(doc, envKey)
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	if len(doc) == 0 {
		return atomicWrite(path, []byte("{}\n"), 0o600)
	}
	return atomicWrite(path, out, 0o600)
}

// writeCodexConfig generates config.toml from the profile and merges it with
// any existing config.toml, replacing the managed profile entry.
func writeCodexConfig(p domain.EnvProfile) error {
	path, err := agentSettingsPath("codex")
	if err != nil {
		return err
	}
	providerID := codexProviderID(p.ID)
	profileName := p.Name
	model := codexModel(p.Models)

	// Render new provider + profile TOML block
	var buf bytes.Buffer
	if err := codexConfigTmpl.Execute(&buf, codexConfigData{
		Name:          profileName,
		ProviderID:    providerID,
		ProviderName:  codexProviderName(p.CodexProviderName),
		BaseURL:       p.BaseURL,
		WireAPI:       codexWireAPI(p.CodexWireAPI),
		EnvKey:        codexEnvKey(p.CodexEnvKey),
		Model:         model,
		ContextWindow: p.CodexContextWindow,
		MaxTokens:     p.CodexMaxTokens,
	}); err != nil {
		return fmt.Errorf("render config: %w", err)
	}
	newBlock := strings.TrimSpace(buf.String())

	// Merge with existing config: remove old sections for this provider/profile
	existing := ""
	if raw, err := os.ReadFile(path); err == nil {
		existing = string(raw)
	} else if !os.IsNotExist(err) {
		return err
	}
	merged := mergeCodexConfig(existing, providerID, profileName, newBlock)
	return atomicWrite(path, []byte(merged), 0o600)
}

// clearCodexConfig removes managed sections from config.toml and the env key from auth.json.
func clearCodexConfig() error {
	// Clear auth.json entry for the currently active profile
	activeID, _, _ := readActiveMarker()
	if activeID != "" {
		// Read the profile to find its env_key
		p, err := ReadEnvProfile(activeID)
		if err == nil && p != nil {
			envKey := codexEnvKey(p.CodexEnvKey)
			authPath, aErr := codexAuthPath()
			if aErr == nil {
				doc := map[string]string{}
				if raw, rErr := os.ReadFile(authPath); rErr == nil {
					_ = json.Unmarshal(raw, &doc)
				}
				delete(doc, envKey)
				out, _ := json.MarshalIndent(doc, "", "  ")
				out = append(out, '\n')
				if len(doc) == 0 {
					_ = atomicWrite(authPath, []byte("{}\n"), 0o600)
				} else {
					_ = atomicWrite(authPath, out, 0o600)
				}
			}
		}
	}
	// Clear config.toml: remove managed sections
	path, err := agentSettingsPath("codex")
	if err != nil {
		return err
	}
	existing := ""
	if raw, rErr := os.ReadFile(path); rErr == nil {
		existing = string(raw)
	} else if !os.IsNotExist(rErr) {
		return rErr
	}
	cleaned := removeCodexManagedSections(existing)
	if cleaned != existing {
		return atomicWrite(path, []byte(cleaned), 0o600)
	}
	return nil
}

// mergeCodexConfig replaces managed sections in existing TOML with newBlock.
func mergeCodexConfig(existing, providerID, profileName, newBlock string) string {
	cleaned := removeCodexManagedSections(existing)
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		return newBlock + "\n"
	}
	return cleaned + "\n\n" + newBlock + "\n"
}

// removeCodexManagedSections strips profile=, [model_providers.<id>], and
// [profiles.<name>] sections from a TOML document.
func removeCodexManagedSections(input string) string {
	lines := strings.Split(input, "\n")
	var out []string
	var skip bool
	profileLine := regexp.MustCompile(`^\s*profile\s*=\s*"`)
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		// Track the active profile line
		if profileLine.MatchString(trimmed) {
			continue // remove managed profile = "..."
		}
		// Detect section start
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			skip = false // stop skipping on any new section
			section := trimmed[1 : len(trimmed)-1]
			if strings.HasPrefix(section, "model_providers.") || strings.HasPrefix(section, "profiles.") {
				skip = true
				continue
			}
		}
		if skip {
			continue
		}
		out = append(out, line)
	}
	result := strings.Join(out, "\n")
	result = strings.TrimSpace(result)
	if result == "" {
		return ""
	}
	return result
}

// codexProviderID derives a safe TOML table key from a profile id.
func codexProviderID(id string) string {
	if id == "" {
		return "custom-provider"
	}
	return strings.ReplaceAll(id, "-", "_") + "_provider"
}

func codexProviderName(name string) string {
	if name == "" {
		return "Custom Provider"
	}
	return name
}

func codexWireAPI(api string) string {
	if api == "" || (api != "chat" && api != "responses") {
		return "chat"
	}
	return api
}

func codexEnvKey(key string) string {
	if key == "" {
		return "OPENAI_API_KEY"
	}
	return key
}

func codexModel(models map[string]string) string {
	if v, ok := models["model"]; ok && v != "" {
		return v
	}
	// Fallback: try opus (first used slot in older profiles)
	if v, ok := models["opus"]; ok && v != "" {
		return v
	}
	return ""
}

func writeActiveMarker(id, agentID string) error {
	path, err := activeMarkerPath()
	if err != nil {
		return err
	}
	return atomicWrite(path, []byte(id+"\n"+agentID+"\n"), 0o600)
}

// buildEnvMap renders a profile into the env-key map written to settings.json.
// The 8 default keys are always emitted; model slot values are duplicated into
// the matching *_MODEL_NAME key (Claude Code reads both).
func buildEnvMap(p domain.EnvProfile) map[string]string {
	env := map[string]string{
		"ANTHROPIC_AUTH_TOKEN": p.AuthToken,
		"ANTHROPIC_BASE_URL":   p.BaseURL,
	}
	for _, slot := range defaultModelSlots {
		val := p.Models[slot.slot]
		env[slot.modelKey] = val
		env[slot.modelKey+"_NAME"] = val
	}
	for k, v := range p.ExtraEnv {
		env[k] = v
	}
	return env
}

// applyEnvToSettings sets the `env` block of settings.json (Claude default).
func applyEnvToSettings(env map[string]string) error {
	path, err := claudeSettingsPath()
	if err != nil {
		return err
	}
	return applyEnvToSettingsForAgent(path, env)
}

func applyEnvToSettingsForAgent(path string, env map[string]string) error {
	return mutateSettings(path, func(doc map[string]any) {
		doc["env"] = env
	})
}

// removeEnvFromSettings deletes the `env` block from settings.json (Claude default).
func removeEnvFromSettings() error {
	path, err := claudeSettingsPath()
	if err != nil {
		return err
	}
	return removeEnvFromSettingsForAgent(path)
}

func removeEnvFromSettingsForAgent(path string) error {
	return mutateSettings(path, func(doc map[string]any) {
		delete(doc, "env")
	})
}

func mutateSettings(path string, fn func(map[string]any)) error {
	doc := map[string]any{}
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &doc) // a malformed file is overwritten, not fatal
	} else if !os.IsNotExist(err) {
		return err
	}
	fn(doc)
	if len(doc) == 0 {
		// nothing to write — leave settings.json absent rather than "{}"
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	return atomicWrite(path, out, 0o600)
}

// atomicWrite writes data to a temp sibling then renames, so a crash mid-write
// never leaves a half-written settings.json or profile.
func atomicWrite(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once renamed
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// FetchEnvModels queries a provider's model catalog at {origin}/v1/models
// using the profile's own credentials. The origin (scheme+host) is always
// extracted from the base URL so paths like "/anthropic" are stripped.
// Both Authorization: Bearer and x-api-key headers are sent so OpenAI-compatible
// and Anthropic-style proxies both work.
// Parsing is lenient: {data:[{id}]} or [{id}] or {models:[{id}]}.
func FetchEnvModels(baseURL, authToken string) ([]string, error) {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return nil, fmt.Errorf("base url is required")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("invalid base url %q", baseURL)
	}
	// Always use the origin (scheme+host), stripping any path.
	origin := parsed.Scheme + "://" + parsed.Host
	endpoint := origin + "/v1/models"

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build models request: %w", err)
	}
	if authToken != "" {
		req.Header.Set("Authorization", "Bearer "+authToken)
		req.Header.Set("x-api-key", authToken)
	}
	req.Header.Set("Accept", "application/json")

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch models from %s: %w", endpoint, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20)) // 1 MiB cap
	if err != nil {
		return nil, fmt.Errorf("read models response: %w", err)
	}
	if res.StatusCode >= 400 {
		snippet := strings.TrimSpace(string(body))
		if len(snippet) > 300 {
			snippet = snippet[:300]
		}
		return nil, fmt.Errorf("provider returned %d for %s: %s", res.StatusCode, endpoint, snippet)
	}
	ids := parseModelIDs(body)
	if len(ids) == 0 {
		return nil, fmt.Errorf("no models returned by %s", endpoint)
	}
	return ids, nil
}

// parseModelIDs extracts model ids from any of the common catalog shapes.
func parseModelIDs(body []byte) []string {
	collect := func(items []any) []string {
		var ids []string
		seen := map[string]bool{}
		for _, item := range items {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			id, _ := m["id"].(string)
			id = strings.TrimSpace(id)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			ids = append(ids, id)
		}
		return ids
	}

	// { "data": [...] } — OpenAI / Anthropic standard
	var wrapped struct {
		Data []any `json:"data"`
	}
	if json.Unmarshal(body, &wrapped) == nil && len(wrapped.Data) > 0 {
		if ids := collect(wrapped.Data); len(ids) > 0 {
			sort.Strings(ids)
			return ids
		}
	}

	// { "models": [...] }
	var alt struct {
		Models []any `json:"models"`
	}
	if json.Unmarshal(body, &alt) == nil && len(alt.Models) > 0 {
		if ids := collect(alt.Models); len(ids) > 0 {
			sort.Strings(ids)
			return ids
		}
	}

	// bare [ {id}, ... ]
	var arr []any
	if json.Unmarshal(body, &arr) == nil {
		if ids := collect(arr); len(ids) > 0 {
			sort.Strings(ids)
			return ids
		}
	}
	return nil
}

package service

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

var (
	integrationNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`)
	envKeyPattern          = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

// AddMCPServerInput is the API-facing MCP configuration payload.
type AddMCPServerInput struct {
	Name      string            `json:"name"`
	Transport string            `json:"transport"`
	Command   string            `json:"command"`
	Args      []string          `json:"args"`
	URL       string            `json:"url"`
	Env       map[string]string `json:"env"`
}

// AgentSkillContent is the API-facing representation of one skill's SKILL.md.
type AgentSkillContent struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	ReadOnly bool   `json:"readOnly"`
	Linked   bool   `json:"linked"`
}

// AgentService resolves agent, model, and skill information.
type AgentService struct {
	registry port.AgentRegistry
}

// NewAgentService creates an agent service backed by the given registry.
func NewAgentService(r port.AgentRegistry) *AgentService {
	return &AgentService{registry: r}
}

// ListAgents returns summaries of all available agents.
func (svc *AgentService) ListAgents() ([]domain.AgentSummary, error) {
	return svc.registry.ListAgents()
}

// GetAgent returns the full agent definition.
func (svc *AgentService) GetAgent(agentID string) (*domain.Agent, error) {
	return svc.registry.GetAgent(agentID)
}

// ListModels returns models available for a specific agent.
func (svc *AgentService) ListModels(agentID string) ([]domain.Model, error) {
	if agentID == "" {
		return nil, errors.New("agent id is required")
	}
	return svc.registry.ListModels(agentID)
}

// ListSkills returns skills available for a specific agent.
func (svc *AgentService) ListSkills(agentID string) ([]domain.Skill, error) {
	if agentID == "" {
		return nil, errors.New("agent id is required")
	}
	return svc.registry.ListSkills(agentID)
}

// InstallSkill installs an existing local skill into another installed agent.
func (svc *AgentService) InstallSkill(agentID, skillName string) error {
	if err := svc.validateManagedAgent(agentID); err != nil {
		return err
	}
	if !integrationNamePattern.MatchString(skillName) {
		return fmt.Errorf("invalid skill name: %w", ErrValidation)
	}
	manager, err := svc.manager()
	if err != nil {
		return err
	}
	return mapManagementError(manager.InstallSkill(agentID, skillName))
}

// RemoveSkill removes a skill from one installed agent.
func (svc *AgentService) RemoveSkill(agentID, skillName string) error {
	if err := svc.validateManagedAgent(agentID); err != nil {
		return err
	}
	if !integrationNamePattern.MatchString(skillName) {
		return fmt.Errorf("invalid skill name: %w", ErrValidation)
	}
	manager, err := svc.manager()
	if err != nil {
		return err
	}
	return mapManagementError(manager.RemoveSkill(agentID, skillName))
}

// GetSkillContent returns one installed skill's fixed SKILL.md file.
func (svc *AgentService) GetSkillContent(agentID, skillName string) (AgentSkillContent, error) {
	if err := svc.validateManagedAgent(agentID); err != nil {
		return AgentSkillContent{}, err
	}
	if !integrationNamePattern.MatchString(skillName) {
		return AgentSkillContent{}, fmt.Errorf("invalid skill name: %w", ErrValidation)
	}
	manager, err := svc.manager()
	if err != nil {
		return AgentSkillContent{}, err
	}
	content, readOnly, linked, err := manager.ReadSkillContent(agentID, skillName)
	if err != nil {
		return AgentSkillContent{}, mapManagementError(err)
	}
	return AgentSkillContent{
		Path:     "SKILL.md",
		Content:  content,
		ReadOnly: readOnly,
		Linked:   linked,
	}, nil
}

// UpdateSkillContent atomically writes one installed skill's SKILL.md file.
func (svc *AgentService) UpdateSkillContent(agentID, skillName, content string) error {
	if err := svc.validateManagedAgent(agentID); err != nil {
		return err
	}
	if !integrationNamePattern.MatchString(skillName) {
		return fmt.Errorf("invalid skill name: %w", ErrValidation)
	}
	manager, err := svc.manager()
	if err != nil {
		return err
	}
	return mapManagementError(manager.WriteSkillContent(agentID, skillName, content))
}

// ListMCPServers returns redacted MCP configuration for one installed agent.
func (svc *AgentService) ListMCPServers(agentID string) ([]domain.MCPServer, error) {
	if err := svc.validateManagedAgent(agentID); err != nil {
		return nil, err
	}
	manager, err := svc.manager()
	if err != nil {
		return nil, err
	}
	servers, err := manager.ListMCPServers(agentID)
	return servers, mapManagementError(err)
}

// AddMCPServer validates and delegates MCP configuration to the local agent.
func (svc *AgentService) AddMCPServer(agentID string, input AddMCPServerInput) error {
	if err := svc.validateManagedAgent(agentID); err != nil {
		return err
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Transport = strings.ToLower(strings.TrimSpace(input.Transport))
	input.Command = strings.TrimSpace(input.Command)
	input.URL = strings.TrimSpace(input.URL)
	if !integrationNamePattern.MatchString(input.Name) {
		return fmt.Errorf("invalid MCP server name: %w", ErrValidation)
	}
	if input.Transport != "stdio" && input.Transport != "http" {
		return fmt.Errorf("transport must be stdio or http: %w", ErrValidation)
	}
	if len(input.Args) > 64 {
		return fmt.Errorf("MCP server accepts at most 64 arguments: %w", ErrValidation)
	}
	for _, argument := range input.Args {
		if len(argument) > 4096 {
			return fmt.Errorf("MCP server argument is too long: %w", ErrValidation)
		}
	}
	if len(input.Env) > 64 {
		return fmt.Errorf("MCP server accepts at most 64 environment values: %w", ErrValidation)
	}
	for key, value := range input.Env {
		if !envKeyPattern.MatchString(key) || len(value) > 16<<10 {
			return fmt.Errorf("invalid MCP environment value for %q: %w", key, ErrValidation)
		}
	}
	if input.Transport == "stdio" {
		if input.Command == "" {
			return fmt.Errorf("command is required for stdio MCP servers: %w", ErrValidation)
		}
		input.URL = ""
	} else {
		parsed, err := url.Parse(input.URL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return fmt.Errorf("a valid http or https URL is required: %w", ErrValidation)
		}
		input.Command = ""
		input.Args = nil
		input.Env = nil
	}

	manager, err := svc.manager()
	if err != nil {
		return err
	}
	err = manager.AddMCPServer(agentID, port.MCPServerInput{
		Name:      input.Name,
		Transport: input.Transport,
		Command:   input.Command,
		Args:      input.Args,
		URL:       input.URL,
		Env:       input.Env,
	})
	return mapManagementError(err)
}

// RemoveMCPServer removes one native MCP server configuration.
func (svc *AgentService) RemoveMCPServer(agentID, serverName string) error {
	if err := svc.validateManagedAgent(agentID); err != nil {
		return err
	}
	if !integrationNamePattern.MatchString(serverName) {
		return fmt.Errorf("invalid MCP server name: %w", ErrValidation)
	}
	manager, err := svc.manager()
	if err != nil {
		return err
	}
	return mapManagementError(manager.RemoveMCPServer(agentID, serverName))
}

// ---- Env profiles (Claude LLM-provider snapshots) ----

// EnvProfileInput is the create payload. AuthToken is required on create.
type EnvProfileInput struct {
	Name      string            `json:"name"`
	BaseURL   string            `json:"baseUrl"`
	AuthToken string            `json:"authToken"`
	Models    map[string]string `json:"models"`
	ExtraEnv  map[string]string `json:"extraEnv"`

	// Codex-specific (ignored for Claude)
	CodexProviderName  string `json:"codexProviderName,omitempty"`
	CodexWireAPI       string `json:"codexWireAPI,omitempty"`
	CodexEnvKey        string `json:"codexEnvKey,omitempty"`
	CodexContextWindow int    `json:"codexContextWindow,omitempty"`
	CodexMaxTokens     int    `json:"codexMaxTokens,omitempty"`
}

// EnvProfilePatch is the update payload. A blank AuthToken means "leave the
// stored token unchanged" so the secret never has to round-trip through the UI.
type EnvProfilePatch struct {
	Name      string            `json:"name"`
	BaseURL   string            `json:"baseUrl"`
	AuthToken string            `json:"authToken"`
	Models    map[string]string `json:"models"`
	ExtraEnv  map[string]string `json:"extraEnv"`

	// Codex-specific (ignored for Claude)
	CodexProviderName  string `json:"codexProviderName,omitempty"`
	CodexWireAPI       string `json:"codexWireAPI,omitempty"`
	CodexEnvKey        string `json:"codexEnvKey,omitempty"`
	CodexContextWindow int    `json:"codexContextWindow,omitempty"`
	CodexMaxTokens     int    `json:"codexMaxTokens,omitempty"`
}

// allowed model slots that map to ANTHROPIC_DEFAULT_*_MODEL env keys (Claude)
// plus "model" for Codex.
var envProfileSlots = map[string]bool{"opus": true, "sonnet": true, "haiku": true, "model": true}

// ListEnvProfiles returns redacted summaries for one agent.
func (svc *AgentService) ListEnvProfiles(agentID string) ([]domain.EnvProfileSummary, error) {
	if err := svc.validateEnvProfileAgent(agentID); err != nil {
		return nil, err
	}
	manager, err := svc.manager()
	if err != nil {
		return nil, err
	}
	profiles, err := manager.ListEnvProfiles(agentID)
	if err != nil {
		return nil, mapManagementError(err)
	}
	out := make([]domain.EnvProfileSummary, 0, len(profiles))
	for _, p := range profiles {
		out = append(out, summarizeEnvProfile(p))
	}
	return out, nil
}

// GetEnvProfile returns one redacted profile summary.
func (svc *AgentService) GetEnvProfile(agentID, profileID string) (*domain.EnvProfileSummary, error) {
	if err := svc.validateEnvProfileAgent(agentID); err != nil {
		return nil, err
	}
	manager, err := svc.manager()
	if err != nil {
		return nil, err
	}
	profiles, err := manager.ListEnvProfiles(agentID)
	if err != nil {
		return nil, mapManagementError(err)
	}
	for _, p := range profiles {
		if p.ID == profileID {
			s := summarizeEnvProfile(p)
			return &s, nil
		}
	}
	return nil, fmt.Errorf("env profile not found: %w", ErrValidation)
}

// CreateEnvProfile validates input, generates a unique slug id, and persists.
func (svc *AgentService) CreateEnvProfile(agentID string, input EnvProfileInput) (*domain.EnvProfileSummary, error) {
	if err := svc.validateEnvProfileAgent(agentID); err != nil {
		return nil, err
	}
	if err := validateEnvProfileFields(input.Name, input.BaseURL, input.AuthToken, true, input.Models, input.ExtraEnv); err != nil {
		return nil, err
	}
	manager, err := svc.manager()
	if err != nil {
		return nil, err
	}
	existing, err := manager.ListEnvProfiles(agentID)
	if err != nil {
		return nil, mapManagementError(err)
	}
	id := uniqueEnvProfileID(slugifyEnvProfileID(input.Name), existing)
	profile := domain.EnvProfile{
		ID:                 id,
		AgentID:            agentID,
		Name:               strings.TrimSpace(input.Name),
		BaseURL:            input.BaseURL,
		AuthToken:          input.AuthToken,
		Models:             normalizeModels(input.Models),
		ExtraEnv:           normalizeExtraEnv(input.ExtraEnv),
		CodexProviderName:  input.CodexProviderName,
		CodexWireAPI:       input.CodexWireAPI,
		CodexEnvKey:        input.CodexEnvKey,
		CodexContextWindow: input.CodexContextWindow,
		CodexMaxTokens:     input.CodexMaxTokens,
	}
	if err := manager.SaveEnvProfile(agentID, profile); err != nil {
		return nil, mapManagementError(err)
	}
	s := summarizeEnvProfile(profile)
	return &s, nil
}

// UpdateEnvProfile merges a patch into the stored profile. A blank AuthToken
// preserves the previously stored token.
func (svc *AgentService) UpdateEnvProfile(agentID, profileID string, patch EnvProfilePatch) (*domain.EnvProfileSummary, error) {
	if err := svc.validateEnvProfileAgent(agentID); err != nil {
		return nil, err
	}
	if err := validateEnvProfileFields(patch.Name, patch.BaseURL, patch.AuthToken, false, patch.Models, patch.ExtraEnv); err != nil {
		return nil, err
	}
	manager, err := svc.manager()
	if err != nil {
		return nil, err
	}
	profiles, err := manager.ListEnvProfiles(agentID)
	if err != nil {
		return nil, mapManagementError(err)
	}
	var current *domain.EnvProfile
	for i := range profiles {
		if profiles[i].ID == profileID {
			current = &profiles[i]
			break
		}
	}
	if current == nil {
		return nil, fmt.Errorf("env profile not found: %w", ErrValidation)
	}
	current.Name = strings.TrimSpace(patch.Name)
	current.BaseURL = patch.BaseURL
	if strings.TrimSpace(patch.AuthToken) != "" {
		current.AuthToken = patch.AuthToken
	} // else: keep stored token
	current.Models = normalizeModels(patch.Models)
	current.ExtraEnv = normalizeExtraEnv(patch.ExtraEnv)
	current.CodexProviderName = patch.CodexProviderName
	current.CodexWireAPI = patch.CodexWireAPI
	current.CodexEnvKey = patch.CodexEnvKey
	current.CodexContextWindow = patch.CodexContextWindow
	current.CodexMaxTokens = patch.CodexMaxTokens
	active := current.Active
	if err := manager.SaveEnvProfile(agentID, *current); err != nil {
		return nil, mapManagementError(err)
	}
	// Re-apply if this profile is the active one, so settings.json stays in sync.
	if active {
		if err := manager.ActivateEnvProfile(agentID, profileID); err != nil {
			return nil, mapManagementError(err)
		}
	}
	current.Active = active
	s := summarizeEnvProfile(*current)
	return &s, nil
}

// DeleteEnvProfile removes a profile; if it was active, settings.json env is cleared.
func (svc *AgentService) DeleteEnvProfile(agentID, profileID string) error {
	if err := svc.validateEnvProfileAgent(agentID); err != nil {
		return err
	}
	manager, err := svc.manager()
	if err != nil {
		return err
	}
	return mapManagementError(manager.DeleteEnvProfile(agentID, profileID))
}

// ActivateEnvProfile marks one profile active and writes its env to settings.json.
func (svc *AgentService) ActivateEnvProfile(agentID, profileID string) error {
	if err := svc.validateEnvProfileAgent(agentID); err != nil {
		return err
	}
	manager, err := svc.manager()
	if err != nil {
		return err
	}
	return mapManagementError(manager.ActivateEnvProfile(agentID, profileID))
}

// DeactivateEnvProfile clears the active profile and removes settings.json env.
func (svc *AgentService) DeactivateEnvProfile(agentID string) error {
	if err := svc.validateEnvProfileAgent(agentID); err != nil {
		return err
	}
	manager, err := svc.manager()
	if err != nil {
		return err
	}
	return mapManagementError(manager.DeactivateEnvProfile(agentID))
}

// FetchEnvProfileModels queries a provider's model catalog server-side. If
// authToken is blank and profileID is set, the stored token is used so the UI
// never needs the secret to refresh a model list.
func (svc *AgentService) FetchEnvProfileModels(agentID, profileID, baseURL, authToken string) ([]domain.EnvModelOption, error) {
	if err := svc.validateEnvProfileAgent(agentID); err != nil {
		return nil, err
	}
	baseURL = strings.TrimSpace(baseURL)
	resolvedToken := strings.TrimSpace(authToken)
	if resolvedToken == "" && profileID != "" {
		manager, err := svc.manager()
		if err != nil {
			return nil, err
		}
		profiles, err := manager.ListEnvProfiles(agentID)
		if err != nil {
			return nil, mapManagementError(err)
		}
		for _, p := range profiles {
			if p.ID == profileID {
				resolvedToken = p.AuthToken
				if baseURL == "" {
					baseURL = p.BaseURL
				}
				break
			}
		}
	}
	if baseURL == "" {
		return nil, fmt.Errorf("base url is required: %w", ErrValidation)
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("a valid http or https base url is required: %w", ErrValidation)
	}
	manager, err := svc.manager()
	if err != nil {
		return nil, err
	}
	ids, err := manager.FetchEnvProfileModels(agentID, baseURL, resolvedToken)
	if err != nil {
		return nil, err
	}
	out := make([]domain.EnvModelOption, 0, len(ids))
	for _, id := range ids {
		out = append(out, domain.EnvModelOption{ID: id})
	}
	return out, nil
}

// GetSettingsFile returns the raw JSON content of an agent's settings.json.
func (svc *AgentService) GetSettingsFile(agentID string) (string, error) {
	if err := svc.validateManagedAgent(agentID); err != nil {
		return "", err
	}
	manager, err := svc.manager()
	if err != nil {
		return "", err
	}
	content, err := manager.GetSettingsFile(agentID)
	return content, mapManagementError(err)
}

// UpdateSettingsFile atomically writes raw JSON to an agent's settings.json.
// No JSON validation is performed — the caller takes responsibility.
func (svc *AgentService) UpdateSettingsFile(agentID, content string) error {
	if err := svc.validateManagedAgent(agentID); err != nil {
		return err
	}
	manager, err := svc.manager()
	if err != nil {
		return err
	}
	return mapManagementError(manager.SetSettingsFile(agentID, content))
}

func (svc *AgentService) validateEnvProfileAgent(agentID string) error {
	if agentID != "claude" && agentID != "codex" {
		return fmt.Errorf("env profiles are only supported for claude or codex: %w", ErrValidation)
	}
	return svc.validateManagedAgent(agentID)
}

func validateEnvProfileFields(name, baseURL, authToken string, requireToken bool, models, extraEnv map[string]string) error {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 80 {
		return fmt.Errorf("name is required (max 80 chars): %w", ErrValidation)
	}
	baseURL = strings.TrimSpace(baseURL)
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("a valid http or https base url is required: %w", ErrValidation)
	}
	if requireToken && strings.TrimSpace(authToken) == "" {
		return fmt.Errorf("auth token is required: %w", ErrValidation)
	}
	if len(authToken) > 4096 {
		return fmt.Errorf("auth token is too long: %w", ErrValidation)
	}
	for slot := range models {
		if !envProfileSlots[slot] {
			return fmt.Errorf("unknown model slot %q (want opus, sonnet, or haiku): %w", slot, ErrValidation)
		}
		if len(models[slot]) > 128 {
			return fmt.Errorf("model id for %q is too long: %w", slot, ErrValidation)
		}
	}
	if len(extraEnv) > 64 {
		return fmt.Errorf("at most 64 extra environment values: %w", ErrValidation)
	}
	for key, value := range extraEnv {
		if !envKeyPattern.MatchString(key) || len(value) > 16<<10 {
			return fmt.Errorf("invalid environment value for %q: %w", key, ErrValidation)
		}
	}
	return nil
}

func normalizeModels(in map[string]string) map[string]string {
	out := map[string]string{}
	for _, slot := range []string{"opus", "sonnet", "haiku", "model"} {
		if v, ok := in[slot]; ok {
			out[slot] = strings.TrimSpace(v)
		}
	}
	return out
}

func normalizeExtraEnv(in map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range in {
		k = strings.TrimSpace(k)
		if k == "" {
			continue
		}
		out[k] = v
	}
	return out
}

func summarizeEnvProfile(p domain.EnvProfile) domain.EnvProfileSummary {
	extra := map[string]string{}
	for k, v := range p.ExtraEnv {
		extra[k] = v
	}
	models := p.Models
	if models == nil {
		models = map[string]string{}
	}
	return domain.EnvProfileSummary{
		ID:       p.ID,
		AgentID:  p.AgentID,
		Name:     p.Name,
		BaseURL:  p.BaseURL,
		HasToken: strings.TrimSpace(p.AuthToken) != "",
		Models:   models,
		ExtraEnv: extra,

		CodexProviderName:  p.CodexProviderName,
		CodexWireAPI:       p.CodexWireAPI,
		CodexEnvKey:        p.CodexEnvKey,
		CodexContextWindow: p.CodexContextWindow,
		CodexMaxTokens:     p.CodexMaxTokens,

		Active:    p.Active,
		UpdatedAt: p.UpdatedAt,
	}
}

// slugifyEnvProfileID derives a profile id from a display name.
func slugifyEnvProfileID(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	prevDash := true
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			prevDash = false
		} else if !prevDash {
			b.WriteByte('-')
			prevDash = true
		}
	}
	id := strings.Trim(b.String(), "-")
	if id == "" {
		return "env"
	}
	return id
}

// uniqueEnvProfileID appends -2, -3, ... until the id does not collide.
func uniqueEnvProfileID(base string, existing []domain.EnvProfile) string {
	taken := map[string]bool{}
	for _, p := range existing {
		taken[p.ID] = true
	}
	if !taken[base] {
		return base
	}
	for n := 2; ; n++ {
		candidate := fmt.Sprintf("%s-%d", base, n)
		if !taken[candidate] {
			return candidate
		}
	}
}

func (svc *AgentService) manager() (port.AgentManager, error) {
	manager, ok := svc.registry.(port.AgentManager)
	if !ok {
		return nil, fmt.Errorf("agent registry is read-only: %w", ErrValidation)
	}
	return manager, nil
}

func (svc *AgentService) validateManagedAgent(agentID string) error {
	if agentID == "" {
		return fmt.Errorf("agent id is required: %w", ErrValidation)
	}
	agent, err := svc.registry.GetAgent(agentID)
	if err != nil {
		return err
	}
	if agent == nil {
		return fmt.Errorf("agent not found: %w", ErrValidation)
	}
	if !agent.Installed {
		return fmt.Errorf("%s is not installed: %w", agent.Name, ErrValidation)
	}
	return nil
}

func mapManagementError(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, port.ErrIntegrationConflict):
		return fmt.Errorf("%v: %w", err, ErrConflict)
	case errors.Is(err, port.ErrAgentManagementUnsupported),
		errors.Is(err, port.ErrIntegrationNotFound):
		return fmt.Errorf("%v: %w", err, ErrValidation)
	default:
		return err
	}
}

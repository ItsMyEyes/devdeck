package registry

import (
	"log"

	"loom/backend/internal/detect"
	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

// LocalRegistry wraps an inner AgentRegistry and enriches it with data from
// locally-installed agent CLIs. When an agent's CLI is found on $PATH, its
// skills and models are read from the agent's config files. When not found,
// the inner registry's static data is returned unchanged (installed: false).
type LocalRegistry struct {
	inner     port.AgentRegistry
	installed map[string]bool
}

// NewLocalRegistry creates a LocalRegistry that wraps the given registry.
// It probes for installed agent CLIs at construction time.
func NewLocalRegistry(inner port.AgentRegistry) *LocalRegistry {
	installed := detect.ProbeAll()
	log.Printf("local registry: probed %d agents, installed: %v", len(installed), installed)
	return &LocalRegistry{inner: inner, installed: installed}
}

// ListAgents returns agent summaries enriched with local installation status.
func (r *LocalRegistry) ListAgents() ([]domain.AgentSummary, error) {
	agents, err := r.inner.ListAgents()
	if err != nil {
		return nil, err
	}
	for i := range agents {
		agents[i].Installed = r.installed[agents[i].ID]
		if agents[i].Installed {
			if skills := detect.ReadSkills(agents[i].ID); skills != nil {
				agents[i].SkillCount = len(skills)
			}
		}
	}
	return agents, nil
}

// GetAgent returns the full agent definition enriched with local data.
// Locally-detected skills fully replace static ones; models are merged.
func (r *LocalRegistry) GetAgent(agentID string) (*domain.Agent, error) {
	agent, err := r.inner.GetAgent(agentID)
	if err != nil {
		return nil, err
	}
	if agent == nil {
		return nil, nil
	}
	agent.Installed = r.installed[agentID]

	if agent.Installed {
		if skills := detect.ReadSkills(agentID); skills != nil {
			agent.Skills = skills
		} else {
			markSkillsReadOnly(agent.Skills)
		}
		if localModels := detect.ReadModels(agentID); localModels != nil {
			agent.Models = mergeModels(localModels, agent.Models)
		}
	}
	return agent, nil
}

// ListModels returns models for an agent, merging locally-detected models
// with the static registry's catalog.
func (r *LocalRegistry) ListModels(agentID string) ([]domain.Model, error) {
	staticModels, err := r.inner.ListModels(agentID)
	if err != nil {
		return nil, err
	}
	if !r.installed[agentID] {
		return staticModels, nil
	}

	localModels := detect.ReadModels(agentID)
	if localModels == nil {
		return staticModels, nil
	}
	return mergeModels(localModels, staticModels), nil
}

// ListSkills returns skills for an agent, preferring locally-detected data.
func (r *LocalRegistry) ListSkills(agentID string) ([]domain.Skill, error) {
	if r.installed[agentID] {
		if skills := detect.ReadSkills(agentID); skills != nil {
			return skills, nil
		}
	}
	skills, err := r.inner.ListSkills(agentID)
	if err == nil {
		markSkillsReadOnly(skills)
	}
	return skills, err
}

func markSkillsReadOnly(skills []domain.Skill) {
	for index := range skills {
		skills[index].ReadOnly = true
	}
}

// InstallSkill links an existing local skill into another installed agent.
func (r *LocalRegistry) InstallSkill(agentID, skillName string) error {
	if !r.installed[agentID] {
		return port.ErrAgentManagementUnsupported
	}
	return detect.InstallSkill(agentID, skillName)
}

// RemoveSkill removes a skill from one installed agent's writable skill root.
func (r *LocalRegistry) RemoveSkill(agentID, skillName string) error {
	if !r.installed[agentID] {
		return port.ErrAgentManagementUnsupported
	}
	return detect.RemoveSkill(agentID, skillName)
}

// ReadSkillContent reads an installed skill's fixed SKILL.md file.
func (r *LocalRegistry) ReadSkillContent(agentID, skillName string) (string, bool, bool, error) {
	if !r.installed[agentID] {
		return "", false, false, port.ErrAgentManagementUnsupported
	}
	return detect.ReadSkillContent(agentID, skillName)
}

// WriteSkillContent atomically updates an installed skill's SKILL.md file.
func (r *LocalRegistry) WriteSkillContent(agentID, skillName, content string) error {
	if !r.installed[agentID] {
		return port.ErrAgentManagementUnsupported
	}
	return detect.WriteSkillContent(agentID, skillName, content)
}

// ListMCPServers reads redacted MCP configuration through the agent's CLI.
func (r *LocalRegistry) ListMCPServers(agentID string) ([]domain.MCPServer, error) {
	if !r.installed[agentID] {
		return nil, port.ErrAgentManagementUnsupported
	}
	return detect.ReadMCPServers(agentID)
}

// AddMCPServer writes MCP configuration through the agent's native CLI.
func (r *LocalRegistry) AddMCPServer(agentID string, input port.MCPServerInput) error {
	if !r.installed[agentID] {
		return port.ErrAgentManagementUnsupported
	}
	return detect.AddMCPServer(agentID, input)
}

// RemoveMCPServer removes MCP configuration through the agent's native CLI.
func (r *LocalRegistry) RemoveMCPServer(agentID, serverName string) error {
	if !r.installed[agentID] {
		return port.ErrAgentManagementUnsupported
	}
	return detect.RemoveMCPServer(agentID, serverName)
}

// ---- Env profiles (Claude-only: ANTHROPIC_* env schema + ~/.claude/settings.json) ----

func envProfileSupported(agentID string, installed map[string]bool) bool {
	return (agentID == "claude" || agentID == "codex") && installed[agentID]
}

func (r *LocalRegistry) ListEnvProfiles(agentID string) ([]domain.EnvProfile, error) {
	if !envProfileSupported(agentID, r.installed) {
		return nil, port.ErrAgentManagementUnsupported
	}
	return detect.ListEnvProfiles(agentID)
}

func (r *LocalRegistry) SaveEnvProfile(agentID string, profile domain.EnvProfile) error {
	if !envProfileSupported(agentID, r.installed) {
		return port.ErrAgentManagementUnsupported
	}
	return detect.WriteEnvProfile(profile)
}

func (r *LocalRegistry) DeleteEnvProfile(agentID, profileID string) error {
	if !envProfileSupported(agentID, r.installed) {
		return port.ErrAgentManagementUnsupported
	}
	return detect.DeleteEnvProfile(profileID)
}

func (r *LocalRegistry) ActivateEnvProfile(agentID, profileID string) error {
	if !envProfileSupported(agentID, r.installed) {
		return port.ErrAgentManagementUnsupported
	}
	return detect.ApplyEnvProfile(profileID, agentID)
}

func (r *LocalRegistry) DeactivateEnvProfile(agentID string) error {
	if !envProfileSupported(agentID, r.installed) {
		return port.ErrAgentManagementUnsupported
	}
	return detect.ClearActiveEnvProfile(agentID)
}

func (r *LocalRegistry) FetchEnvProfileModels(agentID, baseURL, authToken string) ([]string, error) {
	if !envProfileSupported(agentID, r.installed) {
		return nil, port.ErrAgentManagementUnsupported
	}
	return detect.FetchEnvModels(baseURL, authToken)
}

func (r *LocalRegistry) GetSettingsFile(agentID string) (string, error) {
	if !r.installed[agentID] {
		return "", port.ErrAgentManagementUnsupported
	}
	return detect.ReadSettingsFile(agentID)
}

func (r *LocalRegistry) SetSettingsFile(agentID string, content string) error {
	if !r.installed[agentID] {
		return port.ErrAgentManagementUnsupported
	}
	return detect.WriteSettingsFile(agentID, content)
}

// mergeModels prepends local models not already in the static list.
func mergeModels(local, static []domain.Model) []domain.Model {
	staticIDs := make(map[string]bool, len(static))
	for _, m := range static {
		staticIDs[m.ID] = true
	}
	out := make([]domain.Model, 0, len(local)+len(static))
	for _, m := range local {
		if !staticIDs[m.ID] {
			out = append(out, m)
		}
	}
	out = append(out, static...)
	return out
}

// Ensure LocalRegistry implements port.AgentRegistry.
var _ port.AgentRegistry = (*LocalRegistry)(nil)
var _ port.AgentManager = (*LocalRegistry)(nil)

package port

import (
	"errors"

	"devdeck/backend/internal/domain"
)

// AgentRegistry resolves which agents, models, and skills are available.
// Implementations can be static (built-in catalog), dynamic (Jadi backend), or
// a composite that merges multiple sources.
type AgentRegistry interface {
	// ListAgents returns all available agent types.
	ListAgents() ([]domain.AgentSummary, error)

	// GetAgent returns a full agent definition with models and skills.
	GetAgent(agentID string) (*domain.Agent, error)

	// ListModels returns models available for a specific agent.
	ListModels(agentID string) ([]domain.Model, error)

	// ListSkills returns skills available for a specific agent.
	ListSkills(agentID string) ([]domain.Skill, error)
}

var (
	// ErrAgentManagementUnsupported indicates an agent does not expose the
	// requested local-management capability.
	ErrAgentManagementUnsupported = errors.New("agent management is not supported")
	// ErrIntegrationNotFound indicates a requested skill or MCP server is absent.
	ErrIntegrationNotFound = errors.New("agent integration not found")
	// ErrIntegrationConflict indicates a change would break another integration.
	ErrIntegrationConflict = errors.New("agent integration conflict")
)

// MCPServerInput contains the non-redacted values required to configure a
// server. Values are accepted by the API but never returned by MCPServer.
type MCPServerInput struct {
	Name      string
	Transport string
	Command   string
	Args      []string
	URL       string
	Env       map[string]string
}

// AgentManager is the optional mutable layer implemented by a local registry.
// Remote and static registries can remain read-only AgentRegistry sources.
type AgentManager interface {
	InstallSkill(agentID, skillName string) error
	RemoveSkill(agentID, skillName string) error
	ReadSkillContent(agentID, skillName string) (content string, readOnly, linked bool, err error)
	WriteSkillContent(agentID, skillName, content string) error
	ListMCPServers(agentID string) ([]domain.MCPServer, error)
	AddMCPServer(agentID string, input MCPServerInput) error
	RemoveMCPServer(agentID, serverName string) error

	// Env profiles are Claude-only LLM-provider snapshots written to
	// ~/.claude/settings.json's env block.
	ListEnvProfiles(agentID string) ([]domain.EnvProfile, error)
	SaveEnvProfile(agentID string, profile domain.EnvProfile) error
	DeleteEnvProfile(agentID, profileID string) error
	ActivateEnvProfile(agentID, profileID string) error
	DeactivateEnvProfile(agentID string) error
	FetchEnvProfileModels(agentID, baseURL, authToken string) ([]string, error)
	// GetSettingsFile returns the raw JSON of the agent's settings.json.
	GetSettingsFile(agentID string) (string, error)
	// SetSettingsFile atomically writes raw JSON to the agent's settings.json.
	SetSettingsFile(agentID string, content string) error
}

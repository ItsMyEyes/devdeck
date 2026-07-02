package port

import "loom/backend/internal/domain"

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

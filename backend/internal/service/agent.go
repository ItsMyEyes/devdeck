package service

import (
	"errors"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
)

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

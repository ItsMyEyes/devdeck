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
	return r.inner.ListSkills(agentID)
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

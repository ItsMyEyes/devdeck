package registry

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"loom/backend/internal/domain"
)

// JadiRegistry implements port.AgentRegistry by calling a Jadi backend over HTTP.
// When the backend is unreachable, it falls back to the static built-in catalog.
type JadiRegistry struct {
	baseURL    string
	httpClient *http.Client
	fallback   *StaticRegistry
}

// NewJadiRegistry creates a Jadi-backed registry.
func NewJadiRegistry(baseURL string) *JadiRegistry {
	return &JadiRegistry{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
		fallback: NewStaticRegistry(),
	}
}

func (r *JadiRegistry) get(path string, dst any) error {
	url := r.baseURL + path
	resp, err := r.httpClient.Get(url)
	if err != nil {
		return fmt.Errorf("jadi request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("jadi returned %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(dst)
}

// ListAgents tries the Jadi backend, falling back to static data.
func (r *JadiRegistry) ListAgents() ([]domain.AgentSummary, error) {
	var agents []domain.AgentSummary
	if err := r.get("/api/agents", &agents); err != nil {
		log.Printf("jadi: list agents failed (%v), using fallback", err)
		return r.fallback.ListAgents()
	}
	return agents, nil
}

// GetAgent tries the Jadi backend, falling back to static data.
func (r *JadiRegistry) GetAgent(agentID string) (*domain.Agent, error) {
	var agent domain.Agent
	if err := r.get("/api/agents/"+agentID, &agent); err != nil {
		log.Printf("jadi: get agent %s failed (%v), using fallback", agentID, err)
		return r.fallback.GetAgent(agentID)
	}
	return &agent, nil
}

// ListModels tries the Jadi backend, falling back to static data.
func (r *JadiRegistry) ListModels(agentID string) ([]domain.Model, error) {
	var models []domain.Model
	if err := r.get("/api/agents/"+agentID+"/models", &models); err != nil {
		log.Printf("jadi: list models for %s failed (%v), using fallback", agentID, err)
		return r.fallback.ListModels(agentID)
	}
	return models, nil
}

// ListSkills tries the Jadi backend, falling back to static data.
func (r *JadiRegistry) ListSkills(agentID string) ([]domain.Skill, error) {
	var skills []domain.Skill
	if err := r.get("/api/agents/"+agentID+"/skills", &skills); err != nil {
		log.Printf("jadi: list skills for %s failed (%v), using fallback", agentID, err)
		return r.fallback.ListSkills(agentID)
	}
	return skills, nil
}

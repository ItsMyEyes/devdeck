package handler

import (
	"net/http"

	"loom/backend/internal/service"
)

// AgentHandler handles agent/skill/model listing endpoints.
type AgentHandler struct {
	svc *service.AgentService
}

// NewAgentHandler creates an agent handler.
func NewAgentHandler(svc *service.AgentService) *AgentHandler {
	return &AgentHandler{svc: svc}
}

// ListAgents returns summaries of all available agent types.
func (h *AgentHandler) ListAgents(w http.ResponseWriter, r *http.Request) {
	agents, err := h.svc.ListAgents()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, agents)
}

// GetAgent returns the full agent definition with models and skills.
func (h *AgentHandler) GetAgent(w http.ResponseWriter, r *http.Request) {
	agent, err := h.svc.GetAgent(r.PathValue("agentId"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if agent == nil {
		writeErr(w, http.StatusNotFound, "agent not found")
		return
	}
	writeJSON(w, http.StatusOK, agent)
}

// ListModels returns models available for a specific agent.
func (h *AgentHandler) ListModels(w http.ResponseWriter, r *http.Request) {
	models, err := h.svc.ListModels(r.PathValue("agentId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, models)
}

// ListSkills returns skills available for a specific agent.
func (h *AgentHandler) ListSkills(w http.ResponseWriter, r *http.Request) {
	skills, err := h.svc.ListSkills(r.PathValue("agentId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, skills)
}

// InstallSkill installs an existing local skill into one agent.
func (h *AgentHandler) InstallSkill(w http.ResponseWriter, r *http.Request) {
	err := h.svc.InstallSkill(r.PathValue("agentId"), r.PathValue("skillName"))
	if handleStoreErr(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RemoveSkill removes a skill from one agent.
func (h *AgentHandler) RemoveSkill(w http.ResponseWriter, r *http.Request) {
	err := h.svc.RemoveSkill(r.PathValue("agentId"), r.PathValue("skillName"))
	if handleStoreErr(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetSkillContent returns one installed skill's fixed SKILL.md file.
func (h *AgentHandler) GetSkillContent(w http.ResponseWriter, r *http.Request) {
	content, err := h.svc.GetSkillContent(r.PathValue("agentId"), r.PathValue("skillName"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, content)
}

// UpdateSkillContent writes one installed skill's fixed SKILL.md file.
func (h *AgentHandler) UpdateSkillContent(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Content string `json:"content"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := h.svc.UpdateSkillContent(
		r.PathValue("agentId"),
		r.PathValue("skillName"),
		body.Content,
	); handleStoreErr(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListMCPServers returns redacted native MCP configuration for one agent.
func (h *AgentHandler) ListMCPServers(w http.ResponseWriter, r *http.Request) {
	servers, err := h.svc.ListMCPServers(r.PathValue("agentId"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, servers)
}

// AddMCPServer configures an MCP server through the native agent CLI.
func (h *AgentHandler) AddMCPServer(w http.ResponseWriter, r *http.Request) {
	var body service.AddMCPServerInput
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := h.svc.AddMCPServer(r.PathValue("agentId"), body); handleStoreErr(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RemoveMCPServer removes an MCP server through the native agent CLI.
func (h *AgentHandler) RemoveMCPServer(w http.ResponseWriter, r *http.Request) {
	err := h.svc.RemoveMCPServer(r.PathValue("agentId"), r.PathValue("serverName"))
	if handleStoreErr(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- Env profiles (Claude LLM-provider snapshots) ----

// ListEnvProfiles returns redacted LLM-environment profiles for an agent.
func (h *AgentHandler) ListEnvProfiles(w http.ResponseWriter, r *http.Request) {
	profiles, err := h.svc.ListEnvProfiles(r.PathValue("agentId"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, profiles)
}

// GetEnvProfile returns one redacted profile.
func (h *AgentHandler) GetEnvProfile(w http.ResponseWriter, r *http.Request) {
	profile, err := h.svc.GetEnvProfile(r.PathValue("agentId"), r.PathValue("profileId"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, profile)
}

// CreateEnvProfile creates a new LLM-environment profile.
func (h *AgentHandler) CreateEnvProfile(w http.ResponseWriter, r *http.Request) {
	var body service.EnvProfileInput
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	profile, err := h.svc.CreateEnvProfile(r.PathValue("agentId"), body)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusCreated, profile)
}

// UpdateEnvProfile updates an existing profile (blank auth token = unchanged).
func (h *AgentHandler) UpdateEnvProfile(w http.ResponseWriter, r *http.Request) {
	var body service.EnvProfilePatch
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	profile, err := h.svc.UpdateEnvProfile(r.PathValue("agentId"), r.PathValue("profileId"), body)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, profile)
}

// DeleteEnvProfile removes a profile (and clears settings.json env if active).
func (h *AgentHandler) DeleteEnvProfile(w http.ResponseWriter, r *http.Request) {
	err := h.svc.DeleteEnvProfile(r.PathValue("agentId"), r.PathValue("profileId"))
	if handleStoreErr(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ActivateEnvProfile sets a profile active and writes its env to settings.json.
func (h *AgentHandler) ActivateEnvProfile(w http.ResponseWriter, r *http.Request) {
	err := h.svc.ActivateEnvProfile(r.PathValue("agentId"), r.PathValue("profileId"))
	if handleStoreErr(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// DeactivateEnvProfile clears the active profile and removes settings.json env.
func (h *AgentHandler) DeactivateEnvProfile(w http.ResponseWriter, r *http.Request) {
	err := h.svc.DeactivateEnvProfile(r.PathValue("agentId"))
	if handleStoreErr(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetSettingsFile returns the raw JSON content of settings.json.
func (h *AgentHandler) GetSettingsFile(w http.ResponseWriter, r *http.Request) {
	content, err := h.svc.GetSettingsFile(r.PathValue("agentId"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"content": content})
}

// UpdateSettingsFile writes raw JSON to settings.json.
func (h *AgentHandler) UpdateSettingsFile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Content string `json:"content"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := h.svc.UpdateSettingsFile(r.PathValue("agentId"), body.Content); handleStoreErr(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// envModelsQuery is the body for FetchEnvProfileModels.
type envModelsQuery struct {
	ProfileID string `json:"profileId"`
	BaseURL   string `json:"baseUrl"`
	AuthToken string `json:"authToken"`
}

// FetchEnvProfileModels queries a provider's model catalog server-side using
// either the supplied credentials or, when omitted, the stored profile's.
func (h *AgentHandler) FetchEnvProfileModels(w http.ResponseWriter, r *http.Request) {
	var body envModelsQuery
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	models, err := h.svc.FetchEnvProfileModels(r.PathValue("agentId"), body.ProfileID, body.BaseURL, body.AuthToken)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, models)
}
